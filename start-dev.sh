#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Ship-Date Drift & Inventory Buffer Orchestrator — Dev Launcher
# Usage: ./start-dev.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "📦 Installing backend dependencies…"
cd "$ROOT/app/backend" && npm install

echo "📦 Installing frontend dependencies…"
cd "$ROOT/app/frontend" && npm install

echo ""
echo "🧪 Running ADK Python tests…"
cd "$ROOT/app/adk" && .venv/bin/pytest tests/ -v --tb=short

echo ""
echo "🧪 Running backend tests…"
cd "$ROOT/app/backend" && npm test

echo ""
echo "🚀 Starting backend on http://localhost:4000 …"
cd "$ROOT/app/backend" && npm start &

echo ""
echo "🌐 Starting frontend on http://localhost:3000 …"
cd "$ROOT/app/frontend" && npm start &

wait
