fn main() {
    println!("cargo::rustc-check-cfg=cfg(fuzzing)");
    tauri_build::build()
}
