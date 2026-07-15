# LogWatch

Plataforma de **observabilidade, operações e acesso controlado** para
infraestrutura — agent num host/container, backend NestJS, frontend Next.js.
Tudo persiste em **PostgreSQL/TimescaleDB**; sem Elasticsearch/OpenSearch.

Versão atual: ver `backend/package.json` / `frontend/package.json` /
`agent/package.json` (sincronizados) ou o rodapé do menu / `GET /health`.
Histórico de features por versão: [`CHANGELOG.md`](./CHANGELOG.md).

## O que tem hoje

### Observabilidade
- **Logs**: ingestão via agent, busca full-text (FTS + trigram + fallback
  `ILIKE`), filtro por servidor/container/host/level/janela de tempo, tail ao
  vivo via WebSocket, export CSV/JSON/log/gz, saved queries (próprias ou
  compartilhadas). Sem limite artificial de linhas no backend.
- **Métricas de host** (CPU/mem/disco/rede/load/uptime) e inventário de
  containers, coletados pelo agent.
- Endpoint Prometheus `GET /api/metrics`.

### Operações
- **Alertas** por query + threshold em janela, com Slack / Discord / webhook
  HMAC / Telegram / PagerDuty.
- **Audit log** de toda ação sensível.
- **Docker manager** completo via agent (containers, imagens, volumes).
- **Script Manager**: edição/versionamento/execução de scripts no host, com
  aprovação obrigatória apenas quando o servidor é de produção.
- **Log exports agendados** (email ou S3).
- **Patroni**: dashboard multi-cluster (leader/replica/lag/timeline),
  clusters cadastrados via UI.
- **PostgreSQL Monitor**: queries ativas, locks, top queries, sugestão de
  índices, `EXPLAIN` ad-hoc, terminate de PID — multi-database por cluster.
- **FinOps**: dashboard de custo e budgets. *Coleta real de custo AWS/OCI
  ainda não está implementada (stub) — ver "Limitações conhecidas".*
- **Rotação de credenciais**: CRUD + scheduler já registrado; a rotação de
  fato (AWS IAM etc.) ainda não está implementada — ver "Limitações
  conhecidas".

### Acesso (Zero Trust)
- **Terminal Web**: sessão de shell em host ou container via xterm.js, sob
  fluxo de pedido → aprovação humana. Usuário do SO resolvido por mapeamento
  (nunca informado livremente pelo cliente); `sudo` só é concedido na
  aprovação. Todo I/O é gravado e os comandos digitados são capturados, com
  transcript disponível depois.
- **Console de banco**: `SELECT`/`WITH` roda direto (cap de linhas +
  timeout); escrita exige pedido + aprovação por outra pessoa, em transação.
- **Captura de rede/SIP** (estilo sngrep/Wireshark): pedido → aprovação →
  `tcpdump` no agent → streaming ao vivo via WebSocket. Nada é gravado em
  disco; se ninguém estiver assistindo, o conteúdo se perde por design.
  Parser SIP no frontend com call-flow, filtro de método e BPF customizável.

### Segurança
- Auth JWT (access curto + refresh com rotação), bcrypt, brute-force lock.
- **2FA TOTP**, podendo ser obrigatório por usuário.
- Fluxo "defina sua senha" por link único via email.
- Sessões revogáveis; **API keys** com prefixo + bcrypt + IP allowlist.
- **Vault interno** AES-256-GCM para credenciais cloud/SMTP/clusters PG.
- **RBAC granular** baseado em tabelas (`permissions`/`roles`/
  `role_permissions`/`user_roles`) — não é mais um enum fixo de 3 papéis.
- Helmet + CORS estrito + rate limit (`@nestjs/throttler`: 30 req/s, 600/min).
- Logs estruturados (Pino) com redação automática de campos sensíveis.

## Limitações conhecidas (documentado de propósito, não escondido)

- `finops/`: os clientes de custo AWS e OCI são **stubs** — retornam `[]`,
  não chamam Cost Explorer/Usage API de verdade.
- `credential-rotation/`: o scheduler roda, mas a rotação em si está
  comentada como TODO; runs atuais só registram um evento simulado.
