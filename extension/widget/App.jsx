import { useState } from "react";
import ChatWidget from "./ChatWidget.jsx";
import Launcher from "./Launcher.jsx";

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

  return (
    <div className="gd-root">
      {isOpen ? (
        <ChatWidget siteName={siteName} onClose={() => setIsOpen(false)} />
      ) : (
        <Launcher onClick={() => setIsOpen(true)} />
      )}
    </div>
  );
}

export default App;
