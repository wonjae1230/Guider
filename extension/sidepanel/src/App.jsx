// ─────────────────────────────────────────────────────────────────────────────
// 사이드패널 메인 컴포넌트
//
// 전체 흐름:
//  1. 사용자가 질문 입력 → 제출
//  2. content script(domParser.js)에 GET_DOM 메시지 → DOM 요소 수신
//  3. prepareElements()로 민감정보 마스킹
//  4. queryAI()로 백엔드(Claude) 호출
//  5. content script(highlighter.js)에 HIGHLIGHT 메시지 → 요소 강조
//  6. 사이드패널에 결과(reason + 단계 안내) 표시
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from 'react';
import { queryAI }         from '../../ai/client.js';
import { prepareElements } from '../../ai/prompt.js';
import './App.css';

// ─── 상태 상수 ───────────────────────────────────────────────────────────────

const STATUS = {
  IDLE:    'idle',
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR:   'error',
};

// ─── Chrome 통신 헬퍼 ─────────────────────────────────────────────────────────

/**
 * 현재 활성 탭에 메시지를 전송하고 응답을 반환합니다.
 * chrome.runtime.lastError는 catch가 아닌 콜백 내부에서 확인해야 합니다.
 */
async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('활성 탭을 찾을 수 없습니다.');

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error('페이지와 연결할 수 없습니다. 페이지를 새로고침 해주세요.'));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * 현재 활성 탭의 URL을 반환합니다.
 * 서버의 Redis 캐시 키로 사용됩니다 (동일 URL + 동일 질문 = 캐시 히트).
 */
async function getActiveTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? '';
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export default function App() {
  const [question, setQuestion] = useState('');
  const [status,   setStatus]   = useState(STATUS.IDLE);
  const [result,   setResult]   = useState(null);    // { anchors: [], reason: string }
  const [errorMsg, setErrorMsg] = useState('');
  const textareaRef             = useRef(null);

  // ── URL 변경 감지 → 상태 초기화 ──────────────────────────────────────────
  // observer.js가 URL_CHANGED를 보내면 이전 질문/결과를 모두 초기화합니다.
  useEffect(() => {
    const handleMessage = (message) => {
      if (message.type !== 'URL_CHANGED') return;
      setStatus(STATUS.IDLE);
      setResult(null);
      setErrorMsg('');
      setQuestion('');
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  // ── 질문 제출 ─────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    const trimmed = question.trim();
    if (!trimmed || status === STATUS.LOADING) return;

    setStatus(STATUS.LOADING);
    setResult(null);
    setErrorMsg('');

    try {
      // 1. 현재 탭 URL (캐시 키)
      const url = await getActiveTabUrl();

      // 2. DOM 요소 추출 요청
      const domRes = await sendToActiveTab({ type: 'GET_DOM' });
      if (!domRes?.success) {
        throw new Error('페이지 요소를 읽을 수 없습니다. 페이지가 완전히 로드되었는지 확인해 주세요.');
      }

      // 3. 민감정보 마스킹 + 100개 제한 정제
      const elements = prepareElements(domRes.elements);

      // 4. 백엔드 경유 Claude 호출
      const aiResult = await queryAI(trimmed, elements, url);
      setResult(aiResult);
      setStatus(STATUS.SUCCESS);

      // 5. 요소 하이라이트 (anchors가 있을 때만)
      if (aiResult.anchors?.length > 0) {
        await sendToActiveTab({ type: 'HIGHLIGHT', anchors: aiResult.anchors });
      }

    } catch (err) {
      setStatus(STATUS.ERROR);
      setErrorMsg(err.message || '알 수 없는 오류가 발생했습니다.');
    }
  }, [question, status]);

  // Enter: 제출 / Shift+Enter: 줄바꿈 허용
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // 초기화 후 입력창으로 포커스 이동
  const handleReset = () => {
    setStatus(STATUS.IDLE);
    setResult(null);
    setErrorMsg('');
    setQuestion('');
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const anchors    = result?.anchors ?? [];
  const hasAnchors = anchors.length > 0;

  // ── 렌더링 ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* 헤더 */}
      <header className="header">
        <div className="header__row">
          <CompassIcon className="header__icon" />
          <h1 className="header__title">Guider</h1>
        </div>
        <p className="header__subtitle">원하는 기능을 물어보면 찾아드릴게요</p>
      </header>

      {/* 질문 입력 */}
      <form className="search-form" onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <textarea
          ref={textareaRef}
          className="search-form__input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={"예: 수강신청 메뉴는 어디 있어?\n예: 교수님 이메일 찾고 싶어"}
          rows={3}
          disabled={status === STATUS.LOADING}
          autoFocus
        />
        <button
          className="search-form__button"
          type="submit"
          disabled={!question.trim() || status === STATUS.LOADING}
        >
          {status === STATUS.LOADING
            ? <><Spinner className="spinner--btn" /> 분석 중</>
            : '찾기'
          }
        </button>
      </form>

      {/* 로딩 */}
      {status === STATUS.LOADING && (
        <div className="info-card info-card--loading">
          <Spinner className="spinner--lg" />
          <span>페이지를 분석하고 있어요...</span>
        </div>
      )}

      {/* 성공 */}
      {status === STATUS.SUCCESS && result && (
        <div className="result-card">
          <p className="result-card__reason">{result.reason}</p>

          {/* 다중 단계 안내 */}
          {hasAnchors && anchors.length > 1 && (
            <ol className="step-list">
              {anchors.map((anchor, i) => (
                <li key={i} className="step-list__item">
                  <span className="step-list__num">{i + 1}</span>
                  <span className="step-list__label">
                    {anchor.text || anchor.ariaLabel || anchor.id || `요소 ${i + 1}`}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {/* 단일 요소 강조 */}
          {hasAnchors && anchors.length === 1 && (
            <div className="found-badge">
              {anchors[0].text || anchors[0].ariaLabel || anchors[0].id}
            </div>
          )}

          {/* 요소를 찾지 못한 경우 */}
          {!hasAnchors && (
            <p className="result-card__not-found">현재 페이지에서 해당 기능을 찾지 못했어요.</p>
          )}

          <button className="text-button" onClick={handleReset}>다시 질문하기</button>
        </div>
      )}

      {/* 에러 */}
      {status === STATUS.ERROR && (
        <div className="info-card info-card--error">
          <p className="info-card__message">{errorMsg}</p>
          <button className="text-button text-button--error" onClick={handleReset}>
            다시 시도
          </button>
        </div>
      )}

    </div>
  );
}

// ─── 아이콘 컴포넌트 ──────────────────────────────────────────────────────────

function CompassIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}

function Spinner({ className }) {
  return <span className={`spinner ${className ?? ''}`} />;
}
