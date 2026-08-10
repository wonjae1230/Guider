// ─────────────────────────────────────────────────────────────────────────────
// 위젯 전용 AI 헬퍼
//
// 위젯은 content script로 실행되므로 chrome.tabs API를 사용할 수 없습니다.
// URL은 window.location.href로 직접 가져오고, DOM도 document에 직접 접근합니다.
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_URL     = 'http://localhost:3000';
const HIGHLIGHT_CLASS = 'guider-hl';
const TOOLTIP_CLASS   = 'guider-tt';
const HL_COLOR        = '#7b2ff7';

// ─── 민감정보 마스킹 ──────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\d{6}-\d{7}/g,               // 주민등록번호
  /\d{4}-\d{4}-\d{4}-\d{4}/g,  // 카드번호 (하이픈 포함)
  /\d{16}/g,                    // 카드번호 (하이픈 없음)
];

function maskText(text) {
  if (!text) return '';
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[MASKED]');
  }
  return result;
}

// ─── 가시성 체크 ──────────────────────────────────────────────────────────────

// iframe 요소는 해당 iframe의 contentWindow를 넘겨야 올바른 스타일을 가져옵니다.
function isVisible(el, win = window) {
  try {
    const s = win.getComputedStyle(el);
    return (
      s.display    !== 'none'   &&
      s.visibility !== 'hidden' &&
      s.opacity    !== '0'      &&
      el.offsetParent !== null
    );
  } catch {
    return true;
  }
}

// ─── 선택자 ───────────────────────────────────────────────────────────────────

// 일반 인터랙티브 요소 선택자
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[tabindex="0"]:not(body)',
].join(', ');

// 네비게이션 전용 선택자 - 숨겨진 드롭다운·서브메뉴도 포함하기 위해 별도로 관리
// 한국 사이트에서 자주 쓰이는 .gnb, .lnb, .snb, .depth 등의 클래스 패턴을 포함합니다.
const NAV_SELECTOR = [
  'nav a', 'nav button',
  '[role="navigation"] a', '[role="navigation"] button',
  'header a', 'header button',
  '[class*="gnb"] a', '[class*="gnb"] button',
  '[class*="lnb"] a', '[class*="lnb"] button',
  '[class*="snb"] a', '[class*="snb"] button',
  '[class*="depth"] a', '[class*="depth"] button',
  '[class*="menu"] a', '[class*="menu"] button',
  '[class*="nav"] a',  '[class*="nav"] button',
  '[id*="gnb"] a',    '[id*="gnb"] button',
  '[id*="lnb"] a',    '[id*="lnb"] button',
  '[id*="menu"] a',   '[id*="menu"] button',
  '[id*="nav"] a',    '[id*="nav"] button',
].join(', ');

// ─── 키워드 추출 및 관련도 점수 ───────────────────────────────────────────────

const STOP_WORDS = new Set([
  // 조사
  '이', '가', '을', '를', '은', '는', '의', '에', '서', '로', '와', '과', '도', '만',
  '에서', '으로', '한테', '에게', '부터', '까지',
  // 접속사
  '그리고', '하지만', '그런데', '그래서', '또한', '그러면', '그러나',
  // 흔한 동사·형용사 어미
  '싶어', '싶은데', '있어', '없어', '해줘', '해주세요', '알려줘', '봐줘',
  '보고', '찾아', '알고싶어', '궁금해', '궁금한데', '하면', '되는', '있나요', '있어요',
  // 의문사
  '어떻게', '어디서', '어디', '뭐야', '뭐', '어떤', '무엇', '언제', '어때',
]);

function extractKeywords(question) {
  return question
    .replace(/[^\w\s가-힣]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}

// 키워드와 요소의 관련도 점수화
// 양방향 포함 체크: 키워드가 요소 텍스트를 포함하거나, 요소 텍스트가 키워드를 포함
// 예) 키워드 "로그인하려면" → 요소 "로그인" 매칭 (kwLow.includes(word))
//     키워드 "학점"        → 요소 "학점조회" 매칭 (word.includes(kwLow))
function scoreElement(el, keywords) {
  if (!keywords.length) return 0;
  const words = `${el.text} ${el.ariaLabel} ${el.id}`
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 2);
  let score = 0;
  for (const kw of keywords) {
    const kwLow = kw.toLowerCase();
    for (const word of words) {
      if (word.includes(kwLow) || kwLow.includes(word)) {
        score += 1;
        break; // 같은 키워드로 중복 점수 방지
      }
    }
  }
  return score;
}

// ─── DOM 요소 추출 ────────────────────────────────────────────────────────────

