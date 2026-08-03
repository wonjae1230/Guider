import { useLayoutEffect, useRef, useState } from "react";
import ChatWidget from "./ChatWidget.jsx";
import Launcher from "./Launcher.jsx";
import { clampIntoViewport, useDraggable } from "./useDraggable.js";

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
  const [isOpen, setIsOpen] = useState(true);
  const siteName = getSiteName();
  const rootRef = useRef(null);
  const dragHandleProps = useDraggable(rootRef);

  useLayoutEffect(() => {
    clampIntoViewport(rootRef.current);
  }, [isOpen]);

  return (
    <div className="gd-root" ref={rootRef}>
      {isOpen ? (
        <ChatWidget
          siteName={siteName}
          dragHandleProps={dragHandleProps}
          onClose={() => setIsOpen(false)}
        />
      ) : (
        <Launcher dragHandleProps={dragHandleProps} onClick={() => setIsOpen(true)} />
      )}
    </div>
  );
}

export default App;