- `opensearch/`: módulo morto, não importado em `app.module.ts` — resquício
  de uma arquitetura anterior. O storage real de logs é TimescaleDB.
- Existem tabelas de migration para "Terraform Control Plane", SLO/SLI e
  GitHub Actions (e o Dockerfile do backend instala o binário do Terraform),
  mas **nenhum módulo NestJS usa esse schema hoje** — é reserva para trabalho
  futuro, não uma feature ativa.
- As versões antigas deste README mencionavam integração com **Ansible
  Semaphore** e **sincronização automática de inventário multi-cloud
  (AWS/OCI EC2 e Compute)**. Nenhuma das duas existe no código atual — não há
  módulo `automation/` nem `inventory/`, nem chamadas a APIs de EC2/OCI
  Compute. Se isso for necessário, é trabalho a ser feito do zero, não uma
  feature existente para "reconectar".
- `SECRETS_MASTER_KEY` ausente em produção cai num fallback de chave fixa
  derivada de string — funciona, mas é fraco; configure a env de verdade.

## Arquitetura

```
                  ┌─────────────────────────────┐
                  │           Frontend           │  Next.js 14
                  │  /logs /metrics /alerts      │
                  │  /terminal /db-access         │
                  │  /captures /scripts /docker   │
                  │  /finops /credential-rotations│
                  │  /patroni /databases …        │
                  └──────────────┬───────────────┘
                                 │ HTTPS + WS
                  ┌──────────────▼───────────────┐
                  │            Backend            │  NestJS
                  │  ~23 módulos (auth, logs,     │
                  │  zero-trust, capture,         │
                  │  db-access, docker-manager,   │
                  │  scripts, finops, pg-monitor, │
                  │  patroni, secrets, roles…)    │
                  └──┬───────────────────────┬────┘
                     │                       │
        ┌────────────▼────────┐    ┌─────────▼─────────┐
        │ PostgreSQL          │    │ Patroni REST       │
        │ + TimescaleDB       │    │ (clusters PG       │
        │ (logs/metrics/audit │    │  monitorados)      │
        │  /terminal/capture…)│    └────────────────────┘
        └─────────────────────┘

       ┌─────────────────────────────────────────────────┐
       │                    Servidores                    │
       │  cada um roda o logwatch-agent (container):      │
       │   • docker.sock (logs + inventário + manager)    │
       │   • CPU/mem/disco/rede                            │
       │   • shell/terminal (Zero Trust), fs-ops (scripts) │
       │   • tcpdump (captura de rede/SIP sob aprovação)   │
       │   • tudo via WebSocket de controle (/ws/control)  │
       └─────────────────────────────────────────────────┘
```

## Estrutura

```
logwatch/
├── backend/                NestJS API
│   ├── src/
│   │   ├── auth/           JWT + MFA + sessions
│   │   ├── audit/          interceptor + hypertable
│   │   ├── users/ roles/   usuários + RBAC granular
│   │   ├── servers/        + API keys (bcrypt + IP allowlist)
│   │   ├── logs/           ingest + FTS + WS gateway
│   │   ├── metrics/        host metrics ingest + queries
│   │   ├── notifications/ alerts/   regras, scheduler, canais
│   │   ├── docker-manager/ scripts/  controle do agent via /ws/control
│   │   ├── zero-trust/     terminal web com aprovação
│   │   ├── db-access/      console de banco com aprovação
│   │   ├── capture/        captura de rede/SIP com aprovação
│   │   ├── pg-monitor/     dashboard + diagnósticos PostgreSQL
│   │   ├── patroni/        dashboard multi-cluster
│   │   ├── finops/         custo cloud (coleta real é stub)
│   │   ├── credential-rotation/  CRUD + scheduler (rotação real é TODO)
│   │   ├── log-export/     export síncrono + agendado
│   │   ├── secrets/        vault AES-256-GCM
│   │   ├── saved-queries/ mail/
│   │   ├── opensearch/     morto, não registrado em app.module.ts
│   │   ├── health/         health + readyz + Prom /metrics
│   │   └── db/              pg pool central
│   ├── migrations/         001 a 015 (ver CHANGELOG.md)
│   └── Dockerfile          roda migrations e sobe
├── frontend/               Next.js 14
│   ├── app/                login, /, /logs, /metrics, /alerts, /servers,
│   │                       /docker, /scripts, /databases, /patroni,
│   │                       /exports, /audit, /terminal, /db-access,
│   │                       /captures, /finops, /credential-rotations,
│   │                       /settings, /users
│   └── components/
├── agent/                  roda em cada host monitorado
│   └── src/                logs/metrics/inventory + host-shell (terminal) +
│                            fs-ops (scripts) + capture (tcpdump/SIP) +
│                            docker manager via control.ts
├── docker-compose.yml
└── .env.example
```

