#!/usr/bin/env bash
set -euo pipefail

# Shared by ci.yml and release.yml: print the single AppImage bundled for the
# given target, failing if there is not exactly one candidate to harden.

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <cargo-target-triple>" >&2
    exit 2
fi

BUNDLE_DIR="src-tauri/target/$1/release/bundle/appimage"

mapfile -d '' appimages < <(
    find "${BUNDLE_DIR}" -maxdepth 1 -name '*.AppImage' -print0
)
if [[ ${#appimages[@]} -ne 1 ]]; then
    echo "Expected exactly one AppImage in ${BUNDLE_DIR}, found ${#appimages[@]}" >&2
    exit 1
fi

printf '%s\n' "${appimages[0]}"
