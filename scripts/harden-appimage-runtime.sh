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
APPIMAGE="$(realpath -m "$1")"

if [[ ! -f "${APPIMAGE}" ]]; then
    echo "Error: AppImage not found: ${APPIMAGE}" >&2
    exit 1
fi
if [[ ! -f "${HOST_LIBRARY_LIST}" ]]; then
    echo "Error: host library list not found: ${HOST_LIBRARY_LIST}" >&2
    exit 1
fi

# Immutable numbered release tags: unlike `continuous`, these assets are never
# re-published, so the URLs stay valid for the pinned SHA256 values below.
APPIMAGETOOL_VERSION="1.9.1"
RUNTIME_VERSION="20251108"

case "$(uname -m)" in
    x86_64)
        TOOL_ARCH="x86_64"
        APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
        RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"
        ;;
    aarch64|arm64)
        TOOL_ARCH="aarch64"
        APPIMAGETOOL_SHA256="f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158"
        RUNTIME_SHA256="00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444"
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

# Defense in depth for artifacts created before backend_bench moved from an
# auto-discovered Cargo binary target to an opt-in example.
rm -f "${APP_DIR}/usr/bin/backend_bench"

# Tauri can emit .DirIcon as an absolute symlink to its original build AppDir.
# Repoint absolute links only when their target can be mapped to a file in the
# extracted AppDir; an external or ambiguous target is a packaging error.
mapfile -d '' ABSOLUTE_SYMLINKS < <(
    find "${APP_DIR}" -type l -lname '/*' -print0
)
for symlink in "${ABSOLUTE_SYMLINKS[@]}"; do
    target="$(readlink "${symlink}")"
    appdir_relative_target="${target#*.AppDir/}"

    if [[ "${appdir_relative_target}" == "${target}" ]]; then
        appdir_relative_target="${target#/}"
    fi

    candidate="${APP_DIR}/${appdir_relative_target}"
    if [[ ! -e "${candidate}" && ! -L "${candidate}" ]]; then
        echo "Error: absolute symlink does not resolve inside AppDir: ${symlink#"${APP_DIR}/"} -> ${target}" >&2
        exit 1
    fi

    relative_target="$(realpath --relative-to="$(dirname "${symlink}")" "${candidate}")"
    rm -f "${symlink}"
    ln -s "${relative_target}" "${symlink}"
done

APPIMAGETOOL="${WORK_DIR}/appimagetool-${TOOL_ARCH}.AppImage"
curl --fail --location --retry 3 --connect-timeout 20 --max-time 120 \
    --silent --show-error \
    "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-${TOOL_ARCH}.AppImage" \
    --output "${APPIMAGETOOL}"
chmod +x "${APPIMAGETOOL}"

RUNTIME_FILE="${WORK_DIR}/runtime-${TOOL_ARCH}"
curl --fail --location --retry 3 --connect-timeout 20 --max-time 120 \
    --silent --show-error \
    "https://github.com/AppImage/type2-runtime/releases/download/${RUNTIME_VERSION}/runtime-${TOOL_ARCH}" \
    --output "${RUNTIME_FILE}"

printf '%s  %s\n' "${APPIMAGETOOL_SHA256}" "${APPIMAGETOOL}" | sha256sum --check --status
printf '%s  %s\n' "${RUNTIME_SHA256}" "${RUNTIME_FILE}" | sha256sum --check --status

PATCHED_APPIMAGE="${WORK_DIR}/hardened.AppImage"
ARCH="${TOOL_ARCH}" APPIMAGE_EXTRACT_AND_RUN=1 \
    "${APPIMAGETOOL}" --runtime-file "${RUNTIME_FILE}" \
    "${APP_DIR}" "${PATCHED_APPIMAGE}" > /dev/null

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

# Strip the trailing colon from find's output: an empty LD_LIBRARY_PATH
# component would make the dynamic linker also search the current directory.
# Denylisted libraries are expected to resolve from the build host's system
# libraries here, exactly as they must on end-user systems.
APPDIR_LIBRARY_PATH="$(find "${VERIFY_APP_DIR}/usr/lib" -type d -printf '%p:')"
APPDIR_LIBRARY_PATH="${APPDIR_LIBRARY_PATH%:}"
for executable in "${VERIFY_APP_DIR}/usr/bin/iptv-checker" "${WEBKIT_HELPERS[@]}"; do
    if [[ ! -x "${executable}" ]]; then
        continue
    fi

    if ! ldd_output="$(LD_LIBRARY_PATH="${APPDIR_LIBRARY_PATH}" ldd "${executable}" 2>&1)"; then
        echo "Error: failed to inspect runtime dependencies for ${executable}:" >&2
        echo "${ldd_output}" >&2
        validation_failed=1
    elif grep -q 'not found' <<< "${ldd_output}"; then
        echo "Error: hardened AppImage has unresolved runtime dependencies for ${executable}:" >&2
        grep 'not found' <<< "${ldd_output}" >&2
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
