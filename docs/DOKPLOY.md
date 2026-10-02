# Deploy Ticksy like Grailshot

Create a **Docker Compose** service sourced from `haiderlikesrust/ticksy`, branch `main`. Set **Compose Path** to `./compose.dokploy.yaml`. Use Docker Compose, not Docker Stack/Swarm or a Nixpacks Application.

This adapts Grailshot's four-service deployment: `gateway`, `web`, `game`, and `postgres`. Ticksy's Vite build is served by Nginx in `web`; the always-running Fastify coordinator remains in `game`. The gateway sends `/api/` to Fastify and everything else to the frontend. Only the gateway joins the external `dokploy-network`. No host ports are published by the production Compose file.

## Setup

1. Create a Ticksy project and a Docker Compose service in Dokploy. Select the repository, `main`, and Compose path above.
2. Paste [`deploy/dokploy.env.example`](../deploy/dokploy.env.example) into **Environment**. Set `APP_ORIGIN=https://ticksy.pro` with no trailing slash. Replace `POSTGRES_PASSWORD` with a long random alphanumeric password; `openssl rand -hex 32` generates one. Leave `MAINNET_ENABLED=false`. Blank optional keys are valid for the prelaunch site.
3. Point the DNS A record for `ticksy.pro` at the Dokploy server's public IP.
4. Under **Domains**, add host `ticksy.pro`, service **gateway**, container port **80**, path **/**, with HTTPS and Let's Encrypt enabled. Leave Strip Path disabled. Keep ordinary Compose networking; the file already connects the gateway to `dokploy-network`.
5. Click **Deploy**. In Preview Compose, confirm the gateway has both `app` and `dokploy-network`. Wait for all four services to be healthy. PostgreSQL is included; do not create a separate database or set a separate DATABASE_URL.

The Dockerfile uses Node 22 and PostgreSQL 17, following Grailshot. Install/build/start commands are defined by the image; do not add the earlier NIXPACKS variables. `SERVE_STATIC=false` and `TRUST_PROXY_HOPS=2` are set by Compose for this two-proxy layout.

## Verify

- `https://ticksy.pro/api/health` must return `ok: true`, `database: "postgres"`, and `spendingEnabled: false`. Failed database queries return HTTP 503.
- Open `/`, `/leaderboard`, `/profile`, and `/admin` directly, and refresh each page. Check logos, fonts, pack artwork and API responses.
- Open a fresh private window to see the clock welcome animation; reduced-motion users skip it.
- In a wallet-enabled browser, connect and sign a login message. The session cookie should be Secure and HttpOnly. Public prelaunch rewards remain empty.
- GitHub Actions builds all four images and runs a disposable Postgres/gateway smoke test. Check **Verify app and Dokploy stack** before deploying. This is not funded mainnet validation.

## Secrets and launch

Compose maps treasury and provider secrets into **game** only, never into frontend build arguments. `.dockerignore` excludes environment files, local databases and keypair files. Enter real values only in Dokploy's environment editor when preparing validation. Never reuse Grailshot's database or treasury by accident.

The template sets `COLLECTOR_CRYPT_PAYMENT_WALLET=GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3`, recovered from Grailshot's saved provider-signed transaction and checked against its USDC recipient account. This public payment address is not your treasury. Ticksy still validates every new provider transaction against the configured address before signing.

Before unattended operation, configure the coin mint, dedicated treasury recipient/key, RPC, Jupiter access, verified provider payment wallet and any required provider access. Configure the wallet exclusion list and complete a controlled funded end-to-end validation. Keep mainnet disabled until those checks are complete. Private Pokewatch 2000 access still requires verification; deployment does not unlock it.

## Updates and storage

Run **one game container**, without overlapping/blue-green coordinators. Pause new rounds and finish settlement before planned updates. Keep the same Compose service identity and the project-scoped `ticksy-postgres` volume on redeploy. Do not enable deployment isolation that creates a new database volume per release. Configure database backups and test restores before live operation. Do not remove volumes, and do not change the password on an existing volume without updating its Postgres role too.

The backend trusts exactly two proxy hops: Traefik and Nginx. Keep port 4100 private. An extra CDN requires correct trusted-header configuration in Traefik. Docker Compose health checks report failures; unhealthy status alone does not restart a process. Inspect service logs and reconcile pending work before resuming after a failure.

References: [Dokploy Compose](https://docs.dokploy.com/docs/core/docker-compose), [Compose domains](https://docs.dokploy.com/docs/core/docker-compose/domains).
