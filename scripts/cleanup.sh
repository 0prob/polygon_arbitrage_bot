#!/usr/bin/env bash
set -euo pipefail

echo "[cleanup] Stopping stale containers..."
docker stop envio-postgres envio-hasura 2>/dev/null || true
docker rm envio-postgres envio-hasura 2>/dev/null || true

echo "[cleanup] Freeing ports..."
for port in 5433 8080 9898; do
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "[cleanup] Killing pid $pid on port $port"
    kill -9 "$pid" 2>/dev/null || true
  fi
done

echo "[cleanup] Cleaning data directory..."
rm -rf data/
mkdir -p data/

echo "[cleanup] Done"
