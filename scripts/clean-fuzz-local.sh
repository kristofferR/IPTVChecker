#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUZZ_DIR="${ROOT_DIR}/src-tauri/fuzz"

if [ ! -d "${FUZZ_DIR}" ]; then
  echo "No fuzz directory found at ${FUZZ_DIR}"
  exit 0
fi

for path in target artifacts coverage; do
  full_path="${FUZZ_DIR}/${path}"
  if [ -e "${full_path}" ]; then
    rm -rf "${full_path}"
    echo "Removed ${full_path}"
  fi
done

echo "Local fuzz artifacts cleaned."
