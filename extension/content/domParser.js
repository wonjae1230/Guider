// ─────────────────────────────────────────────────────────────────────────────
// 현재 페이지에서 인터랙티브 DOM 요소를 추출합니다.
// 사이드패널이 chrome.tabs.sendMessage({ type: 'GET_DOM' })을 보내면
// 요소 배열을 sendResponse로 반환합니다.
// ─────────────────────────────────────────────────────────────────────────────

// AI가 탐색할 인터랙티브 요소 선택자 목록
// hidden input, 비활성 disabled 요소는 포함하지 않습니다.
const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
].join(', ');

/**
 * 요소가 실제로 화면에 렌더링되어 있는지 확인합니다.
 * display:none, visibility:hidden, opacity:0, 렌더 트리 외 요소를 제외합니다.
 */
function isVisible(el) {
  const style = window.getComputedStyle(el);
  return (
    style.display    !== 'none'   &&
    style.visibility !== 'hidden' &&
    style.opacity    !== '0'      &&
    el.offsetParent  !== null
  );
}

/**
 * 현재 페이지의 인터랙티브 DOM 요소를 추출합니다.
 *
 * 반환 형태: { tag, id, ariaLabel, role, text, type }
 *  - text: innerText → value(input/select) → textContent 순으로 가져옴
 *  - 연속 공백은 단일 공백으로 정리
 *  - 최대 100개 제한 (서버 전송 페이로드 및 AI 토큰 비용 관리)
 */
function extractElements() {
  const nodes    = document.querySelectorAll(INTERACTIVE_SELECTORS);
  const elements = [];

  for (const node of nodes) {
    if (!isVisible(node)) continue;

    // 텍스트 내용 추출: 인풋은 value, 나머지는 innerText 우선
    const rawText = (
      node.innerText   ||
      node.value       ||
      node.textContent ||
      ''
    ).trim().replace(/\s+/g, ' ');

    elements.push({
      tag:       node.tagName.toLowerCase(),
      id:        node.id                         || '',
      ariaLabel: node.getAttribute('aria-label') || '',
      role:      node.getAttribute('role')       || '',
      text:      rawText.slice(0, 100),
      type:      node.getAttribute('type')       || '',
    });

    // 100개 도달 시 즉시 중단 (querySelectorAll 전체 순회 방지)
    if (elements.length >= 100) break;
  }

  return elements;
}

// ─── 메시지 리스너 ─────────────────────────────────────────────────────────────
// 사이드패널에서 보낸 GET_DOM 메시지를 수신하고 요소 배열을 응답합니다.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'GET_DOM') return;

  try {
    const elements = extractElements();
    sendResponse({ success: true, elements });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }

  return true; // sendResponse를 비동기로 호출하기 위한 채널 유지
});
