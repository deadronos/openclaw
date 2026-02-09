#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="openclaw-sandbox:trixie-slim"
UID_BUILD="${UID:-1000}"
GID_BUILD="${GID:-1000}"

docker build -t "${IMAGE_NAME}" --build-arg UID_BUILD="${UID_BUILD}" --build-arg GID_BUILD="${GID_BUILD}" -f Dockerfile.sandbox.node .
echo "Built ${IMAGE_NAME}"
