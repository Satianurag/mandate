#!/usr/bin/env bash
# No host state, credentials, devices, or wallet environment enter either command.
set -euo pipefail
docker build -f Dockerfile.verify -t mandate-verify:local .
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges mandate-verify:local
