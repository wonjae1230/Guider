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
    if (!isVisible(node, win))                    continue;
    if (node.getAttribute('type') === 'password') continue;

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
 */
function collectFrameDocs(doc, win, depth = 0, path = 'top', acc = []) {
  acc.push({ doc, win, path });
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
      collectFrameDocs(iDoc, iWin, depth + 1, `${path} > ${iframe.name || iframe.src || iframe.tagName.toLowerCase()}`, acc);
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
// 하이라이트 대상은 메인 document의 요소이므로 Shadow DOM 외부에 스타일을 주입합니다.

function ensureHighlightStyles() {
  if (document.getElementById('guider-hl-styles')) return;

  const style = document.createElement('style');
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
  document.head.appendChild(style);
}

function findElement(anchor) {
  if (anchor.id) {
    const el = document.getElementById(anchor.id);
    if (el) return el;
  }
  if (anchor.ariaLabel) {
    const el = document.querySelector(`[aria-label="${CSS.escape(anchor.ariaLabel)}"]`);
    if (el) return el;
  }
  if (anchor.text) {
    const candidates = document.querySelectorAll(
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"]',
    );
    for (const el of candidates) {
      if ((el.innerText || el.value || '').trim() === anchor.text) return el;
    }
    for (const el of candidates) {
      const t = (el.innerText || el.value || '').trim();
      if (t && anchor.text.includes(t)) return el;
    }
  }
  return null;
}

/**
 * anchors 배열의 각 요소를 탐색해 하이라이트하고 툴팁을 표시합니다.
 * 첫 번째 요소로 스크롤합니다.
 */
export function highlightAnchors(anchors) {
  clearHighlights();
  ensureHighlightStyles();

  let scrollTarget = null;

  anchors.forEach((anchor, i) => {
    const el = findElement(anchor);
    if (!el) return;

    el.classList.add(HIGHLIGHT_CLASS);

    // 툴팁
    const rect    = el.getBoundingClientRect();
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
 * 모든 하이라이트와 툴팁을 제거합니다.
 */
export function clearHighlights() {
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_CLASS);
  });
  document.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(el => el.remove());
}
