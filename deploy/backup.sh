#!/bin/sh
# Daily compressed dump of the database; keeps KEEP_DAYS days.
set -eu
while true; do
  f="/backups/patpattap-$(date +%Y%m%d-%H%M%S).sql.gz"
  if pg_dump --no-owner | gzip > "$f.tmp"; then
    mv "$f.tmp" "$f"
    echo "backup written: $f"
  else
    echo "backup failed" >&2
  fi
  find /backups -name 'patpattap-*.sql.gz' -mtime +"${KEEP_DAYS:-14}" -exec rm -- {} +
  sleep 86400
done
