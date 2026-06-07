#!/bin/bash
# Persistent restart loop for HyperIndex (envio)
# Keeps envio running continuously for live debugging/optimization loop
# Exits on rapid restart (config error or no HyperIndex data)
# Don't set -e: envio exits with non-zero sometimes, we want to restart

cd /home/x/arb/t/hyperindex

MAX_RESTARTS=50
restart_count=0
last_start_time=0

# ANSI color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}[restart_loop] Starting HyperIndex restart loop (max $MAX_RESTARTS restarts)${NC}"

while [ $restart_count -lt $MAX_RESTARTS ]; do
  current_time=$(date +%s)
  restart_count=$((restart_count + 1))

  # Rapid restart detection: if died within 30s, signal config error
  if [ $last_start_time -gt 0 ] && [ $((current_time - last_start_time)) -lt 30 ]; then
    echo -e "${RED}[restart_loop] envio died within 30s (attempt $restart_count). Possible config error.${NC}"
    if [ $restart_count -ge 5 ]; then
      echo -e "${RED}[restart_loop] 5 rapid attempts - stopping. Check config.yaml and .env.${NC}"
      break
    fi
    sleep 5
  fi

  last_start_time=$current_time
  echo -e "${GREEN}[restart_loop] Starting envio (attempt $restart_count/${MAX_RESTARTS}) $(date '+%H:%M:%S')${NC}"

  ENVIO_FULL_BATCH_SIZE=4500 \
  ENVIO_LOG_LEVEL=info \
  bunx envio start 2>&1

  EXIT_CODE=$?
  echo -e "${YELLOW}[restart_loop] envio exited with code $EXIT_CODE at $(date '+%H:%M:%S')${NC}"

  sleep 3
done

echo -e "${RED}[restart_loop] Loop ended after $restart_count attempts${NC}"
