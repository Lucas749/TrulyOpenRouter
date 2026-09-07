# Hosting the stack (prod)

## Why one VPS, not Vercel

Vercel hosts the web UI fine — but our web server keeps state on disk (team
orgs/members in `.data/members.json`, and it proxies the gateway with a shared
token). Vercel's filesystem is ephemeral: every deploy wipes teams and queues.
Fixing that means Postgres. For the hackathon: everything on one VPS with a
persistent disk, Caddy for HTTPS. Revisit after judging.

## What you need

1. **VPS or AWS** — 2 vCPU / 4 GB minimum (CPU inference for the 0.5b model +
   gateway + web). Any provider, Ubuntu 24.04. ~$6/mo tier is enough.
   AWS path: `infra/` (Terraform) provisions EC2 + RDS Postgres; you apply it
   (see "AWS" below) — I can't reach your account from here.
2. **Domain** — an A record pointing at the box (e.g. `app.yourdomain.com`).
   Needed for HTTPS (Caddy provisions it) and Privy allowed origins.
3. **SSH access** for the ~10 commands below.

## Data (Postgres)

Gateway + web use Postgres when `DATABASE_URL` is set, local files/memory
otherwise. Compose ships a `db` container; on AWS point `POSTGRES_HOST` at RDS.
Schema auto-applies at boot (`gateway/schema.sql`, `web/schema.sql`).
Local proof: `docker run -d --name tor-pg -e POSTGRES_PASSWORD=tor
-e POSTGRES_DB=tor -p 5433:5432 postgres:16-alpine`, then
`DATABASE_URL=postgresql://postgres:tor@127.0.0.1:5433/tor npx vitest run
--fileParallelism=false` (web; PG tests share one DB, so files run serially).

## AWS (Terraform)

```sh
cd infra
terraform init
terraform apply -var key_name=YOUR_EC2_KEY -var allowed_ssh_cidr=YOUR_IP/32 \
  -var db_password=$(openssl rand -hex 24)
# note the outputs: ec2_public_ip, rds_endpoint, next_env
```

Then SSH in, `scp .env.prod` over (with `POSTGRES_HOST` = rds endpoint),
follow "Deploy" below. ~$25/mo (t3.medium + db.t3.micro). Destroy after
judging if you don't need it: `terraform destroy`.

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

## Learned the hard way (2026-09-07 sandbox deploy)

- **Private repo**: the box can't `git clone` (auth). Ship a tarball instead:
  `git archive -o /tmp/tor-app.tgz HEAD` → `scp` → `tar -xzf`.
- **Docker on Ubuntu 24.04 EC2**: `docker-compose-plugin` isn't in the default
  repos — install via `curl -fsSL https://get.docker.com | sudo sh`.
- **RDS Postgres**: rejects plaintext connections (`no pg_hba.conf entry … no
  encryption`) and node distrusts its chain — compose URLs carry
  `?sslmode=no-verify` (encrypted, unverified; fine for testnet demo).
- **Compose bakes env at create time**: after editing `.env.prod`, recreate
  (`up -d --force-recreate`), don't just `restart`.
- **No domain yet**: Caddyfile `:80` serves plain HTTP on the box IP; swap back
  to the domain block before pointing DNS (HTTPS + Privy need it).
- **Gateway/guard ports** bind `127.0.0.1` only — public surface is web:80.
  Operator: `ssh -L 4121:localhost:4121 user@host`.
- **Box smoke test**: `sh ~/box-smoke.sh` (key → chat → receipt assert).
  If chat 502s, the gateway has no local host: check `HOSTS_JSON` in `.env.prod`.

## Notes

- Public surface is only 80/443 → web. Gateway/guard/ollama stay internal;
  reach the gateway yourself over `ssh -L 4121:localhost:4121 user@host`.
- Secrets on the VPS are env vars (documented fallback). The Ledger ring path
  is demoed from the laptop — same code, `SECRETS_BACKEND=ring`.
- Data persists in docker volumes (`web-data`, `gateway-data`, `ollama-data`).
  Back up `/var/lib/docker/volumes` if teams matter to you.
- Re-deploy: `git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`.
