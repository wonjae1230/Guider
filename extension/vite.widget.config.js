import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// content script(플로팅 위젯)는 페이지에 단일 IIFE로 주입되어야 하므로
// sidepanel과 별도의 설정으로 번들링한다. CSS는 widget.css?inline으로
// 문자열로 가져와 Shadow DOM 안에 직접 주입하므로 별도 CSS 파일이 필요 없다.
export default defineConfig({
  root: ".",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: "dist/content",
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 20000,
    lib: {
      entry: "widget/main.jsx",
      formats: ["iife"],
      name: "GuiderWidget",
      fileName: () => "widget.js",
    },
  },
  plugins: [react()],
});
