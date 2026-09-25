// ESLint flat config (ADR-0010 §2.4.2)
// 設定の正典:
//  - https://eslint.org/docs/latest/use/configure/configuration-files
//  - https://typescript-eslint.io/getting-started/typed-linting/
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [".generated", "dist", "src-tauri/target", "src-tauri/gen", "node_modules", "vendor"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  // Promise の取りこぼし (await / void / catch 忘れ) を型情報で検出する
  // (JSX 属性への async handler と、テストコードの act / userEvent は対象外)
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          // React Router v7 の navigate() は Promise 型も返すが、画面遷移の完了を待つ必要はない
          allowForKnownSafeCalls: [
            { from: "package", name: "NavigateFunction", package: "react-router" },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  // prettier 競合ルールの無効化 (format は prettier 単独で扱う、ADR-0010 §2.4.3)
  prettier,
);
