#!/bin/sh
set -eu
kind="${1:?api, publisher or qualify required}"
image="$(cat /etc/uvel/image)"
case "$image" in uvel-admin:*) ;; *) echo 'Invalid pinned UVEL image' >&2; exit 1;; esac
case "$kind" in
  api)
    exec docker run --rm --init --name uvel-admin-api --network host --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 768m --cpus 1 \
      --log-opt max-size=10m --log-opt max-file=3 --tmpfs /tmp:rw,nosuid,nodev,size=128m,uid=10001,gid=10001 \
      --env-file /etc/uvel/api.env -v /var/lib/uvel/database:/data:rw -v /var/www/uvel:/var/www/uvel:ro \
      "$image" node worker/aws/server.mjs ;;
  publisher|qualify)
    name=uvel-publisher
    if [ "$kind" = qualify ]; then
      name=uvel-qualifier
      set -- --mount "type=bind,src=/opt/uvel/qualifications-staging/${image#uvel-admin:},dst=/qualification-output" \
        "$image" node --no-maglev --import ./worker/register-ts-ext.mjs deploy/aws/qualify-release.mjs
    else
      set -- --env-file /etc/uvel/publisher.env "$image" node --no-maglev --import ./worker/register-ts-ext.mjs worker/runner.mjs
    fi
    exec docker run --rm --init --name "$name" --network host --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 768 --memory 6g --cpus 2 --shm-size 512m \
      --log-opt max-size=10m --log-opt max-file=3 --tmpfs /tmp:rw,nosuid,nodev,size=512m,uid=10001,gid=10001 \
      --tmpfs /app/node_modules/.vite-temp:rw,size=64m,uid=10001,gid=10001 \
      --tmpfs /app/node_modules/.astro:rw,size=128m,uid=10001,gid=10001 \
      --tmpfs /app/node_modules/.vite:rw,size=128m,uid=10001,gid=10001 \
      --tmpfs /app/admin/node_modules/.vite-temp:rw,size=64m,uid=10001,gid=10001 \
      --tmpfs /app/worker/node_modules/.vite-temp:rw,size=64m,uid=10001,gid=10001 \
      --tmpfs /app/admin/node_modules/.vite:rw,size=128m,uid=10001,gid=10001 \
      --tmpfs /app/worker/node_modules/.vite:rw,size=128m,uid=10001,gid=10001 \
      -e PUBLISH_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$image")" \
      -v "/opt/uvel/qualifications/${image#uvel-admin:}:/qualification:ro" \
      -e HOME=/var/lib/uvel/publisher -e TMPDIR=/var/lib/uvel/publisher/tmp -e NODE_OPTIONS=--max-old-space-size=4096 \
      -v /var/lib/uvel/publisher:/var/lib/uvel/publisher:rw -v /var/www/uvel:/var/www/uvel:rw \
      "$@" ;;
  *) echo 'Unknown service' >&2; exit 1;;
esac
