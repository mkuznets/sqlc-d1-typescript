#!/usr/bin/env bash
# Decide the outcome of the managed D1 job: the evidence must validate against the
# exact candidate, an evidence artifact ID must exist for the release manifest, and a
# failed verification attempt must fail the job even though its step was allowed to
# continue so cleanup could run.
#
# Reads: EVIDENCE_PATH, CANDIDATE_SHA256, SOURCE_COMMIT, RUN_ID,
#        LOOKUP_MODE, REUSED_ARTIFACT_ID, CREATED_ARTIFACT_ID, VERIFY_OUTCOME
set -euo pipefail
# shellcheck source=scripts/workflows/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${EVIDENCE_PATH:?EVIDENCE_PATH is required}"
: "${CANDIDATE_SHA256:?CANDIDATE_SHA256 is required}"
: "${SOURCE_COMMIT:?SOURCE_COMMIT is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${LOOKUP_MODE:?LOOKUP_MODE is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required; this script only runs inside a GitHub Actions step}"

log "Finalizing managed D1 evidence (lookup mode: $LOOKUP_MODE, verification outcome: ${VERIFY_OUTCOME:-n/a})"

test -f "$EVIDENCE_PATH" ||
  fail "managed evidence '$EVIDENCE_PATH' was never written: verification did not reach the evidence stage, see the verification step log above"

log "Validating evidence against candidate $CANDIDATE_SHA256 from commit $SOURCE_COMMIT"
node scripts/managed-d1-contract.mjs validate-evidence \
  --path "$EVIDENCE_PATH" \
  --sha256 "$CANDIDATE_SHA256" \
  --source-commit "$SOURCE_COMMIT" \
  --run-id "$RUN_ID" \
  --passing true ||
  fail "managed evidence at '$EVIDENCE_PATH' does not attest a passing run of this exact candidate"

remote_date="$(node -e 'process.stdout.write(String(require(require("node:path").resolve(process.argv[1])).run.remoteDate))' "$EVIDENCE_PATH")"
detail "remote date observed on Cloudflare: $remote_date"
echo "remote-date=$remote_date" >>"$GITHUB_OUTPUT"

if test -n "${REUSED_ARTIFACT_ID:-}"; then
  selected_id="$REUSED_ARTIFACT_ID"
  origin="reused from an earlier attempt of this run"
else
  selected_id="${CREATED_ARTIFACT_ID:-}"
  origin="uploaded by this attempt"
fi
test -n "$selected_id" ||
  fail "no managed evidence artifact ID is available: neither the reuse lookup nor the upload step produced one"
printf '%s' "$selected_id" | grep -Eq '^[0-9]+$' ||
  fail "managed evidence artifact ID '$selected_id' is not a decimal ID; the release manifest cannot reference it"
detail "evidence artifact id: $selected_id ($origin)"
echo "evidence-artifact-id=$selected_id" >>"$GITHUB_OUTPUT"

if test "$LOOKUP_MODE" != reuse && test "${VERIFY_OUTCOME:-}" != success; then
  fail "managed D1 verification failed (step outcome: ${VERIFY_OUTCOME:-unknown}); cleanup ran, but this candidate is not verified"
fi

log "Managed D1 evidence accepted"
