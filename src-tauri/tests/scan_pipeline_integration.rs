use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use iptv_checker_lib::commands::export::{export_csv, export_m3u};
use iptv_checker_lib::engine::checker::check_channel_status_with_debug;
use iptv_checker_lib::engine::parser::parse_m3u;
use iptv_checker_lib::engine::proxy::{confirm_geoblock, test_with_proxy};
use iptv_checker_lib::engine::resume::{
    load_checkpoint_results, load_processed_channels, write_entries, CheckpointWriteEntry,
};
use iptv_checker_lib::models::channel::{ChannelResult, ChannelStatus, ContentType};
use iptv_checker_lib::models::scan::RetryBackoff;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct TestHttpResponse {
    status_code: u16,
    reason: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl TestHttpResponse {
    fn bytes(&self) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {} {}\r\n", self.status_code, self.reason);
        for (name, value) in &self.headers {
            response.push_str(name);
            response.push_str(": ");
            response.push_str(value);
            response.push_str("\r\n");
        }
        response.push_str(&format!("Content-Length: {}\r\n", self.body.len()));
        response.push_str("Connection: close\r\n\r\n");
        let mut out = response.into_bytes();
        out.extend_from_slice(&self.body);
        out
    }
}

async fn spawn_http_server(
    handler: Arc<dyn Fn(&str) -> TestHttpResponse + Send + Sync + 'static>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let addr = listener
        .local_addr()
        .expect("listener should expose local address");

    let handle = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let handler = Arc::clone(&handler);
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let read = socket.read(&mut buf).await.unwrap_or(0);
                if read == 0 {
                    return;
                }

                let request = String::from_utf8_lossy(&buf[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let response = handler(path);
                let _ = socket.write_all(&response.bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });

    (format!("http://{}", addr), handle)
}

fn test_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("test client should build")
}

fn temp_file(name: &str) -> String {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir()
        .join(format!("iptv-checker-{name}-{pid}-{nanos}"))
        .to_string_lossy()
        .to_string()
}

fn make_result(
    index: usize,
    status: ChannelStatus,
    url: &str,
    stream_url: Option<&str>,
) -> ChannelResult {
    ChannelResult {
        index,
        playlist: "fixture.m3u8".to_string(),
        name: format!("Channel {}", index),
        group: "Integration".to_string(),
        language: None,
        tvg_id: None,
        tvg_name: None,
        tvg_logo: None,
        tvg_chno: None,
        catchup: None,
        catchup_days: None,
        catchup_source: None,
        url: url.to_string(),
        content_type: ContentType::Live,
        status,
        codec: None,
        resolution: None,
        width: None,
        height: None,
        fps: None,
        latency_ms: None,
        hdr_format: None,
        video_bitrate: None,
        audio_bitrate: None,
        audio_codec: None,
        audio_channel_layout: None,
        audio_only: false,
        screenshot_path: None,
        screenshot_error_reason: None,
        label_mismatches: Vec::new(),
        low_framerate: false,
        error_message: None,
        channel_id: format!("id-{}", index),
        extinf_line: format!("#EXTINF:-1,Channel {}", index),
        metadata_lines: Vec::new(),
        stream_url: stream_url.map(str::to_string),
        retry_count: None,
        error_reason: None,
        drm_system: None,
    }
}

#[tokio::test]
async fn checker_retries_transient_503_then_marks_alive() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let stream_body = vec![b'x'; 600 * 1024];
    let handler_count = Arc::clone(&request_count);

    let handler = Arc::new(move |_path: &str| {
        let current = handler_count.fetch_add(1, Ordering::SeqCst);
        if current == 0 {
            return TestHttpResponse {
                status_code: 503,
                reason: "Service Unavailable",
                headers: vec![("Content-Type".to_string(), "text/plain".to_string())],
                body: b"retry later".to_vec(),
            };
        }

        TestHttpResponse {
            status_code: 200,
            reason: "OK",
            headers: vec![("Content-Type".to_string(), "video/mp2t".to_string())],
            body: stream_body.clone(),
        }
    });

    let (base_url, server_handle) = spawn_http_server(handler).await;
    let cancel = CancellationToken::new();
    let outcome = check_channel_status_with_debug(
        &test_client(),
        &format!("{base_url}/retry"),
        2.0,
        1,
        RetryBackoff::None,
        None,
        "IPTVCheckerTests/1.0",
        &cancel,
    )
    .await
    .expect("checker request should succeed");

    assert_eq!(outcome.status, ChannelStatus::Alive);
    assert_eq!(outcome.retries_used, 1);
    assert_eq!(request_count.load(Ordering::SeqCst), 2);
    server_handle.abort();
}

