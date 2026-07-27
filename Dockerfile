FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends wireguard-tools iptables iproute2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV WG_PORT=51821 \
    WG_HOST=0.0.0.0 \
    WG_DATA_DIR=/data \
    WG_ALLOW_APPLY=1

VOLUME ["/data"]
EXPOSE 51821/tcp 51820/udp

CMD ["node", "server/index.js"]
