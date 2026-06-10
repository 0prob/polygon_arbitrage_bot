#!/bin/bash
# Persistent restart loop for arb bot
# Keeps arb bot running continuously for live debugging/optimization loop
# Exits on rapid restart

cd /home/x/arb/t

MAX_RESTARTS=100
restart_count=0
last_start_time=0

# ANSI color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}[arb_restart_loop] Starting arb restart loop (max $MAX_RESTARTS restarts)${NC}"

while [ $restart_count -lt $MAX_RESTARTS ]; do
  current_time=$(date +%s)
  restart_count=$((restart_count + 1))

  # Rapid restart detection: if died within 10s, signal potential error
  if [ $last_start_time -gt 0 ] && [ $((current_time - last_start_time)) -lt 10 ]; then
    echo -e "${RED}[arb_restart_loop] arb bot died within 10s (attempt $restart_count). Possible crash.${NC}"
    if [ $restart_count -ge 3 ]; then
      echo -e "${RED}[arb_restart_loop] 3 rapid attempts - stopping. Check logs.${NC}"
      break
    fi
    sleep 5
  fi

  last_start_time=$current_time
  echo -e "${GREEN}[arb_restart_loop] Starting arb bot (attempt $restart_count/${MAX_RESTARTS}) $(date '+%H:%M:%S')${NC}"

  # Run the command
  bun --env-file=.env run src/cli/arb_only.ts

  EXIT_CODE=$?
  echo -e "${YELLOW}[arb_restart_loop] arb bot exited with code $EXIT_CODE at $(date '+%H:%M:%S')${NC}"

  sleep 3
done

echo -e "${RED}[arb_restart_loop] Loop ended after $restart_count attempts${NC}"
