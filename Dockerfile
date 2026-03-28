FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app

RUN npm install -g @openai/codex@0.117.0

COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY .env.example ./.env.example

USER node
ENV HOME=/home/node
ENV CODEX_CLI_BRIDGE_HOST=127.0.0.1
ENV CODEX_CLI_BRIDGE_PORT=11434
ENV CODEX_CLI_BRIDGE_MODEL=codex
ENV CODEX_CLI_BRIDGE_CODEX_BIN=codex
ENV CODEX_CLI_BRIDGE_CODEX_EXTRA_ARGS=
ENV CODEX_CLI_BRIDGE_CODEX_FORMAT=text
ENV CODEX_CLI_BRIDGE_TIMEOUT_SECONDS=90
ENV CODEX_CLI_BRIDGE_MAX_BODY_BYTES=32768
ENV CODEX_CLI_BRIDGE_MAX_CONCURRENT_REQUESTS=1

EXPOSE 11434

CMD ["node", "dist/index.js"]
