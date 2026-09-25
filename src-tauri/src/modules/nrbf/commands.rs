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
const MAXIMUM_PROTOCOL_BYTES: usize = 256 * 1024 * 1024;
const MAXIMUM_NODES: usize = 500_000;
const NODE_BATCH_SIZE: usize = 500;

/// 選択された単一NRBFファイルを専用NativeAOT sidecarで解析する。
#[tauri::command]
pub async fn nrbf_inspect_file(
    app: AppHandle,
    state: State<'_, AppState>,
    operation_id: String,
    path: String,
    expand_byte_arrays: bool,
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

    let mut arguments = vec!["--inspect", path.as_str()];
    if expand_byte_arrays {
        arguments.push("--expand-byte-arrays");
    }
    let command = app
        .shell()
        .sidecar("nrbf-decoder")
        .map_err(|error| AppError::Internal(format!("NRBFデコーダーを開始できません: {error}")))?
        .args(arguments)
        // sidecar は応答全体を 1 行の JSON で書くため、行単位で受けると最後に 1 度しか
        // Stdout が届かず、256 MiB の上限を受信中に効かせられない。読めた分ずつ受け取る
        .set_raw_out(true);
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
                            return Err(AppError::Internal("NRBF解析結果が256 MiBの出力上限を超えました。".into()));
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
                        // 最大 256 MiB の JSON 解析と 50 万ノードの検証は async worker を塞がないよう
                        // blocking thread で行う
                        let stdout = std::mem::take(&mut stdout);
                        let stderr = std::mem::take(&mut stderr);
                        let (nodes, summary) = tauri::async_runtime::spawn_blocking(move || {
                            parse_sidecar_response(&stdout, &stderr, status.code)
                        })
                        .await??;
                        // clone せず所有権ごと 500 件ずつ送る
                        let mut nodes = nodes.into_iter();
                        loop {
                            let batch: Vec<_> = nodes.by_ref().take(NODE_BATCH_SIZE).collect();
                            if batch.is_empty() {
                                break;
                            }
                            if token.is_cancelled() {
                                send_progress(&on_progress, &operation_id, NrbfProgress::Cancelled);
                                return Err(AppError::Cancelled { operation_id });
                            }
                            send_progress(&on_progress, &operation_id, NrbfProgress::Nodes { nodes: batch });
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

/// sidecar の応答 JSON を解析・検証し、ノード列とサマリーを返す。
fn parse_sidecar_response(
    stdout: &[u8],
    stderr: &[u8],
    exit_code: Option<i32>,
) -> Result<(Vec<crate::modules::nrbf::protocol::NrbfNode>, NrbfSummary), AppError> {
    let response: SidecarResponse = serde_json::from_slice(stdout).map_err(|error| {
        let detail = String::from_utf8_lossy(stderr);
        AppError::Internal(format!(
            "NRBFデコーダーから不正な応答を受信しました: {error} {detail}"
        ))
    })?;
    if !response.ok || exit_code != Some(0) {
        return Err(AppError::Validation {
            module_id: "nrbf".into(),
            reason: response
                .error
                .unwrap_or_else(|| "NRBFデコーダーが異常終了しました。".into()),
        });
    }
    let summary = response
        .summary
        .ok_or_else(|| AppError::Internal("NRBFデコーダーの応答にサマリーがありません。".into()))?;
    validate_sidecar_payload(&response.nodes, &summary).map_err(AppError::Internal)?;
    Ok((response.nodes, summary))
}

fn validate_sidecar_payload(
    nodes: &[crate::modules::nrbf::protocol::NrbfNode],
    summary: &NrbfSummary,
) -> Result<(), String> {
    if summary.node_count as usize != nodes.len() || nodes.len() > MAXIMUM_NODES {
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

    #[test]
    fn node_limit_matches_the_decoder_contract() {
        assert_eq!(MAXIMUM_NODES, 500_000);
        assert_eq!(MAXIMUM_PROTOCOL_BYTES, 256 * 1024 * 1024);
    }

    fn response_json(ok: bool, nodes: Vec<NrbfNode>, summary: Option<NrbfSummary>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "ok": ok,
            "nodes": nodes,
            "summary": summary,
            "error": if ok { None } else { Some("壊れたNRBFです。") },
        }))
        .unwrap()
    }

    #[test]
    fn parses_a_successful_response_with_trailing_newline() {
        let mut stdout = response_json(
            true,
            vec![node(1, None), node(2, Some(1))],
            Some(summary(2)),
        );
        stdout.push(b'\n');
        let (nodes, parsed) = parse_sidecar_response(&stdout, b"", Some(0)).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(parsed.node_count, 2);
    }

    #[test]
    fn reports_decoder_errors_and_non_zero_exit() {
        let failed = response_json(false, vec![], None);
        assert!(matches!(
            parse_sidecar_response(&failed, b"", Some(1)),
            Err(AppError::Validation { reason, .. }) if reason == "壊れたNRBFです。"
        ));
        let ok_but_crashed = response_json(true, vec![node(1, None)], Some(summary(1)));
        assert!(matches!(
            parse_sidecar_response(&ok_but_crashed, b"", Some(3)),
            Err(AppError::Validation { .. })
        ));
    }

    #[test]
    fn rejects_malformed_json_with_stderr_detail() {
        let result = parse_sidecar_response(b"{not json", b"boom", Some(0));
        assert!(matches!(result, Err(AppError::Internal(message)) if message.contains("boom")));
    }
}
