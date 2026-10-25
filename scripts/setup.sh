#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
  if [ ! -x runtime/node/bin/node ]; then
    task_arch="$(uname -m)"
    case "$task_arch" in x86_64) task_arch=x64;; aarch64) task_arch=arm64;; *) echo "Install Node.js 22+ for this platform"; exit 1;; esac
    task_archive="node-v22.23.4-linux-${task_arch}.tar.xz"
    mkdir -p runtime/downloads runtime/node
    curl -fsSL "https://nodejs.org/dist/v22.23.4/${task_archive}" -o "runtime/downloads/${task_archive}"
    curl -fsSL https://nodejs.org/dist/v22.23.4/SHASUMS256.txt -o runtime/downloads/SHASUMS256.txt
    (cd runtime/downloads && awk -v archive="$task_archive" '$2==archive {print}' SHASUMS256.txt | sha256sum -c -)
    tar -xf "runtime/downloads/${task_archive}" -C runtime/node --strip-components=1
  fi
  export PATH="$PWD/runtime/node/bin:$PATH"
fi
npm ci --no-audit --no-fund
npx tsx scripts/init.ts
npm run build
echo 'Setup complete. Configure config/connections.local.json, then start PostgreSQL, migrate, web and worker.'
