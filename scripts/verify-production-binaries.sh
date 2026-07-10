#!/usr/bin/env bash
set -euo pipefail

# Shared by ci.yml and release.yml: fail if the internal backend_bench binary
# was built alongside a production bundle.

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <cargo-target-triple>" >&2
    exit 2
fi

RELEASE_DIR="src-tauri/target/$1/release"

if find "${RELEASE_DIR}" -maxdepth 1 -type f \
    \( -name 'backend_bench' -o -name 'backend_bench.exe' \) -print -quit | grep -q .; then
    echo "Internal backend_bench binary was built for a production bundle" >&2
    exit 1
fi
