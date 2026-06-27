# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json nest-cli.json ./
RUN npm install
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- pg_repack (cliente CLI) ----
# Alpine não tem pacote `pg_repack` pronto (só existe em repos Debian/PGDG),
# então compilamos o binário cliente direto do código-fonte contra a libpq do
# Postgres 16 do Alpine. É só o cliente que entra na imagem do backend — a
# extensão (.so/.control/.sql) já vem instalada no servidor via
# Dockerfile.postgres. Versão fixada (1.5.0) suporta PG 10-16.
FROM node:20-alpine AS pgrepack-builder
# postgresql16-dev só traz headers/pgxs — o pg_config em si vem do pacote
# `postgresql16` (sem -dev), instalado em /usr/libexec/postgresql16/pg_config
# (versionado de propósito, pra não colidir com outras versões de Postgres
# que existam no sistema/base image — por isso NÃO usar /usr/bin/pg_config
# aqui, que pode resolver pra uma versão diferente da 16).
RUN apk add --no-cache build-base postgresql16 postgresql16-dev curl tar gawk \
 && curl -fsSL https://github.com/reorg/pg_repack/archive/refs/tags/ver_1.5.0.tar.gz -o /tmp/pg_repack.tar.gz \
 && mkdir -p /tmp/pg_repack \
 && tar -xzf /tmp/pg_repack.tar.gz -C /tmp/pg_repack --strip-components=1 \
 && make -C /tmp/pg_repack USE_PGXS=1 PG_CONFIG=/usr/libexec/postgresql16/pg_config with_llvm=no \
 && cp /tmp/pg_repack/bin/pg_repack /usr/local/bin/pg_repack

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# git + terraform (para o Terraform Control Plane)
# libpq (runtime do pg_repack — compilado contra ela na stage acima)
RUN apk add --no-cache git curl ca-certificates libpq \
 && curl -fsSL https://releases.hashicorp.com/terraform/1.9.5/terraform_1.9.5_linux_amd64.zip -o /tmp/tf.zip \
 && unzip /tmp/tf.zip -d /usr/local/bin/ \
 && rm /tmp/tf.zip \
 && terraform -version

COPY --from=pgrepack-builder /usr/local/bin/pg_repack /usr/local/bin/pg_repack
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
