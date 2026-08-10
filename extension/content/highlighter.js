// ─────────────────────────────────────────────────────────────────────────────
// AI 응답의 anchors를 기반으로 DOM 요소를 찾아 하이라이트합니다.
//
// 하이라이트 색상은 페이지 대표색의 보색을 동적으로 계산하여 사용합니다.
// 탐색 폴백 전략: id → aria-label → text 정확 일치 → text 부분 일치
// ─────────────────────────────────────────────────────────────────────────────

const HIGHLIGHT_CLASS = 'guider-highlight';
const TOOLTIP_CLASS   = 'guider-tooltip';

// 대표색을 찾지 못했을 때 사용하는 기본 색상 (인디고)
const FALLBACK_COLOR = { solid: '#6366f1', alpha: 'rgba(99, 102, 241, 0.12)', text: '#ffffff' };

// ─────────────────────────────────────────────────────────────────────────────
// 1. 페이지 대표색 추출
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 배경색이 투명인지 확인합니다.
 * CSS는 투명을 rgba(0, 0, 0, 0) 또는 'transparent'로 표현합니다.
 */
function isTransparent(color) {
  return !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
}

/**
 * 현재 페이지의 대표색(브랜드 컬러)을 추출합니다.
 *
 * 탐색 순서:
 *  1. <meta name="theme-color"> — 가장 명시적인 대표색
 *  2. CSS 커스텀 변수 — 디자인 시스템에서 사용하는 토큰
 *  3. 헤더 / 네비게이션 배경색 — 대부분의 사이트에서 브랜드 색상 적용
 *
 * @returns {string|null} CSS 색상 문자열 또는 null
 */
function extractPrimaryColor() {
  // 1순위: meta theme-color
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme?.content) return metaTheme.content;

  // 2순위: CSS 커스텀 변수 (디자인 시스템 토큰 이름 공통 패턴)
  const rootStyle = getComputedStyle(document.documentElement);
  const cssVarNames = [
    '--primary', '--primary-color', '--brand-color',
    '--accent-color', '--color-primary', '--main-color', '--theme-color',
  ];
  for (const varName of cssVarNames) {
    const value = rootStyle.getPropertyValue(varName).trim();
    if (value) return value;
  }

  // 3순위: 헤더 / 네비게이션 배경색
  // 한국 대학 포털에서 자주 쓰이는 클래스명(.gnb, .lnb)도 포함합니다.
  const navSelectors = [
    'header', 'nav',
    '.header', '.navbar', '.nav', '.gnb', '.lnb',
    '#header', '#nav', '#gnb',
  ];
  for (const selector of navSelectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const bg = getComputedStyle(el).backgroundColor;
    if (!isTransparent(bg)) return bg;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 색상 변환 수학 (RGB ↔ HSL)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CSS 색상 문자열을 {r, g, b} 객체로 파싱합니다.
 * 지원 형식: rgb(), rgba(), #RGB, #RRGGBB
 */
function parseColor(color) {
  if (!color) return null;

  // rgb(r, g, b) 또는 rgba(r, g, b, a)
  const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] };
  }

  // #RGB → #RRGGBB 로 확장 후 파싱
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
  }

  return null;
}

/**
 * RGB → HSL 변환
 * H: 0~360 (색상각), S: 0~100 (채도), L: 0~100 (명도)
 */
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l   = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6;               break;
    case b: h = ((r - g) / d + 4) / 6;               break;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * HSL → RGB 변환
 */
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;

  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h)         * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 보색 계산 및 하이라이트 색상 결정
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 대표색의 보색을 계산합니다.
 *
 * 보색 = 색상환(HSL)에서 H 값을 180도 회전
 *
 * 가시성 보정:
 *  - 채도 < 10% (무채색): 보색이 무의미하므로 null 반환 → 폴백 사용
 *  - 명도 > 88% (거의 흰색) 또는 < 12% (거의 검정): 폴백 사용
 *  - 보색 채도: 원본 채도 또는 최소 65% 중 큰 값 (선명하게 보이도록)
 *  - 보색 명도: 42~56% 범위로 고정 (어두운 배경/밝은 배경 모두에서 가시성 확보)
 *
 * @param {string} color CSS 색상 문자열
 * @returns {{ solid: string, alpha: string, text: string }|null}
 */
function getComplementaryColor(color) {
  const rgb = parseColor(color);
  if (!rgb) return null;

  const hsl = rgbToHsl(rgb);

  // 무채색 또는 극단적 명도 → 보색 계산 의미 없음
  if (hsl.s < 10 || hsl.l > 88 || hsl.l < 12) return null;

  const compH = (hsl.h + 180) % 360;
  const compS = Math.max(hsl.s, 65);              // 최소 채도 65% 보장
  const compL = Math.max(42, Math.min(56, hsl.l)); // 명도 42~56% 범위로 고정

  const { r, g, b } = hslToRgb(compH, compS, compL);

  // 툴팁 텍스트 색상: 보색 명도가 높으면 어두운 텍스트, 낮으면 흰색
  const textColor = compL > 52 ? '#1a1a1a' : '#ffffff';

  return {
    solid: `rgb(${r}, ${g}, ${b})`,
    alpha: `rgba(${r}, ${g}, ${b}, 0.12)`,
    text:  textColor,
  };
}