function nodeToElement(node, hidden = false) {
  const rawText = (node.innerText || node.value || node.textContent || '')
    .trim()
    .replace(/\s+/g, ' ');
  return {
    tag:       node.tagName.toLowerCase(),
    id:        node.id                       || '',
    ariaLabel: maskText(node.getAttribute('aria-label')),
    role:      node.getAttribute('role')     || '',
    text:      maskText(rawText.slice(0, 100)),
    type:      node.getAttribute('type')     || '',
    hidden,     // true이면 현재 화면에 보이지 않는 숨겨진 메뉴 항목
  };
}

/**
 * 현재 페이지(+ same-origin iframe)의 인터랙티브 요소를 추출합니다.
 *
 * 개선 사항:
 *  1. 키워드 관련도 순 정렬: 질문과 관련 있는 요소가 항상 앞에 배치됩니다.
 *  2. 숨겨진 네비게이션 포함: 드롭다운·서브메뉴 등 isVisible 체크를 통과 못 하는
 *     nav/menu 영역 요소도 [숨겨진 메뉴]로 표시하여 AI에 전달합니다.
 *  3. same-origin iframe 지원: 구형 포털(대학 사이트 등) 대응.
 */
export function extractElements(question = '') {
  const keywords = extractKeywords(question);
  const seen     = new Set();
  const elements = [];

  function makeKey(node) {
    return `${node.tagName}|${node.id}|${(node.innerText || node.value || '').slice(0, 40)}`;
  }

  function addFromDoc(doc, win) {
    // 1단계: nav/메뉴 영역 - 숨겨진 것도 포함
    for (const node of doc.querySelectorAll(NAV_SELECTOR)) {
      if (node.getAttribute('type') === 'password') continue;
      const key = makeKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(nodeToElement(node, !isVisible(node, win)));
    }

    // 2단계: 일반 가시적 인터랙티브 요소
    for (const node of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (!isVisible(node, win))                    continue;
      if (node.getAttribute('type') === 'password') continue;
      const key = makeKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(nodeToElement(node, false));
    }
  }

  addFromDoc(document, window);

  // same-origin iframe 내부도 추출
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const iDoc = iframe.contentDocument;
      const iWin = iframe.contentWindow;
      if (iDoc && iWin) addFromDoc(iDoc, iWin);
    } catch {
      // cross-origin SecurityError 무시
    }
  }

  // 관련도 점수 기준 정렬
  // 높은 점수 → 가시적 요소 → 숨겨진 메뉴 순
  elements.sort((a, b) => {
    const sA = scoreElement(a, keywords);
    const sB = scoreElement(b, keywords);
    if (sA !== sB) return sB - sA;
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    return 0;
  });

  return elements.slice(0, 150);
}

/**
 * 페이지의 헤딩(h1~h3) 구조를 추출합니다.
 * AI가 페이지 섹션 구조를 이해하여 더 정확하게 요소를 찾을 수 있게 돕습니다.
 */
export function extractHeadings() {
  const headings = [];
  const docs = [document];

  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      if (iframe.contentDocument) docs.push(iframe.contentDocument);
    } catch {}
  }

  for (const doc of docs) {
    for (const el of doc.querySelectorAll('h1, h2, h3')) {
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) headings.push(`${el.tagName}: ${text.slice(0, 80)}`);
    }
  }

  return headings.slice(0, 20);
}

/**
 * 페이지 텍스트를 추출합니다.
 * 이미 화면에 표시된 정보(학점, 이메일 등)를 AI가 직접 읽어 답할 수 있게 합니다.
 */
export function extractPageText() {
  function getTextFromDoc(doc) {
    const area = doc.querySelector('main, #content, .content, #main, table') || doc.body;
    if (!area) return '';
    return maskText((area.innerText || area.textContent || '').replace(/\s+/g, ' ').trim());
  }

  const parts = [getTextFromDoc(document)];

  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const iDoc = iframe.contentDocument;
      if (iDoc) parts.push(getTextFromDoc(iDoc));
    } catch {}
  }

  return parts.join('\n').slice(0, 3000);
}

// ─── AI 호출 ─────────────────────────────────────────────────────────────────

export async function callAI(question, elements, pageText = '', headings = []) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${BACKEND_URL}/api/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        question,
        elements,
        pageText,
        headings,
        url: window.location.href,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `서버 오류 (HTTP ${response.status})`);
    }

    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 하이라이트 ───────────────────────────────────────────────────────────────

// 활성 MutationObserver 목록 — clearHighlights 호출 시 일괄 해제
const _activeObservers = [];

