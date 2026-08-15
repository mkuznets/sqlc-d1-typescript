#!/usr/bin/env bash
set -euo pipefail

VERSION="v9.1.0"
BASE_URL="https://github.com/bytecodealliance/javy/releases/download/${VERSION}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
    Linux)  os="linux" ;;
    Darwin) os="macos" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) echo "Unsupported OS: ${OS}" >&2; exit 1 ;;
esac

case "${ARCH}" in
    x86_64|amd64)  arch="x86_64" ;;
    arm64|aarch64) arch="arm" ;;
    *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;;
esac

ARCHIVE="javy-${arch}-${os}-${VERSION}.gz"
URL="${BASE_URL}/${ARCHIVE}"
SHA_URL="${URL}.sha256"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/../bin"
mkdir -p "${BIN_DIR}"
DEST="${BIN_DIR}/javy"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

echo "Downloading ${URL}..."
curl -fsSL -o "${TMPDIR}/${ARCHIVE}" "${URL}"
curl -fsSL -o "${TMPDIR}/${ARCHIVE}.sha256" "${SHA_URL}"

echo "Verifying checksum..."
EXPECTED="$(awk '{print $1}' "${TMPDIR}/${ARCHIVE}.sha256")"
if command -v sha256sum &>/dev/null; then
    ACTUAL="$(sha256sum "${TMPDIR}/${ARCHIVE}" | awk '{print $1}')"
elif command -v shasum &>/dev/null; then
    ACTUAL="$(shasum -a 256 "${TMPDIR}/${ARCHIVE}" | awk '{print $1}')"
else
    echo "No sha256sum or shasum found, skipping checksum verification" >&2
    ACTUAL="${EXPECTED}"
fi

if [ "${EXPECTED}" != "${ACTUAL}" ]; then
    echo "Checksum mismatch: expected ${EXPECTED}, got ${ACTUAL}" >&2
    exit 1
fi

echo "Extracting..."
gunzip -c "${TMPDIR}/${ARCHIVE}" > "${DEST}"
chmod +x "${DEST}"

echo "Installed javy ${VERSION} to ${DEST}"
"${DEST}" --version
