//! The headless command line: `iptv-checker scan <playlist-or-saved-name>`.
//!
//! Handled before the Tauri app is built, and nothing here touches a window,
//! so a scan runs on a server with no display, from cron or a systemd timer.
//! It uses the app's saved settings and playlists and writes to its scan
//! history, so the app shows the run later.

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::commands::{export, playlist, saved};
use crate::engine::host::{HeadlessHost, Host, SETTINGS_STORE_FILE};
use crate::engine::scan;
use crate::error::AppError;
use crate::models::channel::ChannelResult;
use crate::models::playlist::PlaylistPreview;
use crate::models::scan::{
    MAX_CONCURRENCY, MIN_CONCURRENCY, ScanClientCapabilities, ScanConfig, ScanEvent, ScanProgress,
    ScanSummary,
};
use crate::models::settings::{AppSettings, ScanPresetCollection, ScanPresetConfig};

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
/// The scan was stopped by Ctrl+C or SIGTERM.
pub const EXIT_INTERRUPTED: i32 = 130;

/// The Tauri app identifier, which names the app data directory.
const APP_IDENTIFIER: &str = "com.iptvchecker.gui";
/// The scan state scope a CLI scan runs under, where a window uses its label.
const SCAN_SCOPE: &str = "cli";
const NO_CHANNELS: &str = "The playlist has no channels to check";

const USAGE: &str = "\
Usage: iptv-checker scan <playlist-or-saved-name> [options]

Check every channel of a playlist without opening a window. The run uses the
app's saved settings and appears in its scan history. Every run checks the
whole playlist again.

<playlist-or-saved-name> is the name of a saved playlist, an M3U file or
folder, or a playlist URL.

Options:
      --export <dir>   Write the CSV report, a playlist per status and the
                       renamed playlist to <dir>, replacing an earlier run's
      --preset <name>  Use a saved scan preset instead of the current settings
      --group <name>   Only scan this group
      --search <text>  Only scan channels matching this source filter
  -q, --quiet          Print errors only
  -v, --verbose        Log every channel as it is checked
  -h, --help           Show this help

Exit codes:
  0    the scan completed
  1    the scan failed, found no channels, or lost the network
  2    invalid arguments
  130  interrupted
";

/// Run a command-line invocation and return its exit code, or `None` when
/// the arguments are not a command and the app should start normally.
pub fn run(args: impl IntoIterator<Item = OsString>) -> Option<i32> {
    let mut args = args
        .into_iter()
        .map(|arg| arg.to_string_lossy().into_owned());
    match args.next()?.as_str() {
        "scan" => Some(scan_command(args.collect())),
        "help" | "--help" | "-h" => {
            print_usage();
            Some(EXIT_OK)
        }
        "--version" | "-V" => {
            print_line(&format!("iptv-checker {}", env!("CARGO_PKG_VERSION")));
            Some(EXIT_OK)
        }
        _ => None,
    }
}

/// Printing ignores write errors: a closed pipe (`| head`) must not panic.
fn print_line(line: &str) {
    let _ = writeln!(std::io::stdout(), "{line}");
}

fn print_error(message: &str) {
    let _ = writeln!(std::io::stderr(), "error: {message}");
}

fn print_usage() {
    print_line(USAGE.trim_end());
    print_line("");
    print_line("Scan settings to override for this run:");
    for (key, value) in setting_defaults() {
        let flag = setting_flag(&key);
        if value.is_boolean() {
            print_line(&format!("      --{flag}, --no-{flag}"));
        } else {
            print_line(&format!("      --{flag} <value>"));
        }
    }
}

#[derive(Debug, Default, PartialEq)]
struct ScanArgs {
    target: String,
    export_dir: Option<PathBuf>,
    preset: Option<String>,
    group: Option<String>,
    search: Option<String>,
    /// Scan settings to override, as settings key and raw value.
    overrides: Vec<(String, String)>,
    quiet: bool,
    verbose: bool,
}

#[derive(Debug, PartialEq)]
enum Parsed {
    Scan(ScanArgs),
    Help,
}

/// Every scan setting a preset captures, with its default. The keys are the
/// override flags, so a new scan setting becomes a flag without a change here.
fn setting_defaults() -> Map<String, Value> {
    match serde_json::to_value(ScanPresetConfig::default()) {
        Ok(Value::Object(settings)) => settings,
        _ => Map::new(),
    }
}

