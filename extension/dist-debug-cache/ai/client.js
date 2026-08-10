// ─────────────────────────────────────────────────────────────────────────────
// 백엔드 /api/query 엔드포인트를 호출하여 AI 응답을 받아옵니다.
// 캐시 처리(동일 URL + 질문 중복 방지)는 서버(Redis)에서 수행합니다.
// ─────────────────────────────────────────────────────────────────────────────

// 백엔드 서버 주소
// 배포 환경에서는 실제 서버 URL로 교체합니다.
const BACKEND_URL = 'http://localhost:3000';

// 단일 요청 최대 대기 시간 (ms)
// 이 시간이 지나면 AbortController가 요청을 강제 취소합니다.
const REQUEST_TIMEOUT_MS = 10_000;

// 타임아웃 발생 시 최대 재시도 횟수
// 사양: "API 타임아웃 시 재시도 1회"
const MAX_RETRIES = 1;

// 재시도 전 대기 시간 (ms)
const RETRY_DELAY_MS = 500;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 타임아웃이 적용된 fetch 래퍼입니다.
 *
 * AbortController를 이용해 지정된 시간이 지나면 요청을 자동 취소합니다.
 * finally 블록에서 타이머를 반드시 해제해 메모리 누수를 방지합니다.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AI 쿼리를 백엔드로 전송하고 결과를 반환합니다.
 *
 * 흐름:
 *  1. 백엔드 /api/query에 POST 요청
 *  2. 타임아웃 또는 오류 발생 시 MAX_RETRIES 횟수만큼 재시도
 *  3. 재시도도 실패하면 마지막 오류를 throw
 *
 * 응답 예시:
 *  { anchors: [{ id, ariaLabel, text }], reason: "안내 메시지", cached: true }
 *
 * @param {string} question   사용자 자연어 질문
 * @param {Array}  elements   prepareElements()로 정제된 DOM 요소 목록
 * @param {string} url        현재 페이지 URL (서버에서 캐시 키로 사용)
 * @returns {Promise<{ anchors: Array, reason: string }>}
 * @throws {Error} 모든 재시도가 실패했을 때
 */
export async function queryAI(question, elements, url) {
  const requestOptions = {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ question, elements, url }),
  };

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_URL}/api/query`,
        requestOptions,
        REQUEST_TIMEOUT_MS,
      );

      // HTTP 레벨 오류 처리 (4xx, 5xx)
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `서버 오류 (HTTP ${response.status})`);
      }

      return await response.json();

    } catch (error) {
      // AbortController 취소는 사용자 친화적 메시지로 변환
      lastError = error.name === 'AbortError'
        ? new Error('요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.')
        : error;

      // 마지막 시도가 아니면 잠시 대기 후 재시도
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  // 모든 재시도 소진 → 마지막 오류 전파
  throw lastError;
}
