# Install the JWT library separately so dependency layers can be reused.
FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Keep the web server and local account/upload API in one deployable image.
FROM caddy:2.11.9-alpine
# Refresh inherited system libraries as well as installing runtime dependencies.
RUN apk upgrade --no-cache \
    && apk add --no-cache nodejs bash tini
COPY --from=dependencies /app/node_modules /app/node_modules
COPY config/caddyfile /etc/caddy/Caddyfile
COPY src/public/ /srv/
COPY src/upload/ /app/
COPY config/start.sh /app/start.sh
RUN mkdir -p /srv/models /data/auth
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e \
    "Promise.all([fetch('http://127.0.0.1/'), fetch('http://127.0.0.1:3000/health')]) \
    .then(([web, api]) => process.exit(web.ok && api.ok ? 0 : 1)) \
    .catch(() => process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "/bin/bash", "/app/start.sh"]
