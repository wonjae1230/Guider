// ─────────────────────────────────────────────────────────────────────────────
// Guider 백엔드 서버
//
// 역할: 크롬 익스텐션 → Claude API 사이의 프록시
//  - API 키를 서버에서만 보유 (익스텐션에 노출 금지)
//  - Redis로 동일 URL + 질문 응답 캐시 (LLM 중복 호출 방지)
//  - Prompt Caching으로 시스템 프롬프트 토큰 비용 절감
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const { connectRedis, getCache, setCache } = require('./cache');

const app    = express();
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── 모델 설정 ────────────────────────────────────────────────────────────────
// claude-sonnet-4-6: 정확도와 속도의 균형이 좋은 모델
// 한국어 의미 이해, 복잡한 UI 판단, 다단계 네비게이션 추론에 haiku보다 우수합니다.
const MODEL = 'claude-sonnet-5';

// ─── 시스템 프롬프트 ──────────────────────────────────────────────────────────
// 모든 요청에서 동일하게 사용되므로 cache_control: ephemeral 지정
// → Anthropic Prompt Caching이 활성화되어 반복 호출 시 비용·속도 개선
const SYSTEM_PROMPT = `You are an AI guide assistant for web pages.
You are given the user's question, page heading structure, a list of interactive DOM elements, and visible page text.
Respond ONLY with the following JSON format — no other text.

Response format:
{"type":"navigate","anchors":[{"id":"element-id","ariaLabel":"aria-label value","text":"element text"}],"reason":"Korean guidance message"}

Type rules:
- "navigate": Found UI elements the user needs to click or navigate to. Include them in anchors.
- "found": The answer can be read directly from page text (e.g. email, grade, name). Set anchors to []. Put the answer directly in reason.
- "notfound": The feature or information cannot be found. Set anchors to []. Explain why in reason.

Rules:
- anchors must only contain elements that exist in the provided DOM element list
- anchors may contain at most 3 elements; list them in order if multiple steps are needed
- Elements marked [hidden menu] are currently invisible dropdown/submenu items. If such an element is the destination, put its visible parent menu first in anchors, then the hidden item.
- Elements marked [hidden menu: click "X" first] require clicking X to reveal them. Put X first in anchors, then the target element.
- When the user's question and UI labels differ (e.g. "grade" → "성적현황", "my info" → "마이페이지"), choose the semantically closest element.
- Never recommend using a search function or navigating to an external link.
- The "reason" field must always be written in Korean.
- Output JSON only — absolutely no other text.`;

// ─── 유틸 함수 ────────────────────────────────────────────────────────────────

/**
 * DOM 요소 배열을 Claude 프롬프트에 삽입할 번호 목록 문자열로 변환합니다.
 *
 * 예시 출력:
 *   1. tag=a id="menu-link" aria-label="수강신청" role="" text="수강신청"
 *   2. tag=button id="" aria-label="" role="button" text="로그인"
 *   3. tag=a id="grade-link" aria-label="" role="" text="금학기성적조회" visible=false revealBy="성적정보"
 */
function formatElements(elements) {
  return elements
    .map((el, i) => {
      let note = '';
      if (el.visible === false) {
        note = el.revealBy?.text
          ? ` [hidden menu: click "${el.revealBy.text}" first]`
          : ' [hidden menu]';
      } else if (el.hidden) {
        // 구버전 호환
        note = ' [hidden menu]';
      }
      return `${i + 1}. tag=${el.tag} id="${el.id}" aria-label="${el.ariaLabel}" role="${el.role}" text="${el.text}"${note}`;
    })
    .join('\n');
}

// ─── /api/query 엔드포인트 ────────────────────────────────────────────────────

/**
 * POST /api/query
 *
 * Body: { question: string, elements: Array, url: string }
 *
 * 처리 흐름:
 *  1. 필수 파라미터 검증
 *  2. Redis에서 캐시 조회 (url + question 조합)
 *  3. 캐시 없으면 Claude API 호출
 *  4. 응답을 JSON 파싱 후 Redis에 저장
 *  5. 결과 반환
 */
app.post('/api/query', async (req, res) => {
  const { question, elements, url, pageText = '', headings = [] } = req.body;

  // 필수 파라미터 누락 검사
  if (!question || !elements || !url) {
    return res.status(400).json({ error: '필수 파라미터(question, elements, url)가 누락되었습니다.' });
  }

  // 캐시 키: URL + 질문 조합
  // 페이지가 바뀌면 URL이 달라지므로 캐시가 자동으로 무효화됩니다.
  const cacheKey = `${url}::${question}`;

  // ── 1단계: Redis 캐시 조회 ──────────────────────────────────────────────────
  try {
    await connectRedis();
    const cached = await getCache(cacheKey);

    if (cached) {
      console.log(`[캐시 히트] ${cacheKey.slice(0, 80)}...`);
      return res.json({ ...cached, cached: true });
    }
  } catch (cacheError) {
    // 캐시 장애는 치명적이지 않으므로 경고만 출력하고 API 호출로 이어갑니다.
    console.warn('[캐시] Redis 조회 실패, Claude API로 계속 진행합니다:', cacheError.message);
  }

  // ── 2단계: Claude API 호출 ─────────────────────────────────────────────────
  console.log(`[쿼리] "${question}" | 요소 ${elements.length}개 | ${url.slice(0, 60)}`);
  const gradeEl = elements.filter(el => el.text?.includes('성적') || el.text?.includes('grade'));
  if (gradeEl.length) console.log('[성적 관련 요소]', gradeEl.map(e => e.text));

  let userMessage = `사용자 질문: ${question}\n\n`;

  // 페이지 헤딩 구조: AI가 페이지 섹션을 이해해 "학점 → 성적현황" 같은 의미 매핑을 잘 하도록 돕습니다.
  if (headings.length > 0) {
    userMessage += `페이지 구조:\n${headings.join('\n')}\n\n`;
  }

  userMessage += `인터랙티브 요소 목록:\n${formatElements(elements)}`;

  // 페이지 텍스트: 이미 화면에 표시된 정보(학점, 이메일 등) 조회 질문 대응
  if (pageText) {
    userMessage += `\n\n페이지 텍스트 (현재 화면에 표시된 정보):\n${pageText}`;
  }

  try {
    const response = await claude.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system: [
        {
          type:          'text',
          text:          SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }, // 시스템 프롬프트 캐시 활성화
        },
      ],
      messages: [
        { role: 'user', content: userMessage },
      ],
    });

    // Claude가 반환한 텍스트를 JSON으로 파싱
    // 모델이 간혹 ```json ... ``` 마크다운 블록으로 감싸는 경우를 제거합니다.
    const rawText   = response.content[0].text.trim();
    const jsonText  = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    console.log('[Claude 응답]', jsonText.slice(0, 200));
    const result    = JSON.parse(jsonText);

    // ── 3단계: 결과 Redis에 저장 ──────────────────────────────────────────────
    try {
      await setCache(cacheKey, result);
    } catch (cacheError) {
      console.warn('[캐시] Redis 저장 실패:', cacheError.message);
    }

    return res.json(result);

  } catch (apiError) {
    // JSON 파싱 실패 또는 Claude API 오류
    console.error('[Claude API] 오류:', apiError.message);
    return res.status(500).json({
      error:   'AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.',
      message: apiError.message,
    });
  }
});

// ─── 서버 시작 ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Guider 서버 실행 중 → http://localhost:${PORT}`);
});
