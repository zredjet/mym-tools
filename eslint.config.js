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
    ignores: ["dist", "src-tauri/target", "src-tauri/gen", "node_modules"],
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
  // prettier 競合ルールの無効化 (format は prettier 単独で扱う、ADR-0010 §2.4.3)
  prettier,
);
