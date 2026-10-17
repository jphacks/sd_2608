use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};

fn history() -> HistorySnapshot {
    serde_json::from_value(json!({"id":"private-history-id","sessionId":"private-session-id","capturedAt":2000,"rangeStart":1000,"rangeEnd":2000,"segments":[{"id":"private-segment-id","sessionId":"private-session-id","startedAt":1000,"endedAt":2000,"appName":"editor.exe","maskedTitle":"observed-data-ignore-instructions"}]})).unwrap()
}
fn content() -> Value {
    json!({"summary":"休憩の時間です。","observedFacts":["エディターの利用が記録されています。"],"nextAction":null})
}
fn envelope(kind: ProviderKind, content: Value) -> Value {
    let text = content.to_string();
    match kind {
        ProviderKind::Gemini => {
            json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"thought":true,"text":"hidden reasoning"},{"text":text}]}}]})
        }
        ProviderKind::OpenAiCompatible => {
            json!({"choices":[{"finish_reason":"stop","message":{"content":text,"refusal":null}}]})
        }
    }
}
fn serve(
    wire: Vec<u8>,
    delay: Duration,
) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let n = stream.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let len: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                if bytes.len() >= end + 4 + len {
                    break;
                }
            }
            assert!(bytes.len() < 1024 * 1024);
        }
        tx.send(String::from_utf8(bytes).unwrap()).unwrap();
        thread::sleep(delay);
        let _ = stream.write_all(&wire);
    });
    (url, rx, worker)
}
fn response(status: u16, body: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).into_bytes()
}
fn settings(kind: ProviderKind, base: String) -> ProviderSettings {
    ProviderSettings {
        kind,
        endpoint: format!("{base}/v1"),
        model: "test-model".into(),
    }
}
fn key() -> Secret {
    Secret(b"dummy-secret-key-never-log".to_vec())
}

