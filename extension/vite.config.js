import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

// Vite는 sidepanel(React UI)만 번들링한다.
// background/content/ai/manifest/icons는 순수 JS이므로 그대로 dist에 복사만 한다.
export default defineConfig({
  root: "sidepanel",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: resolve("./manifest.json"), dest: "." },
        { src: resolve("./background"), dest: "." },
        { src: resolve("./content"), dest: "." },
        { src: resolve("./ai"), dest: "." },
        { src: resolve("./assets/icons"), dest: "assets" },
      ],
    }),
  ],
});
