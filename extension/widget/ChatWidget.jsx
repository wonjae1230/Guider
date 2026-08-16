import { useCallback, useEffect, useRef, useState } from "react";
import logo from "../assets/icons/icon128.png";
import { CloseIcon, MicIcon, SendIcon } from "./icons.jsx";
import { useSpeechToText } from "./useSpeechToText.js";
import { extractElements, extractPageText, extractHeadings, callAI, fetchExamples, highlightAnchors, clearHighlights, waitForIframesReady, getAbsoluteRect } from "./aiHelper.js";

// 페이지별 예시 질문을 못 받아왔을 때(네트워크 오류 등) 보여줄 기본값
const DEFAULT_EXAMPLES = ["로그인하려면 어떻게 해?", "여권 발급일 확인해줘"];

const PHASE = {
  IDLE:    'idle',
  LOADING: 'loading',
  RESULT:  'result',
  ERROR:   'error',
};

// navigate 타입 결과 후 다음 페이지 자동 재실행을 위한 키
// sessionStorage는 같은 탭 내 MPA 페이지 이동에도 유지되며, 탭 종료 시 자동 삭제됩니다.
const SESSION_KEY = 'guiderPendingQuery';

// 탭별 대화 기억 키 (sessionStorage: 탭마다 독립, 탭 닫기 전까지 유지)
// 탭 전환 후 돌아와도, 같은 탭 내 페이지 이동 후 돌아와도 이전 결과를 복원합니다.
const TAB_STATE_KEY = 'guiderTabState';

