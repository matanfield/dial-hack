#!/usr/bin/env bash
# Smoke test for the dial-hack MCP server.
# Usage: bash scripts/smoke.sh [base_url]   (default http://localhost:3000)
set -euo pipefail

BASE="${1:-http://localhost:3000}"
MCP="$BASE/mcp"
H='Content-Type: application/json'
A='Accept: application/json, text/event-stream'

echo "== GET /health"
curl -sf "$BASE/health"
echo

echo "== MCP initialize"
curl -sf -X POST "$MCP" -H "$H" -H "$A" -d '{
  "jsonrpc":"2.0","id":1,"method":"initialize",
  "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}
}'
echo

echo "== MCP tools/list"
curl -sf -X POST "$MCP" -H "$H" -H "$A" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | grep -o '"name":"[a-z_]*"'
echo

echo "== MCP tools/call health"
curl -sf -X POST "$MCP" -H "$H" -H "$A" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"health","arguments":{}}}'
echo
echo "OK: all smoke checks passed"