#[tokio::test]
async fn proxy_stream_check_succeeds_with_http_proxy_response() {
    let stream_body = vec![b'x'; 600 * 1024];
    let handler = Arc::new(move |_path: &str| TestHttpResponse {
        status_code: 200,
        reason: "OK",
        headers: vec![("Content-Type".to_string(), "video/mp2t".to_string())],
        body: stream_body.clone(),
    });
    let (proxy_url, server_handle) = spawn_http_server(handler).await;

    let ok = test_with_proxy("http://example.com/live.ts", &proxy_url, 2.0, 1).await;
    assert!(ok, "proxy check should accept valid streamed content");
    server_handle.abort();
}

#[tokio::test]
async fn proxy_stream_check_follows_hls_manifest_to_media_segment() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let handler_count = Arc::clone(&request_count);
    let handler = Arc::new(move |path: &str| {
        handler_count.fetch_add(1, Ordering::SeqCst);
        if path.contains("live.m3u8") {
            return TestHttpResponse {
                status_code: 200,
                reason: "OK",
                headers: vec![(
                    "Content-Type".to_string(),
                    "application/vnd.apple.mpegurl".to_string(),
                )],
                body:
                    b"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttp://example.com/segment.ts\n"
                        .to_vec(),
            };
        }

        TestHttpResponse {
            status_code: 200,
            reason: "OK",
            headers: vec![("Content-Type".to_string(), "video/mp2t".to_string())],
            body: vec![b'x'; 200 * 1024],
        }
    });
    let (proxy_url, server_handle) = spawn_http_server(handler).await;

    let ok = test_with_proxy("http://example.com/live.m3u8", &proxy_url, 2.0, 1).await;
    assert!(
        ok,
        "proxy check should follow HLS manifests to a live segment"
    );
    assert_eq!(request_count.load(Ordering::SeqCst), 2);
    server_handle.abort();
}

#[tokio::test]
async fn geoblock_confirmation_unconfirmed_when_proxy_candidates_fail_fast() {
    let result = confirm_geoblock(
        "http://example.com/live.ts",
        &[
            "not-a-proxy".to_string(),
            "still-not-a-proxy".to_string(),
            "also-invalid".to_string(),
        ],
        1.0,
    )
    .await;

    assert_eq!(result, ChannelStatus::GeoblockedUnconfirmed);
}

#[test]
fn checkpoint_batch_roundtrip_keeps_latest_results_and_redacts_secrets() {
    let log_file = temp_file("pipeline-log");
    let checkpoint_file = temp_file("pipeline-checkpoint");

    let entries = vec![
        CheckpointWriteEntry {
            log_entry: "1 - First https://demo:secret@example.com/live.m3u8?token=abc".to_string(),
            result: make_result(
                1,
                ChannelStatus::Dead,
                "https://demo:secret@example.com/live.m3u8?token=abc",
                Some("https://stream.example.com/1.m3u8?auth=token1"),
            ),
        },
        CheckpointWriteEntry {
            log_entry: "2 - Second https://example.com/second.m3u8?key=xyz".to_string(),
            result: make_result(
                2,
                ChannelStatus::Alive,
                "https://example.com/second.m3u8?key=xyz",
                None,
            ),
        },
        CheckpointWriteEntry {
            log_entry: "2 - Second retry https://example.com/second.m3u8?key=xyz".to_string(),
            result: make_result(
                2,
                ChannelStatus::Drm,
                "https://example.com/second.m3u8?key=xyz",
                Some("https://stream.example.com/2.m3u8?session=abc"),
            ),
        },
    ];

    write_entries(&log_file, &checkpoint_file, &entries)
        .expect("batch checkpoint write should succeed");

    let loaded = load_checkpoint_results(&checkpoint_file);
    assert_eq!(loaded.len(), 2, "latest result per index should be kept");
    assert_eq!(loaded[0].index, 1);
    assert_eq!(loaded[1].index, 2);
    assert_eq!(loaded[1].status, ChannelStatus::Drm);
    assert!(loaded[0].url.contains("token=REDACTED"));
    assert!(loaded[0]
        .stream_url
        .as_deref()
        .unwrap_or_default()
        .contains("auth=REDACTED"));

    let (processed, last_index) = load_processed_channels(&log_file);
    assert_eq!(last_index, 2);
    assert_eq!(processed.len(), 2);

    let log_contents = std::fs::read_to_string(&log_file).expect("log file should be readable");
    assert!(!log_contents.contains("secret"));
    assert!(!log_contents.contains("token=abc"));
    assert!(log_contents.contains("token=REDACTED"));

    let _ = std::fs::remove_file(&log_file);
    let _ = std::fs::remove_file(&checkpoint_file);
}

