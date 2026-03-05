#![no_main]

use iptv_checker_lib::engine::parser::{
    get_channel_name, get_group_name, parse_extinf_attributes,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let raw = String::from_utf8_lossy(data);
    let synthesized = format!("#EXTINF:-1 {},{}", raw, raw);

    let _ = parse_extinf_attributes(raw.as_ref());
    let _ = parse_extinf_attributes(&synthesized);
    let _ = get_channel_name(raw.as_ref());
    let _ = get_channel_name(&synthesized);
    let _ = get_group_name(raw.as_ref());
    let _ = get_group_name(&synthesized);
});
