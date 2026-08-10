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

function isVisible(el) {
  const s = window.getComputedStyle(el);
  return (
    s.display    !== 'none'   &&
    s.visibility !== 'hidden' &&
    s.opacity    !== '0'      &&
    el.offsetParent !== null
  );
}

/**
 * 현재 페이지의 인터랙티브 요소를 추출합니다.
 * domParser.js와 동일한 로직이지만 content script 직접 실행 버전입니다.
 */
export function extractElements() {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
  ].join(', ');

  const nodes    = document.querySelectorAll(selector);
  const elements = [];

  for (const node of nodes) {
    if (!isVisible(node))                      continue;
    if (node.getAttribute('type') === 'password') continue; // 비밀번호 필드 제외

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

    if (elements.length >= 100) break;
  }

  return elements;
}

// ─── AI 호출 ─────────────────────────────────────────────────────────────────

/**
 * 백엔드 /api/query에 질문과 DOM 요소를 전송하고 AI 응답을 반환합니다.
 * content script는 window.location.href로 현재 URL을 직접 가져옵니다.
 *
 * @returns {Promise<{ anchors: Array, reason: string }>}
 */
export async function callAI(question, elements) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${BACKEND_URL}/api/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        question,
        elements,
        url: window.location.href, // chrome.tabs 불필요
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
