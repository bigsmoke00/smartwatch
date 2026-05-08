# LogWatch v2

Plataforma profissional de **observabilidade e operações** para infraestrutura — pensada para times de cloud que administram dezenas/centenas de servidores em multi-cloud (AWS + OCI), clusters PostgreSQL Patroni e enxames de containers Docker.

Tudo persiste em **PostgreSQL/TimescaleDB**. Sem Elasticsearch/OpenSearch — mantém o padrão da sua infra.

## O que tem

### Observabilidade
- **Logs** ingeridos por agent Docker; busca full-text (FTS + trigram), filtros por servidor/container/level/intervalo, tail em tempo real (WebSocket), export CSV, saved queries.
- **Métricas de host** (CPU, mem, disco, rede, load, uptime) coletadas pelo agent via `systeminformation`.
- **Containers** descobertos automaticamente (estado, image, ports, labels, health).
- **Histograma** de volume de logs por minuto, com breakdown por severidade.

### Operações
- **Alertas** baseados em queries de log + threshold em janela; notificações Slack/Discord/webhook (HMAC)/Telegram/PagerDuty.
- **Audit log** de tudo (auth, mudanças, MFA, automações). Hypertable com retenção 365d.
- **Automação Ansible Semaphore** integrada: lista projetos/templates, dispara playbooks, vê output, encerra tasks — direto da UI do LogWatch.
- **Patroni cluster dashboard**: leader, replicas, lag, timeline, histórico de switchovers.
- **Inventário multi-cloud** (AWS + OCI): sincroniza instâncias EC2 / Compute para popular automaticamente os servers.

### Segurança
- Auth JWT (access 15m + refresh 7d com rotação) e bcrypt cost 12.
- **2FA TOTP** (RFC 6238) com QR code.
- **Brute-force protection**: lock temporário após 5 falhas.
- **Sessões** revogáveis (lista por usuário, expiry, revoke).
- **API keys** com prefixo + bcrypt no segredo, IP allowlist e scopes.
- **Vault interno** AES-256-GCM (chave master via env) para guardar credenciais cloud, tokens de Slack, PagerDuty etc.
- RBAC: `admin` / `operator` / `viewer`.
- Helmet + CORS estrito + rate limit (`@nestjs/throttler`).
- Logs **estruturados** (Pino) com redação automática de campos sensíveis.
- Endpoint Prometheus `/api/metrics` (compatível com scraping).

## Arquitetura

```
                  ┌─────────────────────────────┐
                  │         Frontend             │  Next.js 14 + Tailwind + shadcn-style
                  │   /logs, /metrics, /alerts   │
                  │   /automation, /patroni…     │
                  └──────────────┬──────────────┘
                                 │ HTTPS + WS
                  ┌──────────────▼──────────────┐
                  │           Backend           │  NestJS + Pino + Prom
                  │  Auth · Logs · Metrics ·    │
                  │  Alerts · Automation ·      │
                  │  Patroni · Audit · Vault    │
                  └──┬──────────┬──────────┬────┘
                     │          │          │
        ┌────────────▼────────┐ │  ┌───────▼────────┐
        │ PostgreSQL          │ │  │ Ansible        │
        │ + TimescaleDB       │ │  │ Semaphore (API)│
        │  (logs, metrics,    │ │  │  +  inventário │
        │   audit, alerts,    │ │  └────────────────┘
        │   inventory…)       │ │
        └─────────────────────┘ │
                                ▼
              ┌──────────────────────────────┐
              │   Patroni REST (read only)   │  (cluster Postgres operacional)
              └──────────────────────────────┘

       ┌─────────────────────────────────────────────────┐
       │                    Servidores                    │
       │  cada um roda:  logwatch-agent (container)       │
       │   • lê docker.sock (logs + inventário)           │
       │   • coleta CPU/mem/disco/rede                    │
       │   • envia em batch (gzip + retry exp.)           │
       └─────────────────────────────────────────────────┘
```

## Estrutura

