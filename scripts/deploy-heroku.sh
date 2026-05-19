#!/usr/bin/env bash
set -euo pipefail

# Build the site image as linux/amd64 (Heroku is amd64), push to the
# Heroku container registry, and release. Run from the repo root so
# the Docker build context can see both site/ and docs/.

APP="${HEROKU_APP:-ormuz-llm-gateway}"
IMAGE="registry.heroku.com/${APP}/web"

if ! command -v heroku >/dev/null 2>&1; then
    echo "deploy-heroku: heroku CLI not found on PATH." >&2
    exit 1
fi

if ! heroku auth:whoami >/dev/null 2>&1; then
    echo "deploy-heroku: not logged in. Run 'heroku login' first." >&2
    exit 1
fi

echo "==> ensuring stack=container on $APP"
heroku stack:set container -a "$APP" >/dev/null

echo "==> logging in to Heroku container registry"
heroku container:login >/dev/null

echo "==> building $IMAGE (linux/amd64, plain Docker manifest)"
docker buildx build \
    --platform linux/amd64 \
    --provenance=false \
    --sbom=false \
    -f site/Dockerfile \
    -t "$IMAGE" \
    --output type=docker \
    .

echo "==> pushing $IMAGE"
docker push "$IMAGE"

echo "==> releasing"
heroku container:release web -a "$APP"

URL="$(heroku apps:info -a "$APP" --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).app.web_url))')"
echo
echo "Live at: $URL"
echo
echo "Smoke test:"
echo "  curl -sS -o /dev/null -w 'code=%{http_code}\n' \"$URL\""
