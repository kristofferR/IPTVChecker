//! macOS-only AirPlay sender bridge built on AVKit.
//!
//! Hands the proxy URL to AVKit and lets Apple's frameworks handle discovery,
//! pairing, and the AirPlay protocol. The receiver (Apple TV / AirPlay 2 audio
//! device) is selected by the user from the AVPlayerView's HUD route picker.
//!
//! Why we still need the media proxy on this path:
//! - Apple TV in URL-mode AirPlay does NOT forward `AVURLAsset` HTTP headers
//!   to the receiver-side fetcher. It opens its own request with its own
//!   `AppleCoreMedia/...` UA, so IPTV portals that filter on UA fail.
//! - Single-credential IPTV servers can't service both the local AVPlayer and
//!   the Apple TV simultaneously without contention. The proxy fan-out keeps
//!   one upstream connection for both.
//!
//! Threading: every AVFoundation/AppKit call MUST run on the AppKit main
//! thread. We dispatch to it via [`tauri::AppHandle::run_on_main_thread`] and
//! wrap the resulting `Retained<...>` handles in [`MainOnly`] so the session
//! struct can live in `AppState` (which is shared across tokio workers).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowStyleMask};
use objc2_av_foundation::{AVPlayer, AVPlayerItem, AVURLAsset};
use objc2_av_kit::{AVPlayerView, AVPlayerViewControlsStyle};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::error::AppError;
use crate::models::airplay::{AirPlayMediaRequest, AirPlaySession, AirPlaySessionState};

pub const AIRPLAY_STATUS_EVENT: &str = "airplay://status";

/// `Retained<NSObject>` is `!Send + !Sync` because Cocoa objects must be
/// touched from the thread that created them. We uphold that invariant by
/// dispatching every access through `AppHandle::run_on_main_thread` — never
/// dereferencing the inner field on a worker thread.
struct MainOnly<T>(T);

unsafe impl<T> Send for MainOnly<T> {}
unsafe impl<T> Sync for MainOnly<T> {}

pub struct ActiveAirPlaySession {
    snapshot: AirPlaySession,
    window: MainOnly<Retained<NSWindow>>,
    player: MainOnly<Retained<AVPlayer>>,
    stopped: Arc<AtomicBool>,
}

impl ActiveAirPlaySession {
    pub fn snapshot(&self) -> AirPlaySession {
        self.snapshot.clone()
    }

    /// Tear down the session: pause the player, close the window, drop the
    /// strong refs (which deallocates on the main thread). Idempotent — a
    /// second call after the user closes the window is a no-op.
    pub async fn stop(self, app: &AppHandle) {
        self.stop_with_state(app, AirPlaySessionState::Stopped).await;
    }

    /// Same as `stop` but doesn't emit a status event. Used when a fresh
    /// session is starting immediately on top of this one — the new
    /// `Playing` event is the source of truth and a stale `Stopped` would
    /// flicker the UI.
    pub async fn stop_silent(self, app: &AppHandle) {
        self.stop_inner(app, None).await;
    }

    async fn stop_with_state(self, app: &AppHandle, terminal: AirPlaySessionState) {
        self.stop_inner(app, Some(terminal)).await;
    }

    async fn stop_inner(self, app: &AppHandle, terminal: Option<AirPlaySessionState>) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let ActiveAirPlaySession {
            snapshot,
            window,
            player,
            stopped: _,
        } = self;
        let _ = app.run_on_main_thread(move || {
            // Move both into the closure so the Retained<...> handles drop
            // here (on the main thread) after pause/close.
            let player = player;
            let window = window;
            unsafe { player.0.pause() };
            window.0.close();
            // refs drop at end-of-scope on the main thread
        });
        if let Some(state) = terminal {
            let mut final_snapshot = snapshot;
            final_snapshot.state = state;
            let _ = app.emit(AIRPLAY_STATUS_EVENT, final_snapshot);
        }
    }
}

