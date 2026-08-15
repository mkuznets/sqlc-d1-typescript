#!/usr/bin/env bash
# Decide the outcome of the publish job: a publication record must exist, validate
# against the closed schema, and agree with the mode this run was asked for. A failed
# publication step fails the job even though it was allowed to continue so teardown
# and the record upload could run.
#
# Reads: RECORD_PATH, MODE, PUBLISH_OUTCOME, RELEASE_VERSION
set -euo pipefail
# shellcheck source=scripts/workflows/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${RECORD_PATH:?RECORD_PATH is required}"
: "${MODE:?MODE is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required; this script only runs inside a GitHub Actions step}"

log "Finalizing publication (mode: $MODE, publication step outcome: ${PUBLISH_OUTCOME:-n/a})"

test -f "$RECORD_PATH" ||
  fail "publication record '$RECORD_PATH' was never written: publication did not reach the record stage, see the publication step log above"

node scripts/publication-contract.mjs validate-record --path "$RECORD_PATH" ||
  fail "publication record at '$RECORD_PATH' is not a valid record of this run"

record_field() {
  node -e 'process.stdout.write(String(require(require("node:path").resolve(process.argv[1]))[process.argv[2]] ?? ""))' \
    "$RECORD_PATH" "$1"
}
nested_field() {
  node -e 'const r=require(require("node:path").resolve(process.argv[1]));process.stdout.write(String(r[process.argv[2]][process.argv[3]] ?? ""))' \
    "$RECORD_PATH" "$1" "$2"
}

recorded_mode="$(record_field mode)"
test "$recorded_mode" = "$MODE" ||
  fail "the publication record says mode '$recorded_mode' but this job ran in mode '$MODE'"

object_key="$(nested_field r2 key)"
release_url="$(nested_field github release_url)"
published="$(nested_field github published)"
outcome="$(nested_field r2 outcome)"
detail "R2 $object_key: $outcome"
detail "GitHub release published: $published ($release_url)"
echo "object-key=$object_key" >>"$GITHUB_OUTPUT"
echo "release-url=$release_url" >>"$GITHUB_OUTPUT"

if test "$MODE" = dry-run; then
  test "$published" = false ||
    fail "a dry run published a release; the rehearsal guard failed and this must be investigated before any real tag"
  teardown_object="$(nested_field teardown object)"
  teardown_draft="$(nested_field teardown draft)"
  detail "teardown: object $teardown_object, draft $teardown_draft"
  case "$teardown_object:$teardown_draft" in
    *failed*) fail "the dry run left a rehearsal surface behind (object: $teardown_object, draft: $teardown_draft); delete it by hand" ;;
  esac
fi

test "${PUBLISH_OUTCOME:-}" = success ||
  fail "publication failed (step outcome: ${PUBLISH_OUTCOME:-unknown}); the record above names the phase and the applicable recovery"

if test "$MODE" = publish; then
  test "$published" = true ||
    fail "publication completed without publishing the release; version ${RELEASE_VERSION:-} is not advertised"
fi

log "Publication accepted"
