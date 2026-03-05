use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use iptv_checker_lib::engine::checker::check_channel_status_with_debug;
use iptv_checker_lib::models::scan::RetryBackoff;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

const DEFAULT_CHANNELS: usize = 2_000;
const DEFAULT_CONCURRENCY: usize = 16;
const DEFAULT_TIMEOUT_SECS: f64 = 2.0;
const DEFAULT_PAYLOAD_KB: usize = 600;
const FIRST_RESULT_UNSET: u64 = u64::MAX;

#[derive(Clone)]
struct MockResponse {
    status_code: u16,
    reason: &'static str,
    content_type: &'static str,
    body: Arc<Vec<u8>>,
}

impl MockResponse {
    fn to_bytes(&self) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {} {}\r\n", self.status_code, self.reason);
        response.push_str(&format!("Content-Type: {}\r\n", self.content_type));
        response.push_str(&format!("Content-Length: {}\r\n", self.body.len()));
        response.push_str("Connection: close\r\n\r\n");
        let mut out = response.into_bytes();
        out.extend_from_slice(self.body.as_slice());
        out
    }
}

#[derive(Debug, Serialize)]
struct BenchResult {
    channels: usize,
    concurrency: usize,
    timeout_secs: f64,
    payload_kb: usize,
    total_elapsed_ms: u64,
    time_to_first_result_ms: u64,
    throughput_channels_per_sec: f64,
    alive: usize,
    drm: usize,
    dead: usize,
    geoblocked: usize,
    errors: usize,
}

fn parse_arg_usize(args: &[String], key: &str, default: usize) -> usize {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default)
}

fn parse_arg_f64(args: &[String], key: &str, default: f64) -> f64 {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(default)
}

async fn spawn_mock_stream_server(
    response: MockResponse,
) -> Result<(String, tokio::task::JoinHandle<()>), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("failed to bind mock server: {}", error))?;
    let addr = listener
        .local_addr()
        .map_err(|error| format!("failed to read server address: {}", error))?;

    let handle = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let response = response.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let _ = socket.write_all(&response.to_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });

    Ok((format!("http://{}", addr), handle))
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "Usage: cargo run --release --bin backend_bench -- [--channels N] [--concurrency N] [--timeout-secs F] [--payload-kb N]"
        );
        return Ok(());
    }

    let channels = parse_arg_usize(&args, "--channels", DEFAULT_CHANNELS);
    let concurrency = parse_arg_usize(&args, "--concurrency", DEFAULT_CONCURRENCY).max(1);
    let timeout_secs = parse_arg_f64(&args, "--timeout-secs", DEFAULT_TIMEOUT_SECS);
    let payload_kb = parse_arg_usize(&args, "--payload-kb", DEFAULT_PAYLOAD_KB).max(500);

    let payload = Arc::new(vec![b'x'; payload_kb * 1024]);
    let (base_url, server_handle) = spawn_mock_stream_server(MockResponse {
        status_code: 200,
        reason: "OK",
        content_type: "video/mp2t",
        body: payload,
    })
    .await?;

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("failed to build HTTP client: {}", error))?;
    let cancel = CancellationToken::new();
    let semaphore = Arc::new(Semaphore::new(concurrency));
    let (tx, mut rx) = mpsc::unbounded_channel::<Result<String, String>>();

    let first_result_ms = Arc::new(AtomicU64::new(FIRST_RESULT_UNSET));
    let started_at = Instant::now();

    for index in 0..channels {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| format!("failed to acquire benchmark permit: {}", error))?;
        let tx = tx.clone();
        let client = client.clone();
        let cancel = cancel.clone();
        let first_result_ms = Arc::clone(&first_result_ms);
        let url = format!("{}/stream/{}", base_url, index);
        let started_at = started_at;

        tokio::spawn(async move {
            let _permit = permit;
            let result = check_channel_status_with_debug(
                &client,
                &url,
                timeout_secs,
                0,
                RetryBackoff::None,
                None,
                "IPTVCheckerBench/1.0",
                &cancel,
            )
            .await
            .map(|outcome| outcome.status)
            .map_err(|error| error.to_string());

            let elapsed_ms = started_at.elapsed().as_millis() as u64;
            let _ = first_result_ms.compare_exchange(
                FIRST_RESULT_UNSET,
                elapsed_ms,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            let _ = tx.send(result);
        });
    }
    drop(tx);

    let mut alive = 0usize;
    let mut drm = 0usize;
    let mut dead = 0usize;
    let mut geoblocked = 0usize;
    let mut errors = 0usize;

    while let Some(status_result) = rx.recv().await {
        match status_result {
            Ok(status) => match status.as_str() {
                "Alive" => alive += 1,
                "DRM" => drm += 1,
                "Geoblocked" | "Geoblocked (Confirmed)" | "Geoblocked (Unconfirmed)" => {
                    geoblocked += 1
                }
                _ => dead += 1,
            },
            Err(_) => errors += 1,
        }
    }

    let total_elapsed = started_at.elapsed();
    let total_elapsed_secs = total_elapsed.as_secs_f64();
    let throughput = if total_elapsed_secs > 0.0 {
        channels as f64 / total_elapsed_secs
    } else {
        0.0
    };
    let time_to_first_result_ms = first_result_ms.load(Ordering::SeqCst);

    let result = BenchResult {
        channels,
        concurrency,
        timeout_secs,
        payload_kb,
        total_elapsed_ms: total_elapsed.as_millis() as u64,
        time_to_first_result_ms: if time_to_first_result_ms == FIRST_RESULT_UNSET {
            0
        } else {
            time_to_first_result_ms
        },
        throughput_channels_per_sec: throughput,
        alive,
        drm,
        dead,
        geoblocked,
        errors,
    };

    server_handle.abort();

    let rendered = serde_json::to_string_pretty(&result)
        .map_err(|error| format!("failed to render benchmark JSON: {}", error))?;
    println!("{rendered}");

    Ok(())
}
