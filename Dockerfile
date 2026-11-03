FROM caddy:2.9-alpine

RUN apk add --no-cache nodejs bash tini
COPY config/caddyfile /etc/caddy/Caddyfile
COPY src/public/ /srv/
COPY src/upload/server.mjs /app/server.mjs
COPY config/start.sh /app/start.sh
RUN mkdir -p /srv/models

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "Promise.all([fetch('http://127.0.0.1/'), fetch('http://127.0.0.1:3000/upload')]).then(([web, api]) => process.exit(web.ok && api.status === 405 ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "/bin/bash", "/app/start.sh"]
