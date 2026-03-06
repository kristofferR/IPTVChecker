#!/usr/bin/env bash
set -euo pipefail

# Downloads static ffmpeg + ffprobe binaries for Tauri sidecar bundling.
#
# Sources:
#   macOS:   https://ffmpeg.martin-riedl.de (ffmpeg 8.x, static builds)
#   Linux:   https://github.com/BtbN/FFmpeg-Builds (gpl, static)
#   Windows: https://github.com/BtbN/FFmpeg-Builds (gpl, static)
#
# Usage:
#   bash scripts/download-ffmpeg.sh [target-triple]
#
# If no target triple is given, defaults to the host platform via rustc.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/../src-tauri/binaries"

TARGET="${1:-$(rustc --print host-tuple 2>/dev/null || rustc -vV | sed -n 's/^host: //p')}"

# Windows binaries need .exe extension
EXT=""
if [[ "${TARGET}" == *windows* ]]; then
    EXT=".exe"
fi

mkdir -p "${BIN_DIR}"

download_macos() {
    local arch="$1"
    local base="https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release"

    for name in ffmpeg ffprobe; do
        local output="${BIN_DIR}/${name}-${TARGET}${EXT}"
        if [[ -f "${output}" ]]; then
            echo "  ${name}: already exists, skipping (delete to re-download)"
            continue
        fi

        local url="${base}/${name}.zip"
        echo "  ${name}: downloading from ${url}"
        local tmpzip
        tmpzip="$(mktemp)"
        curl -fSL "${url}" -o "${tmpzip}"
        unzip -o -j "${tmpzip}" "${name}" -d "${BIN_DIR}/"
        mv "${BIN_DIR}/${name}" "${output}"
        chmod +x "${output}"
        rm -f "${tmpzip}"
    done
}

download_btbn() {
    local platform="$1"
    local btbn_tag
    btbn_tag="$(curl -sI "https://github.com/BtbN/FFmpeg-Builds/releases/latest" | grep -i location | sed 's|.*/tag/||;s/\r//')"
    local base="https://github.com/BtbN/FFmpeg-Builds/releases/download/${btbn_tag}"
    local archive="ffmpeg-master-latest-${platform}-gpl"

    local ext_archive=".tar.xz"
    local extract_cmd="tar xf"
    if [[ "${platform}" == *windows* ]]; then
        ext_archive=".zip"
        extract_cmd="unzip -o"
    fi

    local url="${base}/${archive}${ext_archive}"
    echo "  Downloading from ${url}"

    local tmpfile
    tmpfile="$(mktemp)"
    curl -fSL "${url}" -o "${tmpfile}"

    local tmpdir
    tmpdir="$(mktemp -d)"
    cd "${tmpdir}"
    ${extract_cmd} "${tmpfile}"
    cd - > /dev/null

    for name in ffmpeg ffprobe; do
        local src="${tmpdir}/${archive}/bin/${name}${EXT}"
        local output="${BIN_DIR}/${name}-${TARGET}${EXT}"
        if [[ -f "${output}" ]]; then
            echo "  ${name}: already exists, skipping"
        elif [[ -f "${src}" ]]; then
            mv "${src}" "${output}"
            chmod +x "${output}"
            echo "  ${name}: installed"
        else
            echo "  ${name}: NOT FOUND in archive"
        fi
    done

    rm -rf "${tmpdir}" "${tmpfile}"
}

echo "Downloading ffmpeg binaries for ${TARGET}..."

case "${TARGET}" in
    aarch64-apple-darwin)
        download_macos "arm64"
        ;;
    x86_64-apple-darwin)
        download_macos "x86_64"
        ;;
    x86_64-unknown-linux-gnu)
        download_btbn "linux64"
        ;;
    aarch64-unknown-linux-gnu)
        download_btbn "linuxarm64"
        ;;
    x86_64-pc-windows-msvc)
        download_btbn "win64"
        ;;
    aarch64-pc-windows-msvc)
        download_btbn "winarm64"
        ;;
    *)
        echo "Error: unsupported target '${TARGET}'"
        echo "Supported: aarch64-apple-darwin, x86_64-apple-darwin, x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, x86_64-pc-windows-msvc, aarch64-pc-windows-msvc"
        exit 1
        ;;
esac

echo "Done. Binaries in ${BIN_DIR}/"
# Show versions
for name in ffmpeg ffprobe; do
    local_bin="${BIN_DIR}/${name}-${TARGET}${EXT}"
    if [[ -x "${local_bin}" ]]; then
        version=$("${local_bin}" -version 2>&1 | head -1)
        echo "  ${name}: ${version}"
    fi
done
