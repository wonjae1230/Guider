import { useState } from "react";
import "./App.css";

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="app">
      <header className="app__header">
        <h1>Guider</h1>
        <p>웹 페이지 사용법을 안내하는 AI 사이드패널입니다.</p>
      </header>

      <main className="app__content">
        <p>사이드패널 UI 개발을 여기서부터 시작하세요.</p>
        <button onClick={() => setCount((c) => c + 1)}>
          동작 확인용 카운트: {count}
        </button>
      </main>
    </div>
  );
}

export default App;
