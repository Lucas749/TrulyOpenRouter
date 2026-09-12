#!/bin/sh
# Hosted agent box: a machine with no USB port. It runs a session bus and a headless secret store so
# Ledger's CLI can find the Key Ring membership that `tor-agent enroll` puts there from the Mac.
set -e

rm -f /run/dbus.sock
dbus-daemon --session --address="unix:path=/run/dbus.sock" --fork
printf '%s' "${KEYRING_PASS:-tor-demo}" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1 &

for _ in 1 2 3 4 5 6 7 8 9 10; do
  secret-tool search --all dummy dummy >/dev/null 2>&1 && break
  sleep 0.5
done

exec "$@"
