import { useState } from "react";
import { ArrowDownUp } from "lucide-react";

import { Button } from "@/components/ui/Button";
import {
  CopyButton,
  inputClass,
  textareaClass,
  ToolError,
  ToolPage,
  ToolPanel,
} from "@/components/ui/ToolPage";

import { type CodecDirection, type CodecFormat, transformText } from "./codec";

const formatNames: Record<CodecFormat, string> = {
  base64: "Base64",
  base64url: "Base64URL",
  url: "URL percent",
  html: "HTML entity",
  unicode: "Unicode escape",
};

export function CodecPage() {
  const [format, setFormat] = useState<CodecFormat>("base64");
  const [direction, setDirection] = useState<CodecDirection>("encode");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const execute = () => {
    try {
      setOutput(transformText(input, format, direction));
      setError(null);
    } catch (cause) {
      setOutput("");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <ToolPage
      title="エンコード／デコード変換"
      description="主要なテキスト表現をUTF-8基準で相互変換します。"
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="text-[12px]">
          形式
          <select
            className={`${inputClass} ml-2`}
            value={format}
            onChange={(event) => setFormat(event.target.value as CodecFormat)}
          >
            {Object.entries(formatNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px]">
          方向
          <select
            className={`${inputClass} ml-2`}
            value={direction}
            onChange={(event) => setDirection(event.target.value as CodecDirection)}
          >
            <option value="encode">Encode</option>
            <option value="decode">Decode</option>
          </select>
        </label>
        <Button variant="primary" onClick={execute}>
          変換
        </Button>
        <Button
          onClick={() => {
            setInput(output);
            setOutput(input);
            setDirection(direction === "encode" ? "decode" : "encode");
          }}
        >
          <ArrowDownUp size={13} aria-hidden /> 入れ替え
        </Button>
      </div>
      <ToolError message={error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <ToolPanel title="入力">
          <textarea
            className={`${textareaClass} h-72`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </ToolPanel>
        <ToolPanel title="出力" actions={<CopyButton text={output} />}>
          <textarea className={`${textareaClass} h-72`} value={output} readOnly />
        </ToolPanel>
      </div>
    </ToolPage>
  );
}
