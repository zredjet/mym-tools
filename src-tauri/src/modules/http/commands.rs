use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::operations::OperationGuard;
use crate::state::AppState;

const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Deserialize)]
pub struct HttpHeaderInput {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpBodyKind {
    None,
    Text,
    Json,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HttpRequestInput {
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeaderInput>,
    pub body_kind: HttpBodyKind,
    pub body: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct HttpHeaderOutput {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct HttpResponseOutput {
    pub status: u16,
    pub status_text: String,
    pub final_url: String,
    pub headers: Vec<HttpHeaderOutput>,
    pub body: String,
    pub body_kind: String,
    pub body_truncated: bool,
    pub bytes_received: u64,
    pub duration_ms: u64,
}

struct ValidatedRequest {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body_kind: HttpBodyKind,
    body: String,
    timeout: Duration,
}

#[tauri::command]
pub async fn http_send_request(
    state: State<'_, AppState>,
    operation_id: String,
    request: HttpRequestInput,
) -> Result<HttpResponseOutput, AppError> {
    let validated = validate_request(request)?;
    let registry = Arc::clone(&state.operations);
    let token = registry.register(operation_id.clone())?;
    let _guard = OperationGuard::new(&registry, operation_id.clone());
    let result = send_request(validated, &token, &operation_id).await;
    if token.is_cancelled() {
        return Err(AppError::Cancelled { operation_id });
    }
    result
}

fn validate_request(request: HttpRequestInput) -> Result<ValidatedRequest, AppError> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| validation("未対応のHTTP methodです"))?;
    if !matches!(
        method,
        Method::GET
            | Method::POST
            | Method::PUT
            | Method::PATCH
            | Method::DELETE
            | Method::HEAD
            | Method::OPTIONS
    ) {
        return Err(validation("未対応のHTTP methodです"));
    }
    let url = Url::parse(&request.url).map_err(|_| validation("URLが不正です"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(validation("http / https URLだけを指定できます"));
    }
    if request.timeout_ms < MIN_TIMEOUT_MS || request.timeout_ms > MAX_TIMEOUT_MS {
        return Err(validation("timeoutは1〜120秒にしてください"));
    }
    if request.body.len() > 2 * 1024 * 1024 {
        return Err(validation("request bodyは2MiB以下にしてください"));
    }
    if request.headers.len() > 100 {
        return Err(validation("headerは100件以下にしてください"));
    }
    if request
        .headers
        .iter()
        .map(|header| header.name.len().saturating_add(header.value.len()))
        .sum::<usize>()
        > 64 * 1024
    {
        return Err(validation("header合計は64KiB以下にしてください"));
    }
    if matches!(request.body_kind, HttpBodyKind::Json) {
        serde_json::from_str::<serde_json::Value>(&request.body)
            .map_err(|_| validation("JSON bodyが不正です"))?;
    }
    let mut headers = HeaderMap::new();
    for input in request.headers {
        let name = HeaderName::from_bytes(input.name.trim().as_bytes())
            .map_err(|_| validation("header名が不正です"))?;
        if matches!(
            name.as_str(),
            "host" | "content-length" | "connection" | "transfer-encoding"
        ) {
            return Err(validation(
                "Host / Content-Length / hop-by-hop headerは自動管理されます",
            ));
        }
        let value =
            HeaderValue::from_str(&input.value).map_err(|_| validation("header値が不正です"))?;
        headers.append(name, value);
    }
    if matches!(request.body_kind, HttpBodyKind::Json) && !headers.contains_key(CONTENT_TYPE) {
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    Ok(ValidatedRequest {
        method,
        url,
        headers,
        body_kind: request.body_kind,
        body: request.body,
        timeout: Duration::from_millis(request.timeout_ms),
    })
}

async fn send_request(
    request: ValidatedRequest,
    token: &tokio_util::sync::CancellationToken,
    operation_id: &str,
) -> Result<HttpResponseOutput, AppError> {
    let started = Instant::now();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(request.timeout)
        .build()?;
    let mut builder = client
        .request(request.method, request.url)
        .headers(request.headers);
    if !matches!(request.body_kind, HttpBodyKind::None) {
        builder = builder.body(request.body);
    }
    let mut response = tokio::select! {
        biased;
        _ = token.cancelled() => return Err(AppError::Cancelled { operation_id: operation_id.to_string() }),
        result = builder.send() => result?,
    };
    let status = response.status();
    let final_url = response.url().to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| HttpHeaderOutput {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<non-UTF8>").to_string(),
        })
        .collect::<Vec<_>>();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_text = content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("javascript");
    let mut bytes = Vec::new();
    let mut bytes_received = 0_u64;
    let mut truncated = false;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(AppError::Cancelled { operation_id: operation_id.to_string() }),
            result = response.chunk() => result?,
        };
        let Some(chunk) = chunk else { break };
        bytes_received = bytes_received.saturating_add(chunk.len() as u64);
        let remaining = MAX_RESPONSE_BYTES.saturating_sub(bytes.len());
        if remaining == 0 {
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining {
            truncated = true;
            break;
        }
    }
    Ok(HttpResponseOutput {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        final_url,
        headers,
        body: if is_text {
            String::from_utf8_lossy(&bytes).into_owned()
        } else {
            String::new()
        },
        body_kind: if is_text { "text" } else { "binary" }.to_string(),
        body_truncated: truncated,
        bytes_received,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

fn validation(reason: &str) -> AppError {
    AppError::Validation {
        module_id: "http".into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

    fn request(url: &str) -> HttpRequestInput {
        HttpRequestInput {
            method: "GET".into(),
            url: url.into(),
            headers: vec![],
            body_kind: HttpBodyKind::None,
            body: String::new(),
            timeout_ms: 30_000,
        }
    }

    #[test]
    fn validation_accepts_http_and_rejects_other_schemes() {
        assert!(validate_request(request("http://127.0.0.1:8080/path")).is_ok());
        assert!(validate_request(request("file:///tmp/a")).is_err());
    }

    #[test]
    fn validation_rejects_invalid_json_and_managed_headers() {
        let mut invalid_json = request("https://example.com");
        invalid_json.body_kind = HttpBodyKind::Json;
        invalid_json.body = "{".into();
        assert!(validate_request(invalid_json).is_err());
        let mut invalid_header = request("https://example.com");
        invalid_header.headers.push(HttpHeaderInput {
            name: "Content-Length".into(),
            value: "9".into(),
        });
        assert!(validate_request(invalid_header).is_err());

        let mut too_many_headers = request("https://example.com");
        too_many_headers.headers = (0..101)
            .map(|index| HttpHeaderInput {
                name: format!("x-test-{index}"),
                value: "value".into(),
            })
            .collect();
        assert!(validate_request(too_many_headers).is_err());
    }

    fn serve_once(
        body: Vec<u8>,
        content_type: &str,
    ) -> (String, tauri::async_runtime::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let content_type = content_type.to_string();
        let handle = tauri::async_runtime::spawn_blocking(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            let _ = stream.write_all(&body);
        });
        (format!("http://{address}/"), handle)
    }

    #[tokio::test]
    async fn send_request_returns_text_response_metadata() {
        let (url, server) = serve_once(br#"{"ok":true}"#.to_vec(), "application/json");
        let validated = validate_request(request(&url)).unwrap();
        let response = send_request(
            validated,
            &tokio_util::sync::CancellationToken::new(),
            "operation",
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, r#"{"ok":true}"#);
        assert_eq!(response.body_kind, "text");
        assert!(!response.body_truncated);
    }

    #[tokio::test]
    async fn send_request_truncates_oversized_response() {
        let body = vec![b'a'; MAX_RESPONSE_BYTES + 1];
        let (url, server) = serve_once(body, "text/plain");
        let validated = validate_request(request(&url)).unwrap();
        let response = send_request(
            validated,
            &tokio_util::sync::CancellationToken::new(),
            "operation",
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(response.body.len(), MAX_RESPONSE_BYTES);
        assert!(response.body_truncated);
        assert!(response.bytes_received > MAX_RESPONSE_BYTES as u64);
    }

    #[tokio::test]
    async fn redirect_does_not_forward_sensitive_headers_to_another_origin() {
        let redirect_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_address = redirect_listener.local_addr().unwrap();
        let target_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let server = tauri::async_runtime::spawn_blocking(move || {
            let (mut redirect_stream, _) = redirect_listener.accept().unwrap();
            let mut redirect_request = [0_u8; 4096];
            let _ = redirect_stream.read(&mut redirect_request);
            write!(
                redirect_stream,
                "HTTP/1.1 302 Found\r\nLocation: http://{target_address}/target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();

            let (mut target_stream, _) = target_listener.accept().unwrap();
            let mut target_request = [0_u8; 4096];
            let size = target_stream.read(&mut target_request).unwrap();
            let request_text = String::from_utf8_lossy(&target_request[..size]).to_lowercase();
            write!(
                target_stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
            )
            .unwrap();
            request_text.contains("authorization:") || request_text.contains("cookie:")
        });

        let mut input = request(&format!("http://{redirect_address}/start"));
        input.headers = vec![
            HttpHeaderInput {
                name: "Authorization".into(),
                value: "Bearer secret".into(),
            },
            HttpHeaderInput {
                name: "Cookie".into(),
                value: "session=secret".into(),
            },
        ];
        let response = send_request(
            validate_request(input).unwrap(),
            &tokio_util::sync::CancellationToken::new(),
            "operation",
        )
        .await
        .unwrap();
        assert_eq!(response.body, "ok");
        assert!(!server.await.unwrap());
    }

    #[tokio::test]
    async fn send_request_honors_precancelled_token() {
        let validated = validate_request(request("http://127.0.0.1:9/")).unwrap();
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let error = send_request(validated, &token, "cancel-me")
            .await
            .unwrap_err();
        assert!(
            matches!(error, AppError::Cancelled { operation_id } if operation_id == "cancel-me")
        );
    }
}
