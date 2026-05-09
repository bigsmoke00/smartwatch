# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json nest-cli.json ./
RUN npm install
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# git + terraform (para o Terraform Control Plane)
RUN apk add --no-cache git curl ca-certificates \
 && curl -fsSL https://releases.hashicorp.com/terraform/1.9.5/terraform_1.9.5_linux_amd64.zip -o /tmp/tf.zip \
 && unzip /tmp/tf.zip -d /usr/local/bin/ \
 && rm /tmp/tf.zip \
 && terraform -version

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY migrations ./migrations
EXPOSE 4000

# Por padrão: roda migrations e depois sobe o servidor.
# Para pular, defina SKIP_MIGRATIONS=true.
CMD sh -c '\
  if [ "$SKIP_MIGRATIONS" != "true" ]; then \
    echo "[entrypoint] running migrations..."; \
    node dist/scripts/migrate.js || exit 1; \
  fi; \
  exec node dist/main.js'