/**
 * 페이지 대표색 추출 → 보색 계산 → 하이라이트 색상 확정
 * document_idle 타이밍에 DOM이 준비된 상태에서 실행됩니다.
 */
function computeHighlightColor() {
  const primary    = extractPrimaryColor();
  const complement = primary ? getComplementaryColor(primary) : null;
  return complement ?? FALLBACK_COLOR;
}

// 페이지 로드 시 한 번만 계산하고 캐시합니다.
const COLORS = computeHighlightColor();

// ─────────────────────────────────────────────────────────────────────────────
// 4. 스타일 주입
// ─────────────────────────────────────────────────────────────────────────────

// 계산된 보색을 CSS로 주입합니다. id 체크로 중복 삽입을 방지합니다.
(function injectStyles() {
  if (document.getElementById('guider-styles')) return;

  const style = document.createElement('style');
  style.id = 'guider-styles';
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid ${COLORS.solid} !important;
      outline-offset: 2px               !important;
      background-color: ${COLORS.alpha} !important;
      transition: outline 0.15s ease    !important;
    }
    .${TOOLTIP_CLASS} {
      position:      fixed;
      background:    ${COLORS.solid};
      color:         ${COLORS.text};
      padding:       4px 10px;
      border-radius: 6px;
      font-size:     12px;
      font-weight:   600;
      font-family:   -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      white-space:   nowrap;
      z-index:       2147483647;
      pointer-events: none;
      box-shadow:    0 2px 8px rgba(0, 0, 0, 0.15);
    }
  `;
  document.head.appendChild(style);
})();

// ─────────────────────────────────────────────────────────────────────────────
// 5. 요소 탐색
// ─────────────────────────────────────────────────────────────────────────────

/**
 * anchor 객체로 DOM 요소를 탐색합니다.
 *
 * 폴백 순서:
 *  1. id 속성 (신뢰도 최상)
 *  2. aria-label 속성
 *  3. text content 정확 일치
 *  4. text content 부분 일치 (AI가 반환한 text가 잘린 경우 대응)
 */
function findElement(anchor) {
  if (anchor.id) {
    const el = document.getElementById(anchor.id);
    if (el) return el;
  }

  if (anchor.ariaLabel) {
    const el = document.querySelector(`[aria-label="${CSS.escape(anchor.ariaLabel)}"]`);
    if (el) return el;
  }

  if (anchor.text) {
    const candidates = document.querySelectorAll(
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"]',
    );

    // 정확 일치 우선
    for (const el of candidates) {
      const elText = (el.innerText || el.value || '').trim();
      if (elText === anchor.text) return el;
    }

    // 부분 일치 폴백
    for (const el of candidates) {
      const elText = (el.innerText || el.value || '').trim();
      if (elText && anchor.text.includes(elText)) return el;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 하이라이트 적용 / 제거
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 요소 근처에 단계 표시 툴팁을 표시합니다.
 * position:fixed를 사용해 페이지 레이아웃에 영향을 주지 않습니다.
 * 요소가 뷰포트 상단에 붙어 있으면 아래쪽에 표시합니다.
 */
function addTooltip(el, label) {
  const rect = el.getBoundingClientRect();

  const tooltip = document.createElement('div');
  tooltip.className  = TOOLTIP_CLASS;
  tooltip.textContent = label;

  const showBelow = rect.top < 40;
  tooltip.style.top  = showBelow ? `${rect.bottom + 6}px` : `${rect.top - 32}px`;
  tooltip.style.left = `${rect.left}px`;

  document.body.appendChild(tooltip);
}

/**
 * anchors 배열의 각 요소를 탐색해 하이라이트하고 툴팁을 표시합니다.
 * 여러 단계가 있으면 "Step 1/2/3" 순서로 표시합니다.
 * 첫 번째로 찾은 요소로 부드럽게 스크롤합니다.
 *
 * @returns {number} 실제로 찾아 하이라이트된 요소 수
 */
function highlightAnchors(anchors) {
  let foundCount   = 0;
  let scrollTarget = null;

  anchors.forEach((anchor, index) => {
    const el = findElement(anchor);
    if (!el) return;

    el.classList.add(HIGHLIGHT_CLASS);

    const label = anchors.length > 1 ? `Step ${index + 1}` : '여기를 찾아보세요';
    addTooltip(el, label);

    if (!scrollTarget) scrollTarget = el;
    foundCount++;
  });

  if (scrollTarget) {
    scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return foundCount;
}

/**
 * 모든 하이라이트 클래스와 툴팁을 제거합니다.
 * 새 질문, URL 변경, 탭 전환 시 호출됩니다.
 */
function clearHighlights() {
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
    el.classList.remove(HIGHLIGHT_CLASS);
  });
  document.querySelectorAll(`.${TOOLTIP_CLASS}`).forEach(el => el.remove());
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 메시지 리스너
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'HIGHLIGHT') {
    clearHighlights();
    const found = highlightAnchors(message.anchors);
    sendResponse({ success: true, found });
    return true;
  }

  if (message.type === 'CLEAR_HIGHLIGHTS') {
    clearHighlights();
    sendResponse({ success: true });
    return true;
  }
});
