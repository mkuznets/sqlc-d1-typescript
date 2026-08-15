#!/usr/bin/env bash
# Confirm the publication credentials reached this step before anything tries to use
# them, so an empty Environment secret reports which one is missing rather than
# surfacing as an opaque HTTP 401 from GitHub or R2. Values are never printed.
#
# Reads: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID, GITHUB_TOKEN
set -euo pipefail
# shellcheck source=scripts/workflows/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test -n "${GITHUB_TOKEN:-}" ||
  fail "GITHUB_TOKEN is empty; the step must pass github.token so releases can be read and written"
test -n "${R2_ACCESS_KEY_ID:-}" ||
  fail "R2_ACCESS_KEY_ID is empty; add it as a secret of the release-publication environment"
test -n "${R2_SECRET_ACCESS_KEY:-}" ||
  fail "R2_SECRET_ACCESS_KEY is empty; add it as a secret of the release-publication environment"
test -n "${CLOUDFLARE_ACCOUNT_ID:-}" ||
  fail "CLOUDFLARE_ACCOUNT_ID is empty; the repository variable is missing"

command -v aws >/dev/null ||
  fail "the aws CLI is not on PATH; publication uploads to R2 through it and GitHub runners normally preinstall it"

log "Publication credentials are present for the release-publication environment"
detail "$(aws --version 2>&1)"
