//! ネットワーク上の場所になり得るパスの判定。M-Link (`linkmemo`) と M-フォルダ容量 (`dirsize`) が使う。
//!
//! Windows ではネットワーク上のパスに触れた時点 (`metadata()` 等) で SMB 接続が走り、サインイン
//! 情報 (NTLM 認証) がサーバへ送られる。そのためファイルシステムに触る前に、文字列だけで判定する。

/// ネットワーク上の場所になり得るパスか。前の空白は除いて判定する。
///
/// - 先頭 2 文字がどちらもパス区切り (`\` か `/`): UNC (`\\server\share` / `//server/share`) と、
///   Win32 の device path (`\\?\UNC\server\share` / `\\.\UNC\...` / `\\?\GLOBALROOT\...`)
/// - `\??\` で始まる: NT の object path (`\??\UNC\server\share`)。Win32 のパス変換がそのまま通す
pub(crate) fn is_network_path(target: &str) -> bool {
    let mut chars = target.trim_start().chars();
    matches!(
        (chars.next(), chars.next(), chars.next(), chars.next()),
        (Some('\\' | '/'), Some('\\' | '/'), _, _)
            | (Some('\\' | '/'), Some('?'), Some('?'), Some('\\' | '/'))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_paths_are_detected() {
        for path in [
            r"\\attacker\share\invoice.exe",
            "//attacker/share/invoice.exe",
            r"\\?\UNC\attacker\share",
            r"\\.\UNC\attacker\share",
            r"\\?\GLOBALROOT\Device\Mup\attacker\share",
            r"\??\UNC\attacker\share",
            "/??/UNC/attacker/share",
            r"\/attacker/share",
            "  //attacker/share",
        ] {
            assert!(is_network_path(path), "{path}");
        }
        for path in [
            "/Users/x/Documents",
            r"C:\Users\x\Documents",
            r"C:\??\x",
            "/?/x",
            "~/Documents",
            "relative/path",
            "",
        ] {
            assert!(!is_network_path(path), "{path}");
        }
    }
}
