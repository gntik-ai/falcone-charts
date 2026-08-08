#!/usr/bin/env bash
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if command -v node >/dev/null 2>&1; then
  mapfile -t test_files < <(find tests/blackbox -mindepth 2 -type f -name '*.test.mjs' -print | sort)
  if [[ ${#test_files[@]} -eq 0 ]]; then
    echo "black-box: no tests found under tests/blackbox" >&2
    exit 2
  fi
  echo "black-box: running ${#test_files[@]} Node test files"
  node --test --test-concurrency=1 "${test_files[@]}"
  status=$?
  if [[ $status -eq 0 ]]; then
    echo "black-box: PASS (${#test_files[@]} files)"
  else
    echo "black-box: FAIL (node --test exited $status)" >&2
  fi
  exit "$status"
fi

if command -v pytest >/dev/null 2>&1; then
  echo "black-box: Node is unavailable; falling back to pytest"
  pytest -q tests/blackbox
  exit $?
fi

echo "black-box: no supported runner found (need node or pytest)" >&2
exit 2
