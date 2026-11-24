FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./

# --ignore-scripts: better-sqlite3 ships ready-made binaries (prebuilds/), but npm 10 still tries to compile it
# with node-gyp, which needs Python and a C++ compiler that the slim image doesn't have. No dependency needs an
# install script.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data && chown node:node /app/data

# mount config.yaml at /app/config.yaml
# pass secrets as env vars
# keep /app/data on a volume.
VOLUME ["/app/data"]

USER node

CMD ["node", "src/index.js"]
