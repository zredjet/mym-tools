use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::error::AppError;
use crate::modules::nrbf::protocol::{NrbfProgress, NrbfSummary, SidecarResponse};
use crate::operations::OperationGuard;
use crate::state::AppState;

const MAXIMUM_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAXIMUM_PROTOCOL_BYTES: usize = 64 * 1024 * 1024;
const NODE_BATCH_SIZE: usize = 500;

/// 選択された単一NRBFファイルを専用NativeAOT sidecarで解析する。
#[tauri::command]
pub async fn nrbf_inspect_file(
    app: AppHandle,
    state: State<'_, AppState>,
    operation_id: String,
    path: String,
    on_progress: Channel<NrbfProgress>,
) -> Result<NrbfSummary, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());
    let metadata = std::fs::metadata(&path)
        .map_err(|error| AppError::Io(format!("NRBFファイルを読み込めません: {error}")))?;
    if metadata.len() > MAXIMUM_INPUT_BYTES {
        return Err(AppError::Validation {
            module_id: "nrbf".into(),
            reason: "ファイルサイズが64 MiBの上限を超えています。".into(),
        });
    }
    send_progress(
        &on_progress,
        &operation_id,
        NrbfProgress::Started {
            file_size_bytes: metadata.len(),
        },
    );

    let command = app
        .shell()
        .sidecar("nrbf-decoder")
        .map_err(|error| AppError::Internal(format!("NRBFデコーダーを開始できません: {error}")))?
        .args(["--inspect", path.as_str()]);
    let (mut receiver, child) = command.spawn().map_err(|error| {
        AppError::Internal(format!("NRBFデコーダーの起動に失敗しました: {error}"))
    })?;
    let mut child = Some(child);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let timeout = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            _ = token.cancelled() => {
                if let Some(process) = child.take() { let _ = process.kill(); }
                send_progress(&on_progress, &operation_id, NrbfProgress::Cancelled);
                return Err(AppError::Cancelled { operation_id });
            }
            _ = &mut timeout => {
                if let Some(process) = child.take() { let _ = process.kill(); }
                return Err(AppError::Internal("NRBF解析が60秒の上限を超えたため停止しました。".into()));
            }
            event = receiver.recv() => {
                let Some(event) = event else {
                    if let Some(process) = child.take() { let _ = process.kill(); }
                    return Err(AppError::Internal("NRBFデコーダーとの通信が途中で終了しました。".into()));
                };
                match event {
                    CommandEvent::Stdout(bytes) => {
                        if stdout.len().saturating_add(bytes.len()) > MAXIMUM_PROTOCOL_BYTES {
                            if let Some(process) = child.take() { let _ = process.kill(); }
                            return Err(AppError::Internal("NRBF解析結果が64 MiBの出力上限を超えました。".into()));
                        }
                        stdout.extend_from_slice(&bytes);
                    }
                    CommandEvent::Stderr(bytes) => {
                        let remaining = (64 * 1024usize).saturating_sub(stderr.len());
                        stderr.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                    }
                    CommandEvent::Error(error) => {
                        if let Some(process) = child.take() { let _ = process.kill(); }
                        return Err(AppError::Internal(format!("NRBFデコーダーとの通信に失敗しました: {error}")));
                    }
                    CommandEvent::Terminated(status) => {
                        child.take();
                        let response: SidecarResponse = serde_json::from_slice(&stdout).map_err(|error| {
                            let detail = String::from_utf8_lossy(&stderr);
                            AppError::Internal(format!("NRBFデコーダーから不正な応答を受信しました: {error} {detail}"))
                        })?;
                        if !response.ok || status.code != Some(0) {
                            return Err(AppError::Validation {
                                module_id: "nrbf".into(),
                                reason: response.error.unwrap_or_else(|| "NRBFデコーダーが異常終了しました。".into()),
                            });
                        }
                        let summary = response.summary.ok_or_else(|| {
                            AppError::Internal("NRBFデコーダーの応答にサマリーがありません。".into())
                        })?;
                        validate_sidecar_payload(&response.nodes, &summary)
                            .map_err(AppError::Internal)?;
                        for batch in response.nodes.chunks(NODE_BATCH_SIZE) {
                            if token.is_cancelled() {
                                send_progress(&on_progress, &operation_id, NrbfProgress::Cancelled);
                                return Err(AppError::Cancelled { operation_id });
                            }
                            send_progress(&on_progress, &operation_id, NrbfProgress::Nodes { nodes: batch.to_vec() });
                        }
                        if token.is_cancelled() {
                            send_progress(&on_progress, &operation_id, NrbfProgress::Cancelled);
                            return Err(AppError::Cancelled { operation_id });
                        }
                        send_progress(&on_progress, &operation_id, NrbfProgress::Done { summary: summary.clone() });
                        return Ok(summary);
                    }
                    _ => {}
                }
            }
        }
    }
}

