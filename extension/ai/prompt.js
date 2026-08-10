// ─────────────────────────────────────────────────────────────────────────────
// 서버로 전송하기 전 DOM 요소를 정제하고, 민감 정보를 마스킹합니다.
// content script(domParser.js)가 추출한 원시 요소 배열을 입력으로 받습니다.
// ─────────────────────────────────────────────────────────────────────────────

// 텍스트에서 탐지할 민감 정보 패턴
// 서버로 데이터를 보내기 전 클라이언트 측에서 먼저 처리합니다.
const SENSITIVE_PATTERNS = [
  /\d{6}-\d{7}/g,               // 주민등록번호 (예: 900101-1234567)
  /\d{4}-\d{4}-\d{4}-\d{4}/g,  // 신용카드 번호 하이픈 포함 (예: 1234-5678-9012-3456)
  /\d{16}/g,                    // 신용카드 번호 하이픈 없음 (예: 1234567890123456)
];

/**
 * 문자열 내 민감 정보를 [MASKED]로 치환합니다.
 * 패턴이 없으면 원본 문자열을 그대로 반환합니다.
 */
function maskSensitiveText(text) {
  if (!text) return '';

  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[MASKED]');
  }
  return result;
}

/**
 * DOM 요소 배열을 서버 전송용으로 정제합니다.
 *
 * 정제 규칙:
 *  1. type="password" 인 input 필드 제외 (비밀번호 노출 방지)
 *  2. 최대 100개로 제한 (페이로드 크기 및 토큰 비용 관리)
 *  3. ariaLabel, text 필드의 민감 정보 마스킹
 *  4. text 길이 100자 초과분 제거 (불필요한 긴 텍스트 차단)
 *
 * @param {Array<{ tag: string, id: string, ariaLabel: string, role: string, text: string, type: string }>} rawElements
 * @returns {Array<{ tag: string, id: string, ariaLabel: string, role: string, text: string }>}
 */
export function prepareElements(rawElements) {
  return rawElements
    .filter(el => el.type !== 'password')       // 비밀번호 입력 필드 제외
    .slice(0, 100)                               // 최대 100개 제한
    .map(el => ({
      tag:       el.tag       || '',
      id:        el.id        || '',
      ariaLabel: maskSensitiveText(el.ariaLabel),
      role:      el.role      || '',
      text:      maskSensitiveText((el.text || '').slice(0, 100)),
    }));
}
