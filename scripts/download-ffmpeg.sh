#!/usr/bin/env bash
set -euo pipefail

# Downloads static ffmpeg + ffprobe binaries for Tauri sidecar bundling.
# Source: https://github.com/eugeneware/ffmpeg-static/releases
#
# Usage:
#   bash scripts/download-ffmpeg.sh [target-triple]
#
# If no target triple is given, defaults to the host platform via rustc.

FFMPEG_VERSION="b6.1.1"
BASE_URL="https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_VERSION}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/../src-tauri/binaries"

TARGET="${1:-$(rustc --print host-tuple 2>/dev/null || rustc -vV | sed -n 's/^host: //p')}"

# Map Rust target triple to eugeneware platform name
case "${TARGET}" in
    aarch64-apple-darwin)   PLATFORM="darwin-arm64" ;;
    x86_64-apple-darwin)    PLATFORM="darwin-x64"   ;;
    x86_64-unknown-linux-gnu) PLATFORM="linux-x64"  ;;
    x86_64-pc-windows-msvc) PLATFORM="win32-x64"    ;;
    *)
        echo "Error: unsupported target '${TARGET}'"
        echo "Supported: aarch64-apple-darwin, x86_64-apple-darwin, x86_64-unknown-linux-gnu, x86_64-pc-windows-msvc"
        exit 1
        ;;
esac

# Windows binaries need .exe extension
EXT=""
if [[ "${TARGET}" == *windows* ]]; then
    EXT=".exe"
fi

mkdir -p "${BIN_DIR}"

download_binary() {
    local name="$1"
    local output="${BIN_DIR}/${name}-${TARGET}${EXT}"

    if [[ -f "${output}" ]]; then
        echo "  ${name}: already exists, skipping"
        return
    fi

    local url="${BASE_URL}/${name}-${PLATFORM}.gz"
    echo "  ${name}: downloading from ${url}"

    curl -fSL "${url}" | gunzip > "${output}"
    chmod +x "${output}"
}

echo "Downloading ffmpeg binaries for ${TARGET} (${PLATFORM})..."
download_binary "ffmpeg"
download_binary "ffprobe"
echo "Done. Binaries in ${BIN_DIR}/"
