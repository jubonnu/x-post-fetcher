/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // lightningcssはnpmのoptionalDependencies解決が環境によって不安定で、
    // クリーンインストール直後にプラットフォーム別バイナリが見つからずビルドが
    // 失敗することがある（このリポジトリのCIで実際に発生）。esbuildへ切り替えて回避する。
    cssMinify: "esbuild",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
