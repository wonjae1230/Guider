// ─────────────────────────────────────────────────────────────────────────────
// 위젯 전용 AI 헬퍼
//
// 위젯은 content script로 실행되므로 chrome.tabs API를 사용할 수 없습니다.
// URL은 window.location.href로 직접 가져오고, DOM도 document에 직접 접근합니다.
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_URL    = 'http://localhost:3000';
const HIGHLIGHT_CLASS = 'guider-hl';
const TOOLTIP_CLASS   = 'guider-tt';

// 하이라이트 색상: 위젯 브랜드 컬러(보라)와 통일
const HL_COLOR = '#7b2ff7';

// ─── 민감정보 마스킹 ──────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\d{6}-\d{7}/g,               // 주민등록번호
  /\d{4}-\d{4}-\d{4}-\d{4}/g,  // 카드번호 (하이픈 포함)
  /\d{16}/g,                    // 카드번호 (하이픈 없음)
];

function maskText(text) {
  if (!text) return '';
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[MASKED]');
  }
  return result;
}

// ─── DOM 요소 추출 ────────────────────────────────────────────────────────────

// isVisible: 특정 window 컨텍스트에서 요소 표시 여부 확인
// iframe 요소는 iframe 자신의 contentWindow를 넘겨야 올바른 스타일을 가져옵니다.
// false를 반환하면(=완전히 숨겨짐) findHiddenAncestor()/findRevealTrigger()로
// "어떤 트리거를 먼저 클릭해야 이게 나타나는지"를 별도로 추정합니다.
function isVisible(el, win = window) {
  try {
    const s = win.getComputedStyle(el);
    return (
      s.display    !== 'none'   &&
      s.visibility !== 'hidden' &&
      s.opacity    !== '0'      &&
      el.offsetParent !== null
    );
  } catch {
    return true; // 확인 불가 시 포함(크로스오리진 등)
  }
}

/**
 * el부터 조상 체인을 걸어 올라가며, el을 화면에서 감춘 조상(있다면)을 찾습니다.
 * "성적정보" 메뉴처럼 <ul style="display:none">으로 접는 경우뿐 아니라
 * max-height:0/overflow:hidden 방식도 함께 감지합니다.
 *
 * 주의: isVisible()의 offsetParent 체크는 el 자신에게 display:none 조상이
 * 있으면 이미 false를 반환하므로, 이 함수는 그 "숨긴 조상 요소 자체"를
 * 찾아 반환하는 역할입니다(트리거를 찾기 위해 어디서부터 형제를 뒤질지 알아야 함).
 */
function findHiddenAncestor(el, win = window) {
  let node  = el.parentElement;
  let depth = 0;

  while (node && depth < 10) {
    let style;
    try {
      style = win.getComputedStyle(node);
    } catch {
      break;
    }

    const displayHidden = style.display === 'none' || style.visibility === 'hidden';
    const clips = /hidden|clip/.test(style.overflow) || /hidden|clip/.test(style.overflowY);
    const zeroSize = clips && (() => {
      const r = node.getBoundingClientRect();
      return r.height <= 1 || r.width <= 1;
    })();

    if (displayHidden || zeroSize) return node;

    node  = node.parentElement;
    depth++;
  }

  return null;
}

/**
 * 숨겨진 컨테이너(hiddenContainer)를 펼치는 트리거로 추정되는 요소를 찾습니다.
 * "성적정보"처럼 트리거가 <a>/<button>이 아니라 그냥 <div>인 경우가 많아,
 * INTERACTIVE_SELECTOR로 제한하지 않고 "보이고 텍스트가 있는" 형제를 찾습니다.
 */
function findRevealTrigger(hiddenContainer, win = window) {
  let sib = hiddenContainer.previousElementSibling;
  while (sib) {
    if (isVisible(sib, win)) {
      const text = (sib.innerText || sib.textContent || '').trim();
      if (text) return sib;
      const inner = Array.from(sib.querySelectorAll('*')).find(
        (c) => isVisible(c, win) && (c.innerText || c.textContent || '').trim(),
      );
      if (inner) return inner;
    }
    sib = sib.previousElementSibling;
  }
  return null;
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  // tabindex="0": 코레일처럼 div/span으로 만든 커스텀 인터랙티브 요소 포함
  '[tabindex="0"]:not(body)',
].join(', ');

