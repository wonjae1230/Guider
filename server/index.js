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
const SYSTEM_PROMPT = `당신은 웹 페이지 AI 가이드 도우미입니다.
사용자 질문, 페이지의 인터랙티브 DOM 요소 목록, 그리고 페이지 텍스트가 주어집니다.
아래 JSON 형식으로만 응답하세요.

응답 형식:
{"type":"navigate","anchors":[{"id":"요소id","ariaLabel":"aria-label값","text":"요소텍스트"}],"reason":"한국어 안내 메시지"}

type 값 규칙:
- "navigate": 사용자가 클릭하거나 이동해야 하는 UI 요소를 찾은 경우. anchors에 해당 요소 포함.
- "found": 페이지 텍스트에서 정보를 직접 읽어 답변 가능한 경우(예: 이메일, 학점, 이름). anchors는 []. reason에 찾은 정보를 직접 답변.
- "notfound": 해당 기능이나 정보를 찾을 수 없는 경우. anchors는 []. reason에 이유 설명.

공통 규칙:
- anchors는 반드시 제공된 DOM 요소 목록에 있는 요소만 포함하세요
- anchors는 최대 3개까지만 반환하세요 (여러 단계가 필요한 경우 순서대로 나열)
- 요소 목록에 visible=false가 표시된 항목은 아코디언/드롭다운 메뉴 등으로 접혀 있어
  바로 클릭할 수 없는 상태입니다. 이런 요소를 목표로 고를 경우, 함께 표시된
  revealBy 요소를 anchors의 1번째로, 목표 요소를 2번째로 넣어 2단계로 안내하세요.
  revealBy가 없으면 해당 요소 대신 다른 방법을 찾거나 notfound로 응답하세요.
- 검색 기능 사용이나 외부 링크 이동은 절대 추천하지 마세요
- JSON 외의 텍스트는 절대 출력하지 마세요`;

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
      const base = `${i + 1}. tag=${el.tag} id="${el.id}" aria-label="${el.ariaLabel}" role="${el.role}" text="${el.text}"`;
      if (el.visible === false) {
        const revealText = el.revealBy?.text || el.revealBy?.ariaLabel || el.revealBy?.id || '';
        return `${base} visible=false revealBy="${revealText}"`;
      }
      return base;
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
  const { question, elements, url, pageText = '' } = req.body;

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
  // pageText가 있으면 정보 조회 질문(학점, 이름 등)에도 답할 수 있도록 함께 전달
  let userMessage = `사용자 질문: ${question}\n\nDOM 요소 목록:\n${formatElements(elements)}`;
  if (pageText) {
    userMessage += `\n\n페이지 텍스트 (이미 화면에 표시된 정보):\n${pageText}`;
  }

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
    // 모델이 간혹 ```json ... ``` 마크다운 블록으로 감싸는 경우를 제거합니다.
    const rawText   = response.content[0].text.trim();
    const jsonText  = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
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
