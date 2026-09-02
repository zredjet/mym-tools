use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// サイズゲート用の最小疎通。実装フェーズでChannelベースのinspectコマンドへ置き換える。
#[tauri::command]
pub async fn nrbf_native_aot_probe(app: AppHandle, path: String) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("nrbf-decoder")
        .map_err(|error| format!("NRBFデコーダーを開始できません: {error}"))?
        .args(["--probe", path.as_str()])
        .output()
        .await
        .map_err(|error| format!("NRBFデコーダーの実行に失敗しました: {error}"))?;

    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "NRBFデコーダーから不正なUTF-8出力を受信しました。".to_string())?;
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(stdout)
    }
}
