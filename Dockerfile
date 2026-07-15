# Zero-dependency Node app — no npm install step needed.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY config ./config

ENV NODE_ENV=production
ENV DB_PATH=/data/scorecard.db
VOLUME /data

# HTTP UI/API, syslog UDP, syslog TCP
EXPOSE 8080 514/udp 514/tcp

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
