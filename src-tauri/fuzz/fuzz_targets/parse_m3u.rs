#![no_main]

use iptv_checker_lib::engine::parser::parse_m3u;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = parse_m3u(data, "fuzz-playlist.m3u8", &None, &None);
});
