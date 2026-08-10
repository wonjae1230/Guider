require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const { connectRedis, getCache, setCache } = require('./cache');

const app    = express();
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '1mb' }));

<<<<<<< HEAD
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `당신은 웹 페이지 AI 가이드 도우미입니다.
사용자 질문, 페이지의 인터랙티브 DOM 요소 목록, 그리고 페이지 텍스트가 주어집니다.
아래 JSON 형식으로만 응답하세요.
=======
// ─── 모델 설정 ────────────────────────────────────────────────────────────────
// claude-sonnet-4-6: 정확도와 속도의 균형이 좋은 모델
// 한국어 의미 이해, 복잡한 UI 판단, 다단계 네비게이션 추론에 haiku보다 우수합니다.
const MODEL = 'claude-sonnet-4-6';

// ─── 시스템 프롬프트 ──────────────────────────────────────────────────────────
// 모든 요청에서 동일하게 사용되므로 cache_control: ephemeral 지정
// → Anthropic Prompt Caching이 활성화되어 반복 호출 시 비용·속도 개선
const SYSTEM_PROMPT = `You are an AI guide assistant for web pages.
You are given the user's question, page heading structure, a list of interactive DOM elements, and visible page text.
Respond ONLY with the following JSON format — no other text.
>>>>>>> main

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

function formatElements(elements) {
  return elements
<<<<<<< HEAD
      .map((el, i) => {
        const base = `${i + 1}. tag=${el.tag} id="${el.id}" aria-label="${el.ariaLabel}" role="${el.role}" text="${el.text}"`;
        if (el.visible === false) {
          const revealText = el.revealBy?.text || el.revealBy?.ariaLabel || el.revealBy?.id || '';
          return `${base} visible=false revealBy="${revealText}"`;
        }
        return base;
      })
      .join('\n');
=======
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
>>>>>>> main
}

app.post('/api/query', async (req, res) => {
  const { question, elements, url, pageText = '', headings = [] } = req.body;

  if (!question || !elements || !url) {
    return res.status(400).json({ error: '필수 파라미터(question, elements, url)가 누락되었습니다.' });
  }

  const cleanUrl = url.split('?')[0].split('#')[0];
  const normalizedQuestion = question.trim().replace(/\s+/g, ' ');
  const cacheKey = `guideline:${cleanUrl}::${normalizedQuestion}`;

  console.log('\n--------------------------------------------------');
  console.log('[요청 들어옴] Cache Key:', cacheKey);

  try {
    await connectRedis();
    const cached = await getCache(cacheKey);

    if (cached) {
      console.log('✅ [Cache Hit] 캐시된 데이터를 즉시 반환합니다.');
      return res.json({ ...cached, cached: true });
    }
    console.log('❌ [Cache Miss] 캐시 데이터 없음 -> Claude API 호출 시작');
  } catch (cacheError) {
    console.warn('[Cache 오류]:', cacheError.message);
  }

<<<<<<< HEAD
  let userMessage = `사용자 질문: ${question}\n\nDOM 요소 목록:\n${formatElements(elements)}`;
=======
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
>>>>>>> main
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
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: userMessage },
      ],
    });

    const rawText   = response.content[0].text.trim();
    const jsonText  = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    console.log('[Claude 응답]', jsonText.slice(0, 200));
    const result    = JSON.parse(jsonText);

    try {
      await setCache(cacheKey, result);
      console.log('💾 [Cache Save] 성공적으로 캐시에 저장되었습니다.');
    } catch (cacheError) {
      console.warn('[Cache 저장 실패]:', cacheError.message);
    }

    return res.json(result);

  } catch (apiError) {
    console.error('[Claude API 오류]:', apiError.message);
    return res.status(500).json({
      error:   'AI 응답 생성에 실패했습니다.',
      message: apiError.message,
    });
  }
});
// ─── 서버 시작 (index.js 맨 밑부분) ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await connectRedis();
    const server = app.listen(PORT, () => {
      console.log(`Guider 서버 실행 중 → http://localhost:${PORT}`);
      console.log('요청 대기 중... (서버가 켜져 있는 상태입니다)');
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ [오류] ${PORT}번 포트가 이미 사용 중입니다. 기존 프로세스를 종료하거나 포트를 변경하세요.`);
      } else {
        console.error('❌ [서버 실행 에러]:', err);
      }
    });
  } catch (err) {
    console.error('❌ [startServer 에러]:', err);
  }
}

startServer();