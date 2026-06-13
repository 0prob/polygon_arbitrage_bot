#!/usr/bin/env bash
# Block shell patterns that leave repo/hypersync processes orphaned in the background.
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.command // empty')

if [[ -z "$command" ]]; then
  echo '{ "permission": "allow" }'
  exit 0
fi

# Ignore quoted literals so greps/echos mentioning blocked commands are not matched.
strip_quoted() {
  local s=$1
  s=$(printf '%s' "$s" | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g')
  printf '%s' "$s"
}
unquoted=$(strip_quoted "$command")

long_running_producer='(bun[[:space:]]+(test|run)|vitest|npm[[:space:]]+run[[:space:]]+(test|dev)|bunx[[:space:]]+vitest|envio[[:space:]]+(dev|run|start|stop)|bunx[[:space:]]+envio|bun[[:space:]]+run[[:space:]]+(dev|devr|debug))'

# Root workspace uses vitest via `bun run test`; bare `bun test` is wrong here.
if [[ "$unquoted" =~ (^|[;&|[:space:]])bun[[:space:]]+test([[:space:]]|$) ]] &&
  [[ ! "$unquoted" =~ --cwd[[:space:]]+hyperindex ]]; then
  jq -n \
    --arg msg "Blocked bare \`bun test\`. Use \`bun run test\` (vitest) or \`bun run --cwd hyperindex test:bun\` instead." \
    --arg agent "Do not run bare \`bun test\` in the repo root. Use \`timeout 120 bun run test\`. Never pipe test/dev/hypersync commands to tail or head." \
    '{ permission: "deny", user_message: $msg, agent_message: $agent }'
  exit 0
fi

# Piping a long-running producer to tail/head exits the consumer early and orphans the producer.
if [[ "$unquoted" == *"|"* ]] &&
  [[ "$unquoted" =~ (tail|head) ]] &&
  [[ "$unquoted" =~ $long_running_producer ]]; then
  jq -n \
    --arg msg "Blocked: piping a long-running command to tail/head leaves the producer orphaned when tail exits." \
    --arg agent "Run tests/dev/hypersync commands directly (e.g. \`timeout 120 bun run test\`, \`bun run dev\`). To cap output, redirect to a file instead of using \`| tail\`." \
    '{ permission: "deny", user_message: $msg, agent_message: $agent }'
  exit 0
fi

# Background envio/docker dev stacks without a supervising shell are hard to clean up later.
if [[ "$unquoted" =~ (^|[;&|[:space:]])(docker[[:space:]]+(compose[[:space:]]+up|run)|nohup[[:space:]]+(bunx[[:space:]]+envio|envio|bun[[:space:]]+run[[:space:]]+dev)) ]] &&
  [[ "$unquoted" == *"&"* || "$unquoted" == *nohup* ]]; then
  jq -n \
    --arg msg "Blocked: backgrounding envio/hypersync dev commands can leave Docker (postgres/hasura) running without supervision." \
    --arg agent "Run \`bun run dev\` in the foreground. Session-end hooks only stop envio Docker when envio-related orphan processes are killed." \
    '{ permission: "deny", user_message: $msg, agent_message: $agent }'
  exit 0
fi

echo '{ "permission": "allow" }'
exit 0
