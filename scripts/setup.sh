#!/usr/bin/env bash
# One-shot setup: install deps, store your NVIDIA NIM key as a Cloudflare
# secret, deploy the Worker, and print the Claude Code export commands.
set -euo pipefail

if ! command -v npx >/dev/null 2>&1; then
    echo "npx not found. Install Node.js first: https://nodejs.org" >&2
    exit 1
fi

echo "==> Installing dependencies"
npm install --silent

if [ -z "${NVIDIA_API_KEY:-}" ]; then
    echo
    echo "Grab a free NVIDIA NIM API key at https://build.nvidia.com/ (any model page > Get API Key)."
    read -rsp "Paste your NVIDIA_API_KEY: " NVIDIA_API_KEY
    echo
fi

if [ -z "$NVIDIA_API_KEY" ]; then
    echo "No API key provided. Aborting." >&2
    exit 1
fi

echo "==> Storing NVIDIA_API_KEY as a Cloudflare secret"
printf '%s' "$NVIDIA_API_KEY" | npx wrangler secret put NVIDIA_API_KEY

echo "==> Deploying"
DEPLOY_LOG="$(mktemp)"
npx wrangler deploy | tee "$DEPLOY_LOG"

WORKER_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | tail -1)"
rm -f "$DEPLOY_LOG"

echo
echo "==> Done. Point Claude Code at your Worker:"
echo
echo "  export ANTHROPIC_BASE_URL=${WORKER_URL:-https://<your-worker>.workers.dev}"
echo "  export ANTHROPIC_API_KEY=dummy"
echo "  export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1"
echo
echo "The last line makes every model in src/registry.ts show up in Claude Code's"
echo "/model picker automatically (requires Claude Code v2.1.129+)."
echo