// 단일 document에서 인터랙티브 요소를 최대 limit개 추출합니다.
function extractFromDoc(doc, win, limit = 100) {
  const nodes    = doc.querySelectorAll(INTERACTIVE_SELECTOR);
  const elements = [];

  for (const node of nodes) {
    if (node.getAttribute('type') === 'password') continue;

    // 성적정보 > 금학기성적조회처럼 <ul style="display:none">에 감춰진 요소는
    // isVisible()이 false를 반환해 예전엔 통째로 제외됐습니다. 지금은 제외하지 않고,
    // 대신 "펼치는 트리거"를 찾아 revealBy로 같이 담아 AI가 2단계로 안내할 수 있게 합니다.
    const visible = isVisible(node, win);
    let revealBy  = null;

    if (!visible) {
      const hiddenAncestor = findHiddenAncestor(node, win);
      const trigger = hiddenAncestor ? findRevealTrigger(hiddenAncestor, win) : null;
      if (!trigger) continue; // 트리거조차 못 찾으면 안내가 불가능하므로 제외

      const triggerText = (trigger.innerText || trigger.value || trigger.textContent || '').trim();
      revealBy = {
        id:        trigger.id                         || '',
        ariaLabel: maskText(trigger.getAttribute('aria-label')),
        text:      maskText(triggerText.slice(0, 100)),
      };
    }

    const rawText = (node.innerText || node.value || node.textContent || '')
      .trim()
      .replace(/\s+/g, ' ');

    elements.push({
      tag:       node.tagName.toLowerCase(),
      id:        node.id                         || '',
      ariaLabel: maskText(node.getAttribute('aria-label')),
      role:      node.getAttribute('role')       || '',
      text:      maskText(rawText.slice(0, 100)),
      type:      node.getAttribute('type')       || '',
      visible,
      revealBy,
    });

    if (elements.length >= limit) break;
  }

  return elements;
}

// 클래스넷처럼 iframe 안에 또 iframe(header/menu/main/footer 등 프레임셋)이
// 중첩된 구조를 감안해, 몇 단계까지 파고들지 정하는 상한선입니다.
const MAX_FRAME_DEPTH = 4;

/**
 * same-origin iframe들을 재귀적으로 아직 로딩 중이면 완료(또는 타임아웃)까지 기다립니다.
 *
 * iframe.contentDocument는 same-origin이면 로딩 중에도 항상 접근되므로,
 * readyState를 확인하지 않으면 frame.jsp처럼 콘텐츠가 늦게 채워지는
 * 구형 JSP 포털에서 아직 비어있는 문서를 그대로 읽어 빈 배열을 반환하게 됩니다.
 * (PR #10 자동 재실행 이후 바로 추출이 실행될 때 특히 잘 발생합니다.)
 *
 * frame.jsp 자체가 header/menu/main/footer 같은 하위 iframe을 또 담은
 * 프레임셋인 경우가 있어, 로드가 끝난 iframe 안으로도 재귀적으로 들어갑니다.
 */
