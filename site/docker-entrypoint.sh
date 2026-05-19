#!/bin/sh
set -e

# Heroku injects $PORT at runtime. Default to 8080 for local docker run.
: "${PORT:=8080}"

# Render the nginx template, substituting only ${PORT} so nginx's own
# variables ($uri, $host, etc.) are preserved verbatim.
envsubst '${PORT}' < /etc/nginx/templates/default.conf.template \
    > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