fn setting_flag(key: &str) -> String {
    key.replace('_', "-")
}

fn parse_scan_args(args: Vec<String>) -> Result<Parsed, String> {
    let settings = setting_defaults();
    let mut parsed = ScanArgs::default();
    let mut target = None;
    let mut args = args.into_iter();
    let mut options_ended = false;

    while let Some(arg) = args.next() {
        let Some(option) = arg.strip_prefix("--").filter(|_| !options_ended) else {
            match arg.as_str() {
                "-h" if !options_ended => return Ok(Parsed::Help),
                "-q" if !options_ended => parsed.quiet = true,
                "-v" if !options_ended => parsed.verbose = true,
                _ if arg.starts_with('-') && arg.len() > 1 && !options_ended => {
                    return Err(format!("unknown option: {arg}"));
                }
                _ if target.is_some() => {
                    return Err(format!("unexpected argument: {arg}"));
                }
                _ => target = Some(arg),
            }
            continue;
        };
        if option.is_empty() {
            options_ended = true;
            continue;
        }

        let (name, inline_value) = match option.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (option, None),
        };
        let key = name.replace('-', "_");
        // A value that starts with a dash has to be written `--option=value`,
        // so a forgotten value never swallows the next option.
        let value = |args: &mut std::vec::IntoIter<String>| {
            inline_value
                .clone()
                .or_else(|| {
                    let next = args.as_slice().first()?;
                    (!next.starts_with('-')).then(|| args.next()).flatten()
                })
                .ok_or_else(|| format!("--{name} needs a value"))
        };
        match name {
            "help" => return Ok(Parsed::Help),
            "quiet" => parsed.quiet = true,
            "verbose" => parsed.verbose = true,
            "export" => parsed.export_dir = Some(PathBuf::from(value(&mut args)?)),
            "preset" => parsed.preset = Some(value(&mut args)?),
            "group" => parsed.group = Some(value(&mut args)?),
            "search" => parsed.search = Some(value(&mut args)?),
            _ => match settings.get(&key) {
                // A switch: `--skip-screenshots`, or `--skip-screenshots=false`.
                Some(Value::Bool(_)) => parsed
                    .overrides
                    .push((key, inline_value.unwrap_or_else(|| "true".to_string()))),
                Some(_) => parsed.overrides.push((key, value(&mut args)?)),
                None => match key.strip_prefix("no_") {
                    Some(switch) if matches!(settings.get(switch), Some(Value::Bool(_))) => parsed
                        .overrides
                        .push((switch.to_string(), "false".to_string())),
                    _ => return Err(format!("unknown option: --{name}")),
                },
            },
        }
    }

    // A setting's type does not depend on its saved value, so a bad value
    // is known to be one before anything is loaded.
    let mut check = ScanPresetConfig::default();
    for (key, raw) in &parsed.overrides {
        override_setting(&mut check, key, raw)?;
    }

    parsed.target = target.ok_or("missing the playlist to scan")?;
    Ok(Parsed::Scan(parsed))
}

/// Set one scan setting from its command-line text. The text is read as the
/// setting's own type: as JSON where that fits (a number, `null` to clear an
/// optional setting), otherwise as plain text.
fn override_setting(config: &mut ScanPresetConfig, key: &str, raw: &str) -> Result<(), String> {
    let Ok(Value::Object(current)) = serde_json::to_value(&*config) else {
        return Err("could not read the scan settings".to_string());
    };
    let candidates = [
        serde_json::from_str::<Value>(raw).ok(),
        Some(Value::String(raw.to_string())),
    ];
    for candidate in candidates.into_iter().flatten() {
        let mut changed = current.clone();
        changed.insert(key.to_string(), candidate);
        if let Ok(parsed) = serde_json::from_value(Value::Object(changed)) {
            *config = parsed;
            return Ok(());
        }
    }
    Err(format!("invalid value for --{}: {raw}", setting_flag(key)))
}

