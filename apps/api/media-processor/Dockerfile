FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 relaymedia

WORKDIR /app
COPY server.mjs /app/server.mjs

USER relaymedia
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
