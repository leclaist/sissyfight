# sissyfight

Revival of the 1999 multiplayer game SiSSYFiGHT 2000, rewritten with node.js, SockJS, and CreateJS HTML5 library.

**Play it at [sissyfight2026.lol](https://sissyfight2026.lol).**

This is a fork of the archived [moonmilk/sissyfight](https://github.com/moonmilk/sissyfight) by Ranjit Bhatnagar, Naomi Clark, and Eric Zimmerman, with the server modernized (Node.js 24, Express 5, MySQL 8) and deployed to Azure. The game itself is unchanged.

All original code and art are released under the MIT License or the Creative Commons CC-BY License. This repository also incorporates works that have their own licenses. For details, see [licenses.md](licenses.md).

To find collaborators and exchange info about the source code, the original authors recommend the SiSSYFiGHT Facebook group.

## bots

When there aren't enough people around, players can fight computer-controlled girls:

- Every school has a **Robo Recess** room. When someone walks in, bots fill it to 5 players (leaving a spot for a friend), so a game can start right away.
- In any other room, if people wait about 20 seconds without enough players for a game (3), bots fill it to 5.
- Bots leave when the humans do. Booting a bot works like booting anyone, and she isn't replaced.
- Bots' names start with "Robo" (reserved, so nobody can pretend to be one). They have no accounts and never appear in the rankings; humans still score normally in games with bots.

With `ANTHROPIC_API_KEY` set, each bot asks Claude (Haiku 5.5 by default, `BOT_MODEL` to change) for her move every turn, with the game state, last turn's results, and recent chat. Every bot in a room has a different personality, and each game every bot gets a secret rival spread across all players, bots included, so they don't all gang up on the one human (they aren't told who's a bot). Every message a person types gets a reply, from the bot she named or whoever spoke least recently, and at most one bot trash-talks per turn. While people are around, bots also chat on their own every 15-40 seconds when things are quiet (gossip, drama, team-up offers) and sometimes answer each other, up to two lines before they wait for a person to say something. Without a key, or if the API is slow or failing, or past `BOT_DAILY_CALL_LIMIT` calls in a day (default 3000), bots pick random legal moves and stay quiet. Set `BOTS=off` to disable them. The code is in [bots/](bots).

## running a sissyfight server

The server runs on Node.js 24 with MySQL 8 for users, scores, and sessions, and an SMTP email service (SendGrid) for password reset emails. Game state lives in the server process, so run exactly one instance.

### local development

With Docker installed:

```
docker compose up                        # http://localhost:3000 (APP_PORT=3100 docker compose up to use another port)
docker compose run --rm app npm test     # game engine + server tests against MySQL
```

A game needs at least 3 players. To play alone, start some bots that join whatever game room you're in and make random moves:

```
docker compose exec app node scripts/dev-bots.js 3 angel   # 3 bots in the Sweet Sunny Angel Valley school
```

### docker image

The [Dockerfile](Dockerfile) builds the production image. On startup the container runs `npm run db:setup` and then the server. Azure Container Apps runs `linux/amd64`, so from an Apple Silicon Mac:

```
docker buildx build --platform linux/amd64 -t sissyfight .
# or build in Azure Container Registry directly:
az acr build --registry <your-acr> --image sissyfight:<tag> .
```

To try the production image locally against the compose database: `docker compose --profile image up --build image` (http://localhost:3001).

Run exactly one replica (game rooms live in memory), route WebSockets through the ingress, and use `/healthz` for health probes.

`npm run db:setup` creates the tables and default texts from [database_tables.sql](database_tables.sql). It is safe to run on every deploy.

### configuration

| Variable | |
|---|---|
| `DATABASE_URL` | `mysql://user:password@host:3306/database` (the older `SISSYFIGHT_DB=mysql\|host\|database\|user\|password` form also works) |
| `DB_SSL` | `true` to require TLS to MySQL (Azure Database for MySQL needs this) |
| `SESSION_SECRET` | secret for signing session cookies; required when `NODE_ENV=production` |
| `SENDGRID_API_KEY` | SendGrid API key for password reset emails (or `SISSYFIGHT_MAILER=service\|user\|password` for another [Nodemailer](https://nodemailer.com/) service) |
| `MAIL_TRANSPORT` | `json` to log emails instead of sending them |
| `PUBLIC_URL` | base URL used in emailed links, e.g. `https://play.sissyfight.com` |
| `BASIC_AUTH` | optional closed-testing logins: `user,password[\|user,password]` |
| `PORT` | HTTP port (default 3000) |
| `ANTHROPIC_API_KEY` | lets bots use Claude for moves and chat (optional) |
| `BOTS`, `BOT_MODEL`, `BOT_DAILY_CALL_LIMIT` | turn bots `off`, pick their model, cap model calls per day |

The password reset email's sender, subject, and text are rows in the `Texts` table (`pwreset-email-*`); set `pwreset-email-from` to a sender address verified in SendGrid. The `homepage-news` row is shown on the main page.

## deploying to Azure

[infra/](infra) holds Terraform for Azure Container Apps and Azure Database for MySQL, pulling the image from an existing container registry.

```
cp infra/terraform.tfvars.example infra/terraform.tfvars   # set subscription_id
infra/deploy.sh                                             # build the image in ACR
cd infra && terraform init && terraform apply              # create everything (first time)
terraform output dns_records                               # A + TXT records to add at your DNS provider
../infra/bind-domain.sh                                     # once DNS resolves: custom domain + managed certificate
```

After that, `infra/deploy.sh` builds the current commit and rolls the app onto it. Terraform state and `terraform.tfvars` hold secrets and are gitignored.

The live site runs as:

| | |
|---|---|
| URL | https://sissyfight2026.lol (DNS at Porkbun: an A record to the Container Apps environment, plus the `asuid` TXT verification record) |
| App | Container App `sissyfight` in resource group `sissyfight-rg` (East US), one replica |
| Database | Azure Database for MySQL Flexible Server 8.4 (Burstable B1ms), 7-day point-in-time backups |
| Image | `continuationacr.azurecr.io/sissyfight:<commit>` |
| Logs | Log Analytics workspace `sissyfight-logs`, or `az containerapp logs show -n sissyfight -g sissyfight-rg --follow` |

Password reset emails are off until a SendGrid key is set (`sendgrid_api_key` in `terraform.tfvars`). Bots use Claude once `anthropic_api_key` is set there; apply with `terraform apply`.

### continuous deployment

[CI](.github/workflows/ci.yml) runs the tests (against a MySQL service) and builds the Docker image on every push and pull request. When CI passes on `master`, [Deploy](.github/workflows/deploy.yml) builds the image in ACR, rolls the container app onto it, waits for the new revision to be healthy, and smoke-tests the site. It logs in to Azure with OpenID Connect, using these repository variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. The deploy job is skipped until they are set; `infra/setup-github-oidc.sh` creates the Azure identity (trusted only for `master` of this repo) and sets them, once.

To ship a change: open a pull request, let CI pass, and merge it.
