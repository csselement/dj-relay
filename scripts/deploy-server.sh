#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 user@server.example.com"
  exit 1
fi

target="$1"
release_dir="${REMOTE_DIR:-/opt/discus}"

ssh "$target" "sudo mkdir -p '$release_dir' && sudo chown \"\$USER\" '$release_dir'"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude dist --exclude data --exclude backups --exclude .env --exclude caddy-root.crt \
  --exclude .playwright-cli --exclude output --exclude test-results --exclude playwright-report \
  ./ "$target:$release_dir/"
ssh "$target" "cd '$release_dir' && test -f .env && sudo docker compose config --quiet && sudo docker compose pull && sudo docker compose up -d --build && if grep -q '^CADDY_TLS_ISSUER=internal$' .env; then sudo docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt && sudo chown \"\$USER:\$USER\" ./caddy-root.crt && chmod 644 ./caddy-root.crt; fi && sudo docker compose ps"
