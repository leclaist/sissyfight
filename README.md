# sissyfight

Revival of the 1999 multiplayer game SiSSYFiGHT 2000, rewritten with node.js, SockJS, and CreateJS HTML5 library.

All original code and art are released under the MIT License or the Creative Commons CC-BY License. This repository also incorporates works that have their own licenses. For details, see [licenses.md](licenses.md).

This is an archived repository - we can't accept issues or pull requests here. You are welcome to fork this repo or copy it anywhere else. 

To find collaborators and exchange info about the source code, we recommend the SiSSYFiGHT Facebook group.
We unfortunately can't offer any additional support for use of the code.

## running a sissyfight server

The server runs on Node.js 24 with MySQL 8 for users, scores, and sessions, and an SMTP email service (SendGrid) for password reset emails. Game state lives in the server process, so run exactly one instance.

### local development

With Docker installed:

```
docker compose up                        # http://localhost:3000 (APP_PORT=3100 docker compose up to use another port)
docker compose run --rm app npm test     # game engine + server tests against MySQL
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

After that, `infra/deploy.sh` builds the current commit and rolls the app onto it.

### continuous deployment

[CI](.github/workflows/ci.yml) runs the tests (against a MySQL service) and builds the Docker image on every push and pull request. When CI passes on `master`, [Deploy](.github/workflows/deploy.yml) builds the image in ACR, rolls the container app onto it, waits for the new revision to be healthy, and smoke-tests the site. It logs in to Azure with OpenID Connect, using these repository variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`. The deploy job is skipped until they are set. Terraform state and `terraform.tfvars` hold secrets and are gitignored.