export async function waitForIframesReady(root = document, timeoutMs = 2000, depth = 0) {
  if (depth >= MAX_FRAME_DEPTH) return;

  // <frame>은 <frameset> 기반 구형 페이지에서 쓰이는 태그로, <iframe>과 별개 셀렉터가 필요합니다.
  const iframes = Array.from(root.querySelectorAll('iframe, frame'));

  await Promise.all(
    iframes.map(async (iframe) => {
      let doc;
      try {
        doc = iframe.contentDocument;
      } catch {
        return; // cross-origin: 기다릴 수 없으니 바로 진행
      }
      if (!doc) return;

      if (doc.readyState !== 'complete') {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          iframe.addEventListener('load', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        try {
          doc = iframe.contentDocument; // load 이후 문서가 교체됐을 수 있어 다시 조회
        } catch {
          return;
        }
      }

      if (doc) await waitForIframesReady(doc, timeoutMs, depth + 1);
    }),
  );
}

/**
 * root 문서와 그 안에 중첩된 모든 same-origin iframe 문서를 재귀적으로 모읍니다.
 * cross-origin iframe은 SecurityError로 접근이 막히므로 건너뜁니다.
 *
 * chain: top부터 이 문서까지 거쳐온 iframe/frame 요소 목록.
 * 하이라이트 시 중첩 프레임 안 요소의 화면 좌표(top 뷰포트 기준)를 계산하는 데 필요합니다.
 */
function collectFrameDocs(doc, win, depth = 0, path = 'top', chain = [], acc = []) {
  acc.push({ doc, win, path, chain });
  console.log(`[Guider] 프레임 방문: ${path} (depth=${depth}, readyState=${doc.readyState})`);

  if (depth >= MAX_FRAME_DEPTH) return acc;

  // <frame>은 <frameset> 기반 구형 페이지(클래스넷 등)에서 쓰이는 태그로, <iframe>과 별개 셀렉터가 필요합니다.
  for (const iframe of doc.querySelectorAll('iframe, frame')) {
    try {
      const iDoc = iframe.contentDocument;
      const iWin = iframe.contentWindow;
      if (!iDoc || !iWin) {
        console.log(`[Guider] ${iframe.tagName} contentDocument 없음 (${path}):`, iframe.src);
        continue;
      }
      collectFrameDocs(
        iDoc, iWin, depth + 1,
        `${path} > ${iframe.name || iframe.src || iframe.tagName.toLowerCase()}`,
        [...chain, iframe], acc,
      );
    } catch (err) {
      console.log(`[Guider] ${iframe.tagName} 접근 실패(교차 출처 등, ${path}):`, iframe.src, err.message);
    }
  }

  return acc;
}

/**
 * 현재 페이지(+ 중첩된 same-origin iframe 전체)의 인터랙티브 요소를 추출합니다.
 * 구형 대학 포털처럼 iframe(심지어 iframe 안의 iframe) 기반 구조도 지원합니다.
 *
 * extractElements/extractPageText 호출 전에 waitForIframesReady()로
 * iframe 로딩을 기다려야 콘텐츠가 채워진 상태를 읽을 수 있습니다.
 */
export function extractElements() {
  const frames = collectFrameDocs(document, window);
  const elements = [];

  for (const { doc, win, path } of frames) {
    if (elements.length >= 100) break;
    const found = extractFromDoc(doc, win, 100 - elements.length);
    if (found.length > 0) {
      console.log(`[Guider] 요소 추출 (${path}):`, found.length, '개');
    }
    elements.push(...found);
  }

  // 접힌 것으로 판단된 요소와, 그 트리거 추정 결과를 별도로 확인할 수 있게 로그
  const hidden = elements.filter((e) => e.visible === false);
  if (hidden.length > 0) {
    console.log('[Guider] 접힘(visible=false)으로 판단된 요소:', hidden);
  } else {
    console.log('[Guider] 접힘으로 판단된 요소 없음 (전부 visible=true로 추출됨)');
  }

  return elements;
}

/**
 * 현재 페이지(+ 중첩된 same-origin iframe 전체)의 가시 텍스트를 추출합니다.
 * "총 학점이 몇 점이야?" 같은 정보 조회 질문에 답하기 위해 사용됩니다.
 * 최대 3000자로 잘라 토큰 낭비를 방지합니다.
 */
export function extractPageText() {
  function getTextFromDoc(doc) {
    // 핵심 콘텐츠 영역 우선, 없으면 body 전체
    const area = doc.querySelector('main, #content, .content, #main, table') || doc.body;
    if (!area) return '';
    return maskText(
      (area.innerText || area.textContent || '').replace(/\s+/g, ' ').trim(),
    );
  }

  const frames = collectFrameDocs(document, window);
  const parts = frames.map(({ doc, path }) => {
    const text = getTextFromDoc(doc);
    console.log(`[Guider] 텍스트 추출 (${path}):`, text.length, '자');
    return text;
  });

  return parts.join('\n').slice(0, 3000);
}

// ─── AI 호출 ─────────────────────────────────────────────────────────────────

/**
 * 백엔드 /api/query에 질문과 DOM 요소를 전송하고 AI 응답을 반환합니다.
 * content script는 window.location.href로 현재 URL을 직접 가져옵니다.
 *
 * @returns {Promise<{ anchors: Array, reason: string }>}
 */
export async function callAI(question, elements, pageText = '') {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${BACKEND_URL}/api/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        question,
        elements,
        pageText, // 정보 조회 질문 대응용 페이지 텍스트
        url: window.location.href,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `서버 오류 (HTTP ${response.status})`);
    }

    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 하이라이트 ───────────────────────────────────────────────────────────────
// extractElements와 마찬가지로 anchor가 top이 아니라 중첩된 frame/iframe 안의
// 요소를 가리킬 수 있으므로, 하이라이트도 collectFrameDocs로 모든 프레임을 뒤집니다.

