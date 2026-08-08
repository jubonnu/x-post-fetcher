import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ルートのESLint設定。`apps/worker`・`apps/scraper`・`packages/shared`を対象にする。
 * `apps/admin-web`はVite scaffold付属のoxlintを既に使っているため対象外にする。
 * 型情報を使う`typed linting`（parserOptions.project）は、パッケージごとにtsconfigの
 * includeが異なる（例: workerのtsconfig.jsonはtestsを含まない）ため今回は導入せず、
 * 構文ベースのrecommendedルールのみを適用する。
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "apps/admin-web/**",
      "apps/worker/migrations/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // 未使用のcatchバインディングなど、意図的に無視するケースが多いため`_`prefixのみ許容する。
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Honoルートハンドラ等でconsole.error/warnを使う既存パターンを許容する（infoは避ける方針の目印として警告に留める）。
      "no-console": ["warn", { allow: ["error", "warn"] }],
    },
  },
  {
    // テストのfixture/mockはレスポンス形状を都度厳密に型付けするコストが見合わないことが多いため、
    // このルールに限りテストファイルでは緩和する（src側は引き続きerror）。
    files: ["**/tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
