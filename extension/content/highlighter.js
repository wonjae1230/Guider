// ─────────────────────────────────────────────────────────────────────────────
// AI 응답의 anchors를 기반으로 DOM 요소를 찾아 하이라이트합니다.
//
// 탐색 폴백 전략: id → aria-label → text 정확 일치 → text 부분 일치
// 하이라이트: outline #6366f1 + 배경 rgba(99,102,241,0.1)
// 툴팁: position:fixed로 페이지 레이아웃에 영향 없이 오버레이 표시
// ─────────────────────────────────────────────────────────────────────────────

const HIGHLIGHT_CLASS = 'guider-highlight';
const TOOLTIP_CLASS   = 'guider-tooltip';

// ─── 스타일 주입 ──────────────────────────────────────────────────────────────
// content script가 페이지에 로드될 때 하이라이트 CSS를 한 번만 삽입합니다.
// id로 중복 삽입을 방지합니다.
(function injectStyles() {
  if (document.getElementById('guider-styles')) return;

  const style = document.createElement('style');
  style.id = 'guider-styles';
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid #6366f1 !important;
      outline-offset: 2px     !important;
      background-color: rgba(99, 102, 241, 0.1) !important;
      transition: outline 0.15s ease !important;
    }
    .${TOOLTIP_CLASS} {
      position:    fixed;
      background:  #6366f1;
      color:       #fff;
      padding:     4px 10px;
      border-radius: 6px;
      font-size:   12px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      white-space: nowrap;
      z-index:     2147483647;
      pointer-events: none;
      box-shadow:  0 2px 8px rgba(0, 0, 0, 0.15);
    }
  `;
  document.head.appendChild(style);
})();

// ─── 요소 탐색 ─────────────────────────────────────────────────────────────────

/**
 * anchor 객체로 DOM 요소를 탐색합니다.
 *
 * 폴백 순서:
 *  1. id 속성 (가장 신뢰도 높음)
 *  2. aria-label 속성
 *  3. text content 정확 일치
 *  4. text content 부분 일치 (긴 레이블의 일부만 일치하는 경우 대응)
 *
 * @param {{ id: string, ariaLabel: string, text: string }} anchor
 * @returns {Element|null}
 */
function findElement(anchor) {
  // 1순위: id 속성
  if (anchor.id) {
    const el = document.getElementById(anchor.id);
    if (el) return el;
  }

  // 2순위: aria-label 속성
  if (anchor.ariaLabel) {
    const el = document.querySelector(
      `[aria-label="${CSS.escape(anchor.ariaLabel)}"]`,
    );
    if (el) return el;
  }

  // 3·4순위: text content (인터랙티브 요소 내에서만 탐색)
  if (anchor.text) {
    const candidates = document.querySelectorAll(
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"]',
    );

    // 정확 일치 우선
    for (const el of candidates) {
      const elText = (el.innerText || el.value || '').trim();
      if (elText === anchor.text) return el;
    }

    // 부분 일치 폴백 (AI가 반환한 text가 잘린 경우 대응)
    for (const el of candidates) {
      const elText = (el.innerText || el.value || '').trim();
      if (elText && anchor.text.includes(elText)) return el;
    }
  }

  return null;
}

// ─── 툴팁 ──────────────────────────────────────────────────────────────────────

/**
 * 하이라이트된 요소 근처에 단계 표시 툴팁을 띄웁니다.
 * position:fixed를 사용해 페이지 레이아웃에 영향을 주지 않습니다.
 * 요소가 뷰포트 상단에 붙어 있으면 아래쪽에 표시합니다.
 */
function addTooltip(el, label) {
  const rect = el.getBoundingClientRect();

  const tooltip = document.createElement('div');
  tooltip.className = TOOLTIP_CLASS;
  tooltip.textContent = label;

  // 요소 위쪽 표시가 기본, 공간 부족 시 아래쪽으로 전환
  const showBelow = rect.top < 40;
  tooltip.style.top  = showBelow ? `${rect.bottom + 6}px` : `${rect.top - 32}px`;
  tooltip.style.left = `${rect.left}px`;

  document.body.appendChild(tooltip);
}

// ─── 하이라이트 적용 / 제거 ───────────────────────────────────────────────────

/**
 * anchors 배열의 각 요소를 탐색해 하이라이트하고 툴팁을 표시합니다.
 * 여러 단계가 있을 경우 "Step 1", "Step 2" 형태로 순서를 표시합니다.
 * 첫 번째로 찾은 요소로 부드럽게 스크롤합니다.
 *
 * @param {Array<{ id: string, ariaLabel: string, text: string }>} anchors
 * @returns {number} 실제로 찾아 하이라이트된 요소 수
 */
function highlightAnchors(anchors) {
  let foundCount   = 0;
  let scrollTarget = null;

  anchors.forEach((anchor, index) => {
    const el = findElement(anchor);
    if (!el) return;

    el.classList.add(HIGHLIGHT_CLASS);

    const label = anchors.length > 1 ? `Step ${index + 1}` : '여기를 찾아보세요';
    addTooltip(el, label);

    // 가장 처음 찾은 요소로 스크롤 (여러 요소가 있을 경우 첫 번째 기준)
    if (!scrollTarget) scrollTarget = el;
    foundCount++;
  });

  if (scrollTarget) {
    scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return foundCount;
}

/**
 * 모든 하이라이트 클래스와 툴팁 요소를 제거합니다.
 * 새 질문 입력, URL 변경, 탭 전환 시 호출됩니다.
 */
function clearHighlights() {
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_CLASS);
  });
  document.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(el => el.remove());
}

// ─── 메시지 리스너 ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT') {
    clearHighlights(); // 새 하이라이트 전에 기존 것 먼저 제거
    const found = highlightAnchors(message.anchors);
    sendResponse({ success: true, found });
    return true;
  }

  if (message.type === 'CLEAR_HIGHLIGHTS') {
    clearHighlights();
    sendResponse({ success: true });
    return true;
  }
});
