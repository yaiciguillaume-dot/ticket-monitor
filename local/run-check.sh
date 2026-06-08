#!/bin/bash
# Lancé périodiquement par launchd. Exécute une vérification des billetteries.
cd "$(dirname "$0")/.." || exit 1
echo "----- $(date '+%Y-%m-%d %H:%M:%S') -----"
/Users/gyaici/.local/bin/node src/check.js