## Como rodar

```bash
# 1. Configure
cp .env.example .env
# edite as senhas e segredos; gere SECRETS_MASTER_KEY com `openssl rand -hex 32`

# 2. Suba a stack
docker compose up -d --build

# 3. Acesse
#    Frontend:   http://localhost:3000
#    Backend:    http://localhost:4000/api
#    Health:     http://localhost:4000/api/health   (inclui "version")
#    Prometheus: http://localhost:4000/api/metrics
```

Login inicial: ver `.env.example` / seed da primeira migration (troque a
senha imediatamente).

## Conectar com Patroni (read-only)

```
PATRONI_NODES=http://pg1:8008,http://pg2:8008,http://pg3:8008
PATRONI_BASIC_AUTH=monitor:senha
```

Ou cadastre o cluster direto pela UI (**Cluster Patroni**), sem precisar de
env var — suporta múltiplos clusters desde a migration 007.

## Conectar um servidor (agent)

No painel: **Servidores → Novo → Gerar API key**. Copie a chave
(`sk_xxxx.yyyy`) e rode no host:

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

O agent expõe, sob controle do backend (`/ws/control`): coleta de logs,
métricas e inventário de containers; gerenciamento Docker; terminal web
(Zero Trust); leitura/escrita/execução de scripts no host; captura de
rede/SIP via `tcpdump`. Veja [`agent/README.md`](./agent/README.md) para
detalhes de cada um.

## Por dentro do TimescaleDB

- **Hypertables**: `logs`, `host_metrics`, `audit_events`, entre outras.
- **Retention policy de logs: 14 dias** (`006_log_storage_optimization.sql`),
  não 90 — ajuste a policy diretamente no banco se precisar de mais.
- Compressão automática dos logs após algumas horas.
- Linhas idênticas no mesmo segundo são consolidadas em `repeat_count`.
- **Busca de chamada FreeSWITCH/Unity por call UUID**: linhas cujo primeiro
  token é um UUID (ex.: trace de dialplan do FreeSWITCH) são reconhecidas na
  ingestão e gravadas com o campo estruturado `call_uuid` (índice parcial
  `idx_logs_call_uuid_ts`), sem exigir tabela nova. Fontes de altíssimo
  volume (como esse FreeSWITCH) podem ter um teto de linhas
  armazenadas/minuto maior via `servers.log_rate_limit_per_minute`. Veja a
  tela **Unity (FreeSWITCH)** e [`docs/UNITY_FREESWITCH.md`](./docs/UNITY_FREESWITCH.md).

## Rate limiting

`@nestjs/throttler` configurado em `app.module.ts`: **30 req/s** (`short`) e
**600 req/min** (`long`) por IP, globalmente — não é específico de logs.

## Segurança em profundidade

Veja [`backend/SECURITY.md`](./backend/SECURITY.md) para o modelo completo,
e a seção "Limitações conhecidas" acima para o que ainda não está pronto.

## Mais documentação

- [`CHANGELOG.md`](./CHANGELOG.md) — histórico de features por versão.
- [`agent/README.md`](./agent/README.md) — o que o agent faz e como roda.
- [`docs/LOGS.md`](./docs/LOGS.md) — detalhes da tela de Logs.
- [`docs/SCRIPT_MANAGER.md`](./docs/SCRIPT_MANAGER.md) — Script Manager.
- [`docs/UNITY_FREESWITCH.md`](./docs/UNITY_FREESWITCH.md) — integração
  FreeSWITCH/Unity e busca de chamada por call UUID.