/// Start a new AirPlay session. Builds an `AVPlayer` over the LAN-bound proxy
/// URL and presents it in a fresh `AVPlayerView` inside an `NSWindow`. The
/// view's HUD includes the AirPlay route picker so the user can pick an
/// Apple TV (or any AirPlay-capable receiver). Local playback runs in the
/// window until the user routes to a receiver, after which AVPlayer
/// transparently swaps to "external playback" mode and the local view goes
/// quiet.
///
/// All UI is created on the AppKit main thread. The returned handle holds
/// strong refs to the window and player so they survive past this call;
/// dropping the handle (or calling `stop`) tears the session down.
pub async fn start_session(
    app: AppHandle,
    request: AirPlayMediaRequest,
    proxy_url: String,
) -> Result<ActiveAirPlaySession, AppError> {
    let (tx, rx) = oneshot::channel::<
        Result<(MainOnly<Retained<NSWindow>>, MainOnly<Retained<AVPlayer>>), String>,
    >();

    let proxy_url_for_setup = proxy_url.clone();
    let title = request
        .channel_name
        .clone()
        .unwrap_or_else(|| "AirPlay".to_string());

    app.run_on_main_thread(move || {
        let _ = tx.send(build_session_on_main_thread(&proxy_url_for_setup, &title));
    })
    .map_err(|err| {
        AppError::Other(format!(
            "Failed to dispatch AirPlay setup to main thread: {err}"
        ))
    })?;

    let (window, player) = rx
        .await
        .map_err(|_| {
            AppError::Other("AirPlay main-thread setup channel closed unexpectedly".to_string())
        })?
        .map_err(AppError::Other)?;

    let snapshot = AirPlaySession {
        state: AirPlaySessionState::Playing,
        stream_url: proxy_url,
        channel_name: request.channel_name,
        channel_logo: request.channel_logo,
        error_message: None,
        external_playback_active: false,
    };
    let _ = app.emit(AIRPLAY_STATUS_EVENT, snapshot.clone());

    Ok(ActiveAirPlaySession {
        snapshot,
        window,
        player,
        stopped: Arc::new(AtomicBool::new(false)),
    })
}

/// Construct the AVKit object graph (NSURL → AVURLAsset → AVPlayerItem →
/// AVPlayer → AVPlayerView → NSWindow), present the window, and start
/// playback. Returns the `Retained<...>` window and player so the caller
/// can keep them alive and tear them down on stop.
fn build_session_on_main_thread(
    url: &str,
    title: &str,
) -> Result<(MainOnly<Retained<NSWindow>>, MainOnly<Retained<AVPlayer>>), String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "build_session_on_main_thread must run on the main thread".to_string())?;

    unsafe {
        let url_ns = NSString::from_str(url);
        let nsurl =
            NSURL::URLWithString(&url_ns).ok_or_else(|| format!("Invalid AirPlay URL: {url}"))?;

        let asset = AVURLAsset::assetWithURL(&nsurl);
        let item = AVPlayerItem::playerItemWithAsset(&asset, mtm);
        let player = AVPlayer::playerWithPlayerItem(Some(&item), mtm);
        // Default is YES, but we set explicitly so future contributors can see
        // the route picker is intentional rather than default fallout.
        player.setAllowsExternalPlayback(true);

        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(800.0, 450.0));
        let view: Retained<AVPlayerView> =
            AVPlayerView::initWithFrame(mtm.alloc::<AVPlayerView>(), frame);
        view.setPlayer(Some(&player));
        view.setControlsStyle(AVPlayerViewControlsStyle::Floating);

        let style_mask = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Resizable
            | NSWindowStyleMask::Miniaturizable;
        let window: Retained<NSWindow> = NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc::<NSWindow>(),
            frame,
            style_mask,
            NSBackingStoreType::Buffered,
            false,
        );
        // Don't auto-release on close — we keep our own strong ref and want
        // explicit teardown control. Without this, closing the window from
        // the title bar would deallocate a window we still hold a Retained
        // to, leading to a use-after-free when stop() runs.
        window.setReleasedWhenClosed(false);
        let title_ns = NSString::from_str(title);
        window.setTitle(&title_ns);
        window.setContentView(Some(&view));
        window.center();
        window.makeKeyAndOrderFront(None);

        player.play();

        Ok((MainOnly(window), MainOnly(player)))
    }
}
