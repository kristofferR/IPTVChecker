use std::env;
use std::path::Path;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(fuzzing)");

    let mut attributes = tauri_build::Attributes::new();
    if embeds_manifest_with_linker() {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
        let manifest = Path::new(&manifest_dir).join("windows-app-manifest.xml");
        println!("cargo::rerun-if-changed={}", manifest.display());
        println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo::rustc-link-arg=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }

    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
}

/// tauri-build links its application manifest into binaries only. A unit test
/// executable then starts without Common Controls v6 and Windows refuses to
/// load it (`STATUS_ENTRYPOINT_NOT_FOUND`). Debug builds on Windows embed the
/// same manifest through the linker instead, which reaches every target.
///
/// Release builds keep tauri-build's own manifest, so the shipped binary is
/// built as before; `cargo test --release` still fails to start on Windows.
/// Cross builds from other hosts are left alone too: their tests cannot run,
/// and lld-link needs `mt.exe` to merge a manifest.
fn embeds_manifest_with_linker() -> bool {
    cfg!(windows)
        && env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && env::var("PROFILE").as_deref() == Ok("debug")
}
