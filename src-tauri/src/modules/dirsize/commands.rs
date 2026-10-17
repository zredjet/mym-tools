//! 指定フォルダ配下の容量を集計するTauri command (ADR-0025)。
//!
//! 読み取り専用で、何も書かない (D-06)。結果はフロントが画面を離れた時点で破棄する。
//! 走査は `tauri::async_runtime::spawn_blocking` の単一スレッドで行い、項目ごとに取消しを確かめる。

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;
use crate::operations::OperationGuard;
use crate::state::AppState;

use super::progress::DirSizeProgress;
use super::scan::{scan_inner, DirSizeScanResult, Limits};

#[tauri::command]
pub async fn dirsize_scan(
    state: State<'_, AppState>,
    operation_id: String,
    root_path: String,
    on_progress: Channel<DirSizeProgress>,
) -> Result<DirSizeScanResult, AppError> {
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());
    let id_for_blocking = operation_id.clone();

    let join_result = tauri::async_runtime::spawn_blocking(move || {
        let mut progress = make_channel_sink(on_progress, id_for_blocking.clone());
        let result = scan_inner(
            &root_path,
            Limits::default(),
            &token,
            &id_for_blocking,
            &mut progress,
        );
        if matches!(result, Err(AppError::Cancelled { .. })) {
            progress(DirSizeProgress::Cancelled);
        }
        result
    })
    .await;

    join_result.map_err(AppError::from)?
}

fn make_channel_sink(
    channel: Channel<DirSizeProgress>,
    operation_id: String,
) -> impl FnMut(DirSizeProgress) {
    move |event| {
        if let Err(error) = channel.send(event) {
            tracing::warn!(
                operation_id = %operation_id,
                error = %error,
                "dirsize progress channel send failed; continuing"
            );
        }
    }
}
