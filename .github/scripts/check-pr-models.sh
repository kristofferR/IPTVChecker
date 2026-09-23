#!/usr/bin/env bash
set -euo pipefail

event_file=${1:?GitHub event JSON path required}
author=$(jq -r '.pull_request.user.login // ""' "$event_file")

if [[ "$author" == "kristofferR" ]]; then
  exit 0
fi

body=$(jq -r '.pull_request.body // ""' "$event_file")
mapfile -t declarations < <(printf '%s\n' "$body" | sed -n 's/^AI models used:[[:space:]]*//p')

if (( ${#declarations[@]} != 1 )); then
  echo "Add one 'AI models used:' line to the PR description." >&2
  exit 1
fi

declaration=${declarations[0]%$'\r'}
if [[ "$declaration" == "None" ]]; then
  exit 0
fi

if [[ "$declaration" == *"[replace"* || ! "$declaration" =~ [[:digit:]] ]]; then
  echo "List the AI model names and versions, or use 'AI models used: None'." >&2
  exit 1
fi
