#![no_main]

use iptv_checker_lib::engine::parser::find_playlists_in_dir;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let depth = data.first().map(|byte| usize::from(*byte) % 96).unwrap_or(0);
    let fingerprint = data
        .iter()
        .fold(0u64, |acc, byte| acc.wrapping_mul(16777619) ^ u64::from(*byte));

    let root = std::env::temp_dir().join(format!(
        "iptv-fuzz-playlist-depth-{}-{}",
        std::process::id(),
        fingerprint
    ));

    let _ = std::fs::remove_dir_all(&root);
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }

    let mut nested = root.clone();
    for level in 0..depth {
        nested = nested.join(format!("d{}", level));
        if std::fs::create_dir_all(&nested).is_err() {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
    }

    let extension = if data.get(1).map(|value| value % 2 == 0).unwrap_or(true) {
        "m3u8"
    } else {
        "m3u"
    };
    let playlist_path = nested.join(format!("sample.{}", extension));
    let _ = std::fs::write(
        &playlist_path,
        "#EXTM3U\n#EXTINF:-1,Sample\nhttp://example.com/stream.m3u8\n",
    );

    let root_string = root.to_string_lossy().to_string();
    let _ = find_playlists_in_dir(&root_string);

    let _ = std::fs::remove_dir_all(&root);
});
