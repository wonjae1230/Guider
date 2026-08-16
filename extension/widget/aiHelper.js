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

// ─── 가시성 체크 ──────────────────────────────────────────────────────────────

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
function extractFromDoc(doc, win, limit = 400) {
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
// 세종시청처럼 상단 네비 + "전체메뉴" 모달까지 합치면 인터랙티브 요소가
// 100개를 훌쩍 넘는 대형 포털 사이트가 있어, 뒤쪽에 있는 메뉴 항목이
// 잘려서 AI에게 전달조차 안 되는 문제가 있었습니다. 400으로 상향합니다.
const MAX_ELEMENTS = 400;

export function extractElements() {
  const frames = collectFrameDocs(document, window);
  const elements = [];

  for (const { doc, win, path } of frames) {
    if (elements.length >= MAX_ELEMENTS) break;
    const found = extractFromDoc(doc, win, MAX_ELEMENTS - elements.length);
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
 * 페이지의 헤딩(h1~h3) 구조를 추출합니다.
 * AI가 페이지 섹션 구조를 이해하여 더 정확하게 요소를 찾을 수 있게 돕습니다.
 */
export function extractHeadings() {
  const headings = [];
  const frames = collectFrameDocs(document, window);

  for (const { doc } of frames) {
    for (const el of doc.querySelectorAll('h1, h2, h3')) {
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) headings.push(`${el.tagName}: ${text.slice(0, 80)}`);
    }
  }

  return headings.slice(0, 20);
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

export async function callAI(question, elements, pageText = '', headings = []) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${BACKEND_URL}/api/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        question,
        elements,
        pageText,
        headings,
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

const BADGE_CLASS = 'guider-badge';

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
    .${BADGE_CLASS} {
      position:        fixed;
      width:           20px;
      height:          20px;
      border-radius:   50%;
      background:      ${HL_COLOR};
      color:            #fff;
      font-size:        12px;
      font-weight:      700;
      font-family:      -apple-system, BlinkMacSystemFont, sans-serif;
      display:          flex;
      align-items:      center;
      justify-content:  center;
      z-index:          2147483647;
      pointer-events:   none;
      box-shadow:       0 1px 4px rgba(0,0,0,0.35);
      border:           2px solid #fff;
    }
  `;
  doc.head.appendChild(style);
}

function findElementInDoc(doc, anchor, win = window) {
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
    // PC/모바일 중복 마크업 등으로 같은 텍스트를 가진 요소가 여러 개 있을 수 있어,
    // "지금 실제로 보이는" 요소를 우선 채택합니다. 완전히 안 보이는 요소만 있으면
    // (숨긴 조상을 revealStep에서 강제로 펼치는 시나리오를 위해) 폴백으로 반환합니다.
    let exactHidden   = null;
    let partialHidden = null;

    // 1. 표준 인터랙티브 요소 — 정확히 일치
    for (const el of candidates) {
      if ((el.innerText || el.value || '').trim() === anchor.text) {
        if (isVisible(el, win)) return el;
        if (!exactHidden) exactHidden = el;
      }
    }
    // 2. 표준 인터랙티브 요소 — 부분 포함
    for (const el of candidates) {
      const t = (el.innerText || el.value || '').trim();
      if (t && anchor.text.includes(t)) {
        if (isVisible(el, win)) return el;
        if (!partialHidden) partialHidden = el;
      }
    }
    if (exactHidden)   return exactHidden;
    if (partialHidden) return partialHidden;

    // 3. 비표준 클릭 요소(div/li 아코디언 트리거 등) — 직접 텍스트만 가진 leaf 요소로 제한
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
  for (const { doc, win, chain } of collectFrameDocs(document, window)) {
    const el = findElementInDoc(doc, anchor, win);
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
 * 요소 하나에 배지/툴팁을 그립니다. 요소가 아직 (접힌 아코디언 등으로) 렌더링
 * 안 된 상태면(getBoundingClientRect가 0,0,0,0) 아무것도 그리지 않고 null을 반환합니다.
 * 반환값의 tooltip/badge는 나중에 removeStepMarkers에서 정확히 이 요소 것만 지우는 데 씁니다.
 */
function drawStepMarkers(el, doc, chain, i, multiStep) {
  ensureHighlightStyles(doc); // 요소가 속한 프레임의 document에도 주입 (.guider-hl 적용용)
  el.classList.add(HIGHLIGHT_CLASS);

  const localRect = el.getBoundingClientRect();
  if (localRect.width === 0 && localRect.height === 0) {
    return null; // 아직 숨겨져 있어 위치를 계산할 수 없음
  }

  const rect = getAbsoluteRect(el, chain);
  // 사이드바처럼 화면 가장자리에 붙은 요소는 배지를 -10px 띄우면 화면 밖으로 잘리므로 클램프
  const clampedTop  = Math.max(4, rect.top - 10);
  const clampedLeft = Math.max(4, rect.left - 10);

  const tooltip = document.createElement('div');
  tooltip.className   = TOOLTIP_CLASS;
  tooltip.textContent = multiStep ? `Step ${i + 1}` : '여기를 찾아보세요';
  tooltip.style.top   = rect.top > 40 ? `${rect.top - 32}px` : `${rect.bottom + 6}px`;
  tooltip.style.left  = `${Math.max(4, rect.left)}px`;
  document.body.appendChild(tooltip);

  let badge = null;
  if (multiStep) {
    badge = document.createElement('div');
    badge.className   = BADGE_CLASS;
    badge.textContent = String(i + 1);
    badge.style.top   = `${clampedTop}px`;
    badge.style.left  = `${clampedLeft}px`;
    document.body.appendChild(badge);
  }

  return { el, tooltip, badge };
}

function removeStepMarkers(marker) {
  if (!marker) return;
  marker.el.classList.remove(HIGHLIGHT_CLASS);
  marker.tooltip?.remove();
  marker.badge?.remove();
}

/**
 * anchors 배열을 순서대로 안내합니다.
 * 여러 단계(anchors.length > 1)일 때는 한 번에 다 띄우지 않고, 사용자가 실제
 * 페이지에서 현재 단계 요소를 클릭할 때마다 다음 단계를 새로 찾아 보여줍니다.
 * (성적정보 같은 아코디언을 펼치기 전엔 다음 단계 요소가 화면에 없어 위치를
 * 계산할 수 없으므로, 클릭 → DOM 변화 → 재탐색 흐름이 필요합니다.)
 *
 * onStepComplete(index)는 anchors[index]에 해당하는 요소를 사용자가 실제로
 * 클릭했을 때 호출됩니다 (ChatWidget이 체크리스트 UI를 갱신하는 데 사용).
 */
export function highlightAnchors(anchors, onStepComplete) {
  clearHighlights();

  // 툴팁/배지는 항상 top 문서의 body에 붙으므로, top 문서에도 스타일이 있어야 합니다.
  // (타겟 요소가 전부 중첩 프레임 안에 있으면 그 프레임에만 스타일이 들어가 안 보이는 버그가 있었음)
  ensureHighlightStyles(document);

  const multiStep = anchors.length > 1;
  const MAX_RETRIES = 6; // 600ms 간격으로 최대 ~3.6초까지만 재탐색 (무한 재시도 방지)

  function revealStep(i, retriesLeft = MAX_RETRIES) {
    if (i >= anchors.length) return;

    const found = findElement(anchors[i]);
    if (!found) {
      console.log('[Guider] 하이라이트 대상 요소를 못 찾음:', anchors[i]);
      return;
    }
    const { el, doc, chain } = found;
    const marker = drawStepMarkers(el, doc, chain, i, multiStep);

    // 강제로 메뉴를 열어버리지 않습니다 — Guider는 "어디를 클릭/호버해야 하는지"만
    // 알려주고, 실제 상호작용은 사용자가 직접 하도록 둡니다. 지금 안 보이면
    // 사용자가 이전 단계를 실제로 클릭/호버해서 펼치길 기다렸다가 재탐색합니다.
    if (!marker) {
      if (retriesLeft <= 0) {
        console.log('[Guider] 요소가 계속 숨겨져 있어 재탐색 포기:', anchors[i]);
        return;
      }
      console.log('[Guider] 요소가 아직 숨겨져 있어 배지/툴팁 생략(펼치면 자동 재탐색):', anchors[i]);
      // 지금은 안 보이지만, 클릭/호버로 펼쳐질 수 있으니 잠시 후 한 번 더 시도합니다.
      setTimeout(() => revealStep(i, retriesLeft - 1), 600);
      return;
    }

    if (i === 0) marker.el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // 단계가 1개뿐이어도(anchors.length === 1) 완료 처리는 동일하게 합니다.
    // 배지/"Step N" 텍스트만 multiStep일 때 표시할 뿐, 완료 체크는 항상 필요합니다.
    // 클릭형 메뉴뿐 아니라 :hover로만 펼쳐지는 메뉴도 있어, click과 mouseenter
    // 둘 다 "사용자가 실제로 상호작용했다"는 신호로 받아들여 다음 단계로 넘어갑니다.
    let advanced = false;
    function onStepAdvance() {
      if (advanced) return;
      advanced = true;
      marker.el.removeEventListener('click', onStepAdvance);
      marker.el.removeEventListener('mouseenter', onStepAdvance);
      removeStepMarkers(marker);
      onStepComplete?.(i);
      // 상호작용으로 메뉴가 펼쳐지는 등 DOM이 바뀔 시간을 준 뒤 다음 단계를 다시 찾습니다.
      setTimeout(() => revealStep(i + 1), 300);
    }
    marker.el.addEventListener('click', onStepAdvance);
    marker.el.addEventListener('mouseenter', onStepAdvance);
  }

  revealStep(0);
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
  document.querySelectorAll(`.${BADGE_CLASS}`).forEach(el => el.remove());
}
