import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { CopyButton, inputClass, ToolError, ToolPage, ToolPanel } from "@/components/ui/ToolPage";

import { generatePassword, generateToken, type PasswordOptions } from "./secretGenerator";

export function SecretGeneratorPage() {
  const [mode, setMode] = useState<"password" | "token">("password");
  const [options, setOptions] = useState<PasswordOptions>({
    length: 24,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: true,
  });
  const [byteLength, setByteLength] = useState(32);
  const [encoding, setEncoding] = useState<"hex" | "base64url">("base64url");
  const [result, setResult] = useState("");
  const [error, setError] = useState<string | null>(null);

  const generate = () => {
    try {
      setResult(
        mode === "password" ? generatePassword(options) : generateToken(byteLength, encoding),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <ToolPage
      title="安全なランダム文字列生成"
      description="Web Cryptoだけを乱数源に使い、秘密値をローカル生成します。"
    >
      <ToolPanel title="生成条件">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-[12px]">
            用途
            <select
              className={`${inputClass} mt-1 block`}
              value={mode}
              onChange={(event) => setMode(event.target.value as "password" | "token")}
            >
              <option value="password">パスワード</option>
              <option value="token">Token</option>
            </select>
          </label>
          {mode === "password" ? (
            <>
              <label className="text-[12px]">
                長さ
                <input
                  className={`${inputClass} mt-1 block w-24`}
                  type="number"
                  min={8}
                  max={256}
                  value={options.length}
                  onChange={(event) =>
                    setOptions((current) => ({
                      ...current,
                      length: event.currentTarget.valueAsNumber,
                    }))
                  }
                />
              </label>
              {(["lower", "upper", "digits", "symbols", "excludeAmbiguous"] as const).map((key) => (
                <label key={key} className="flex h-8 items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={options[key]}
                    onChange={(event) =>
                      setOptions((current) => ({ ...current, [key]: event.target.checked }))
                    }
                  />
                  {
                    {
                      lower: "小文字",
                      upper: "大文字",
                      digits: "数字",
                      symbols: "記号",
                      excludeAmbiguous: "紛らわしい文字を除外",
                    }[key]
                  }
                </label>
              ))}
            </>
          ) : (
            <>
              <label className="text-[12px]">
                Bytes
                <input
                  className={`${inputClass} mt-1 block w-24`}
                  type="number"
                  min={1}
                  max={128}
                  value={byteLength}
                  onChange={(event) => setByteLength(event.currentTarget.valueAsNumber)}
                />
              </label>
              <label className="text-[12px]">
                表現
                <select
                  className={`${inputClass} mt-1 block`}
                  value={encoding}
                  onChange={(event) => setEncoding(event.target.value as "hex" | "base64url")}
                >
                  <option value="base64url">Base64URL</option>
                  <option value="hex">Hex</option>
                </select>
              </label>
            </>
          )}
          <Button variant="primary" onClick={generate}>
            生成
          </Button>
        </div>
      </ToolPanel>
      <div className="mt-3">
        <ToolError message={error} />
      </div>
      <ToolPanel title="生成結果" className="mt-4" actions={<CopyButton text={result} />}>
        <p className="min-h-12 rounded-[var(--radius)] bg-[var(--bg-muted)] p-3 font-mono text-[13px] break-all">
          {result || "—"}
        </p>
      </ToolPanel>
    </ToolPage>
  );
}
