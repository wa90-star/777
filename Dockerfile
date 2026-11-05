FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    RADAR_DATA_DIR=/data

COPY --chown=node:node package.json ./
COPY --chown=node:node *.js ./
COPY --chown=node:node ef-primary/*.mjs ./ef-primary/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node public/ ./public/

RUN mkdir -p /data && chown node:node /data

EXPOSE 3000

# Optional self-hosting check. Railway's configured deployment healthcheck is
# separate. Use core HTTP rather than loading fetch for a tiny local request.
HEALTHCHECK --interval=5m --timeout=3s --start-period=90s --retries=3 \
  CMD ["node", "-e", "const r=require('node:http').get({host:'127.0.0.1',port:Number(process.env.PORT||3000),path:'/api/status',timeout:2000,agent:false},s=>{s.resume();if(s.statusCode!==200)process.exitCode=1});r.on('timeout',()=>r.destroy(new Error('timeout')));r.on('error',()=>{process.exitCode=1});"]

CMD ["node", "container-entrypoint.js"]
