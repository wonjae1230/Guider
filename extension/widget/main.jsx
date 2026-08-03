import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import widgetStyles from "./widget.css?inline";

function mount() {
  if (document.getElementById("guider-widget-host")) return;

  const host = document.createElement("div");
  host.id = "guider-widget-host";
  document.documentElement.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = widgetStyles;
  shadowRoot.appendChild(style);

  const appRoot = document.createElement("div");
  shadowRoot.appendChild(appRoot);

  ReactDOM.createRoot(appRoot).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

mount();
