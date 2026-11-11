#!/bin/sh
# Prints Codex's rate limits as one JSON line and exits.
# Approach credit: Joseph Malicki's jmalicki/herdr-mod-ai-usage (MIT), whose collector
# reads `codex app-server` account/rateLimits/read. No code is copied from it.
#
# Asks `codex app-server` (JSON-RPC: initialize, initialized,
# account/rateLimits/read); Codex authenticates itself and this script reads no
# tokens. If that fails, prints the newest rate-limit snapshot Codex logged in
# its sessions (last 14 days) as {"snapshot": <line>}.
#
# Exit: 0 = printed something, 127 = codex CLI not found,
# 1 = codex found but no reply and no snapshot.
# Override the binary with HERDR_USAGE_CODEX_BIN; sessions follow CODEX_HOME.

# Not installed: say so, even if old session logs exist (they'd look like a reading).
CODEX=$(command -v "${HERDR_USAGE_CODEX_BIN:-codex}" 2>/dev/null) || exit 127

{
  dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-codex-limits.XXXXXX") || exit 1
  out="$dir/out"
  deadline=$(($(date +%s) + 15))
  # A plain pipe, not a FIFO: Git Bash's mkfifo doesn't reach a native Windows codex.
  # The writer holds stdin open until the reply lands (or 15 s), then the supervisor terminates app-server.
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr-usage-limits","version":"1.0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"initialized"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}'
    i=0
    while [ "$i" -lt 75 ] && [ "$(date +%s)" -lt "$deadline" ]; do
      if grep -q '"id":2' "$out" 2>/dev/null; then break; fi
      sleep 0.2
      i=$((i + 1))
    done
  } | (
    exec 3<&0
    "$CODEX" app-server <&3 3<&- >"$out" 2>/dev/null &
    child=$!
    exec 3<&-
    # EOF can drain outstanding RPCs for longer than our budget. Stop and reap the child.
    i=0
    while [ "$i" -lt 75 ] && [ "$(date +%s)" -lt "$deadline" ]; do
      if grep -q '"id":2' "$out" 2>/dev/null; then break; fi
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

  if grep -m1 '"id":2' "$out"; then
    rm -rf "$dir"
    exit 0
  fi
  rm -rf "$dir"
}

# app-server didn't answer: offer the newest logged snapshot (the mod shows it
# as the last reading, dated, with the provider marked as failing).
sessions="${CODEX_HOME:-$HOME/.codex}/sessions"
if [ -d "$sessions" ]; then
  for f in $(find "$sessions" -name '*.jsonl' -mtime -14 2>/dev/null | xargs ls -t 2>/dev/null | head -30); do
    line=$(grep -h '"rate_limits":{' "$f" 2>/dev/null | tail -1)
    if [ -n "$line" ]; then
      printf '{"snapshot":%s}\n' "$line"
      exit 0
    fi
  done
fi

exit 1
