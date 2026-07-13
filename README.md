# Discus

Discus is a private, browser-based stereo audio relay for remote DJs. It publishes mixer or audio-interface input as Opus over WebRTC and provides separate, expiring links for DJs and listeners.

## Features

- Private owner, DJ, and listener access
- WHIP/WHEP streaming through MediaMTX
- Stereo input metering and audio-device selection
- Live and historical listener counts
- Dark-first responsive interface with optional light mode
- Listener jitter buffering for steadier playback
- Docker deployment with Caddy-managed HTTPS

## Development

Requirements: Node.js 24+, npm, and a Chromium-based browser.

```sh
npm install
ADMIN_PASSWORD=relay-test-password \
TOKEN_SECRET=dev-only-token-secret-at-least-32-bytes \
MEDIAMTX_AUTH_SECRET=dev-media-auth-secret \
npm run dev
```

Open `http://localhost:3000/admin`. Remote audio capture requires HTTPS.

Run the checks with:

```sh
npm run check
npm run test:e2e
```

## Deployment

Copy the environment template, replace every example secret, and set the public hostname:

```sh
cp .env.example .env
docker compose config --quiet
docker compose up -d --build
```

Expose TCP 443 and UDP/TCP 8189 to the host. Keep the application and MediaMTX administration ports private.

For repeat Orange Pi deployments:

```sh
./scripts/deploy-pi.sh user@orange-pi-host
```

The default deployment path is `/mnt/ssd/dj-relay`. Runtime data, secrets, backups, and generated test artifacts are excluded from Git.
