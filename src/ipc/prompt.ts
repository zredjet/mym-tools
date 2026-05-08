/**
 * M-Prompt 固有 Tauri コマンドのラッパー (`module-contract.md` §12.1)。
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * プロンプト本文の `{{name}}` を `variables` で差し込んだ完成プロンプトを返す
 * (`prompt_render_template` / pure function)。
 */
export function promptRenderTemplate(input: {
  body: string;
  variables: Record<string, string>;
}): Promise<string> {
  return invoke<string>("prompt_render_template", {
    body: input.body,
    variables: input.variables,
  });
}
