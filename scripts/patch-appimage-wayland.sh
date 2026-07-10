#!/usr/bin/env bash
set -euo pipefail

# Tauri's AppImage bundler currently includes libwayland-client from the build
# host. Newer Mesa versions then load that older copy instead of the target
# system library and WebKitGTK aborts with EGL_BAD_PARAMETER on Wayland.
# Upstream: https://github.com/tauri-apps/tauri/issues/15665
#
# Remove the bundled copy and repack the AppImage so Mesa and WebKitGTK use the
# target system's matching Wayland client library instead.

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <path-to-AppImage>" >&2
    exit 2
fi

APPIMAGE="$(realpath "$1")"
if [[ ! -f "${APPIMAGE}" ]]; then
    echo "Error: AppImage not found: ${APPIMAGE}" >&2
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
LIB_DIR="${APP_DIR}/usr/lib"
mapfile -d '' BUNDLED_WAYLAND_LIBS < <(
    find "${LIB_DIR}" -maxdepth 1 -name 'libwayland-client.so*' -print0
)

if [[ ${#BUNDLED_WAYLAND_LIBS[@]} -eq 0 ]]; then
    echo "Error: no bundled libwayland-client found in ${APPIMAGE}" >&2
    exit 1
fi

rm -f -- "${BUNDLED_WAYLAND_LIBS[@]}"

APPIMAGETOOL="${WORK_DIR}/appimagetool-${TOOL_ARCH}.AppImage"
curl --fail --location --retry 3 --silent --show-error \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${TOOL_ARCH}.AppImage" \
    --output "${APPIMAGETOOL}"
chmod +x "${APPIMAGETOOL}"

PATCHED_APPIMAGE="${WORK_DIR}/patched.AppImage"
ARCH="${TOOL_ARCH}" APPIMAGE_EXTRACT_AND_RUN=1 \
    "${APPIMAGETOOL}" "${APP_DIR}" "${PATCHED_APPIMAGE}" > /dev/null

VERIFY_DIR="${WORK_DIR}/verify"
mkdir "${VERIFY_DIR}"
(
    cd "${VERIFY_DIR}"
    "${PATCHED_APPIMAGE}" --appimage-extract > /dev/null
)

if find "${VERIFY_DIR}/squashfs-root/usr/lib" -maxdepth 1 \
    -name 'libwayland-client.so*' -print -quit | grep -q .; then
    echo "Error: patched AppImage still bundles libwayland-client" >&2
    exit 1
fi

mv "${PATCHED_APPIMAGE}" "${APPIMAGE}"
chmod +x "${APPIMAGE}"
echo "Patched AppImage to use the target system's libwayland-client: ${APPIMAGE}"