```
logwatch/
├── backend/                NestJS API
│   ├── src/
│   │   ├── auth/           JWT + MFA + sessions
│   │   ├── audit/          interceptor + hypertable
│   │   ├── users/
│   │   ├── servers/        + API keys (bcrypt + IP allowlist)
│   │   ├── logs/           ingest + FTS + WS gateway
│   │   ├── metrics/        host metrics ingest + queries
│   │   ├── notifications/  Slack/Discord/Webhook/PD/Telegram
│   │   ├── alerts/         regras + scheduler
│   │   ├── automation/     proxy Ansible Semaphore
│   │   ├── inventory/      containers + cloud sync
│   │   ├── patroni/
│   │   ├── secrets/        AES-256-GCM vault
│   │   ├── saved-queries/
│   │   ├── health/         health + readyz + Prom /metrics
│   │   └── db/             pg pool central
│   ├── migrations/         001_init.sql (schema completo)
│   └── Dockerfile          roda migrations e sobe
├── frontend/               Next.js 14
│   ├── app/                login, /, /logs, /metrics, /alerts,
│   │                       /automation, /patroni, /inventory,
│   │                       /servers, /containers, /audit, /settings
│   └── components/
├── agent/                  Container Docker
│   └── src/                logs.ts, metrics.ts, inventory.ts
├── docker-compose.yml      stack completa + profiles
└── .env.example
```

## Como rodar

```bash
# 1. Configure
cp .env.example .env
# (edite as senhas e segredos. Gere SECRETS_MASTER_KEY com `openssl rand -hex 32`)

# 2. Suba a stack base
docker compose up -d --build

# 3. (opcional) Suba o Semaphore para automação
docker compose --profile semaphore up -d

# 4. (opcional) Suba o agent local para logs do próprio host
docker compose --profile agent up -d

# 5. Acesse
#    Frontend:   http://localhost:3000
#    Backend:    http://localhost:4000/api/docs
#    Semaphore:  http://localhost:3001
#    Prom:       http://localhost:4000/api/metrics
```

Login inicial: `admin@logwatch.local` / `ChangeMe!123` (troque imediatamente).

## Conectar com Patroni (read-only)

Configure no `.env`:

```
PATRONI_NODES=http://pg1:8008,http://pg2:8008,http://pg3:8008
PATRONI_BASIC_AUTH=monitor:senha
```

A página **Cluster Patroni** mostra leader, replicas, lag e timeline a cada 10s.

## Conectar com Ansible Semaphore

```
SEMAPHORE_URL=https://semaphore.suainfra.com
SEMAPHORE_API_TOKEN=ey…  # gerado em Settings → Api Tokens
```

A aba **Automação** lista projetos/templates e permite executar playbooks com auditoria completa de quem disparou o quê.

## Conectar um servidor

No painel: **Servidores → Novo → Gerar API key**. Copie a chave (`sk_xxxx.yyyy`) e rode no host:

```bash
docker run -d \
  --name logwatch-agent \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e LOGWATCH_BASE_URL=https://logwatch.suainfra.com/api \
  -e LOGWATCH_API_KEY=sk_xxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyy \
  -e LOGWATCH_SERVER_NAME=$(hostname) \
  ghcr.io/suaorg/logwatch-agent:latest
```

O agent envia automaticamente:
- Logs de todos os containers
- Métricas de host a cada 15s
- Inventário de containers a cada 60s
- Heartbeat com hostname, OS, arch, versão

## Por dentro do TimescaleDB

- **Hypertables**: `logs` (1d chunks), `host_metrics` (1d), `audit_events` (7d), `alert_events`, `automation_runs`.
- **Compressão automática** após 7 dias (segmentado por `server_id` + `level`).
- **Retention policies**: logs 90d, métricas 180d, audit 365d (configurável).
- **Continuous aggregate** `logs_per_min` pré-calcula contagens.
- FTS via `tsvector` + trigger; busca fuzzy via `pg_trgm`.

## Segurança em profundidade

Veja [`backend/SECURITY.md`](./backend/SECURITY.md) para o modelo completo (rotação de chaves, recomendações de TLS/mTLS, escopo mínimo do Patroni REST etc.).

## Roadmap (próximos passos sugeridos)

- mTLS opcional entre agent e backend
- Worker BullMQ dedicado para alertas (escalar avaliação)
- Adapter Redis para WebSocket em modo cluster
- Dashboard customizável (drag-and-drop de painéis)
- Exec remoto via Semaphore ad-hoc (one-shot)
- SSO OIDC (Keycloak/Authelia/Google Workspace)
- TLS cert expiry monitor + auto-renew via cert-manager hook
