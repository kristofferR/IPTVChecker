// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `iptv-checker scan ...` runs headless and never starts the app.
    if let Some(code) = iptv_checker_lib::cli::run(std::env::args_os().skip(1)) {
        std::process::exit(code);
    }
    iptv_checker_lib::run()
}