/// The saved settings, with the chosen preset and then the command-line
/// overrides applied on top.
fn scan_settings(store: &Map<String, Value>, args: &ScanArgs) -> Result<AppSettings, String> {
    // Like the app, fall back to the defaults when the saved ones do not parse.
    let mut settings = match store.get("settings") {
        Some(value) => serde_json::from_value(value.clone()).unwrap_or_else(|error| {
            let _ = writeln!(
                std::io::stderr(),
                "warning: the saved settings are unreadable, using the defaults: {error}"
            );
            AppSettings::default()
        }),
        None => AppSettings::default(),
    };

    if let Some(name) = args.preset.as_deref() {
        let presets = store
            .get("scan_presets")
            .and_then(|value| serde_json::from_value::<ScanPresetCollection>(value.clone()).ok())
            .unwrap_or_default();
        presets
            .presets
            .iter()
            .find(|preset| preset.name.eq_ignore_ascii_case(name))
            .ok_or_else(|| format!("There is no scan preset named \"{name}\""))?
            .config
            .apply_to_settings(&mut settings);
    }

    let mut config = ScanPresetConfig::from_settings(&settings);
    for (key, raw) in &args.overrides {
        override_setting(&mut config, key, raw)?;
    }
    config.apply_to_settings(&mut settings);
    Ok(settings)
}

fn app_data_dir() -> Result<PathBuf, String> {
    // The app data directory, resolved the way Tauri does.
    dirs::data_dir()
        .map(|dir| dir.join(APP_IDENTIFIER))
        .ok_or_else(|| "Could not find the app data directory".to_string())
}

/// The app's settings store. A machine the app never ran on has none, which
/// reads as an empty store: default settings and no saved playlists.
fn load_store(data_dir: &Path) -> Result<Map<String, Value>, String> {
    let path = data_dir.join(SETTINGS_STORE_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

/// Resolve concurrency for a scan, like `resolveSmartConcurrency` in the app.
/// 0 is auto: the Xtream connection limit, else 1 for a single server and 10
/// for several. An explicit choice is still capped at the Xtream limit.
fn resolve_concurrency(setting: u32, single_provider: bool, xtream_max: Option<u32>) -> u32 {
    let explicit = (setting != 0).then(|| setting.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY));
    match xtream_max.filter(|max| *max > 0) {
        Some(max) => {
            let max = max.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY);
            explicit.map_or(max, |explicit| explicit.min(max))
        }
        None => explicit.unwrap_or(if single_provider { 1 } else { 10 }),
    }
}

/// The scan the app would start for this playlist with these settings.
fn scan_config(settings: &AppSettings, preview: &PlaylistPreview, args: &ScanArgs) -> ScanConfig {
    ScanConfig {
        file_path: preview.file_path.clone(),
        source_identity: preview.source_identity.clone(),
        playlist_display_name: Some(preview.file_name.clone()),
        group_filter: args.group.clone(),
        channel_search: args.search.clone(),
        selected_indices: None,
        hide_vod_content: settings.hide_vod_content,
        timeout: settings.timeout,
        extended_timeout: settings.extended_timeout,
        concurrency: resolve_concurrency(
            settings.concurrency,
            preview.single_provider,
            preview.xtream_max_connections,
        ),
        retries: settings.retries,
        retry_backoff: settings.retry_backoff,
        user_agent: settings.user_agent.clone(),
        skip_screenshots: settings.skip_screenshots,
        profile_bitrate: settings.profile_bitrate,
        ffprobe_timeout_secs: settings.ffprobe_timeout_secs,
        ffmpeg_bitrate_timeout_secs: settings.ffmpeg_bitrate_timeout_secs,
        accept_invalid_certs: settings.accept_invalid_certs,
        proxy_file: settings.proxy_file.clone(),
        test_geoblock: settings.test_geoblock,
        screenshots_dir: settings.screenshots_dir.clone(),
        auto_capture_sample_clips: settings.auto_capture_sample_clips,
        sample_clip_duration_secs: settings.sample_clip_duration_secs,
        client_capabilities: Some(ScanClientCapabilities {
            event_batch_v1: true,
        }),
    }
}

