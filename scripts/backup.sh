#!/usr/bin/env sh
set -eu

if ! docker info >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

backup_dir="${1:-./backups}"
mkdir -p "$backup_dir"
stamp="$(date +%Y%m%d-%H%M%S)"
docker compose exec -T app node -e "const{backup,DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/dj-relay.sqlite');backup(db,'/app/data/backup-$stamp.sqlite').then(()=>db.close())"
docker compose cp "app:/app/data/backup-$stamp.sqlite" "$backup_dir/dj-relay-$stamp.sqlite"
docker compose exec -T app rm -f "/app/data/backup-$stamp.sqlite" 2>/dev/null || true
find "$backup_dir" -type f -name 'dj-relay-*.sqlite' -mtime +7 -delete
if [ -n "${SUDO_USER:-}" ]; then
  chown -R "$SUDO_USER:$SUDO_USER" "$backup_dir"
fi
echo "$backup_dir/dj-relay-$stamp.sqlite"
