import { diffLines, diffWords, diffWordsWithSpace, type Change } from "diff";

export type DiffMode = "lines" | "words";

export interface TextDiffInput {
  left: string;
  right: string;
  mode: DiffMode;
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
}

export function computeTextDiff(input: TextDiffInput): Change[] {
  if (input.left.length > 1024 * 1024 || input.right.length > 1024 * 1024) {
    throw new Error("各入力は1MiB以下にしてください");
  }
  const options = { ignoreWhitespace: input.ignoreWhitespace, ignoreCase: input.ignoreCase };
  if (input.mode === "lines") return diffLines(input.left, input.right, options);
  return input.ignoreWhitespace
    ? diffWords(input.left, input.right, options)
    : diffWordsWithSpace(input.left, input.right, options);
}
