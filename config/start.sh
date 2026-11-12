#!/bin/bash
# Run both application processes under tini, which reaps orphaned children.
if [ "${API_WATCH:-false}" = "true" ]; then
    # Watch the entry point and its imports; keep dependencies outside the source mount.
    node --watch --watch-preserve-output "${API_ENTRYPOINT:-/app/server.mjs}" &
else
    node "${API_ENTRYPOINT:-/app/server.mjs}" &
fi
upload_pid=$!

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!

# Stop both supervised processes and reap them during shutdown or failure.
stop() {
    # Either process may already have exited when this cleanup runs.
    kill -TERM "$upload_pid" "$caddy_pid" 2>/dev/null || true
    wait "$upload_pid" "$caddy_pid" 2>/dev/null || true
}

# Docker/Swarm shutdown is expected: stop both children and exit successfully.
trap 'stop; exit 0' TERM INT

# A failure in either process must stop the other, rather than leave a partial app.
wait -n "$upload_pid" "$caddy_pid"
result=$?
stop

# Unexpected exits should trigger the container restart policy.
if [ "$result" -eq 0 ]; then
    result=1
fi
exit "$result"
