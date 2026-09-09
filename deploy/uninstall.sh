#!/bin/bash
# Stopper og fjerner tjenestene igjen.
for L in no.musicstreamerweb.server no.musicstreamerweb.tunnel; do
  launchctl bootout "gui/$UID/$L" 2>/dev/null && echo "Stoppet: $L"
  rm -f "$HOME/Library/LaunchAgents/$L.plist"
done
echo "Fjernet."
