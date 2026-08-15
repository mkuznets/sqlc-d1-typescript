#!/usr/bin/env bash
# Read the changelog for this release from the annotated tag message. The maintainer
# writes release notes at tag time; nothing else generates them. A dry run has no tag,
# so it has no notes and the release body falls back to a commit-history link.
#
# Reads: RELEASE_TAG (may be empty), NOTES_PATH
set -euo pipefail
# shellcheck source=scripts/workflows/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${NOTES_PATH:?NOTES_PATH is required}"

if test -z "${RELEASE_TAG:-}"; then
  log "No tag for this run, so the release body carries no changelog"
  : >"$NOTES_PATH"
  exit 0
fi

git rev-parse -q --verify "refs/tags/$RELEASE_TAG" >/dev/null ||
  fail "tag $RELEASE_TAG is not present in the checkout; the publish job needs fetch-tags so the tag message can be read"

log "Reading the changelog from the message of tag $RELEASE_TAG"
git tag -l --format='%(contents:body)' "$RELEASE_TAG" >"$NOTES_PATH"
detail "$(wc -l <"$NOTES_PATH" | tr -d ' ') line(s) of changelog"
