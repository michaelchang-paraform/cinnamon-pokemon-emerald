#!/bin/sh
# Stops and removes the battle helper LaunchAgent. The log file stays.
set -eu

LABEL="com.pokemon-emerald.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "Stopped $LABEL."
else
  echo "$LABEL is not loaded."
fi

if [ -f "$PLIST" ]; then
  rm "$PLIST"
  echo "Removed $PLIST."
else
  echo "No plist at $PLIST."
fi
echo "Log kept: $HOME/Library/Logs/pokemon-emerald-helper.log"