/// Parse -> check -> export, over the same code paths the app uses.
///
/// The unit tests cover each stage in isolation; this one checks that a real
/// playlist survives the whole trip: that parsed channels keep the identity the
/// exporters rely on, that a mixed alive/dead server produces the statuses the
/// "alive only" export filters on, and that the exported M3U can be parsed back.
#[tokio::test]
async fn playlist_round_trips_from_parse_through_check_to_export() {
    let stream_body = vec![b'x'; 600 * 1024];
    let handler = Arc::new(move |path: &str| {
        // /live/2 is the dead one; everything else streams.
        if path.starts_with("/live/2") {
            return TestHttpResponse {
                status_code: 404,
                reason: "Not Found",
                headers: vec![("Content-Type".to_string(), "text/plain".to_string())],
                body: b"gone".to_vec(),
            };
        }
        TestHttpResponse {
            status_code: 200,
            reason: "OK",
            headers: vec![("Content-Type".to_string(), "video/mp2t".to_string())],
            body: stream_body.clone(),
        }
    });
    let (base_url, server_handle) = spawn_http_server(handler).await;

    let playlist = format!(
        "#EXTM3U\n\
         #EXTINF:-1 tvg-id=\"one\" group-title=\"News\",Channel One\n\
         {base_url}/live/1\n\
         #EXTINF:-1 tvg-id=\"two\" group-title=\"News\",Channel Two\n\
         {base_url}/live/2\n\
         #EXTINF:-1 tvg-id=\"three\" group-title=\"Sports\",Channel Three\n\
         {base_url}/live/3\n"
    );

    let preview = parse_m3u(playlist.as_bytes(), "integration.m3u", &None, &None)
        .expect("playlist should parse");
    assert_eq!(preview.total_channels, 3);
    assert_eq!(
        preview.groups,
        vec!["News".to_string(), "Sports".to_string()]
    );

    // Check every parsed channel against the mock server.
    let cancel = CancellationToken::new();
    let mut results = Vec::new();
    for channel in &preview.channels {
        let outcome = check_channel_status_with_debug(
            &test_client(),
            &channel.url,
            2.0,
            0,
            RetryBackoff::None,
            None,
            "IPTVCheckerTests/1.0",
            &cancel,
        )
        .await
        .expect("checker request should complete");

        let mut result = make_result(channel.index, outcome.status, &channel.url, None);
        result.name = channel.name.clone();
        result.group = channel.group.clone();
        result.extinf_line = channel.extinf_line.clone();
        results.push(result);
    }
    server_handle.abort();

    let statuses: Vec<_> = results.iter().map(|result| result.status).collect();
    assert_eq!(
        statuses,
        vec![
            ChannelStatus::Alive,
            ChannelStatus::Dead,
            ChannelStatus::Alive
        ],
        "the 404 channel must be the only dead one"
    );

    // Export only the alive channels, as the "alive only" export scope does.
    let alive: Vec<ChannelResult> = results
        .iter()
        .filter(|result| result.status == ChannelStatus::Alive)
        .cloned()
        .collect();

    let m3u_path = temp_file("roundtrip.m3u");
    export_m3u(alive.clone(), m3u_path.clone())
        .await
        .expect("m3u export should succeed");

    let exported = std::fs::read(&m3u_path).expect("exported m3u should be readable");
    let reparsed =
        parse_m3u(&exported, "exported.m3u", &None, &None).expect("exported m3u should parse");
    assert_eq!(
        reparsed.total_channels, 2,
        "dead channel must not be exported"
    );
    assert_eq!(
        reparsed
            .channels
            .iter()
            .map(|channel| channel.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Channel One", "Channel Three"],
    );

    let csv_path = temp_file("roundtrip.csv");
    export_csv(alive, csv_path.clone(), "integration".to_string(), true)
        .await
        .expect("csv export should succeed");

    let csv = std::fs::read_to_string(&csv_path).expect("exported csv should be readable");
    let data_rows = csv.lines().skip(2).filter(|line| !line.is_empty()).count();
    assert_eq!(data_rows, 2, "csv should hold one row per exported channel");
    assert!(csv.contains("Channel One"));
    assert!(csv.contains("Channel Three"));
    assert!(!csv.contains("Channel Two"));

    let _ = std::fs::remove_file(&m3u_path);
    let _ = std::fs::remove_file(&csv_path);
}
