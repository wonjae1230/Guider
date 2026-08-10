import { useRef, useState } from "react";
import logo from "../assets/icons/icon128.png";
import { CloseIcon, MicIcon, SendIcon } from "./icons.jsx";
import { useSpeechToText } from "./useSpeechToText.js";
import { extractElements, callAI, highlightAnchors, clearHighlights } from "./aiHelper.js";

const EXAMPLES = ["로그인하려면 어떻게 해?", "여권 발급일 확인해줘"];

// 위젯 표시 단계
const PHASE = {
  IDLE:    'idle',
  LOADING: 'loading',
  RESULT:  'result',
  ERROR:   'error',
};

function ChatWidget({ siteName, dragHandleProps, onClose }) {
  const [value,   setValue]  = useState("");
  const [phase,   setPhase]  = useState(PHASE.IDLE);
  const [result,  setResult] = useState(null);   // { anchors, reason }
  const [errorMsg, setError] = useState("");
  const textareaRef = useRef(null);

  const { isSupported: isMicSupported, isListening, toggleListening } =
    useSpeechToText(setValue);

  // ── AI 질문 처리 ────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const question = value.trim();
    if (!question || phase === PHASE.LOADING) return;

    setValue("");
    setPhase(PHASE.LOADING);
    setResult(null);
    setError("");
    clearHighlights();

    try {
      // 1. 페이지 DOM 요소 추출 (민감정보 마스킹 포함)
      const elements = extractElements();

      // 2. 백엔드 경유 Claude 호출
      const aiResult = await callAI(question, elements);
      setResult(aiResult);
      setPhase(PHASE.RESULT);

      // 3. 요소 하이라이트
      if (aiResult.anchors?.length > 0) {
        highlightAnchors(aiResult.anchors);
      }
    } catch (err) {
      setError(err.message || "알 수 없는 오류가 발생했습니다.");
      setPhase(PHASE.ERROR);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 초기 상태로 복귀
  const handleReset = () => {
    clearHighlights();
    setPhase(PHASE.IDLE);
    setResult(null);
    setError("");
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const anchors    = result?.anchors ?? [];
  const hasAnchors = anchors.length > 0;

  return (
    <div className="gd-card">
      <header className="gd-header" {...dragHandleProps}>
        <div className="gd-header__brand">
          <img className="gd-header__logo" src={logo} alt="" draggable="false" />
          <div className="gd-header__text">
            <div className="gd-header__title">
              Guider
              <span className="gd-header__sep">|</span>
              <span className="gd-header__sitename">{siteName}</span>
            </div>
          </div>
        </div>
        <button type="button" className="gd-header__close" onClick={onClose} aria-label="닫기">
          <CloseIcon />
        </button>
      </header>

      {/* ── 본문: 단계별 표시 ───────────────────────────────────────────── */}

      {phase === PHASE.IDLE && (
        <div className="gd-body">
          <img className="gd-body__hero" src={logo} alt="" />
          <h2 className="gd-body__heading">무엇을 도와드릴까요?</h2>
          <p className="gd-body__desc">
            현재 페이지에서 찾고 싶은 것이나
            <br />
            하고 싶은 작업을 자유롭게 물어보세요.
          </p>
          <div className="gd-examples">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="gd-example"
                onClick={() => setValue(ex)}
              >
                <span className="gd-example__label">예시</span>
                <span className="gd-example__text">&quot;{ex}&quot;</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === PHASE.LOADING && (
        <div className="gd-body gd-body--center">
          <div className="gd-spinner" />
          <p className="gd-loading-text">페이지를 분석하고 있어요...</p>
        </div>
      )}

      {phase === PHASE.RESULT && result && (
        <div className="gd-body gd-body--result">
          {/* AI 안내 메시지 */}
          <p className="gd-result-reason">{result.reason}</p>

          {/* 다중 단계 */}
          {hasAnchors && anchors.length > 1 && (
            <ol className="gd-step-list">
              {anchors.map((anchor, i) => (
                <li key={i} className="gd-step-item">
                  <span className="gd-step-num">{i + 1}</span>
                  <span className="gd-step-label">
                    {anchor.text || anchor.ariaLabel || anchor.id || `요소 ${i + 1}`}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {/* 단일 요소 */}
          {hasAnchors && anchors.length === 1 && (
            <div className="gd-found-badge">
              {anchors[0].text || anchors[0].ariaLabel || anchors[0].id}
            </div>
          )}

          {/* 요소 미발견 */}
          {!hasAnchors && (
            <p className="gd-not-found">현재 페이지에서 해당 기능을 찾지 못했어요.</p>
          )}

          <button type="button" className="gd-reset-btn" onClick={handleReset}>
            다시 질문하기
          </button>
        </div>
      )}

      {phase === PHASE.ERROR && (
        <div className="gd-body gd-body--center">
          <p className="gd-error-msg">{errorMsg}</p>
          <button type="button" className="gd-reset-btn gd-reset-btn--error" onClick={handleReset}>
            다시 시도
          </button>
        </div>
      )}

      {/* ── 입력 영역 ───────────────────────────────────────────────────── */}
      <footer className="gd-footer">
        <div className="gd-input-row">
          <textarea
            ref={textareaRef}
            className="gd-input"
            rows={1}
            placeholder="어떤 것을 찾고 계신가요?"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={phase === PHASE.LOADING}
          />
          {isMicSupported && (
            <button
              type="button"
              className={`gd-mic${isListening ? " gd-mic--active" : ""}`}
              onClick={() => toggleListening(value)}
              aria-label={isListening ? "음성 입력 중지" : "음성으로 입력"}
              aria-pressed={isListening}
              disabled={phase === PHASE.LOADING}
            >
              <MicIcon />
            </button>
          )}
          <button
            type="button"
            className="gd-send"
            onClick={handleSend}
            disabled={!value.trim() || phase === PHASE.LOADING}
            aria-label="전송"
          >
            <SendIcon />
          </button>
        </div>
        <div className="gd-hint">Enter로 전송 · Shift+Enter로 줄바꿈</div>
      </footer>
    </div>
  );
}

export default ChatWidget;
