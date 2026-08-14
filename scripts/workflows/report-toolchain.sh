#!/usr/bin/env bash
# Print the resolved version and location of every tool a job depends on, and fail
# loudly when a setup step silently did not install one.
#
# Usage: report-toolchain.sh node npm bun sqlc
set -euo pipefail
# shellcheck source=scripts/workflows/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test $# -gt 0 || fail "report-toolchain.sh needs at least one tool name"

log "Toolchain resolved on this runner ($(uname -s) $(uname -m)):"
for tool in "$@"; do
  path="$(command -v "$tool" || true)"
  test -n "$path" || fail "required tool '$tool' is not on PATH: the setup step for it did not run or failed"
  case "$tool" in
    sqlc) version="$("$tool" version)" ;;
    *) version="$("$tool" --version)" ;;
  esac
  detail "$(printf '%-6s %-12s %s' "$tool" "$version" "$path")"
done
