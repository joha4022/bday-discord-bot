#!/bin/sh
set -e

STAMP=$(date +%Y-%m-%d_%H-%M-%S)
FILE="/backups/circlebot_${STAMP}.sql"

pg_dump -F c -f "$FILE"

# Keep last 30 dumps
ls -1t /backups/circlebot_*.sql | tail -n +31 | xargs -r rm -f
