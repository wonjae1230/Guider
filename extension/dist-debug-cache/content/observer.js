// ─────────────────────────────────────────────────────────────────────────────
// URL 변경과 페이지 언로드를 감지하여 하이라이트를 초기화합니다.
//
// 감지 대상:
//  - SPA 라우팅: history.pushState / replaceState 직접 래핑
//    (이 메서드들은 이벤트를 발생시키지 않으므로 래핑이 필요합니다)
//  - 브라우저 뒤로/앞으로: popstate 이벤트
//  - 해시(#) 변경: hashchange 이벤트
//  - 일반 페이지 이동 / 새로고침: pagehide 이벤트
// ─────────────────────────────────────────────────────────────────────────────

// 현재 URL을 기억해 실제 변경 여부를 판단합니다.
let currentUrl = location.href;

/**
 * highlighter.js의 클래스명과 동일하게 유지합니다.
 * content script 간 직접 함수 호출이 불가하므로 DOM을 직접 정리합니다.
 */
const HIGHLIGHT_CLASS = 'guider-highlight';
const TOOLTIP_CLASS   = 'guider-tooltip';

/**
 * 페이지의 모든 하이라이트와 툴팁을 제거합니다.
 */
function clearHighlights() {
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_CLASS);
  });
  document.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(el => el.remove());
}

/**
 * URL 변경 시 실행됩니다.
 *
 * 동일 URL에서 재호출되는 경우(예: replaceState 반복)는 무시합니다.
 * 하이라이트를 초기화하고 사이드패널에 URL_CHANGED 메시지를 전송합니다.
 * 사이드패널은 이 메시지를 받아 이전 질문/응답 상태를 리셋할 수 있습니다.
 */
function onUrlChange() {
  if (location.href === currentUrl) return;
  currentUrl = location.href;

  clearHighlights();

  // 사이드패널이 열려 있지 않으면 sendMessage가 오류를 반환하므로 catch로 무시합니다.
  chrome.runtime.sendMessage({ type: 'URL_CHANGED', url: currentUrl }).catch(() => {});
}

// ─── SPA 라우팅 감지 ──────────────────────────────────────────────────────────
// history.pushState / replaceState는 별도 이벤트를 발생시키지 않습니다.
// 원본 함수를 래핑하여 호출 직후 URL 변경을 감지합니다.

const _originalPushState    = history.pushState.bind(history);
const _originalReplaceState = history.replaceState.bind(history);

history.pushState = function (...args) {
  _originalPushState(...args);
  onUrlChange();
};

history.replaceState = function (...args) {
  _originalReplaceState(...args);
  onUrlChange();
};

// ─── 브라우저 이벤트 기반 감지 ────────────────────────────────────────────────

// 브라우저 뒤로/앞으로 버튼 (popstate는 pushState와 달리 이벤트가 발생합니다)
window.addEventListener('popstate', onUrlChange);

// URL 해시(#anchor) 변경
window.addEventListener('hashchange', onUrlChange);

// 일반 페이지 이동 또는 새로고침 시 하이라이트 제거
// pagehide는 unload보다 신뢰도가 높고 BFCache와 호환됩니다.
window.addEventListener('pagehide', clearHighlights);