/// Open what the user named: a saved playlist (by name or id), else a
/// playlist URL, else a file or folder.
async fn open_target(host: &dyn Host, args: &ScanArgs) -> Result<PlaylistPreview, AppError> {
    let target = args.target.trim();
    let (group, search) = (args.group.clone(), args.search.clone());

    let name = target.to_lowercase();
    let saved = saved::load_saved_playlists(host)?
        .into_iter()
        .filter(|entry| entry.id == target || entry.display_name.to_lowercase() == name)
        .collect::<Vec<_>>();
    match saved.as_slice() {
        [entry] => {
            return Ok(saved::open_saved_entry(host, entry, group, search)
                .await?
                .preview);
        }
        [] => {}
        several => {
            return Err(AppError::Validation(format!(
                "Several saved playlists are named \"{target}\". Use an id instead: {}",
                several
                    .iter()
                    .map(|entry| entry.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
    }

    if target.starts_with("http://") || target.starts_with("https://") {
        return playlist::open_playlist_from_url(host, target.to_string(), group, search).await;
    }
    if !Path::new(target).exists() {
        return Err(AppError::Validation(format!(
            "There is no saved playlist named \"{target}\", and no such file or folder"
        )));
    }
    // The app always holds absolute paths, and a scan's resume and media
    // files are keyed on the path as written.
    let path = std::path::absolute(target)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| target.to_string());
    playlist::open_playlist_path(host, path, group, search).await
}

/// Create the export folder and check it can be written to before the scan,
/// so one that cannot be used fails the run at once rather than after it. A
/// folder inside a scanned folder is refused: the next run would scan the
/// exported playlists.
fn prepare_export_dir(export_dir: &Path, playlist_path: &str) -> Result<(), String> {
    let probe = export_dir.join(".iptv-checker-export-check");
    std::fs::create_dir_all(export_dir)
        .and_then(|()| std::fs::write(&probe, b""))
        .and_then(|()| std::fs::remove_file(&probe))
        .map_err(|error| format!("Could not write to {}: {error}", export_dir.display()))?;
    let scanned = Path::new(playlist_path);
    if scanned.is_dir()
        && let (Ok(export_dir), Ok(scanned)) = (export_dir.canonicalize(), scanned.canonicalize())
        && export_dir.starts_with(scanned)
    {
        return Err(format!(
            "{} is inside the folder being scanned, so the next scan would check the exported playlists too",
            export_dir.display()
        ));
    }
    Ok(())
}

/// A file name stem for a playlist's exports.
fn export_stem(playlist_name: &str) -> String {
    let name = playlist_name.trim();
    // ASCII lowercasing keeps byte offsets, so the suffix length is the same.
    let lowercase = name.to_ascii_lowercase();
    let name = [".m3u8", ".m3u"]
        .iter()
        .find(|extension| lowercase.ends_with(*extension))
        .map_or(name, |extension| &name[..name.len() - extension.len()]);
    let stem = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>();
    let stem = stem.trim_matches(['.', ' ']);
    if stem.is_empty() {
        "playlist".to_string()
    } else {
        stem.to_string()
    }
}

/// Write the exports the app's Export menu offers for a whole playlist: the
/// CSV report, one playlist per status, and the renamed playlist. Unlike the
/// menu, a status with no channels gets an empty playlist: the folder is
/// written to run after run and must not keep an earlier run's.
async fn write_exports(
    dir: &Path,
    playlist_name: &str,
    mut results: Vec<ChannelResult>,
) -> Result<(), AppError> {
    // Results arrive in the order they finished; exports follow the playlist.
    results.sort_by_key(|result| result.index);

    let stem = export_stem(playlist_name);
    let csv = dir.join(format!("{stem}.csv"));
    let playlist = dir
        .join(format!("{stem}.m3u8"))
        .to_string_lossy()
        .into_owned();
    export::export_csv(
        results.clone(),
        csv.to_string_lossy().into_owned(),
        playlist_name.to_string(),
        true,
    )
    .await?;
    export::write_split_playlists(&results, &playlist, true)?;
    export::export_renamed(results, playlist).await
}

/// Where the CLI writes for the person or log watching it: errors and
/// progress to stderr, the result to stdout.
struct Console {
    quiet: bool,
    /// stderr is a terminal, so progress is one line redrawn in place.
    live: bool,
    /// When progress was last written, and the line that was.
    last_progress: Mutex<Option<(Instant, String)>>,
    /// Stops the running scan.
    stop: OnceLock<CancellationToken>,
    network_lost: AtomicBool,
}

/// Erases the progress line before something else is written over it.
const CLEAR_LINE: &str = "\r\x1b[2K";

impl Console {
    fn new(quiet: bool) -> Self {
        Self {
            quiet,
            live: !quiet && std::io::stderr().is_terminal(),
            last_progress: Mutex::new(None),
            stop: OnceLock::new(),
            network_lost: AtomicBool::new(false),
        }
    }

    fn status(&self, line: &str) {
        if !self.quiet {
            let clear = if self.live { CLEAR_LINE } else { "" };
            let _ = writeln!(std::io::stderr(), "{clear}{line}");
        }
    }

    /// Scan events worth telling the person watching about.
    fn on_event(&self, event: &str, payload: &str) {
        match event {
            "scan://progress" => {
                if let Ok(event) = serde_json::from_str::<ScanEvent<ScanProgress>>(payload) {
                    self.progress(&event.payload);
                }
            }
            // The app waits for the network with someone watching. Nobody
            // is here, so the run fails and the next scheduled one retries.
            "scan://network-paused" => {
                self.network_lost.store(true, Ordering::Relaxed);
                if let Some(stop) = self.stop.get() {
                    stop.cancel();
                }
            }
            "scan://screenshots-paused" => {
                self.status("Disk space is low. No more screenshots or clips this scan.");
            }
            _ => {}
        }
    }

    fn progress(&self, progress: &ScanProgress) {
        if self.quiet {
            return;
        }
        // A terminal redraws a few times a second; a log gets a line a minute.
        let interval = Duration::from_millis(if self.live { 250 } else { 60_000 });
        let Ok(mut last) = self.last_progress.lock() else {
            return;
        };
        let line = format!(
            "{}/{} checked, {} alive, {} dead",
            progress.completed, progress.total, progress.alive, progress.dead
        );
        // The last channel always shows, once.
        let finished = progress.completed >= progress.total;
        if let Some((at, previous)) = last.as_ref()
            && (*previous == line || (!finished && at.elapsed() < interval))
        {
            return;
        }
        *last = Some((Instant::now(), line.clone()));
        let mut stderr = std::io::stderr();
        let _ = if self.live {
            write!(stderr, "{CLEAR_LINE}{line}")
        } else {
            writeln!(stderr, "{line}")
        };
        let _ = stderr.flush();
    }

    fn clear_progress(&self) {
        if self.live {
            let mut stderr = std::io::stderr();
            let _ = write!(stderr, "{CLEAR_LINE}");
            let _ = stderr.flush();
        }
    }
}

/// The engine logs through `log`; the CLI sends that to stderr.
struct StderrLog {
    level: log::LevelFilter,
    live: bool,
}

impl log::Log for StderrLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            let clear = if self.live { CLEAR_LINE } else { "" };
            let _ = writeln!(
                std::io::stderr(),
                "{clear}{}: {}",
                record.level().as_str().to_lowercase(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

fn format_elapsed(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    match (secs / 3600, secs % 3600 / 60, secs % 60) {
        (0, 0, secs) => format!("{secs}s"),
        (0, mins, secs) => format!("{mins}m {secs:02}s"),
        (hours, mins, _) => format!("{hours}h {mins:02}m"),
    }
}

fn format_summary(summary: &ScanSummary, elapsed: Duration) -> String {
    let mut counts = vec![
        format!("{} alive", summary.alive),
        format!("{} dead", summary.dead),
    ];
    for (count, label) in [
        (summary.placeholder, "placeholder"),
        (summary.geoblocked, "geoblocked"),
        (summary.drm, "DRM-protected"),
    ] {
        if count > 0 {
            counts.push(format!("{count} {label}"));
        }
    }
    format!(
        "Checked {} {} in {}: {}",
        summary.total,
        if summary.total == 1 {
            "channel"
        } else {
            "channels"
        },
        format_elapsed(elapsed),
        counts.join(", ")
    )
}

/// Ctrl+C or SIGTERM, whichever comes first.
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            },
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// The first signal stops the scan cleanly; a second one quits at once.
fn stop_on_signal(cancel: CancellationToken, console: Arc<Console>) {
    tokio::spawn(async move {
        stop_signal().await;
        console.status("Stopping the scan.");
        cancel.cancel();
        stop_signal().await;
        std::process::exit(EXIT_INTERRUPTED);
    });
}

/// Scan the playlist `args` names and report the result. `watch_for_stop`
/// gets the token that stops the scan, to cancel when the user asks.
async fn run_scan(
    data_dir: PathBuf,
    store: Map<String, Value>,
    settings: AppSettings,
    args: &ScanArgs,
    console: Arc<Console>,
    watch_for_stop: fn(CancellationToken, Arc<Console>),
) -> Result<i32, String> {
    let host = HeadlessHost::new(data_dir, store, {
        let console = Arc::clone(&console);
        move |event, payload| console.on_event(event, payload)
    });
    *host.app_state().settings.lock().await = settings.clone();

    let preview = open_target(&host, args)
        .await
        .map_err(|error| error.to_string())?;
    let config = scan_config(&settings, &preview, args);
    // An error page served as a playlist parses to nothing. That is a failed
    // run, not an empty result to record and export over the last good one.
    if scan::scannable_channels(&preview, &config).is_empty() {
        return Err(NO_CHANNELS.to_string());
    }
    if let Some(dir) = &args.export_dir {
        prepare_export_dir(dir, &preview.file_path)?;
    }
    console.status(&format!("Scanning {}", preview.file_name));

    let started_at = Instant::now();
    let pending = scan::begin_scan(host.app_state(), SCAN_SCOPE, config)
        .await
        .map_err(|error| error.to_string())?
        .fresh();
    let _ = console.stop.set(pending.cancel_token());
    watch_for_stop(pending.cancel_token(), Arc::clone(&console));
    let outcome = pending.run(Arc::new(host.clone())).await;
    console.clear_progress();
    let outcome = outcome.map_err(|error| error.to_string())?;
    if console.network_lost.load(Ordering::Relaxed) {
        return Err("The network went down during the scan".to_string());
    }
    if outcome.cancelled {
        console.status("The scan was stopped before it finished.");
        return Ok(EXIT_INTERRUPTED);
    }
    // The playlist changed under the scan: never export nothing over a
    // good run.
    if outcome.summary.total == 0 {
        return Err(NO_CHANNELS.to_string());
    }

    if let Some(dir) = &args.export_dir {
        write_exports(dir, &preview.file_name, outcome.results)
            .await
            .map_err(|error| format!("Could not write the exports: {error}"))?;
    }
    if !args.quiet {
        print_line(&format_summary(&outcome.summary, started_at.elapsed()));
        if let Some(dir) = &args.export_dir {
            print_line(&format!("Exports are in {}", dir.display()));
        }
    }
    // The app only shows what is in its history, so an unsaved run failed.
    match outcome.history_error {
        Some(error) => Err(format!(
            "The scan finished, but could not be saved to scan history: {error}"
        )),
        None => Ok(EXIT_OK),
    }
}

fn scan_command(args: Vec<String>) -> i32 {
    let args = match parse_scan_args(args) {
        Ok(Parsed::Scan(args)) => args,
        Ok(Parsed::Help) => {
            print_usage();
            return EXIT_OK;
        }
        Err(message) => {
            print_error(&message);
            let _ = writeln!(
                std::io::stderr(),
                "Run `iptv-checker scan --help` for the options."
            );
            return EXIT_USAGE;
        }
    };

    let console = Arc::new(Console::new(args.quiet));
    let run = || {
        let data_dir = app_data_dir()?;
        let store = load_store(&data_dir)?;
        let settings = scan_settings(&store, &args)?;

        // The saved log level applies here too; `-v` raises it to every channel.
        let level = match (args.quiet, args.verbose) {
            (true, _) => log::LevelFilter::Error,
            (false, true) => settings.level_filter().max(log::LevelFilter::Info),
            (false, false) => settings.level_filter(),
        };
        let logger = StderrLog {
            level,
            live: console.live,
        };
        if log::set_boxed_logger(Box::new(logger)).is_ok() {
            log::set_max_level(level);
        }

        // Tauri's runtime is plain tokio; using it keeps the engine's
        // `tauri::async_runtime::spawn` calls on the same runtime.
        tauri::async_runtime::block_on(run_scan(
            data_dir,
            store,
            settings,
            &args,
            Arc::clone(&console),
            stop_on_signal,
        ))
    };
    match run() {
        Ok(code) => code,
        Err(message) => {
            print_error(&message);
            EXIT_FAILED
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Parsed, String> {
        parse_scan_args(args.iter().map(|arg| arg.to_string()).collect())
    }

    fn scan_args(args: &[&str]) -> ScanArgs {
        match parse(args) {
            Ok(Parsed::Scan(args)) => args,
            other => panic!("expected scan arguments, got {other:?}"),
        }
    }

    #[test]
    fn app_identifier_matches_the_tauri_config() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_IDENTIFIER);
    }

    #[test]
    fn only_commands_keep_the_app_from_starting() {
        let args = |args: &[&str]| args.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(run(args(&[])), None);
        assert_eq!(run(args(&["/playlists/sample.m3u"])), None);
        assert_eq!(run(args(&["scan"])), Some(EXIT_USAGE));
    }

    #[test]
    fn options_and_setting_overrides_parse() {
        let args = scan_args(&[
            "Sample Provider",
            "--export",
            "/tmp/out",
            "--timeout=5",
            "--user-agent",
            "Sample/1.0",
            "--skip-screenshots",
            "--no-profile-bitrate",
            "--test-geoblock=false",
            "-q",
        ]);
        assert_eq!(args.target, "Sample Provider");
        assert_eq!(args.export_dir, Some(PathBuf::from("/tmp/out")));
        assert!(args.quiet);
        assert_eq!(
            args.overrides,
            [
                ("timeout", "5"),
                ("user_agent", "Sample/1.0"),
                ("skip_screenshots", "true"),
                ("profile_bitrate", "false"),
                ("test_geoblock", "false"),
            ]
            .map(|(key, value)| (key.to_string(), value.to_string()))
        );
    }

    #[test]
    fn bad_arguments_are_usage_errors() {
        assert!(parse(&[]).is_err());
        assert!(parse(&["a.m3u", "b.m3u"]).is_err());
        assert!(parse(&["a.m3u", "--no-such-setting", "1"]).is_err());
        assert!(parse(&["a.m3u", "--no-timeout"]).is_err());
        assert!(parse(&["a.m3u", "--export"]).is_err());
        // A forgotten value does not swallow the next option.
        assert!(parse(&["a.m3u", "--export", "--quiet"]).is_err());
        assert_eq!(
            scan_args(&["a.m3u", "--search=-HD"]).search.as_deref(),
            Some("-HD")
        );
        assert!(parse(&["a.m3u", "--timeout", "soon"]).is_err());
        assert_eq!(parse(&["--help"]), Ok(Parsed::Help));
        // After `--`, a name starting with a dash is the playlist.
        assert_eq!(scan_args(&["--", "-odd-name.m3u"]).target, "-odd-name.m3u");
    }

    #[test]
    fn overrides_are_read_as_the_settings_own_type() {
        let mut config = ScanPresetConfig::default();
        override_setting(&mut config, "timeout", "5").unwrap();
        override_setting(&mut config, "user_agent", "123").unwrap();
        override_setting(&mut config, "extended_timeout", "20").unwrap();
        override_setting(&mut config, "screenshots_dir", "2024").unwrap();
        override_setting(&mut config, "retry_backoff", "linear").unwrap();
        assert_eq!(config.timeout, 5.0);
        assert_eq!(config.user_agent, "123");
        assert_eq!(config.extended_timeout, Some(20.0));
        assert_eq!(config.screenshots_dir.as_deref(), Some("2024"));
        assert_eq!(
            config.retry_backoff,
            crate::models::scan::RetryBackoff::Linear
        );

        override_setting(&mut config, "screenshots_dir", "null").unwrap();
        assert_eq!(config.screenshots_dir, None);
        assert!(override_setting(&mut config, "timeout", "soon").is_err());
        assert_eq!(config.timeout, 5.0);
    }

    #[test]
    fn flags_override_the_preset_which_overrides_saved_settings() {
        let store = serde_json::json!({
            "settings": { "timeout": 8.0, "retries": 1, "user_agent": "Saved/1.0" },
            "scan_presets": { "presets": [{
                "name": "Thorough",
                "config": { "timeout": 30.0, "retries": 5, "user_agent": "Preset/1.0" },
            }] },
        });
        let Value::Object(store) = store else {
            unreachable!()
        };

        let saved = scan_settings(&store, &scan_args(&["a.m3u"])).unwrap();
        assert_eq!((saved.timeout, saved.retries), (8.0, 1));

        let args = scan_args(&["a.m3u", "--preset", "thorough", "--retries", "2"]);
        let settings = scan_settings(&store, &args).unwrap();
        assert_eq!((settings.timeout, settings.retries), (30.0, 2));
        assert_eq!(settings.user_agent, "Preset/1.0");

        assert!(scan_settings(&store, &scan_args(&["a.m3u", "--preset", "Missing"])).is_err());
    }

    #[test]
    fn concurrency_resolves_like_the_app() {
        // Auto: the Xtream limit, else one connection per single server.
        assert_eq!(resolve_concurrency(0, true, None), 1);
        assert_eq!(resolve_concurrency(0, false, None), 10);
        assert_eq!(resolve_concurrency(0, true, Some(3)), 3);
        assert_eq!(resolve_concurrency(0, false, Some(50)), 20);
        // Explicit: kept, but never above the Xtream limit.
        assert_eq!(resolve_concurrency(6, true, None), 6);
        assert_eq!(resolve_concurrency(6, false, Some(2)), 2);
        assert_eq!(resolve_concurrency(99, false, None), 20);
        assert_eq!(resolve_concurrency(4, false, Some(0)), 4);
    }

    #[test]
    fn export_names_are_safe_file_stems() {
        assert_eq!(export_stem("channels.m3u"), "channels");
        assert_eq!(export_stem("Channels.M3U8"), "Channels");
        assert_eq!(
            export_stem("provider.example (viewer)"),
            "provider.example (viewer)"
        );
        assert_eq!(export_stem("a/b:c"), "a_b_c");
        assert_eq!(export_stem(" .. "), "playlist");
    }

    /// Serves stream-like bytes for `/alive` and 404 for everything else.
    async fn spawn_stream_server() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = vec![0u8; 4096];
                    let read = socket.read(&mut request).await.unwrap_or(0);
                    let alive = String::from_utf8_lossy(&request[..read]).starts_with("GET /alive");
                    let (status, body) = if alive {
                        ("200 OK", vec![0x47u8; 600 * 1024])
                    } else {
                        ("404 Not Found", Vec::new())
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn a_headless_scan_writes_exports_and_history() {
        let root = std::env::temp_dir().join(format!(
            "iptv-cli-scan-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (data_dir, exports) = (root.join("data"), root.join("exports"));
        std::fs::create_dir_all(&root).unwrap();
        let server = spawn_stream_server().await;
        let playlist = root.join("channels.m3u");
        std::fs::write(
            &playlist,
            format!(
                "#EXTM3U\n#EXTINF:-1 group-title=\"Samples\",Sample One\n{server}/alive\n\
                 #EXTINF:-1 group-title=\"Samples\",Sample Two\n{server}/gone\n"
            ),
        )
        .unwrap();

        let args = scan_args(&[
            playlist.to_str().unwrap(),
            "--export",
            exports.to_str().unwrap(),
            "--skip-screenshots",
            "--retries=0",
            "--timeout=5",
            "--ffprobe-timeout-secs=1",
            "--quiet",
        ]);
        let store = Map::new();
        let settings = scan_settings(&store, &args).unwrap();
        let code = run_scan(
            data_dir.clone(),
            store,
            settings,
            &args,
            Arc::new(Console::new(args.quiet)),
            |_, _| {},
        )
        .await;
        assert_eq!(code, Ok(EXIT_OK));

        let csv = std::fs::read_to_string(exports.join("channels.csv")).unwrap();
        assert!(csv.contains(",Alive,Samples,Sample One,"), "{csv}");
        assert!(csv.contains(",Dead,Samples,Sample Two,"), "{csv}");
        for file in [
            "channels_working.m3u8",
            "channels_dead.m3u8",
            "channels_renamed.m3u8",
        ] {
            assert!(exports.join(file).is_file(), "{file} is missing");
        }
        // A status with no channels still replaces what an earlier run left.
        let geoblocked = std::fs::read_to_string(exports.join("channels_geoblocked.m3u8"));
        assert_eq!(geoblocked.unwrap().trim(), "#EXTM3U");

        // The app reads the run from the same history files.
        let history = data_dir.join("scan-history-v2");
        let index: Value =
            serde_json::from_slice(&std::fs::read(history.join("index.json")).unwrap()).unwrap();
        let entries = index["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["summary"]["alive"], 1);
        assert_eq!(entries[0]["summary"]["dead"], 1);
        let run_file = format!("{}.json", entries[0]["id"].as_str().unwrap());
        assert!(history.join("runs").join(run_file).is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn summaries_leave_out_empty_statuses() {
        let summary = ScanSummary {
            total: 12,
            alive: 9,
            dead: 2,
            placeholder: 0,
            geoblocked: 1,
            drm: 0,
            low_framerate: 0,
            mislabeled: 0,
            playlist_score: None,
        };
        assert_eq!(
            format_summary(&summary, Duration::from_secs(312)),
            "Checked 12 channels in 5m 12s: 9 alive, 2 dead, 1 geoblocked"
        );
        assert_eq!(format_elapsed(Duration::from_secs(42)), "42s");
        assert_eq!(format_elapsed(Duration::from_secs(3780)), "1h 03m");
    }
}
