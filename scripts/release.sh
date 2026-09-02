#!/usr/bin/env bash
# Builds a self-contained release bundle: server/dist + web/dist + production-only
# node_modules. Pure-JS dependencies, so one tarball runs on macOS/Linux/Windows
# anywhere Node 20+ is installed. Usage: scripts/release.sh [version]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
STAGE_NAME="d8s-$VERSION"
STAGE="$ROOT/release/$STAGE_NAME"

rm -rf "$ROOT/release"
mkdir -p "$STAGE/server" "$STAGE/web"

echo "==> Building web + server"
(cd "$ROOT" && npm run build)

echo "==> Staging bundle"
cp -R "$ROOT/server/dist" "$STAGE/server/dist"
cp -R "$ROOT/web/dist" "$STAGE/web/dist"

node -e "
const p = require('$ROOT/server/package.json');
const out = {
  name: 'd8s',
  version: '$VERSION',
  private: true,
  type: 'module',
  scripts: { start: 'node server/dist/index.js' },
  dependencies: p.dependencies,
};
require('fs').writeFileSync('$STAGE/package.json', JSON.stringify(out, null, 2) + '\n');
"

cat > "$STAGE/start.sh" <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
NODE_ENV=production node server/dist/index.js
EOF
chmod +x "$STAGE/start.sh"

cat > "$STAGE/start.cmd" <<'EOF'
@echo off
cd /d "%~dp0"
set NODE_ENV=production
node server\dist\index.js
EOF

cat > "$STAGE/README.txt" <<'EOF'
D8s - compare Kubernetes resources across environments

Requirements:
  - Node.js 20+
  - A working kubeconfig (plus any auth plugins your contexts use,
    e.g. aws CLI for EKS, kubelogin for AKS)

Run:
  ./start.sh        (macOS / Linux)
  start.cmd         (Windows)

Serves on http://localhost:4173 and opens your browser.
Environments you add are stored in ~/.d8s/environments.json.
EOF

echo "==> Installing production dependencies into bundle"
(cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

echo "==> Creating tarball"
tar -czf "$ROOT/release/$STAGE_NAME.tgz" -C "$ROOT/release" "$STAGE_NAME"

SIZE=$(du -sh "$ROOT/release/$STAGE_NAME.tgz" | cut -f1)
echo "==> Done: release/$STAGE_NAME.tgz ($SIZE)"
