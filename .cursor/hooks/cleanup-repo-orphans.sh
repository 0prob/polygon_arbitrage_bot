#!/usr/bin/env bash
# Kill repo-scoped dev/test/hypersync processes orphaned under systemd (no TTY).
# Stops envio-* Docker containers only when envio-related orphans were killed
# and no interactive envio dev session is attached to a terminal.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HYPERINDEX_DIR="$REPO_ROOT/hyperindex"

log() {
  echo "[cleanup-repo-orphans] $*" >&2
}

is_envio_related_cmd() {
  local cmd=$1
  [[ "$cmd" =~ (^|[[:space:]])envio([[:space:]]|$) ]] && return 0
  [[ "$cmd" == *bunx*envio* ]] && return 0
  [[ "$cmd" == *dev-hyperindex* ]] && return 0
  return 1
}

is_repo_runtime_cmd() {
  local cmd=$1
  is_envio_related_cmd "$cmd" && return 0
  [[ "$cmd" =~ (^|[[:space:]/])(bun|node|vitest)([[:space:]]|$) ]] && return 0
  return 1
}

is_repo_orphan() {
  local pid=$1
  local cwd ppid tty parent_comm cmd

  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || return 1
  [[ "$cwd" == "$REPO_ROOT"/* || "$cwd" == "$REPO_ROOT" ]] || return 1

  tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ' || true)
  [[ -z "$tty" || "$tty" == "?" ]] || return 1

  ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
  parent_comm=$(ps -p "$ppid" -o comm= 2>/dev/null | tr -d ' ')
  [[ "$parent_comm" == "systemd" ]] || return 1

  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [[ -n "$cmd" ]] || return 1
  [[ "$cmd" == *cursor* || "$cmd" == *Cursor* ]] && return 1
  [[ "$cmd" == *cleanup-repo-orphans* ]] && return 1
  is_repo_runtime_cmd "$cmd" || return 1

  return 0
}

has_active_envio_session() {
  local pid cwd tty cmd

  while read -r pid; do
    [[ -n "$pid" ]] || continue
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || continue
    [[ "$cwd" == "$REPO_ROOT"/* || "$cwd" == "$REPO_ROOT" ]] || continue

    tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ' || true)
    [[ -n "$tty" && "$tty" != "?" ]] || continue

    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    [[ -n "$cmd" ]] || continue
    is_envio_related_cmd "$cmd" && return 0
    [[ "$cmd" =~ bun[[:space:]]+run[[:space:]]+(dev|devr|debug) ]] && return 0
  done < <(pgrep -u "$(id -u)" 2>/dev/null || true)

  return 1
}

cleanup_envio_docker() {
  if has_active_envio_session; then
    log "skipping envio docker cleanup — interactive envio/dev session has a TTY"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    log "docker not available; skipping envio container cleanup"
    return 0
  fi

  local running
  running=$(docker ps -q --filter name=envio- 2>/dev/null || true)
  if [[ -z "$running" ]]; then
    return 0
  fi

  log "stopping envio docker stack (envio-postgres, envio-hasura, etc.)"
  if [[ -d "$HYPERINDEX_DIR" ]]; then
    (cd "$HYPERINDEX_DIR" && bunx envio stop >/dev/null 2>&1) || true
  fi

  docker rm -f $(docker ps -q --filter name=envio- 2>/dev/null) >/dev/null 2>&1 || true
  log "envio docker cleanup complete"
}

killed=0
killed_envio=0
while read -r pid; do
  [[ -n "$pid" ]] || continue
  if is_repo_orphan "$pid"; then
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo "?")
    log "killing orphan pid=$pid: $cmd"
    kill "$pid" 2>/dev/null || true
    killed=$((killed + 1))
    if is_envio_related_cmd "$cmd"; then
      killed_envio=$((killed_envio + 1))
    fi
  fi
done < <(pgrep -u "$(id -u)" 2>/dev/null || true)

if [[ "$killed_envio" -gt 0 ]]; then
  sleep 0.5
  cleanup_envio_docker
fi

log "done (killed $killed process(es), envio-related $killed_envio)"
exit 0
