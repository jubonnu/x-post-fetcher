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
    // テストは`.env`ファイル（gitignore対象、開発者のローカル環境にしか無い）の有無に
    // 依存してはいけない。CI（.envが存在しない）でVITE_API_BASE_URL未設定エラーになり、
    // 認証まわりのテストが軒並み失敗していたため、テスト専用の値をここで固定する。
    env: {
      VITE_API_BASE_URL: "http://localhost:9999",
    },
  },
});
