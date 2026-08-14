#!/usr/bin/env bash
# Prove that the wasm downloaded from the run artifact is byte-identical to the one
# the build job produced. Every verification job runs this before testing anything:
# testing a different binary than the one we would publish is worse than no test.
#
# Usage: verify-candidate-digest.sh <plugin.wasm> <file containing the expected sha256>
set -euo pipefail
# shellcheck source=scripts/workflows/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

wasm="${1:-}"
digest_file="${2:-}"
test -n "$wasm" && test -n "$digest_file" ||
  fail "usage: verify-candidate-digest.sh <plugin.wasm> <digest-file>"
test -f "$wasm" ||
  fail "candidate wasm '$wasm' is missing: the download-artifact step did not produce it"
test -f "$digest_file" ||
  fail "recorded digest file '$digest_file' is missing: the build job did not upload it"

expected="$(tr -d '[:space:]' <"$digest_file")"
actual="$(sha256sum "$wasm" | awk '{print $1}')"

log "Verifying candidate identity"
detail "candidate: $wasm ($(wc -c <"$wasm" | tr -d ' ') bytes)"
detail "expected:  $expected (from $digest_file)"
detail "actual:    $actual"

printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$' ||
  fail "recorded digest '$expected' is not 64 lowercase hex characters; the build job wrote a malformed digest"
test "$actual" = "$expected" ||
  fail "candidate digest mismatch: the downloaded artifact is not the wasm this run built, refusing to verify a different binary"

log "Candidate identity confirmed; verifying the exact publication candidate"
