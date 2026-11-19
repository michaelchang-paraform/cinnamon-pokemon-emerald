#!/bin/sh
# Starts the battle helper. Extra arguments go to src/server.js (see --help).
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="${PKMN_NODE:-$(command -v node || echo node)}"
exec "$NODE" --max-old-space-size=512 "$DIR/src/server.js" "$@"
