import { useState } from "react";
import ChatWidget from "./ChatWidget.jsx";
import Launcher from "./Launcher.jsx";

function App() {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <div className="gd-root">
      {isOpen ? (
        <ChatWidget onClose={() => setIsOpen(false)} />
      ) : (
        <Launcher onClick={() => setIsOpen(true)} />
      )}
    </div>
  );
}

export default App;
