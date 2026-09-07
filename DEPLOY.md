# Hosting the stack (prod)

## Why one VPS, not Vercel

Vercel hosts the web UI fine — but our web server keeps state on disk (team
orgs/members in `.data/members.json`, and it proxies the gateway with a shared
token). Vercel's filesystem is ephemeral: every deploy wipes teams and queues.
Fixing that means Postgres. For the hackathon: everything on one VPS with a
persistent disk, Caddy for HTTPS. Revisit after judging.

## What you need

1. **VPS** — 2 vCPU / 4 GB minimum (CPU inference for the 0.5b model + gateway
   + web). Any provider, Ubuntu 24.04. ~$6/mo tier is enough.
2. **Domain** — an A record pointing at the VPS (e.g. `app.yourdomain.com`).
   Needed for HTTPS (Caddy provisions it) and Privy allowed origins.
3. **SSH access** for the ~10 commands below.

## Deploy (on the VPS)

```sh
git clone https://github.com/Lucas749/TrulyOpenRouter && cd TrulyOpenRouter
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin
cp .env.prod.example .env.prod && nano .env.prod   # fill every PASTE_…

# Caddyfile: replace app.example.com with your domain
sed -i 's/app.example.com/YOUR_DOMAIN/' Caddyfile

docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker exec $(docker ps -q --filter ancestor=ollama/ollama) ollama pull qwen2.5:0.5b
curl -sf http://localhost:4121/health && curl -sf http://localhost:3002/ -o /dev/null && echo UP
```

Then in the **Privy dashboard** (your app → Settings → Allowed origins) add
`https://YOUR_DOMAIN`. Fund the host + agent accounts from the testnet faucets.

## Notes

- Public surface is only 80/443 → web. Gateway/guard/ollama stay internal;
  reach the gateway yourself over `ssh -L 4121:localhost:4121 user@host`.
- Secrets on the VPS are env vars (documented fallback). The Ledger ring path
  is demoed from the laptop — same code, `SECRETS_BACKEND=ring`.
- Data persists in docker volumes (`web-data`, `gateway-data`, `ollama-data`).
  Back up `/var/lib/docker/volumes` if teams matter to you.
- Re-deploy: `git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`.
