#!/usr/bin/env bash
set -euo pipefail

VERSION="v1.72.0"
BASE_URL="https://github.com/bufbuild/buf/releases/download/${VERSION}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
    Linux)  os="Linux" ;;
    Darwin) os="Darwin" ;;
    MINGW*|MSYS*|CYGWIN*) os="Windows" ;;
    *) echo "Unsupported OS: ${OS}" >&2; exit 1 ;;
esac

case "${ARCH}" in
    x86_64|amd64)  arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;;
esac

if [ "${os}" = "Darwin" ]; then
    arch="${ARCH}"  # Darwin uses arm64/x86_64 as-is
fi

BINARY="buf-${os}-${arch}"
URL="${BASE_URL}/${BINARY}"
SHA_URL="${BASE_URL}/sha256.txt"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/../bin"
mkdir -p "${BIN_DIR}"
DEST="${BIN_DIR}/buf"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

echo "Downloading ${URL}..."
curl -fsSL -o "${TMPDIR}/${BINARY}" "${URL}"
curl -fsSL -o "${TMPDIR}/sha256.txt" "${SHA_URL}"

echo "Verifying checksum..."
EXPECTED="$(grep "  ${BINARY}\$" "${TMPDIR}/sha256.txt" | awk '{print $1}')"
if [ -z "${EXPECTED}" ]; then
    echo "Could not find checksum for ${BINARY}" >&2
    exit 1
fi

if command -v sha256sum &>/dev/null; then
    ACTUAL="$(sha256sum "${TMPDIR}/${BINARY}" | awk '{print $1}')"
elif command -v shasum &>/dev/null; then
    ACTUAL="$(shasum -a 256 "${TMPDIR}/${BINARY}" | awk '{print $1}')"
else
    echo "No sha256sum or shasum found, skipping checksum verification" >&2
    ACTUAL="${EXPECTED}"
fi

if [ "${EXPECTED}" != "${ACTUAL}" ]; then
    echo "Checksum mismatch: expected ${EXPECTED}, got ${ACTUAL}" >&2
    exit 1
fi

cp "${TMPDIR}/${BINARY}" "${DEST}"
chmod +x "${DEST}"

echo "Installed buf ${VERSION} to ${DEST}"
"${DEST}" --version
