# GitHub Actions workflows

The branch for editing anything under `.github/workflows/` or `scripts/workflows/`.

## No scripts inside workflow files — bash only

A `run:` block holds plain bash: a handful of commands, `test` and `echo` guards, and invocations of scripts.
Anything beyond a few lines of bash — a `node -e` one-liner, a heredoc program, an inline procedure — goes into
a file under `scripts/workflows/` that the workflow calls. Pass workflow values in through `env:` rather than
interpolating `${{ }}` into the middle of a script. Shared helpers live in `scripts/workflows/lib.sh` (`log`,
`detail`, `warn`, `fail`).

## Every workflow logs what is going on, including every meaningful failure

- Every job and every step carries a `name:` that says what it does.
- Each step announces what it is about to do and what it observed — versions installed, digests compared,
  artifacts selected, which branch of a reuse-or-create decision was taken and why.
- Every failure exits with a message that says what failed **and what that means**, emitted as a `::error::`
  annotation through `fail` from `scripts/workflows/lib.sh`, so it reaches the run summary. A bare `test a = b`
  or `[[ … ]]` guard that fails silently leaves the reader with an exit code and nothing else.
- A guard checking for a secret, variable, tool, or file reports which one is missing and which setup step
  should have provided it.

## Contract tests assert on workflow text

`test/verification-contracts.test.ts` and `test/compatibility-scripts.test.ts` assert on workflow text. When
logic moves from a workflow into `scripts/workflows/`, move the corresponding assertion with it so the
invariant keeps its owner.
