#!/usr/bin/env bash
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-openclaw-sandbox-custom:trixie-slim}"
TARGET_IMAGE="${TARGET_IMAGE:-openclaw-sandbox-common-custom:trixie-slim}"
PACKAGES="${PACKAGES:-curl wget jq yq coreutils grep nodejs npm python3 python3-pip git ca-certificates \
golang-go rustc cargo unzip zip pkg-config libasound2-dev build-essential cmake file sqlite3 \
ripgrep procps nano fd-find openssh-client less locales tzdata mc tree fzf bat eza tmux vim rsync \
gh yt-dlp ffmpeg}"
INSTALL_PNPM="${INSTALL_PNPM:-1}"
INSTALL_BUN="${INSTALL_BUN:-1}"
BUN_INSTALL_DIR="${BUN_INSTALL_DIR:-/opt/bun}"
INSTALL_BREW="${INSTALL_BREW:-1}"
BREW_INSTALL_DIR="${BREW_INSTALL_DIR:-/home/linuxbrew/.linuxbrew}"
INSTALL_MCPORTER="${INSTALL_MCPORTER:-1}"
INSTALL_GIFGREP="${INSTALL_GIFGREP:-1}"
GIFGREP_GO_MODULE="${GIFGREP_GO_MODULE:-github.com/steipete/gifgrep/cmd/gifgrep@latest}"
INSTALL_NANO_PDF="${INSTALL_NANO_PDF:-1}"
INSTALL_INFRA_TOOLS="${INSTALL_INFRA_TOOLS:-0}"
INFRA_BREW_FORMULAE="${INFRA_BREW_FORMULAE:-kubectl helm terraform ansible}"
INSTALL_PEEKABOO="${INSTALL_PEEKABOO:-0}"
FINAL_USER="${FINAL_USER:-openclaw}"

if ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
  echo "Base image missing: ${BASE_IMAGE}"
  echo "Building base image via scripts/sandbox-setup.sh..."
  scripts/sandbox-setup.sh
fi

echo "Building ${TARGET_IMAGE} with: ${PACKAGES}"

docker build \
  -t "${TARGET_IMAGE}" \
    -f Dockerfile.sandbox-common.node \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  --build-arg PACKAGES="${PACKAGES}" \
  --build-arg INSTALL_PNPM="${INSTALL_PNPM}" \
  --build-arg INSTALL_BUN="${INSTALL_BUN}" \
  --build-arg BUN_INSTALL_DIR="${BUN_INSTALL_DIR}" \
  --build-arg INSTALL_BREW="${INSTALL_BREW}" \
  --build-arg BREW_INSTALL_DIR="${BREW_INSTALL_DIR}" \
  --build-arg INSTALL_MCPORTER="${INSTALL_MCPORTER}" \
  --build-arg INSTALL_GIFGREP="${INSTALL_GIFGREP}" \
  --build-arg GIFGREP_GO_MODULE="${GIFGREP_GO_MODULE}" \
  --build-arg INSTALL_NANO_PDF="${INSTALL_NANO_PDF}" \
  --build-arg INSTALL_INFRA_TOOLS="${INSTALL_INFRA_TOOLS}" \
  --build-arg INFRA_BREW_FORMULAE="${INFRA_BREW_FORMULAE}" \
  --build-arg INSTALL_PEEKABOO="${INSTALL_PEEKABOO}" \
  --build-arg FINAL_USER="${FINAL_USER}" \
  .
  
cat <<NOTE
Built ${TARGET_IMAGE}.
To use it, set agents.defaults.sandbox.docker.image to "${TARGET_IMAGE}" and restart.
If you want a clean re-create, remove old sandbox containers:
  docker rm -f \$(docker ps -aq --filter label=openclaw.sandbox=1)
NOTE
