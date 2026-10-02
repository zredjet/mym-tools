/** 設定画面の Link セクション: 確認せずに開くネットワーク上のサーバの一覧と追加・削除。 */
import { type FormEvent, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { hostFromInput } from "@/modules/linkmemo/networkTrust";
import { useTrustedNetworkHosts } from "@/modules/linkmemo/useTrustedNetworkHosts";

export function LinkMemoSettingsSection() {
  const { hosts, trust, untrust } = useTrustedNetworkHosts();
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const host = hostFromInput(input);
    if (host == null) {
      setInputError("サーバ名を入力してください (例: nas、\\\\nas\\share)");
      return;
    }
    trust(host);
    setInput("");
    setInputError(null);
  };

  return (
    <div className="flex max-w-md flex-col gap-2">
      <div>
        <h3 className="text-[13px] font-medium text-[var(--fg)]">
          確認せずに開くネットワーク上のサーバ
        </h3>
        <p className="text-[12px] text-[var(--fg-muted)]">
          ネットワーク上の場所 (\\サーバ\共有) を開くと、Windows
          ではサインイン情報がそのサーバへ送られます。ここに無いサーバは、開く前に確認します。
        </p>
      </div>
      {hosts.length === 0 ? (
        <p className="text-[12px] text-[var(--fg-subtle)]">登録したサーバはありません。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
          {hosts.map((host) => (
            <li key={host} className="flex min-h-9 items-center justify-between gap-3 px-3">
              <span className="min-w-0 truncate font-mono text-[13px]">{host}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${host} を削除`}
                onClick={() => untrust(host)}
              >
                <Trash2 size={13} aria-hidden /> 削除
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex items-center gap-2" onSubmit={handleSubmit}>
        <input
          aria-label="サーバ名"
          placeholder="nas または \\nas\share"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setInputError(null);
          }}
          className="h-8 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-2 font-mono text-[13px]"
        />
        <Button type="submit" size="sm">
          <Plus size={13} aria-hidden /> 追加
        </Button>
      </form>
      {inputError != null && (
        <p role="alert" className="text-[12px] text-[var(--destructive)]">
          {inputError}
        </p>
      )}
    </div>
  );
}
