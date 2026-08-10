import { useLayoutEffect, useEffect, useRef, useState } from "react";
import ChatWidget from "./ChatWidget.jsx";
import Launcher from "./Launcher.jsx";
import { clampIntoViewport, useDraggable } from "./useDraggable.js";

const STORAGE_KEY = "guiderWidgetOpen";

function getSiteName() {
  const ogSiteName = document
    .querySelector('meta[property="og:site_name"]')
    ?.content?.trim();
  return (
    ogSiteName ||
    document.title.trim() ||
    window.location.hostname.replace(/^www\./, "")
  );
}

function App() {
  // null = 스토리지에서 읽기 전 (깜빡임 방지)
  const [isOpen, setIsOpen] = useState(null);
  const siteName = getSiteName();
  const rootRef = useRef(null);
  const dragHandleProps = useDraggable(rootRef);

  // 마운트 시 저장된 상태 복원
  // 기본값은 true (처음 설치 시 펼쳐진 상태)
  useEffect(() => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      setIsOpen(result[STORAGE_KEY] ?? true);
    });
  }, []);

  useLayoutEffect(() => {
    if (isOpen !== null) {
      clampIntoViewport(rootRef.current);
    }
  }, [isOpen]);

  // 상태 변경 시 스토리지에 저장
  const open = () => {
    setIsOpen(true);
    chrome.storage.local.set({ [STORAGE_KEY]: true });
  };

  const close = () => {
    setIsOpen(false);
    chrome.storage.local.set({ [STORAGE_KEY]: false });
  };

  // 스토리지 읽기 전에는 렌더링하지 않아 초기 깜빡임 방지
  if (isOpen === null) return null;

  return (
    <div className="gd-root" ref={rootRef}>
      {isOpen ? (
        <ChatWidget
          siteName={siteName}
          dragHandleProps={dragHandleProps}
          onClose={close}
        />
      ) : (
        <Launcher dragHandleProps={dragHandleProps} onClick={open} />
      )}
    </div>
  );
}

export default App;