function ensureHighlightStyles(doc) {
  if (doc.getElementById('guider-hl-styles')) return;

  const style = doc.createElement('style');
  style.id    = 'guider-hl-styles';
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid ${HL_COLOR} !important;
      outline-offset: 2px            !important;
      background-color: rgba(123, 47, 247, 0.1) !important;
      transition: outline 0.15s ease !important;
    }
    .${TOOLTIP_CLASS} {
      position:      fixed;
      background:    ${HL_COLOR};
      color:         #fff;
      padding:       4px 10px;
      border-radius: 6px;
      font-size:     12px;
      font-weight:   600;
      font-family:   -apple-system, BlinkMacSystemFont, sans-serif;
      white-space:   nowrap;
      z-index:       2147483646;
      pointer-events: none;
      box-shadow:    0 2px 8px rgba(0,0,0,0.15);
    }
  `;
  doc.head.appendChild(style);
}

function findElementInDoc(doc, anchor) {
  if (anchor.id) {
    const el = doc.getElementById(anchor.id);
    if (el) return el;
  }
  if (anchor.ariaLabel) {
    const el = doc.querySelector(`[aria-label="${CSS.escape(anchor.ariaLabel)}"]`);
    if (el) return el;
  }
  if (anchor.text) {
    const candidates = doc.querySelectorAll(
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"]',
    );
    for (const el of candidates) {
      if ((el.innerText || el.value || '').trim() === anchor.text) return el;
    }
    for (const el of candidates) {
      const t = (el.innerText || el.value || '').trim();
      if (t && anchor.text.includes(t)) return el;
    }

    // "성적정보"처럼 아코디언 트리거가 <a>/<button>이 아니라 그냥 <div>/<li>인 경우 대비.
    // 오탐 방지를 위해 자기 자신에게 직접 텍스트를 가진(자식 요소가 없는) 요소로 제한합니다.
    const broad = doc.querySelectorAll('div, li, span, dt, th, td');
    for (const el of broad) {
      if (el.children.length === 0 && (el.innerText || el.textContent || '').trim() === anchor.text) {
        return el;
      }
    }
  }
  return null;
}

/**
 * anchor가 가리키는 요소를 top 문서부터 모든 중첩 프레임까지 뒤져서 찾습니다.
 * 찾으면 { el, doc, chain }을 반환합니다. chain은 top → 이 요소가 속한 프레임까지의
 * iframe/frame 요소 목록으로, 화면 좌표 변환에 사용됩니다.
 */
function findElement(anchor) {
  for (const { doc, chain } of collectFrameDocs(document, window)) {
    const el = findElementInDoc(doc, anchor);
    if (el) return { el, doc, chain };
  }
  return null;
}

/**
 * 중첩 프레임 안 요소의 getBoundingClientRect()는 그 프레임 자신의 뷰포트 기준이므로,
 * chain에 있는 iframe/frame들의 위치를 top까지 누적해서 top 뷰포트 기준 좌표로 변환합니다.
 */
function getAbsoluteRect(el, chain) {
  const rect = el.getBoundingClientRect();
  let top    = rect.top;
  let left   = rect.left;

  for (let i = chain.length - 1; i >= 0; i--) {
    const frameRect = chain[i].getBoundingClientRect();
    top  += frameRect.top;
    left += frameRect.left;
  }

  return { top, left, bottom: top + rect.height };
}

/**
 * anchors 배열의 각 요소를 탐색해 하이라이트하고 툴팁을 표시합니다.
 * 첫 번째 요소로 스크롤합니다.
 */
export function highlightAnchors(anchors) {
  clearHighlights();

  let scrollTarget = null;

  anchors.forEach((anchor, i) => {
    const found = findElement(anchor);
    if (!found) {
      console.log('[Guider] 하이라이트 대상 요소를 못 찾음:', anchor);
      return;
    }
    const { el, doc, chain } = found;

    ensureHighlightStyles(doc); // 요소가 속한 프레임의 document에 스타일 주입
    el.classList.add(HIGHLIGHT_CLASS);

    // 툴팁은 항상 top 문서에 띄우되, 좌표는 프레임 체인을 거쳐 top 뷰포트 기준으로 변환
    const rect    = getAbsoluteRect(el, chain);
    const tooltip = document.createElement('div');
    tooltip.className  = TOOLTIP_CLASS;
    tooltip.textContent = anchors.length > 1 ? `Step ${i + 1}` : '여기를 찾아보세요';
    tooltip.style.top  = rect.top > 40 ? `${rect.top - 32}px` : `${rect.bottom + 6}px`;
    tooltip.style.left = `${rect.left}px`;
    document.body.appendChild(tooltip);

    if (!scrollTarget) scrollTarget = el;
  });

  scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * 모든 프레임에 걸친 하이라이트와 top 문서의 툴팁을 제거합니다.
 */
export function clearHighlights() {
  for (const { doc } of collectFrameDocs(document, window)) {
    doc.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
      el.classList.remove(HIGHLIGHT_CLASS);
    });
  }
  document.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(el => el.remove());
}
