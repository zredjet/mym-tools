//! draw.ioクライアント資産を、IPC権限を持たないloopback originから配信する。

use std::net::TcpListener as StdTcpListener;
use std::path::{Component, PathBuf};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::error::AppError;

const MAX_REQUEST_HEADER_BYTES: usize = 16 * 1024;
const EDITOR_CSP: &str = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' tauri: http://tauri.localhost http://localhost:1420";
static SERVER_PORT: Mutex<Option<u16>> = Mutex::new(None);

/// エディタを初めて開いた時だけ127.0.0.1のランダムportでasset serverを起動する。
///
/// TauriはこのHTTP originをremoteとして扱う。capabilityにremote URLを付与しないため、
/// WindowsでTauri初期化scriptがsubframeへ挿入されてもcore/plugin IPCは拒否される。
#[tauri::command]
pub async fn diagram_editor_url(app: AppHandle) -> Result<String, AppError> {
    let mut server_port = SERVER_PORT
        .lock()
        .map_err(|_| AppError::Io("diagram asset server lock is poisoned".into()))?;
    if let Some(port) = *server_port {
        return Ok(editor_url(port));
    }

    let std_listener = StdTcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| AppError::Io(format!("failed to bind diagram asset server: {error}")))?;
    std_listener.set_nonblocking(true).map_err(|error| {
        AppError::Io(format!("failed to configure diagram asset server: {error}"))
    })?;
    let port = std_listener
        .local_addr()
        .map_err(|error| AppError::Io(format!("failed to inspect diagram asset server: {error}")))?
        .port();
    let listener = TcpListener::from_std(std_listener)
        .map_err(|error| AppError::Io(format!("failed to start diagram asset server: {error}")))?;

    tauri::async_runtime::spawn(async move {
        serve(listener, app, port).await;
    });
    *server_port = Some(port);
    Ok(editor_url(port))
}

fn editor_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/index.html")
}

async fn serve(listener: TcpListener, app: AppHandle, port: u16) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) if peer.ip().is_loopback() => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle_connection(stream, &app, port).await;
                });
            }
            Ok(_) => {}
            Err(error) => {
                tracing::error!(%error, "diagram asset server stopped");
                break;
            }
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    app: &AppHandle,
    port: u16,
) -> std::io::Result<()> {
    let mut request = vec![0_u8; MAX_REQUEST_HEADER_BYTES];
    let mut received = 0;
    loop {
        if received == request.len() {
            return write_response(&mut stream, 431, "text/plain", b"request too large", false)
                .await;
        }
        let read = stream.read(&mut request[received..]).await?;
        if read == 0 {
            return Ok(());
        }
        received += read;
        if request[..received]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            break;
        }
    }

    let (head_only, relative_path) = match parse_request(&request[..received], port) {
        Ok(value) => value,
        Err(status) => {
            return write_response(&mut stream, status, "text/plain", b"invalid request", false)
                .await;
        }
    };

    match load_asset(app, &relative_path) {
        Some((bytes, content_type)) => {
            write_response(&mut stream, 200, &content_type, &bytes, head_only).await
        }
        None => write_response(&mut stream, 404, "text/plain", b"not found", head_only).await,
    }
}

fn parse_request(request: &[u8], port: u16) -> Result<(bool, String), u16> {
    let text = std::str::from_utf8(request).map_err(|_| 400_u16)?;
    let mut lines = text.split("\r\n");
    let mut request_line = lines.next().ok_or(400_u16)?.split_whitespace();
    let method = request_line.next().ok_or(400_u16)?;
    let target = request_line.next().ok_or(400_u16)?;
    if request_line.next() != Some("HTTP/1.1") || request_line.next().is_some() {
        return Err(400);
    }
    let head_only = match method {
        "GET" => false,
        "HEAD" => true,
        _ => return Err(405),
    };
    let expected_host = format!("127.0.0.1:{port}");
    let host = lines.find_map(|line| {
        line.split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
            .map(|(_, value)| value.trim())
    });
    if host != Some(expected_host.as_str()) {
        return Err(400);
    }
    let path = target.split('?').next().ok_or(400_u16)?;
    safe_asset_path(path)
        .map(|path| (head_only, path))
        .ok_or(400_u16)
}

fn load_asset(app: &AppHandle, relative_path: &str) -> Option<(Vec<u8>, String)> {
    let _ = app;
    #[cfg(debug_assertions)]
    {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".generated/public/drawio")
            .join(relative_path);
        std::fs::read(path)
            .ok()
            .map(|bytes| (bytes, content_type_for(relative_path).to_string()))
    }

    #[cfg(not(debug_assertions))]
    {
        app.asset_resolver()
            .get(format!("drawio/{relative_path}"))
            .map(|asset| (asset.bytes, asset.mime_type))
    }
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nContent-Security-Policy: {EDITOR_CSP}\r\nCache-Control: no-store\r\nCross-Origin-Resource-Policy: same-origin\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nPermissions-Policy: camera=(), microphone=(), geolocation=(), payment=()\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    if !head_only {
        stream.write_all(body).await?;
    }
    stream.shutdown().await
}

fn safe_asset_path(uri_path: &str) -> Option<String> {
    let decoded = percent_decode_str(uri_path).decode_utf8().ok()?;
    if decoded.starts_with("//") {
        return None;
    }
    let decoded = decoded.strip_prefix('/').unwrap_or(&decoded).to_string();
    let relative = if decoded.is_empty() {
        "index.html".to_string()
    } else {
        decoded
    };
    let path = PathBuf::from(&relative);
    if path
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        Some(relative)
    } else {
        None
    }
}

#[cfg(debug_assertions)]
fn content_type_for(path: &str) -> &'static str {
    match std::path::Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "eot" => "application/vnd.ms-fontobject",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_expected_loopback_host_and_read_methods() {
        let get = b"GET /js/app.min.js?offline=1 HTTP/1.1\r\nHost: 127.0.0.1:43123\r\n\r\n";
        assert_eq!(
            parse_request(get, 43123),
            Ok((false, "js/app.min.js".into()))
        );
        let head = b"HEAD / HTTP/1.1\r\nHost: 127.0.0.1:43123\r\n\r\n";
        assert_eq!(parse_request(head, 43123), Ok((true, "index.html".into())));
        let wrong_host = b"GET / HTTP/1.1\r\nHost: localhost:43123\r\n\r\n";
        assert_eq!(parse_request(wrong_host, 43123), Err(400));
        let post = b"POST / HTTP/1.1\r\nHost: 127.0.0.1:43123\r\n\r\n";
        assert_eq!(parse_request(post, 43123), Err(405));
    }

    #[test]
    fn accepts_local_asset_paths_and_rejects_traversal() {
        assert_eq!(safe_asset_path("/"), Some("index.html".into()));
        assert_eq!(
            safe_asset_path("/img/Azure%20API.svg"),
            Some("img/Azure API.svg".into())
        );
        assert_eq!(safe_asset_path("/../secret"), None);
        assert_eq!(safe_asset_path("/%2e%2e/secret"), None);
        assert_eq!(safe_asset_path("//server/share"), None);
    }

    #[test]
    fn editor_csp_allows_only_same_origin_connections_and_no_frames() {
        assert!(EDITOR_CSP.contains("connect-src 'self'"));
        assert!(EDITOR_CSP.contains("frame-src 'none'"));
        assert!(EDITOR_CSP.contains("frame-ancestors"));
        assert!(!EDITOR_CSP.contains("https://"));
        assert!(!EDITOR_CSP.contains("ws:"));
    }
}
