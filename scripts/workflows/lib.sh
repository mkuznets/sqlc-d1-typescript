# shellcheck shell=bash
# Shared logging helpers for workflow scripts. Source this file; do not execute it.
#
# Every workflow script must say what it is about to do, what it observed, and why
# it failed. `fail` emits a GitHub Actions error annotation so the failure is visible
# on the run summary page without opening the log.

log() { printf '==> %s\n' "$*"; }
detail() { printf '    %s\n' "$*"; }
warn() { printf '::warning::%s\n' "$*"; }
fail() {
  printf '::error::%s\n' "$*" >&2
  exit "${FAIL_EXIT_CODE:-1}"
}
