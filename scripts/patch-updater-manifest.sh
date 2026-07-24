#!/usr/bin/env bash
set -euo pipefail

# Repoint one platform entry in a release's latest.json at a specific asset.
#
# tauri-action signs the artifacts it builds and writes their URLs into
# latest.json, but two of our release assets are replaced *after* that:
#
#   * the macOS .dmg — notarized and stapled in a later step, and used instead
#     of Tauri's stock .app.tar.gz so the updater installs the same artifact
#     users download;
#   * the Linux AppImage — rewritten in place by harden-appimage-runtime.sh.
#
# In both cases the stock signature no longer matches the published bytes, so
# the caller re-signs the final asset and hands the signature to this script.
#
# The updater resolves a manifest entry by trying "{os}-{arch}-{installer}"
# before "{os}-{arch}" (see tauri-plugin-updater's `update_url_and_signature`),
# so both keys are written — otherwise a stale installer-suffixed entry written
# by tauri-action would still win.
#
# Usage:
#   patch-updater-manifest.sh <tag> <os-arch> <installer> <asset-name> <signature>
#
# Requires GITHUB_TOKEN and GITHUB_REPOSITORY in the environment.

if [[ $# -ne 5 ]]; then
    echo "Usage: $0 <tag> <os-arch> <installer> <asset-name> <signature>" >&2
    exit 2
fi

TAG="$1"
PLATFORM="$2"
INSTALLER="$3"
ASSET_NAME="$4"
SIGNATURE="$5"

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

if [[ -z "${SIGNATURE}" ]]; then
    echo "Error: refusing to write an empty signature for ${PLATFORM}." >&2
    exit 1
fi

release_id="$(gh api "repos/${GITHUB_REPOSITORY}/releases" --paginate \
    | jq -r --arg tag "${TAG}" '.[] | select(.tag_name == $tag) | .id' \
    | head -n1)"
if [[ -z "${release_id}" ]]; then
    echo "Error: no release found for tag ${TAG}." >&2
    exit 1
fi

assets="$(gh api "repos/${GITHUB_REPOSITORY}/releases/${release_id}/assets" --paginate)"

asset_id="$(printf '%s\n' "${assets}" \
    | jq -r --arg name "${ASSET_NAME}" '.[] | select(.name == $name) | .id' \
    | head -n1)"
if [[ -z "${asset_id}" ]]; then
    echo "Error: asset ${ASSET_NAME} was not found on release ${TAG}." >&2
    exit 1
fi

manifest_id="$(printf '%s\n' "${assets}" \
    | jq -r '.[] | select(.name == "latest.json") | .id' \
    | head -n1)"
if [[ -z "${manifest_id}" ]]; then
    echo "Error: latest.json was not found; cannot repoint the ${PLATFORM} updater." >&2
    exit 1
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

gh api -H "Accept: application/octet-stream" \
    "repos/${GITHUB_REPOSITORY}/releases/assets/${manifest_id}" \
    > "${WORK_DIR}/latest.json"

# The API asset URL (rather than browser_download_url) is what the updater
# fetches; it sends `Accept: application/octet-stream`, so GitHub streams the
# bytes instead of the asset's JSON metadata.
asset_url="https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}"

jq \
    --arg platform "${PLATFORM}" \
    --arg installer "${INSTALLER}" \
    --arg url "${asset_url}" \
    --arg signature "${SIGNATURE}" \
    '.platforms[$platform].url = $url
      | .platforms[$platform].signature = $signature
      | .platforms[($platform + "-" + $installer)].url = $url
      | .platforms[($platform + "-" + $installer)].signature = $signature' \
    "${WORK_DIR}/latest.json" > "${WORK_DIR}/latest.next.json"

mv "${WORK_DIR}/latest.next.json" "${WORK_DIR}/latest.json"
gh release upload "${TAG}" "${WORK_DIR}/latest.json" --clobber

echo "Repointed ${PLATFORM} and ${PLATFORM}-${INSTALLER} at ${ASSET_NAME}."