// 대화 한 턴(질문 + AI 답변)을 그린다. 진행 중인 턴과, 페이지 이동으로 아래에 쌓인
// 지난 턴(isHistory) 모두 이 컴포넌트로 그려서 완료 배너를 포함해 그대로 이어 보입니다.
function ChatTurn({ question, result, completedSteps, isHistory = false }) {
  const anchors     = result?.anchors ?? [];
  const hasAnchors  = anchors.length > 0;
  // 이전 응답(type 필드 없음)과의 하위 호환: 기본값 'navigate'
  const resultType  = result?.type ?? 'navigate';
  const doneSet     = new Set(completedSteps);
  // 안내(투두리스트, 1단계여도 포함)의 모든 단계를 실제로 클릭 완료했는지
  const allStepsDone = hasAnchors && doneSet.size >= anchors.length;

  return (
    <div className={`gd-turn${isHistory ? ' gd-turn--history' : ''}`}>
      {question && <p className="gd-turn__question">&quot;{question}&quot;</p>}

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

          {/* 안내 체크리스트: 단계가 1개여도 동일하게 표시. 실제 페이지에서
              해당 요소를 클릭하면 완료 표시(취소선)됨 */}
          {hasAnchors && (
            <ol className="gd-step-list">
              {anchors.map((anchor, i) => {
                const done = doneSet.has(i);
                return (
                  <li key={i} className={`gd-step-item${done ? ' gd-step-item--done' : ''}`}>
                    <span className="gd-step-num">{done ? '✓' : i + 1}</span>
                    <span className="gd-step-label">
                      {anchor.text || anchor.ariaLabel || anchor.id || `요소 ${i + 1}`}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {/* 모든 단계를 실제로 클릭 완료했을 때 크게 보여주는 완료 배너 */}
          {allStepsDone && (
            <div className="gd-complete-banner">
              <span className="gd-complete-banner__confetti" aria-hidden="true">
                <span></span><span></span><span></span>
                <span></span><span></span><span></span>
              </span>
              <span className="gd-complete-banner__icon">✓</span>
              <span className="gd-complete-banner__text">모든 단계를 완료했어요!</span>
            </div>
          )}

          {/* 요소 미발견 */}
          {!hasAnchors && (
            <p className="gd-not-found">현재 페이지에서 해당 기능을 찾지 못했어요.</p>
          )}
        </>
      )}
    </div>
  );
}

function ChatWidget({ siteName, dragHandleProps, onClose }) {
  const [value,    setValue]  = useState("");
  const [phase,    setPhase]  = useState(PHASE.IDLE);
  const [result,   setResult] = useState(null);
  const [errorMsg, setError]  = useState("");
  // 다단계 안내(anchors 2개 이상)에서 사용자가 실제 페이지에서 해당 단계 요소를
  // 클릭할 때마다 highlightAnchors의 onStepComplete 콜백으로 채워지는 완료된 단계 인덱스
  const [completedSteps, setCompletedSteps] = useState(new Set());
  // 페이지 이동으로 다음 턴이 시작되어도 이전 턴(질문+답변+체크리스트)이 사라지지
  // 않도록 대화창처럼 아래에 쌓아두는 기록. 새 턴이 시작될 때 직전 턴이 여기로 옮겨갑니다.
  const [turnHistory, setTurnHistory] = useState([]);
  // IDLE 화면 예시 질문: 기본값이 먼저 반짝 보였다가 AI 예시로 바뀌면 어색하므로,
  // 로딩 중엔 스켈레톤을 보여주고 AI 예시가 도착한 뒤에야 실제 버튼을 표시합니다.
  const [examples, setExamples] = useState(DEFAULT_EXAMPLES);
  const [examplesLoading, setExamplesLoading] = useState(true);
  // 안내 중인 요소가 위젯 카드 뒤에 가려질 때 카드를 잠깐 접어 보여줄지 여부
  const [minimized, setMinimized] = useState(false);
  const textareaRef  = useRef(null);
  const lastQuestion = useRef('');
  // stale closure 방지: URL 변경 이벤트 핸들러에서 최신 state를 읽기 위한 refs
  const phaseRef     = useRef(PHASE.IDLE);
  const resultRef    = useRef(null);
  // history와 짝을 이루는 refs: setState 타이밍에 의존하지 않고 triggerQuery 안에서
  // 바로 다음 턴의 히스토리 아카이빙 여부를 동기적으로 판단하기 위해 사용합니다.
  const historyRef        = useRef([]);
  const resultQuestionRef = useRef('');
  const completedStepsRef = useRef(new Set());
  // 대화 스크롤 영역: 새 턴이 추가되면 맨 아래로 자동 스크롤합니다.
  const bodyRef = useRef(null);
  // 카드 자체의 위치/크기를 재서 안내 대상 요소와 겹치는지 판단하는 데 씁니다.
  const cardRef = useRef(null);

  useEffect(() => { phaseRef.current  = phase;  }, [phase]);
  useEffect(() => { resultRef.current = result; }, [result]);
  useEffect(() => { completedStepsRef.current = completedSteps; }, [completedSteps]);

  // 새 턴(히스토리 추가, 로딩 시작, 결과 도착)이 생길 때마다 대화창을 맨 아래로 스크롤
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [turnHistory, phase, result]);

  // 마운트 시 한 번, 현재 페이지에 맞는 예시 질문을 가져옵니다. 실패하면
  // (네트워크 오류 등) 조용히 기본값으로 폴백하되, 로딩 표시는 항상 끝냅니다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await waitForIframesReady();
        const elements = extractElements();
        const headings = extractHeadings();
        const generated = await fetchExamples(elements, headings);
        if (!cancelled && generated) setExamples(generated);
      } catch {
        // 기본값 유지
      } finally {
        if (!cancelled) setExamplesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const { isSupported: isMicSupported, isListening, toggleListening } =
    useSpeechToText(setValue);

  // 안내 대상 요소가 나타날 때마다 호출됩니다. 위젯 카드(우하단 고정)에
  // 가려지는 위치라면 카드를 잠깐 접어 실제 페이지 요소를 클릭할 수 있게 합니다.
  //
  // el.getBoundingClientRect()를 바로 쓰지 않고 getAbsoluteRect(el, chain)로
  // 다시 재는 이유: 요소가 중첩 iframe 안에 있으면 el 자신의 rect는 그 프레임
  // 내부 좌표라서, top 문서 기준으로 떠 있는 위젯 카드와 좌표계가 달라 비교가
  // 틀어집니다. 또한 첫 단계는 scrollIntoView(smooth)가 걸려 있어 즉시 재면
  // 스크롤이 끝나기 전 좌표를 잡으므로, 카드가 다시 펼쳐지고 스크롤 애니메이션도
  // 끝날 만큼 잠깐 기다린 뒤에 측정합니다.
  const handleStepVisible = useCallback((el, chain) => {
    setMinimized(false);
    setTimeout(() => {
      if (!cardRef.current || !el) return;
      const cardRect = cardRef.current.getBoundingClientRect();
      const elRect   = getAbsoluteRect(el, chain);
      const overlaps = !(
        elRect.right  < cardRect.left  ||
        elRect.left   > cardRect.right ||
        elRect.bottom < cardRect.top   ||
        elRect.top    > cardRect.bottom
      );
      if (overlaps) setMinimized(true);
    }, 350);
  }, []);

  // ── 공통 질문 처리 ─────────────────────────────────────────────────────────
  // handleSend와 자동 재실행 양쪽에서 호출되므로 분리합니다.
  // auto: true면 사용자가 직접 물은 게 아니라 페이지 이동으로 자동 재실행된 것입니다.
  // "모든 단계를 완료했어요!"까지 본 뒤 마지막 클릭이 로그인 페이지 등 관련 없는
  // 곳으로 이어지면, 자동 재질문이 "못 찾았어요"를 새로 띄워 방금 본 완료 화면을
  // 덮어써버리는 문제가 있어 이 경우만 결과를 무시하고 완료 화면을 유지합니다.
  const triggerQuery = useCallback(async (question, { auto = false } = {}) => {
    // 직전 턴에 결과가 남아있다면(체크리스트, 완료 배너 포함) 지우지 않고
    // 히스토리로 옮겨서 새 턴 아래에 계속 보이도록 합니다.
    let archivedTurn = null;
    if (resultRef.current) {
      archivedTurn = {
        question:       resultQuestionRef.current,
        result:         resultRef.current,
        completedSteps: Array.from(completedStepsRef.current),
      };
      historyRef.current = [...historyRef.current, archivedTurn];
      setTurnHistory(historyRef.current);
    }

    const prevAnchors   = archivedTurn?.result.anchors ?? [];
    const prevFullyDone = auto && prevAnchors.length > 0 &&
      archivedTurn.completedSteps.length >= prevAnchors.length;

    setValue("");
    setPhase(PHASE.LOADING);
    setResult(null);
    setError("");
    setCompletedSteps(new Set());
    setMinimized(false);
    clearHighlights();

    try {
      await waitForIframesReady();
      const elements = extractElements();
      const pageText = extractPageText();
      const headings = extractHeadings();
      const aiResult = await callAI(question, elements, pageText, headings);
      // type 필드가 없는 캐시된 구버전 응답은 'navigate'로 간주합니다 (하위 호환).
      const effectiveType = aiResult.type ?? 'navigate';

      if (prevFullyDone && effectiveType === 'notfound') {
        // 이미 다 완료된 안내를 자동으로 이어가다 관련 없는 페이지에 도착한 경우:
        // 방금 archiving한 턴을 되돌려 완료 화면을 그대로 유지합니다.
        historyRef.current = historyRef.current.slice(0, -1);
        setTurnHistory(historyRef.current);
        setResult(archivedTurn.result);
        setPhase(PHASE.RESULT);
        resultQuestionRef.current = archivedTurn.question;
        setCompletedSteps(new Set(archivedTurn.completedSteps));
        try { sessionStorage.removeItem(SESSION_KEY); } catch {}
        return;
      }

      setResult(aiResult);
      setPhase(PHASE.RESULT);
      resultQuestionRef.current = question;

      if (aiResult.anchors?.length > 0) {
        highlightAnchors(aiResult.anchors, (i) => {
          setCompletedSteps((prev) => new Set(prev).add(i));
        }, handleStepVisible);
      }

      // navigate 타입이면 다음 페이지 이동 후 자동 재실행할 수 있도록 저장
      // sessionStorage는 같은 탭 내 MPA 이동에도 유지되어 chrome.storage.session보다 신뢰성이 높습니다.
      if (effectiveType === 'navigate' && aiResult.anchors?.length > 0) {
        try {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify({ question, fromUrl: location.href }));
        } catch {}
      } else {
        try { sessionStorage.removeItem(SESSION_KEY); } catch {}
      }
    } catch (err) {
      setError(err.message || "알 수 없는 오류가 발생했습니다.");
      setPhase(PHASE.ERROR);
    }
  }, []);

  // ── 탭 대화 기록 저장 ──────────────────────────────────────────────────────
  // 현재 턴(질문+답변)과 그 위에 쌓인 히스토리, 체크리스트 진행 상황을 매번 최신으로
  // 저장해 둡니다. 체크 표시가 바뀔 때도 다시 저장되어야 페이지 이동 직전 상태가
  // 정확히 남습니다 (완료 배너가 뜬 채로 다음 페이지로 넘어가는 경우 등).
  useEffect(() => {
    if (phase !== PHASE.RESULT || !result) return;
    try {
      sessionStorage.setItem(TAB_STATE_KEY, JSON.stringify({
        question: resultQuestionRef.current,
        result,
        url: location.href,
        history: turnHistory,
        completedSteps: Array.from(completedSteps),
      }));
    } catch {}
  }, [phase, result, completedSteps, turnHistory]);

  // ── 마운트 시 탭 대화 기록 복원 ────────────────────────────────────────────
  // sessionStorage는 탭별로 분리되어 있으므로 탭 전환 후 돌아와도 이 탭의 기록만 복원합니다.
  // (하이라이트는 DOM이 바뀌었을 수 있어 복원하지 않습니다)
  useEffect(() => {
    try {
      // 새로고침(F5)은 sessionStorage 기준으로 "같은 탭, 같은 URL"이라 그냥 두면
      // 이전 대화가 그대로 복원돼 버립니다. Navigation Timing API로 실제 새로고침인
      // 경우만 구분해서 기록을 지우고 첫 화면(IDLE)으로 시작합니다.
      // (링크 클릭 등으로 같은 URL에 돌아온 경우는 'navigate'라 기존처럼 복원됩니다)
      const navEntry = performance.getEntriesByType('navigation')[0];
      if (navEntry?.type === 'reload') {
        sessionStorage.removeItem(TAB_STATE_KEY);
        return;
      }

      const saved = sessionStorage.getItem(TAB_STATE_KEY);
      if (!saved) return;
      const { question, result: savedResult, url, history: savedHistory } = JSON.parse(saved);
      // 같은 URL일 때만 복원 (다른 페이지에서의 기록은 auto-retry가 처리)
      if (url === location.href && savedResult) {
        lastQuestion.current = question;
        resultQuestionRef.current = question;
        historyRef.current = savedHistory || [];
        setTurnHistory(historyRef.current);
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
    // sessionStorage는 같은 탭 내 페이지 이동에도 유지됩니다.
    try {
      const pendingRaw = sessionStorage.getItem(SESSION_KEY);
      if (pendingRaw) {
        const pending = JSON.parse(pendingRaw);
        if (pending.fromUrl !== location.href) {
          sessionStorage.removeItem(SESSION_KEY);

          // 이전 페이지에서의 마지막 턴(완료 배너 포함)을 이번 위젯 인스턴스로
          // 옮겨와야 triggerQuery가 그것을 히스토리로 archiving할 수 있습니다.
          try {
            const savedRaw = sessionStorage.getItem(TAB_STATE_KEY);
            if (savedRaw) {
              const saved = JSON.parse(savedRaw);
              resultQuestionRef.current = saved.question;
              resultRef.current         = saved.result;
              completedStepsRef.current = new Set(saved.completedSteps || []);
              historyRef.current        = saved.history || [];
            }
          } catch {}

          lastQuestion.current = pending.question;
          triggerQuery(pending.question, { auto: true });
        }
      }
    } catch {}

    // SPA(pushState/popstate) 대응:
    // navigate 결과 상태에서 URL이 바뀌면 같은 질문을 새 페이지에서 재실행합니다.
    const handleUrlChange = () => {
      if (
        phaseRef.current === PHASE.RESULT &&
        resultRef.current?.type === 'navigate' &&
        lastQuestion.current
      ) {
        // DOM이 새 페이지로 업데이트될 시간을 확보한 후 재실행
        setTimeout(() => triggerQuery(lastQuestion.current, { auto: true }), 400);
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

  // "다시 질문하기": 이전 턴들을 이어붙이지 않고 완전히 새 대화로 시작합니다.
  const handleReset = () => {
    clearHighlights();
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    try { sessionStorage.removeItem(TAB_STATE_KEY); } catch {}
    setPhase(PHASE.IDLE);
    setResult(null);
    setError("");
    setCompletedSteps(new Set());
    setMinimized(false);
    setTurnHistory([]);
    historyRef.current        = [];
    resultRef.current         = null;
    resultQuestionRef.current = '';
    completedStepsRef.current = new Set();
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // 안내 대상 요소가 카드 뒤에 가려질 때: 대화 상태는 그대로 유지한 채
  // 작은 아이콘으로 접어서 실제 페이지 요소를 클릭할 수 있게 비켜줍니다.
  if (minimized) {
    return (
      <button
        type="button"
        className="gd-launcher gd-launcher--minimized"
        onClick={() => setMinimized(false)}
        aria-label="가려진 안내 대상이 있어요 · 클릭해서 Guider 다시 보기"
        {...dragHandleProps}
      >
        <img src={logo} alt="" draggable="false" />
        <span className="gd-launcher__pulse" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="gd-card" ref={cardRef}>
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
            {examplesLoading ? (
              <>
                <div className="gd-example gd-example--skeleton" aria-hidden="true">
                  <span className="gd-example__label-skeleton" />
                  <span className="gd-example__text-skeleton" />
                </div>
                <div className="gd-example gd-example--skeleton" aria-hidden="true">
                  <span className="gd-example__label-skeleton" />
                  <span className="gd-example__text-skeleton" />
                </div>
              </>
            ) : (
              examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  className="gd-example"
                  onClick={() => setValue(ex)}
                >
                  <span className="gd-example__label">예시</span>
                  <span className="gd-example__text">&quot;{ex}&quot;</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* 히스토리가 쌓인 상태(페이지 이동으로 이어지는 대화)에서는 로딩/결과/오류
          화면 모두 이전 턴들을 위에 두고 그 아래에서 이어지도록 표시합니다. */}
      {phase === PHASE.LOADING && (
        <div
          className={`gd-body ${turnHistory.length > 0 ? 'gd-body--result' : 'gd-body--center'}`}
          ref={bodyRef}
        >
          {turnHistory.map((turn, i) => (
            <ChatTurn key={i} question={turn.question} result={turn.result} completedSteps={turn.completedSteps} isHistory />
          ))}
          <div className={`gd-loading-turn${turnHistory.length > 0 ? ' gd-loading-turn--inline' : ''}`}>
            <div className="gd-spinner" />
            <p className="gd-loading-text">페이지를 분석하고 있어요...</p>
          </div>
        </div>
      )}

      {phase === PHASE.RESULT && result && (
        <div className="gd-body gd-body--result" ref={bodyRef}>
          {turnHistory.map((turn, i) => (
            <ChatTurn key={i} question={turn.question} result={turn.result} completedSteps={turn.completedSteps} isHistory />
          ))}

          <ChatTurn question={resultQuestionRef.current} result={result} completedSteps={Array.from(completedSteps)} />

          <button type="button" className="gd-reset-btn" onClick={handleReset}>
            다시 질문하기
          </button>
        </div>
      )}

      {phase === PHASE.ERROR && (
        <div
          className={`gd-body ${turnHistory.length > 0 ? 'gd-body--result' : 'gd-body--center'}`}
          ref={bodyRef}
        >
          {turnHistory.map((turn, i) => (
            <ChatTurn key={i} question={turn.question} result={turn.result} completedSteps={turn.completedSteps} isHistory />
          ))}
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
