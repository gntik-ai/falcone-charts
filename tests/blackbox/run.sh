#!/usr/bin/env bash
set -euo pipefail

suite_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v pytest >/dev/null 2>&1; then
  runner=(pytest)
elif command -v python3 >/dev/null 2>&1 && python3 -m pytest --version >/dev/null 2>&1; then
  runner=(python3 -m pytest)
else
  echo "ERROR: pytest is required to run the black-box suite" >&2
  exit 2
fi

echo "Black-box runner: ${runner[*]}"
"${runner[@]}" "$suite_dir"
