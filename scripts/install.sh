#!/bin/sh
# Openship installer — https://get.openship.io
#
#   curl -fsSL https://get.openship.io | sh
#
# Installs the Openship CLI, which sets up and runs the self-hosted server
# (`openship init`, `openship server`). No Node or npm required — Openship
# runs on Bun, and this script installs Bun for you if it's missing.
#
# Env overrides:
#   OPENSHIP_VERSION=0.1.9   pin a specific CLI version (default: latest)
set -eu

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
err()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; }

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }

# 1. Ensure Bun (the runtime). Installs to ~/.bun by default; no Node/npm.
if ! command -v bun >/dev/null 2>&1; then
  info "Installing the Bun runtime…"
  curl -fsSL https://bun.sh/install | bash
  BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export BUN_INSTALL
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

command -v bun >/dev/null 2>&1 || {
  err "Bun install finished but 'bun' is not on PATH. Open a new shell and re-run."
  exit 1
}

# 2. Install the Openship CLI globally (fetched from the registry by Bun —
#    the npm CLI itself is never invoked).
PKG="openship"
[ -n "${OPENSHIP_VERSION:-}" ] && PKG="openship@${OPENSHIP_VERSION}"
info "Installing the Openship CLI (${PKG})…"
bun add -g "$PKG"

# 3. Next steps.
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
cat <<EOF

$(printf '\033[32m✔\033[0m') Openship installed.

  openship init       # configure your self-hosted server
  openship server     # run it
  openship --help     # everything else

If 'openship' isn't found, add Bun's global bin to your PATH:
  export PATH="${BUN_BIN}:\$PATH"
EOF
