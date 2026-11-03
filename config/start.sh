#!/bin/bash
# Stop the container if either process exits; forward shutdown to both.
node /app/server.mjs &
upload_pid=$!
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!

stop() {
    kill -TERM "$upload_pid" "$caddy_pid" 2>/dev/null || true
    wait "$upload_pid" "$caddy_pid" 2>/dev/null || true
}
trap 'stop; exit 0' TERM INT
wait -n "$upload_pid" "$caddy_pid"
result=$?
stop
# Unexpected exits should trigger the container restart policy.
if [ "$result" -eq 0 ]; then result=1; fi
exit "$result"
