# syntax=docker/dockerfile:1

# Production image. Azure Container Apps runs linux/amd64, so from an Apple
# Silicon Mac build with:  docker buildx build --platform linux/amd64 -t sissyfight .
# (or build in Azure with: az acr build --registry <acr> --image sissyfight:<tag> .)

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# create tables (idempotent), then run the server as PID 1 so it receives SIGTERM
CMD ["sh", "-c", "node scripts/db-setup.js && exec node app.js"]
