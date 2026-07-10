#!/usr/bin/env bash
set -euo pipefail

# Tauri's legacy AppImage bundler can copy host-coupled libraries and auxiliary
# Cargo binaries into production bundles. Older copies of those libraries can
# conflict with newer drivers and system services on the target distribution.
# Upstream: https://github.com/tauri-apps/tauri/issues/15665

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <path-to-AppImage>" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_LIBRARY_LIST="${SCRIPT_DIR}/appimage-host-libraries.txt"
APPIMAGE="$(realpath "$1")"

if [[ ! -f "${APPIMAGE}" ]]; then
    echo "Error: AppImage not found: ${APPIMAGE}" >&2
    exit 1
fi
if [[ ! -f "${HOST_LIBRARY_LIST}" ]]; then
    echo "Error: host library list not found: ${HOST_LIBRARY_LIST}" >&2
    exit 1
fi

case "$(uname -m)" in
    x86_64)
        TOOL_ARCH="x86_64"
        ;;
    aarch64|arm64)
        TOOL_ARCH="aarch64"
        ;;
    *)
        echo "Error: unsupported AppImage build host architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

mapfile -t HOST_LIBRARIES < <(
    sed 's/#.*//' "${HOST_LIBRARY_LIST}" | sed '/^[[:space:]]*$/d'
)

WORK_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

chmod +x "${APPIMAGE}"
(
    cd "${WORK_DIR}"
    "${APPIMAGE}" --appimage-extract > /dev/null
)

APP_DIR="${WORK_DIR}/squashfs-root"

REMOVED_LIBRARIES=()
for library in "${HOST_LIBRARIES[@]}"; do
    mapfile -d '' matches < <(
        find "${APP_DIR}" \( -type f -o -type l \) -name "${library}*" -print0
    )
    if [[ ${#matches[@]} -gt 0 ]]; then
        REMOVED_LIBRARIES+=("${library}")
        rm -f -- "${matches[@]}"
    fi
done

# Cargo auto-discovers src/bin/backend_bench.rs, and Tauri otherwise packages
# that internal benchmark as an additional production binary on every OS.
rm -f "${APP_DIR}/usr/bin/backend_bench"

APPIMAGETOOL="${WORK_DIR}/appimagetool-${TOOL_ARCH}.AppImage"
curl --fail --location --retry 3 --silent --show-error \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${TOOL_ARCH}.AppImage" \
    --output "${APPIMAGETOOL}"
chmod +x "${APPIMAGETOOL}"

PATCHED_APPIMAGE="${WORK_DIR}/hardened.AppImage"
ARCH="${TOOL_ARCH}" APPIMAGE_EXTRACT_AND_RUN=1 \
    "${APPIMAGETOOL}" "${APP_DIR}" "${PATCHED_APPIMAGE}" > /dev/null

VERIFY_DIR="${WORK_DIR}/verify"
mkdir "${VERIFY_DIR}"
(
    cd "${VERIFY_DIR}"
    "${PATCHED_APPIMAGE}" --appimage-extract > /dev/null
)
VERIFY_APP_DIR="${VERIFY_DIR}/squashfs-root"

validation_failed=0

for library in "${HOST_LIBRARIES[@]}"; do
    if find "${VERIFY_APP_DIR}" \( -type f -o -type l \) \
        -name "${library}*" -print -quit | grep -q .; then
        echo "Error: hardened AppImage still bundles host library ${library}" >&2
        validation_failed=1
    fi
done

if find "${VERIFY_APP_DIR}" -type l -lname '/*' -print -quit | grep -q .; then
    echo "Error: hardened AppImage contains absolute symlinks:" >&2
    find "${VERIFY_APP_DIR}" -type l -lname '/*' -printf '  %P -> %l\n' >&2
    validation_failed=1
fi

if find -L "${VERIFY_APP_DIR}" -type l -print -quit | grep -q .; then
    echo "Error: hardened AppImage contains broken symlinks:" >&2
    find -L "${VERIFY_APP_DIR}" -type l -printf '  %P -> %l\n' >&2
    validation_failed=1
fi

for required_binary in iptv-checker ffmpeg ffprobe; do
    if [[ ! -x "${VERIFY_APP_DIR}/usr/bin/${required_binary}" ]]; then
        echo "Error: required runtime binary is missing: ${required_binary}" >&2
        validation_failed=1
    fi
done

for required_launcher in AppRun AppRun.wrapped; do
    if [[ ! -x "${VERIFY_APP_DIR}/${required_launcher}" ]]; then
        echo "Error: required AppImage launcher is missing: ${required_launcher}" >&2
        validation_failed=1
    fi
done

if [[ -e "${VERIFY_APP_DIR}/usr/bin/backend_bench" ]]; then
    echo "Error: internal backend_bench binary is present in production AppImage" >&2
    validation_failed=1
fi

GSTREAMER_DIR="${VERIFY_APP_DIR}/usr/lib/gstreamer-1.0"
if [[ ! -d "${GSTREAMER_DIR}" ]] || ! find "${GSTREAMER_DIR}" \
    -maxdepth 1 -type f -name 'libgst*.so' -print -quit | grep -q .; then
    echo "Error: bundled GStreamer plugin set is missing or empty" >&2
    validation_failed=1
fi

WEBKIT_HELPERS=()
for helper in WebKitNetworkProcess WebKitWebProcess; do
    mapfile -t helper_matches < <(
        find "${VERIFY_APP_DIR}/usr/lib" -type f -name "${helper}" -perm /111
    )
    if [[ ${#helper_matches[@]} -eq 0 ]]; then
        echo "Error: required WebKitGTK helper is missing: ${helper}" >&2
        validation_failed=1
    else
        WEBKIT_HELPERS+=("${helper_matches[0]}")
    fi
done

APPDIR_LIBRARY_PATH="$(find "${VERIFY_APP_DIR}/usr/lib" -type d -printf '%p:')"
for executable in "${VERIFY_APP_DIR}/usr/bin/iptv-checker" "${WEBKIT_HELPERS[@]}"; do
    if [[ -x "${executable}" ]] && LD_LIBRARY_PATH="${APPDIR_LIBRARY_PATH}" \
        ldd "${executable}" 2>&1 | grep -q 'not found'; then
        echo "Error: hardened AppImage has unresolved runtime dependencies for ${executable}:" >&2
        LD_LIBRARY_PATH="${APPDIR_LIBRARY_PATH}" ldd "${executable}" 2>&1 \
            | grep 'not found' >&2
        validation_failed=1
    fi
done

if [[ ${validation_failed} -ne 0 ]]; then
    exit 1
fi

mv "${PATCHED_APPIMAGE}" "${APPIMAGE}"
chmod +x "${APPIMAGE}"

if [[ ${#REMOVED_LIBRARIES[@]} -gt 0 ]]; then
    printf 'Removed host-coupled libraries: %s\n' "${REMOVED_LIBRARIES[*]}"
else
    echo "No host-coupled libraries were bundled"
fi
echo "Hardened and verified AppImage runtime: ${APPIMAGE}"
