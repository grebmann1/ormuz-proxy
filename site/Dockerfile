# Multi-stage build for the Ormuz public website.
# Build context expected to be the repo root so we can COPY both
# `site/` and `docs/` (the markdown sources) in one shot.
#
# Build:
#   docker build -f site/Dockerfile -t ormuz-site:latest .
# Run:
#   docker run --rm -p 8080:80 ormuz-site:latest

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
COPY --from=builder /work/site/dist /usr/share/nginx/html
COPY site/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