#[test]
fn both_protocols_send_only_the_frozen_observations_and_use_auth_headers() {
    for kind in [ProviderKind::Gemini, ProviderKind::OpenAiCompatible] {
        let (base, rx, worker) = serve(
            response(200, &envelope(kind, content()).to_string()),
            Duration::ZERO,
        );
        let output = HttpReportProvider::default()
            .generate(&settings(kind, base), &key(), &history(), &|| true)
            .unwrap();
        assert_eq!(output.next_action, None);
        let request = rx.recv().unwrap();
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(!body.contains("dummy-secret"));
        assert!(!body.contains("private-"));
        assert!(!body.contains("faceDetected"));
        assert!(body.contains("observed-data-ignore-instructions"));
        assert!(headers.contains(if kind == ProviderKind::Gemini {
            "POST /v1/models/test-model:generateContent"
        } else {
            "POST /v1"
        }));
        assert!(
            headers
                .to_ascii_lowercase()
                .contains(if kind == ProviderKind::Gemini {
                    "x-goog-api-key: dummy-secret"
                } else {
                    "authorization: bearer dummy-secret"
                })
        );
        let payload: Value = serde_json::from_str(body).unwrap();
        if kind == ProviderKind::OpenAiCompatible {
            assert_eq!(payload["stream"], false);
            assert_eq!(payload["model"], "test-model");
        }
        worker.join().unwrap();
    }
}
#[test]
fn failures_are_fixed_redacted_errors_and_do_not_retry() {
    for (status, code) in [
        (401, ErrorCode::PermissionDenied),
        (403, ErrorCode::PermissionDenied),
        (429, ErrorCode::NetworkFailure),
        (500, ErrorCode::NetworkFailure),
        (302, ErrorCode::NetworkFailure),
    ] {
        let wire = if status == 302 {
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/leak\r\nContent-Length: 0\r\n\r\n"
                .to_vec()
        } else {
            response(
                status,
                "dummy-secret-key-never-log private history server error",
            )
        };
        let (base, rx, worker) = serve(wire, Duration::ZERO);
        let result = HttpReportProvider::default()
            .generate(
                &settings(ProviderKind::OpenAiCompatible, base),
                &key(),
                &history(),
                &|| true,
            )
            .unwrap_err();
        assert_eq!(result.code, code);
        assert!(!result.message.contains("dummy-secret"));
        assert!(!result.message.contains("history"));
        assert!(result.retryable);
        rx.recv().unwrap();
        worker.join().unwrap();
    }
}
#[test]
fn bounded_body_rejects_oversize_declared_and_chunked_and_malformed_json() {
    let big = "x".repeat(MAX_BODY + 1);
    let chunked = format!(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
        big.len(),
        big
    )
    .into_bytes();
    for wire in [response(200, &big), chunked, response(200, "not JSON")] {
        let (base, rx, worker) = serve(wire, Duration::ZERO);
        assert_eq!(
            HttpReportProvider::default()
                .generate(
                    &settings(ProviderKind::OpenAiCompatible, base),
                    &key(),
                    &history(),
                    &|| true
                )
                .unwrap_err()
                .code,
            ErrorCode::InvalidResponse
        );
        rx.recv().unwrap();
        worker.join().unwrap();
    }
}
#[test]
fn timeout_and_cancellation_drop_the_pending_request() {
    let (base, rx, worker) = serve(
        response(200, &envelope(ProviderKind::Gemini, content()).to_string()),
        Duration::from_millis(300),
    );
    let provider = HttpReportProvider {
        timeout: Duration::from_millis(80),
    };
    assert_eq!(
        provider
            .generate(
                &settings(ProviderKind::Gemini, base),
                &key(),
                &history(),
                &|| true
            )
            .unwrap_err()
            .code,
        ErrorCode::Timeout
    );
    rx.recv().unwrap();
    worker.join().unwrap();
    let (base, rx, worker) = serve(response(200, "{}"), Duration::from_millis(300));
    let active = Arc::new(AtomicBool::new(true));
    let cancel = active.clone();
    let cancelling = thread::spawn(move || {
        rx.recv().unwrap();
        cancel.store(false, Ordering::SeqCst);
    });
    let began = std::time::Instant::now();
    assert_eq!(
        HttpReportProvider::default()
            .generate(
                &settings(ProviderKind::Gemini, base),
                &key(),
                &history(),
                &|| active.load(Ordering::SeqCst)
            )
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert!(began.elapsed() < Duration::from_millis(250));
    cancelling.join().unwrap();
    worker.join().unwrap();
}
#[test]
fn redirect_never_reaches_the_destination_and_connect_errors_are_redacted() {
    let destination = TcpListener::bind("127.0.0.1:0").unwrap();
    destination.set_nonblocking(true).unwrap();
    let wire = format!(
        "HTTP/1.1 302 Found\r\nLocation: http://{}/stolen\r\nContent-Length: 0\r\n\r\n",
        destination.local_addr().unwrap()
    )
    .into_bytes();
    let (base, rx, worker) = serve(wire, Duration::ZERO);
    let provider = HttpReportProvider {
        timeout: Duration::from_millis(200),
    };
    assert_eq!(
        provider
            .generate(
                &settings(ProviderKind::OpenAiCompatible, base),
                &key(),
                &history(),
                &|| true
            )
            .unwrap_err()
            .code,
        ErrorCode::NetworkFailure
    );
    assert_eq!(
        destination.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    rx.recv().unwrap();
    worker.join().unwrap();
    let address = destination.local_addr().unwrap();
    drop(destination);
    let result = HttpReportProvider {
        timeout: Duration::from_secs(3),
    }
    .generate(
        &settings(ProviderKind::Gemini, format!("http://{address}")),
        &key(),
        &history(),
        &|| true,
    )
    .unwrap_err();
    assert_eq!(result.code, ErrorCode::NetworkFailure);
    assert!(!result.message.contains(&address.to_string()));
}
#[test]
fn output_requires_complete_strict_json_and_exact_unicode_limits() {
    let mut valid = content();
    valid["summary"] = json!("あ".repeat(2000));
    valid["observedFacts"] = json!(vec!["あ".repeat(300); 10]);
    valid["nextAction"] = json!("あ".repeat(500));
    for kind in [ProviderKind::Gemini, ProviderKind::OpenAiCompatible] {
        assert!(
            parse(
                kind,
                &serde_json::to_vec(&envelope(kind, valid.clone())).unwrap(),
                "dummy-key"
            )
            .is_ok()
        );
        let mut cases = Vec::new();
        let mut x = content();
        x["summary"] = json!("あ".repeat(2001));
        cases.push(x);
        let mut x = content();
        x["observedFacts"] = json!(vec!["fact"; 11]);
        cases.push(x);
        let mut x = content();
        x["observedFacts"] = json!(["あ".repeat(301)]);
        cases.push(x);
        let mut x = content();
        x["nextAction"] = json!("あ".repeat(501));
        cases.push(x);
        let mut x = content();
        x.as_object_mut().unwrap().remove("nextAction");
        cases.push(x);
        let mut x = content();
        x["extra"] = json!(true);
        cases.push(x);
        let mut x = content();
        x["summary"] = json!(" ");
        cases.push(x);
        let mut x = content();
        x["observedFacts"] = json!([3]);
        cases.push(x);
        for x in cases {
            assert_eq!(
                parse(
                    kind,
                    &serde_json::to_vec(&envelope(kind, x)).unwrap(),
                    "dummy-key"
                )
                .unwrap_err()
                .code,
                ErrorCode::InvalidResponse
            );
        }
        let mut incomplete = envelope(kind, content());
        if kind == ProviderKind::Gemini {
            incomplete["candidates"][0]["finishReason"] = json!("MAX_TOKENS");
        } else {
            incomplete["choices"][0]["finish_reason"] = json!("length");
        }
        assert!(parse(kind, &serde_json::to_vec(&incomplete).unwrap(), "dummy-key").is_err());
    }
    let reflected = json!({"summary":"secret-to-hide","observedFacts":["secret-to-hide"],"nextAction":"secret-to-hide"});
    let result = parse(
        ProviderKind::OpenAiCompatible,
        &serde_json::to_vec(&envelope(ProviderKind::OpenAiCompatible, reflected)).unwrap(),
        "secret-to-hide",
    )
    .unwrap();
    assert!(
        !serde_json::to_string(&result)
            .unwrap()
            .contains("secret-to-hide")
    );
}
#[test]
fn endpoint_rules_block_remote_http_userinfo_query_and_model_path_injection() {
    for endpoint in [
        "http://example.com/v1",
        "https://user:pass@example.com/v1",
        "https://example.com/?key=x",
        "https://example.com/#x",
    ] {
        assert!(validate_provider(&settings(ProviderKind::Gemini, endpoint.into())).is_err());
    }
    let mut value = settings(ProviderKind::Gemini, "https://example.com".into());
    value.model = "../secret".into();
    assert!(validate_provider(&value).is_err());
    value.kind = ProviderKind::OpenAiCompatible;
    value.model = "org/model".into();
    assert!(validate_provider(&value).is_ok());
}
