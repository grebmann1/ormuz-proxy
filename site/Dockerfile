# Multi-stage build for the Ormuz public website.
# Build context expected to be the repo root so we can COPY both
# `site/` and `docs/` (the markdown sources) in one shot.
#
# Build:
#   docker build -f site/Dockerfile -t ormuz-site:latest .
# Run locally:
#   docker run --rm -e PORT=8080 -p 8080:8080 ormuz-site:latest
# Heroku injects $PORT at runtime; nothing else to configure.

FROM node:20-alpine AS builder
WORKDIR /work/site

# Install deps first (cache-friendly).
COPY site/package.json ./package.json
RUN npm install --omit=optional --no-audit --no-fund

# Copy site sources and the markdown docs.
COPY site/build.mjs ./build.mjs
COPY site/src ./src
COPY docs /work/docs

# Render to /work/site/dist
RUN node build.mjs

FROM nginx:alpine AS runtime

# envsubst comes from gettext on alpine.
RUN apk add --no-cache gettext

COPY --from=builder /work/site/dist /usr/share/nginx/html
COPY site/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY site/docker-entrypoint.sh /docker-entrypoint-ormuz.sh
RUN chmod +x /docker-entrypoint-ormuz.sh

CMD ["/docker-entrypoint-ormuz.sh"]
