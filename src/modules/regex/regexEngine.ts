export interface RegexMatchResult {
  index: number;
  text: string;
  captures: (string | null)[];
  groups: Record<string, string | null>;
}

export interface RegexEvaluation {
  matches: RegexMatchResult[];
  replacement: string;
}

export function evaluateRegex(input: {
  pattern: string;
  flags: string;
  text: string;
  replacement: string;
}): RegexEvaluation {
  if (input.pattern.length > 10_000) throw new Error("patternは10,000文字以下にしてください");
  if (input.text.length > 1024 * 1024) throw new Error("テスト文字列は1MiB以下にしてください");
  const regex = new RegExp(input.pattern, input.flags);
  const matches: RegexMatchResult[] = [];
  if (regex.global || regex.sticky) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input.text)) != null) {
      matches.push(toResult(match));
      if (match[0] === "") regex.lastIndex += 1;
      if (matches.length >= 10_000) throw new Error("match件数が10,000件を超えました");
    }
  } else {
    const match = regex.exec(input.text);
    if (match != null) matches.push(toResult(match));
  }
  return { matches, replacement: input.text.replace(regex, input.replacement) };
}

function toResult(match: RegExpExecArray): RegexMatchResult {
  return {
    index: match.index,
    text: match[0],
    captures: match.slice(1).map((value) => value ?? null),
    groups: Object.fromEntries(
      Object.entries(match.groups ?? {}).map(([key, value]) => [key, value ?? null]),
    ),
  };
}
