FROM node:24-alpine

WORKDIR /app

COPY deploy/relay/package.json deploy/relay/package-lock.json ./
RUN npm ci --omit=dev

COPY tools/remote_relay.js ./tools/remote_relay.js
COPY tools/lib/remote_access.js ./tools/lib/remote_access.js

ENV SCC_RELAY_HOST=0.0.0.0
ENV SCC_RELAY_PORT=8782
ENV SCC_RELAY_REGISTRY=/data/registry.json

VOLUME ["/data"]
EXPOSE 8782

CMD ["node", "tools/remote_relay.js", "start"]
