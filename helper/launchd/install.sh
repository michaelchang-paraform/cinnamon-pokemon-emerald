#!/bin/sh
# Installs a per-user LaunchAgent that keeps the battle helper running.
# Dry run by default: prints the plan and changes nothing. Pass --yes to install.
set -eu

LABEL="com.pokemon-emerald.helper"
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER_DIR="$(cd "$HERE/.." && pwd)"
START_SH="$HELPER_DIR/start.sh"
TEMPLATE="$HERE/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/pokemon-emerald-helper.log"
DOMAIN="gui/$(id -u)"
PORT=41851

NODE="${PKMN_NODE:-$(command -v node || true)}"
CLAUDE_BIN="$(command -v claude || true)"
AGENT_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
[ -n "$NODE" ] && AGENT_PATH="$(dirname "$NODE"):$AGENT_PATH"
[ -n "$CLAUDE_BIN" ] && AGENT_PATH="$(dirname "$CLAUDE_BIN"):$AGENT_PATH"

fail() {
  echo "error: $*" >&2
  exit 1
}

[ -f "$START_SH" ] || fail "start.sh not found at $START_SH"
[ -f "$TEMPLATE" ] || fail "template not found at $TEMPLATE"
[ -n "$NODE" ] && [ -x "$NODE" ] || fail "node not found. Run from a shell where node works, or set PKMN_NODE=/path/to/node"
case "$START_SH$NODE$LOG" in *'|'*|*'&'*) fail "paths with | or & are not supported" ;; esac

echo "Pokemon Emerald battle helper: LaunchAgent install"
echo "  agent     $LABEL"
echo "  plist     $PLIST"
echo "  runs      /bin/sh $START_SH"
echo "  node      $NODE"
echo "  claude    ${CLAUDE_BIN:-not found (Claude battles stay off)}"
echo "  log       $LOG"
echo "  starts    at login and now; restarts only after a crash, at most once every 30 s"

if [ "${1:-}" != "--yes" ]; then
  echo
  echo "Dry run: nothing changed. Run again with --yes to install."
  exit 0
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  fail "a helper already listens on port $PORT. Stop it (Ctrl-C in its terminal), then run this again."
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
TMP="$(mktemp)"
sed -e "s|__LABEL__|$LABEL|g" \
    -e "s|__START_SH__|$START_SH|g" \
    -e "s|__HELPER_DIR__|$HELPER_DIR|g" \
    -e "s|__NODE__|$NODE|g" \
    -e "s|__PATH__|$AGENT_PATH|g" \
    -e "s|__LOG__|$LOG|g" \
    "$TEMPLATE" > "$TMP"
plutil -lint "$TMP" >/dev/null || { rm -f "$TMP"; fail "generated plist is not valid"; }

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
mv "$TMP" "$PLIST"
chmod 644 "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

echo
echo "Installed. Check it with:"
echo "  launchctl print $DOMAIN/$LABEL | grep -E 'state|pid|last exit'"
echo "  curl -s http://127.0.0.1:$PORT/health"
echo "Log: $LOG"
