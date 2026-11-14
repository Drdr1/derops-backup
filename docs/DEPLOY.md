# Production deployment (Hetzner VPS, Caddy, Docker Compose)

Production URL: https://backup.derops.dev — app `derops-backup` (client_id dac3487a…), the one
that holds Shopify's theme-write exemption. Development uses a *separate* Shopify app
(`shopify.app.dev.toml`, created with `shopify app config link`) so `app dev` never rewrites
the production URLs.

## One-time server setup

```bash
# DNS: A record backup.derops.dev → VPS IP (Cloudflare, proxy off or on — both work)

ssh root@VPS
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
git clone git@github.com:Drdr1/derops-backup.git ~/derops-backup   # needs a deploy key with read access
cd ~/derops-backup
cp .env.production.example .env.production
nano .env.production      # fill SHOPIFY_API_SECRET, POSTGRES_PASSWORD, ENCRYPTION_KEY (see comments)

# Caddy: add to /etc/caddy/Caddyfile
#   backup.derops.dev {
#       reverse_proxy 127.0.0.1:3458
#   }
systemctl reload caddy

./scripts/deploy.sh       # build + start web, worker, postgres, redis
curl -s https://backup.derops.dev/healthz   # → ok
```

## Each release

```bash
ssh root@VPS 'cd ~/derops-backup && ./scripts/deploy.sh'
```

Then, from your laptop, push the app config (scopes, webhooks, URLs) to Shopify whenever
`shopify.app.production.toml` changed:

```bash
shopify app deploy -c production
```

## Backups of the backup app

- Postgres volume `pgdata`: `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U derops derops_backup | gzip > ~/derops-backup-$(date +%F).sql.gz` (cron daily, copy off-box).
- `ENCRYPTION_KEY` in `.env.production`: keep a copy in a password manager. Without it, merchants' stored S3 credentials cannot be decrypted (they would just re-enter them, but every scheduled backup would fail until then).
- Merchant data lives in their own buckets, never on this server.

## Install on a store

Partner Dashboard → derops-backup → Test on development store, or the App Store listing once approved.
