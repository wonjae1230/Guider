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
// claude-haiku-4-5: Claude 패밀리 중 가장 빠른 모델
// 응답 속도 우선, 구조화된 JSON 출력 신뢰도 높음
const MODEL = 'claude-haiku-4-5-20251001';

// ─── 시스템 프롬프트 ──────────────────────────────────────────────────────────
// 모든 요청에서 동일하게 사용되므로 cache_control: ephemeral 지정
// → Anthropic Prompt Caching이 활성화되어 반복 호출 시 비용·속도 개선
const SYSTEM_PROMPT = `당신은 웹 페이지 UI 가이드 도우미입니다.
사용자 질문과 페이지의 인터랙티브 DOM 요소 목록이 주어집니다.
사용자가 원하는 작업을 수행할 수 있는 UI 요소를 찾아 아래 JSON 형식으로만 응답하세요.

응답 형식:
{"anchors":[{"id":"요소id","ariaLabel":"aria-label값","text":"요소텍스트"}],"reason":"한국어 안내 메시지"}

규칙:
- anchors는 반드시 제공된 DOM 요소 목록에 있는 요소만 포함하세요
- anchors는 최대 3개까지만 반환하세요 (여러 단계가 필요한 경우 순서대로 나열)
- 해당 기능을 찾을 수 없으면 anchors를 []로, reason에 찾지 못한 이유와 안내를 작성하세요
- 검색 기능 사용이나 외부 링크 이동은 절대 추천하지 마세요
- JSON 외의 텍스트는 절대 출력하지 마세요`;

// ─── 유틸 함수 ────────────────────────────────────────────────────────────────

/**
 * DOM 요소 배열을 Claude 프롬프트에 삽입할 번호 목록 문자열로 변환합니다.
 *
 * 예시 출력:
 *   1. tag=a id="menu-link" aria-label="수강신청" role="" text="수강신청"
 *   2. tag=button id="" aria-label="" role="button" text="로그인"
 */
function formatElements(elements) {
  return elements
    .map(
      (el, i) =>
        `${i + 1}. tag=${el.tag} id="${el.id}" aria-label="${el.ariaLabel}" role="${el.role}" text="${el.text}"`,
    )
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
  const { question, elements, url } = req.body;

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
  const userMessage = `사용자 질문: ${question}\n\nDOM 요소 목록:\n${formatElements(elements)}`;

  try {
    const response = await claude.messages.create({
      model:      MODEL,
      max_tokens: 512,
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
    const rawText = response.content[0].text.trim();
    const result  = JSON.parse(rawText);

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
