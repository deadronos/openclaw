#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="openclaw-sandbox:trixie-slim"

docker build -t "${IMAGE_NAME}" -f Dockerfile.sandbox.node .
echo "Built ${IMAGE_NAME}"
