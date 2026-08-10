require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const { connectRedis, getCache, setCache } = require('./cache');

const app    = express();
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const MODEL = 'claude-haiku-4-5-20251001';

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

app.post('/api/query', async (req, res) => {
  const { question, elements, url, pageText = '' } = req.body;

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
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: userMessage },
      ],
    });

    const rawText   = response.content[0].text.trim();
    const jsonText  = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
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