function ensureHighlightStyles() {
  if (document.getElementById('guider-hl-styles')) return;

  const style = document.createElement('style');
  style.id    = 'guider-hl-styles';
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid ${HL_COLOR} !important;
      outline-offset: 2px            !important;
      background-color: rgba(123, 47, 247, 0.1) !important;
      transition: outline 0.15s ease !important;
    }
    .${TOOLTIP_CLASS} {
      position:      fixed;
      background:    ${HL_COLOR};
      color:         #fff;
      padding:       4px 10px;
      border-radius: 6px;
      font-size:     12px;
      font-weight:   600;
      font-family:   -apple-system, BlinkMacSystemFont, sans-serif;
      white-space:   nowrap;
      z-index:       2147483646;
      pointer-events: none;
      box-shadow:    0 2px 8px rgba(0,0,0,0.15);
    }
  `;
  document.head.appendChild(style);
}

// 요소에 하이라이트 클래스와 툴팁을 추가합니다.
function addHighlight(el, label) {
  el.classList.add(HIGHLIGHT_CLASS);

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return; // 실제 크기 없으면 툴팁 생략

  const tooltip = document.createElement('div');
  tooltip.className   = TOOLTIP_CLASS;
  tooltip.textContent = label;
  tooltip.style.top   = rect.top > 40 ? `${rect.top - 32}px` : `${rect.bottom + 6}px`;
  tooltip.style.left  = `${rect.left}px`;
  document.body.appendChild(tooltip);
}

// 숨겨진 요소의 DOM 트리를 올라가며 가시적이고 인터랙티브한 트리거 요소를 찾습니다.
// 예: display:none 서브메뉴 항목 → 그것을 열어주는 상위 메뉴 버튼
function findVisibleTrigger(hiddenEl) {
  let current = hiddenEl.parentElement;
  while (current && current !== document.body) {
    if (isVisible(current)) {
      if (current.matches('a, button, [role="button"], [tabindex]')) return current;
      const child = current.querySelector('a, button, [role="button"]');
      if (child && isVisible(child)) return child;
    }
    current = current.parentElement;
  }
  return null;
}

function findElement(anchor) {
  const CANDIDATES = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"]';

  if (anchor.id) {
    const el = document.getElementById(anchor.id);
    if (el) return el;
  }
  if (anchor.ariaLabel) {
    const el = document.querySelector(`[aria-label="${CSS.escape(anchor.ariaLabel)}"]`);
    if (el) return el;
  }
  if (anchor.text) {
    const candidates = [...document.querySelectorAll(CANDIDATES)];
    // 1. 가시적 요소 — 정확히 일치
    for (const el of candidates) {
      if (isVisible(el) && (el.innerText || el.value || '').trim() === anchor.text) return el;
    }
    // 2. 가시적 요소 — 포함 관계
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || el.value || '').trim();
      if (t && anchor.text.includes(t)) return el;
    }
    // 3. 숨겨진 요소 중 트리거가 있는 것 우선 (모바일 메뉴처럼 트리거가 없는 요소보다 데스크톱 드롭다운 선호)
    for (const el of candidates) {
      const t = (el.innerText || el.value || '').trim();
      if (t === anchor.text && !isVisible(el) && findVisibleTrigger(el) !== null) return el;
    }
    // 4. 숨겨진 요소 — 마지막 폴백
    for (const el of candidates) {
      if ((el.innerText || el.value || '').trim() === anchor.text) return el;
    }
  }
  return null;
}

/**
 * anchors 배열의 각 요소를 탐색해 하이라이트하고 툴팁을 표시합니다.
 *
 * 가시적 요소: 바로 하이라이트합니다.
 * 숨겨진 요소(드롭다운 등): 상위 트리거를 먼저 하이라이트하고,
 *   MutationObserver로 요소가 보이기 시작하면 자동으로 하이라이트를 전환합니다.
 */
export function highlightAnchors(anchors) {
  clearHighlights();
  ensureHighlightStyles();

  let scrollTarget = null;

  anchors.forEach((anchor, i) => {
    const el = findElement(anchor);
    if (!el) return;

    const label = anchors.length > 1 ? `Step ${i + 1}` : '여기를 찾아보세요';

    if (isVisible(el)) {
      addHighlight(el, label);
      if (!scrollTarget) scrollTarget = el;
    } else {
      // 숨겨진 요소: 상위 트리거를 먼저 하이라이트
      const trigger = findVisibleTrigger(el);
      if (trigger) {
        addHighlight(trigger, label);
        if (!scrollTarget) scrollTarget = trigger;
      }

      // 요소가 보이기 시작하면 트리거 → 실제 요소로 하이라이트 전환
      const obs = new MutationObserver(() => {
        if (!isVisible(el)) return;
        obs.disconnect();
        if (trigger) trigger.classList.remove(HIGHLIGHT_CLASS);
        document.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(t => t.remove());
        addHighlight(el, label);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      obs.observe(document.body, {
        attributes:      true,
        subtree:         true,
        attributeFilter: ['style', 'class'],
      });

      _activeObservers.push(obs);
      setTimeout(() => obs.disconnect(), 30_000); // 30초 후 자동 해제
    }
  });

  scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * 모든 하이라이트, 툴팁, MutationObserver를 제거합니다.
 */
export function clearHighlights() {
  _activeObservers.forEach(obs => obs.disconnect());
  _activeObservers.length = 0;

  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_CLASS);
  });
  document.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(el => el.remove());
}
