FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    RADAR_DATA_DIR=/data

COPY --chown=node:node package.json ./
COPY --chown=node:node *.js ./
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node public/ ./public/

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=8s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/status').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["sh", "-c", "node journal-dedupe-v4.js; exec node server-v4.js"]
