import { useCallback, useEffect, useRef, useState } from "react";
import logo from "../assets/icons/icon128.png";
import { CloseIcon, MicIcon, SendIcon } from "./icons.jsx";
import { useSpeechToText } from "./useSpeechToText.js";
import { extractElements, extractPageText, extractHeadings, callAI, highlightAnchors, clearHighlights } from "./aiHelper.js";

const EXAMPLES = ["로그인하려면 어떻게 해?", "여권 발급일 확인해줘"];

const PHASE = {
  IDLE:    'idle',
  LOADING: 'loading',
  RESULT:  'result',
  ERROR:   'error',
};

// navigate 타입 결과 후 다음 페이지 자동 재실행을 위한 세션 스토리지 키
// chrome.storage.session은 브라우저 세션 동안 유지되어 MPA 전체 새로고침에도 살아있습니다.
const SESSION_KEY = 'guiderPendingQuery';

// 탭별 대화 기억 키 (sessionStorage: 탭마다 독립, 탭 닫기 전까지 유지)
// 탭 전환 후 돌아와도, 같은 탭 내 페이지 이동 후 돌아와도 이전 결과를 복원합니다.
const TAB_STATE_KEY = 'guiderTabState';

function ChatWidget({ siteName, dragHandleProps, onClose }) {
  const [value,    setValue]  = useState("");
  const [phase,    setPhase]  = useState(PHASE.IDLE);
  const [result,   setResult] = useState(null);
  const [errorMsg, setError]  = useState("");
  const textareaRef  = useRef(null);
  const lastQuestion = useRef('');
  // stale closure 방지: URL 변경 이벤트 핸들러에서 최신 state를 읽기 위한 refs
  const phaseRef     = useRef(PHASE.IDLE);
  const resultRef    = useRef(null);

  useEffect(() => { phaseRef.current  = phase;  }, [phase]);
  useEffect(() => { resultRef.current = result; }, [result]);

  const { isSupported: isMicSupported, isListening, toggleListening } =
    useSpeechToText(setValue);

  // ── 공통 질문 처리 ─────────────────────────────────────────────────────────
  // handleSend와 자동 재실행 양쪽에서 호출되므로 분리합니다.
  const triggerQuery = useCallback(async (question) => {
    setValue("");
    setPhase(PHASE.LOADING);
    setResult(null);
    setError("");
    clearHighlights();

    try {
      const elements = extractElements(question); // 질문 키워드로 관련 요소 우선 정렬
      const pageText = extractPageText();
      const headings = extractHeadings();        // 페이지 섹션 구조 전달
      const aiResult = await callAI(question, elements, pageText, headings);

      setResult(aiResult);
      setPhase(PHASE.RESULT);

      if (aiResult.anchors?.length > 0) {
        highlightAnchors(aiResult.anchors);
      }

      // 탭 대화 기록 저장: 같은 탭에서 돌아왔을 때 결과를 복원하기 위함
      try {
        sessionStorage.setItem(TAB_STATE_KEY, JSON.stringify({
          question,
          result: aiResult,
          url: location.href,
        }));
      } catch {}

      // navigate 타입이면 다음 페이지 이동 후 자동 재실행할 수 있도록 저장
      if (aiResult.type === 'navigate') {
        chrome.storage.session?.set({
          [SESSION_KEY]: { question, fromUrl: location.href },
        });
      } else {
        // 목표에 도달했으면 pending 제거
        chrome.storage.session?.remove(SESSION_KEY);
      }
    } catch (err) {
      setError(err.message || "알 수 없는 오류가 발생했습니다.");
      setPhase(PHASE.ERROR);
    }
  }, []);

  // ── 마운트 시 탭 대화 기록 복원 ────────────────────────────────────────────
  // sessionStorage는 탭별로 분리되어 있으므로 탭 전환 후 돌아와도 이 탭의 기록만 복원합니다.
  // (하이라이트는 DOM이 바뀌었을 수 있어 복원하지 않습니다)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TAB_STATE_KEY);
      if (!saved) return;
      const { question, result: savedResult, url } = JSON.parse(saved);
      // 같은 URL일 때만 복원 (다른 페이지에서의 기록은 auto-retry가 처리)
      if (url === location.href && savedResult) {
        lastQuestion.current = question;
        setResult(savedResult);
        setPhase(PHASE.RESULT);
      }
    } catch {}
  }, []);

  // ── 마운트 시 자동 재실행 + URL 변경 감지 ──────────────────────────────────
  useEffect(() => {
    // MPA(전체 페이지 이동) 대응:
    // 이전 페이지에서 'navigate' 결과를 받은 후 사용자가 링크를 눌러 이동하면,
    // 새 페이지가 로드될 때 위젯이 다시 마운트되고 여기서 pending 질문을 자동 실행합니다.
    chrome.storage.session?.get([SESSION_KEY], (res) => {
      const pending = res?.[SESSION_KEY];
      if (pending && pending.fromUrl !== location.href) {
        chrome.storage.session.remove(SESSION_KEY);
        lastQuestion.current = pending.question;
        triggerQuery(pending.question);
      }
    });

    // SPA(pushState/popstate) 대응:
    // navigate 결과 상태에서 URL이 바뀌면 같은 질문을 새 페이지에서 재실행합니다.
    const handleUrlChange = () => {
      if (
        phaseRef.current === PHASE.RESULT &&
        resultRef.current?.type === 'navigate' &&
        lastQuestion.current
      ) {
        // DOM이 새 페이지로 업데이트될 시간을 확보한 후 재실행
        setTimeout(() => triggerQuery(lastQuestion.current), 400);
      }
    };

    window.addEventListener('popstate',   handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);

    // pushState/replaceState는 이벤트를 발생시키지 않으므로 직접 래핑
    // _guiderWrapped 플래그로 중복 래핑을 방지합니다.
    if (!history._guiderWrapped) {
      const origPush    = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);
      history.pushState    = (...args) => { origPush(...args);    handleUrlChange(); };
      history.replaceState = (...args) => { origReplace(...args); handleUrlChange(); };
      history._guiderWrapped = true;
    }

    return () => {
      window.removeEventListener('popstate',   handleUrlChange);
      window.removeEventListener('hashchange', handleUrlChange);
    };
  }, [triggerQuery]);

  // ── 입력 처리 ──────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const question = value.trim();
    if (!question || phase === PHASE.LOADING) return;
    lastQuestion.current = question;
    await triggerQuery(question);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReset = () => {
    clearHighlights();
    chrome.storage.session?.remove(SESSION_KEY);
    try { sessionStorage.removeItem(TAB_STATE_KEY); } catch {}
    setPhase(PHASE.IDLE);
    setResult(null);
    setError("");
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const anchors    = result?.anchors ?? [];
  const hasAnchors = anchors.length > 0;
  // 이전 응답(type 필드 없음)과의 하위 호환: 기본값 'navigate'
  const resultType = result?.type ?? 'navigate';

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

          {/* type: found → 페이지에서 정보를 직접 찾은 경우 (이메일, 학점 등) */}
          {resultType === 'found' ? (
            <div className="gd-info-box">
              <div className="gd-info-box__label">✓ 찾았어요!</div>
              <p className="gd-info-box__text">{result.reason}</p>
            </div>
          ) : (
            <>
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
            </>
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
