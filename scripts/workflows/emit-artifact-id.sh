#!/usr/bin/env bash
# Publish the ID of an artifact that was either reused from an earlier attempt of this
# run or uploaded by this attempt. Downstream jobs address artifacts by exact ID, so an
# empty or non-numeric ID must stop the run rather than silently produce a bad reference.
#
# Reads: REUSED_ID, CREATED_ID, OUTPUT_NAME, LABEL
set -euo pipefail
# shellcheck source=scripts/workflows/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${OUTPUT_NAME:?OUTPUT_NAME is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required; this script only runs inside a GitHub Actions step}"
label="${LABEL:-artifact}"

if test -n "${REUSED_ID:-}"; then
  id="$REUSED_ID"
  origin="reused from an earlier attempt of this run"
else
  id="${CREATED_ID:-}"
  origin="uploaded by this attempt"
fi

test -n "$id" ||
  fail "no $label artifact ID is available: neither the reuse lookup nor the upload step produced one"
printf '%s' "$id" | grep -Eq '^[0-9]+$' ||
  fail "$label artifact ID '$id' is not a decimal ID; downstream jobs cannot download it by ID"

log "$label artifact id $id ($origin)"
echo "$OUTPUT_NAME=$id" >>"$GITHUB_OUTPUT"