fn validate_sidecar_payload(
    nodes: &[crate::modules::nrbf::protocol::NrbfNode],
    summary: &NrbfSummary,
) -> Result<(), String> {
    if summary.node_count as usize != nodes.len() || nodes.len() > 100_000 {
        return Err("NRBFデコーダーのノード件数が契約と一致しません。".into());
    }
    for (index, node) in nodes.iter().enumerate() {
        let expected_id =
            u32::try_from(index + 1).map_err(|_| "NRBFデコーダーのノードIDが範囲外です。")?;
        if node.id != expected_id || node.parent_id.is_some_and(|parent| parent >= node.id) {
            return Err("NRBFデコーダーのノード階層が不正です。".into());
        }
        if node
            .reference_target_id
            .is_some_and(|target| target == 0 || target >= node.id)
        {
            return Err("NRBFデコーダーの参照先IDが不正です。".into());
        }
        if !matches!(
            node.kind.as_str(),
            "object" | "array" | "scalar" | "null" | "reference" | "unsupported"
        ) || node
            .shape
            .as_ref()
            .is_some_and(|shape| shape.iter().any(|length| *length < 0))
        {
            return Err("NRBFデコーダーのノード形式が不正です。".into());
        }
    }
    Ok(())
}

fn send_progress(channel: &Channel<NrbfProgress>, operation_id: &str, progress: NrbfProgress) {
    if let Err(error) = channel.send(progress) {
        tracing::warn!(%operation_id, %error, "nrbf progress channel send failed; continuing");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::nrbf::protocol::NrbfNode;

    fn summary(node_count: u32) -> NrbfSummary {
        NrbfSummary {
            path: "/tmp/a.bin".into(),
            file_name: "a.bin".into(),
            file_size_bytes: 32,
            root_type: None,
            node_count,
            warnings: vec![],
            duration_ms: 1,
        }
    }

    fn node(id: u32, parent_id: Option<u32>) -> NrbfNode {
        NrbfNode {
            id,
            parent_id,
            display_name: "$".into(),
            raw_name: "$".into(),
            kind: "object".into(),
            type_name: None,
            assembly_name: None,
            formatted_value: None,
            record_id: Some(id.to_string()),
            reference_target_id: None,
            shape: None,
        }
    }

    #[test]
    fn accepts_a_sequential_tree_and_back_reference() {
        let mut nodes = vec![node(1, None), node(2, Some(1))];
        nodes[1].kind = "reference".into();
        nodes[1].reference_target_id = Some(1);
        assert_eq!(validate_sidecar_payload(&nodes, &summary(2)), Ok(()));
    }

    #[test]
    fn rejects_inconsistent_or_forward_pointing_protocol_data() {
        let mut nodes = vec![node(1, None), node(2, Some(1))];
        nodes[1].reference_target_id = Some(2);
        assert!(validate_sidecar_payload(&nodes, &summary(2)).is_err());
        assert!(validate_sidecar_payload(&nodes[..1], &summary(2)).is_err());
    }
}
