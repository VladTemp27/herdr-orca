#!/bin/sh
# Prints Claude Code's usage (one `control_response` JSON line) and exits.
#
# Runs your own `claude` CLI briefly and sends it the `get_usage` control
# request; the CLI authenticates itself. This script reads no tokens or
# credential files, sends no prompt and starts no turn. `--safe-mode` keeps
# hooks, MCP servers and customizations out of it.
# Approach credit: Joseph Malicki's jmalicki/herdr-mod-ai-usage (MIT), whose
# collector asks the claude CLI for usage this way. No code is copied from it.
#
# Exit: 0 = printed the reply, 127 = claude CLI not found, 1 = no reply in 15 s.
# Override the binary with HERDR_USAGE_CLAUDE_BIN.

CLAUDE=$(command -v "${HERDR_USAGE_CLAUDE_BIN:-claude}" 2>/dev/null) || exit 127

dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-claude-usage.XXXXXX") || exit 1
out="$dir/out"
deadline=$(($(date +%s) + 15))

# A plain pipe, not a FIFO: Git Bash's mkfifo doesn't reach a native Windows claude.
# The writer holds stdin open until the reply lands (or 15 s), then the supervisor terminates claude.
{
  printf '%s\n' '{"type":"control_request","request_id":"herdr-usage-limits","request":{"subtype":"get_usage","skip_behaviors":true}}'
  i=0
  while [ "$i" -lt 75 ] && [ "$(date +%s)" -lt "$deadline" ]; do
    if grep -q '"control_response"' "$out" 2>/dev/null; then break; fi
    sleep 0.2
    i=$((i + 1))
  done
} | (
  exec 3<&0
  "$CLAUDE" -p --safe-mode --no-session-persistence \
    --input-format stream-json --output-format stream-json --verbose \
    <&3 3<&- >"$out" 2>/dev/null &
  child=$!
  exec 3<&-
  # EOF can drain outstanding RPCs for longer than our budget. Stop and reap the child.
  i=0
  while [ "$i" -lt 75 ] && [ "$(date +%s)" -lt "$deadline" ]; do
    if grep -q '"control_response"' "$out" 2>/dev/null; then break; fi
    if ! kill -0 "$child" 2>/dev/null; then break; fi
    sleep 0.2
    i=$((i + 1))
  done
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      # A CLI shim can own a native child: terminate the owned Windows process tree.
      winpid=$(ps -p "$child" | awk 'NR == 2 { print $4 }')
      if [ -n "$winpid" ]; then MSYS_NO_PATHCONV=1 taskkill.exe /PID "$winpid" /T /F >/dev/null 2>&1; fi
      ;;
    *)
      # npm shims may own the native CLI; stop the whole owned Unix process tree.
      descendants=$(ps -axo pid=,ppid= | awk -v root="$child" '
        { parent[$1] = $2 }
        END { for (pid in parent) {
          p = pid; while (p in parent && p != root) p = parent[p]
          if (p == root) print pid
        } }')
      if [ -n "$descendants" ]; then kill -KILL $descendants 2>/dev/null; fi
      ;;
  esac
  kill -KILL "$child" 2>/dev/null
  wait "$child" 2>/dev/null
)

status=1
if grep -m1 '"control_response"' "$out"; then status=0; fi
rm -rf "$dir"
exit $status
