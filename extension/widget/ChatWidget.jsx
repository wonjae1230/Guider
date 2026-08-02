import { useRef, useState } from "react";
import logo from "../assets/icons/icon128.png";
import { CloseIcon, SendIcon } from "./icons.jsx";

const EXAMPLES = ["로그인하려면 어떻게 해?", "여권 발급일 확인해줘"];

function ChatWidget({ onClose }) {
  const [value, setValue] = useState("");
  const textareaRef = useRef(null);

  const handleSend = () => {
    const text = value.trim();
    if (!text) return;
    // TODO: 실제 메시지 전송/AI 응답 연동
    setValue("");
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="gd-card">
      <header className="gd-header">
        <div className="gd-header__brand">
          <img className="gd-header__logo" src={logo} alt="" />
          <div className="gd-header__text">
            <div className="gd-header__title">Guider</div>
            <div className="gd-header__subtitle">AI 웹 내비게이션 도우미</div>
          </div>
        </div>
        <button
          type="button"
          className="gd-header__close"
          onClick={onClose}
          aria-label="닫기"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="gd-body">
        <img className="gd-body__hero" src={logo} alt="" />
        <h2 className="gd-body__heading">무엇을 도와드릴까요?</h2>
        <p className="gd-body__desc">
          현재 페이지에서 찾고 싶은 것이나
          <br />
          하고 싶은 작업을 자유롭게 물어보세요.
        </p>

        <div className="gd-examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="gd-example"
              onClick={() => setValue(example)}
            >
              <span className="gd-example__label">예시</span>
              <span className="gd-example__text">&quot;{example}&quot;</span>
            </button>
          ))}
        </div>
      </div>

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
          />
          <button
            type="button"
            className="gd-send"
            onClick={handleSend}
            disabled={!value.trim()}
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
