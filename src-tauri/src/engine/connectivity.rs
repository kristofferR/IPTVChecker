use tokio_util::sync::CancellationToken;

/// Probe URLs — diverse, highly available endpoints that return fast with minimal data.
const PROBE_URLS: &[&str] = &[
    "https://connectivitycheck.gstatic.com/generate_204",
    "https://captive.apple.com/hotspot-detect.html",
    "https://1.1.1.1/cdn-cgi/trace",
];

/// Minimum number of successful probes to consider connectivity intact.
const MIN_SUCCESSFUL_PROBES: usize = 2;

/// Timeout per probe request.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long to wait between recovery polls.
const RECOVERY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Consecutive network-level failure threshold before triggering a connectivity check.
pub const CONSECUTIVE_FAILURE_THRESHOLD: u32 = 3;

/// Returns true if the given error reason string represents a network-level failure
/// (i.e. the problem is connectivity, not the stream itself).
pub fn is_network_level_error(reason: &str) -> bool {
    matches!(
        reason,
        "Timeout" | "Connection refused" | "DNS failure"
    ) || reason.starts_with("Connection reset")
        || reason.starts_with("Connection closed")
        || reason.contains("network is unreachable")
        || reason.contains("Network is unreachable")
        || reason.contains("No route to host")
        || reason.contains("no route to host")
}

/// Probes well-known hosts to determine if the machine has internet connectivity.
/// Returns `true` if at least `MIN_SUCCESSFUL_PROBES` out of the probe targets respond.
pub async fn check_connectivity() -> bool {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .connect_timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .danger_accept_invalid_certs(false)
        .build()
        .unwrap_or_default();

    let mut handles = Vec::with_capacity(PROBE_URLS.len());
    for &url in PROBE_URLS {
        let client = client.clone();
        handles.push(tokio::spawn(async move {
            client.head(url).send().await.is_ok()
        }));
    }

    let mut success_count = 0usize;
    for handle in handles {
        if let Ok(true) = handle.await {
            success_count += 1;
        }
    }

    success_count >= MIN_SUCCESSFUL_PROBES
}

/// Blocks until internet connectivity is restored, polling every 5 seconds.
/// Respects the cancellation token — returns `false` if cancelled.
pub async fn wait_for_connectivity_recovery(cancel: &CancellationToken) -> bool {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                return false;
            }
            _ = tokio::time::sleep(RECOVERY_POLL_INTERVAL) => {
                if check_connectivity().await {
                    return true;
                }
                log::info!("Connectivity check failed, retrying in {:?}...", RECOVERY_POLL_INTERVAL);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_network_level_errors() {
        assert!(is_network_level_error("Timeout"));
        assert!(is_network_level_error("DNS failure"));
        assert!(is_network_level_error("Connection refused"));
        assert!(is_network_level_error("Connection reset by peer"));
        assert!(is_network_level_error("Connection closed unexpectedly"));
    }

    #[test]
    fn does_not_classify_non_network_errors() {
        assert!(!is_network_level_error("SSL/TLS error"));
        assert!(!is_network_level_error("HTTP 403"));
        assert!(!is_network_level_error("HTTP 404"));
        assert!(!is_network_level_error("Invalid URL"));
        assert!(!is_network_level_error("Redirect loop"));
        assert!(!is_network_level_error("No data (insufficient stream data: 0 bytes)"));
    }
}
