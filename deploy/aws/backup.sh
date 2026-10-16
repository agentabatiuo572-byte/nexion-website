#!/bin/sh
set -eu
image="$(cat /etc/uvel/image)"
exec docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --memory 512m \
  --env-file /etc/uvel/api.env -v /var/lib/uvel/database:/data:rw -v /var/www/uvel:/var/www/uvel:ro -v /var/backups/uvel-admin:/backup:rw \
  "$image" node worker/aws/backup.mjs /backup
