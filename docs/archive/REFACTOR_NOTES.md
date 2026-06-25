> **Arquivado.** Estas notas descrevem correções de uma fase antiga
> (migration 005) sobre uma arquitetura que **não é mais a atual** — citam
> `cloud_accounts`/`cloud_resources`/`cloud_sync_runs` (sync AWS multi-account),
> `topology_nodes`/`host.connections` (mapa de topologia) e `runbooks`/
> `bastion_sessions`, nenhum dos quais existe em `backend/src/` hoje. A
> plataforma seguiu por outro caminho (ver [`../CHANGELOG.md`](../CHANGELOG.md)
> e [`../README.md`](../README.md)). Mantido só como histórico.

# Refactor — bugs reportados resolvidos

Esta rodada **não refatorou** o código existente; apenas resolveu os problemas
apontados e implementou os TODOs pendentes. Todas as mudanças são aditivas,
sem breaking changes na API existente.

## Migration 005

Roda automaticamente pelo entrypoint do backend. Idempotente.

- `servers.deleted_at` (soft-delete)
- FK `host_metrics.server_id → servers ON DELETE CASCADE`
- `pg_cluster_features` (cache de detecção)
- `cloud_sync_runs` (hypertable, auditoria de sync cloud)
- `cloud_accounts` (multi-account com vault_secret)
- `cloud_resources` (resultado da sincronização)

## Bug 1 — Hosts não podiam ser apagados

**Causa:** controller chamava `DELETE FROM servers` direto, mas FKs CASCADE
não cobriam `host_metrics` (sem FK) e logs/script_executions (hypertables sem FK).
Resultado: Postgres bloqueava por FK ou deixava órfãos silenciosos.

**Fix:**
- Migration 005 adiciona FK CASCADE em `host_metrics`
- `ServersService.remove()` agora roda em transação, limpa hypertables sem FK
  (logs, script_executions, runbook_executions, terminal_session_events) e
  remove nó topology referenciando o server
- Suporte a soft-delete: `DELETE /servers/:id?soft=true`
- Endpoint novo `POST /servers/:id/restore`
- `list()` filtra `deleted_at IS NULL` por default; `?includeDeleted=true` mostra todos
- UI: botão lixeira em cada linha com confirm explicando hard vs soft delete

## Bug 2 — Monitoramento PostgreSQL não funcionava bem

**Causa:** se `pg_stat_statements` não estava habilitado, a aba "Top Queries"
ficava vazia silenciosamente, e a coleta podia gerar erros no log do backend.

**Fix:**
- Tabela `pg_cluster_features` cacheia detecção de extensões + versão + recovery
- `validateAndDetect(creds)` valida cred via STS-equivalente (`SHOW server_version`)
  e detecta `pg_stat_statements`, `pg_buffercache`, `pg_repack`
- Endpoints novos:
  - `POST /pg/validate` (sem salvar — testa cred)
  - `POST /pg/clusters/:id/detect` (re-roda detecção)
  - `GET /pg/clusters/:id/features`
- `createCluster` dispara detect em background (não bloqueia se cluster offline)
- Coleta de top queries captura erro e registra `has_pg_stat_statements=false`
- UI mostra **banner amigável** com instruções de como habilitar a extensão
- TODO sugerido: `npm i` dos SDKs para ativar real validação cloud

## Bug 3 — AWS inventory não sincronizava

**Causa:** `cloud-sync.service.ts` original era stub com `this.logger.warn(...)`
e retornava sem nada. Não havia tabela pra guardar resultados nem credenciais
multi-account.

**Fix completo:**
- Schema `cloud_accounts` (vault_secret nomeado) + `cloud_resources` + `cloud_sync_runs`
- `AwsSyncService` real com `@aws-sdk/client-{sts,ec2,rds,iam,s3,elbv2}` via
  **dynamic import** (não quebra build sem o SDK; mensagem clara em sync_runs)
- `validate()`: STS GetCallerIdentity — testa cred, retorna account+arn
- `listRegions()`: descobre regiões habilitadas
- `sync()` paginado por região × tipo de recurso, registra cada combinação em
  `cloud_sync_runs` (status running → ok|error|partial)
- Marca recursos não-vistos como `removed_at = now()` (sync incremental funcional)
- Multi-account: cada `cloud_accounts` tem seu próprio `vault_secret`
- Endpoints REST:
  - `POST /cloud/aws/validate` (sem salvar)
  - `POST /cloud/accounts` (cria conta)
  - `POST /cloud/accounts/:id/sync` (dispara sync)
  - `GET /cloud/resources?accountId=&type=&region=` (lista o que foi sincronizado)
  - `GET /cloud/sync-runs?account=` (auditoria)

**Para ativar de verdade:**
```bash
cd backend && npm i @aws-sdk/client-sts @aws-sdk/client-ec2 @aws-sdk/client-rds \
  @aws-sdk/client-iam @aws-sdk/client-s3 @aws-sdk/client-elastic-load-balancing-v2
```
Os SDKs já estão no `package.json`. Sem o `npm i`, sync registra erro amigável
em `cloud_sync_runs` mas backend não cai.

## Bug 4 — Terminal só acessava containers, não host

**Causa:** `term.start` no agent rejeitava chamadas sem `containerId`.

**Fix:**
- Novo `agent/src/host-shell.ts` usa `node-pty` para alocar PTY real no host
- `term.start { target: 'host' | 'container' }` no agent dispatcher
  - `target=host`: usa `node-pty` direto no shell do agent
  - `target=container`: comportamento antigo (docker exec)
- Modo `readonly`: regex bloqueia comandos destrutivos (rm/mv/dd/kill/systemctl stop/...)
- Modo `sudo` opcional
- `term.resize { cols, rows }` propagado pelo gateway WS
- TerminalGateway: `auth.target` no handshake, default = host se sem containerId
- UI `/terminal`: select "Host Linux / Container Docker" + checkboxes readonly/sudo
- TerminalView: emite `resize` ao redimensionar janela
- Dockerfile do agent: `apk add bash sudo iproute2 procps curl` + build deps pra node-pty

**Importante:** para o terminal "host" ser realmente o host (não o container do
agent), rode o agent com `--pid host --network host` e bind do `/`.

## Bug 5 — Topologia sem edges reais

**Causa:** `discover()` só criava edges `server→container hosts`. TCP não era usado.

**Fix:**
- Agent: nova op `host.connections` (`ss -tnp state established` ou `netstat -tnp`)
- Agent: nova op `host.processes` (top 30 por CPU)
- TopologyService.discover() agora chama `host.connections` em servers ativos,
  parseia IPs:portas, cria nó kind=`external` se desconhecido, e edge
  `server→external` com `protocol=tcp` e `port=<real>`
- Filtra loopback e portas efêmeras (>49152)
- Best-effort: erros não interrompem discovery (try/catch por server)

## TODOs implementados

- ✅ **cron-parser real** no `LogExportService` — `cron-parser.parseExpression(s.schedule_cron, { currentDate: anchor }).next()`
- ✅ **nodemailer** — `sendEmail()` usa SMTP_* env (compatível com MailHog do compose)
- ✅ **@aws-sdk/client-s3** — `uploadS3()` lê cred do vault (`secrets.get('aws_logexport')`)
- ✅ **AWS SDKs** (sts, ec2, rds, iam, s3, elbv2) — dynamic import no AwsSyncService
- ✅ **`host.connections` op** no agent → topology v2

## Frontend UX

- `lib/useApi.ts`: hook unificado para fetch com loading/error/auto-refresh
  - `useApi<T>('/path', { intervalMs: 10_000 })` → `{ data, error, loading, reload, setData }`
- `components/ui/States.tsx`: `<LoadingState/>`, `<ErrorState onRetry/>`, `<EmptyState/>`,
  `<Resolved>` (renderiza o estado certo automaticamente)
- Páginas existentes não foram migradas pra não quebrar nada — usar incrementalmente

## Variáveis de ambiente novas

```bash
# SMTP (log scheduler email destination)
SMTP_HOST=mailhog
SMTP_PORT=1025
SMTP_FROM=logwatch@local
# SMTP_USER=...
# SMTP_PASS=...
# SMTP_SECURE=true

# Os secrets cloud ficam no VAULT INTERNO (não no env). Cadastre via
# POST /secrets   { name: 'aws_logexport', value: '{"accessKeyId":"...","secretAccessKey":"...","region":"sa-east-1"}' }
```

## Como aplicar

```bash
cd logwatch
docker compose down
docker compose up -d --build      # roda migration 005 + sobe backend novo
# (instalar SDKs cloud — opcional, mas recomendado)
docker compose exec backend npm i @aws-sdk/client-sts @aws-sdk/client-ec2 \
  @aws-sdk/client-rds @aws-sdk/client-iam @aws-sdk/client-s3 \
  @aws-sdk/client-elastic-load-balancing-v2
```

## O que NÃO foi feito (escopo evitado pra não inflar mudanças)

- Refator do agent inteiro (filas internas, watchdog, deduplicação completos)
  → coleções básicas adicionadas; estabilidade existente preservada
- Migração das páginas frontend pro `useApi` — disponibilizado, não aplicado
- mTLS opcional agent↔backend
- node-cron por schedule (atual: cron base de 1 min + cron-parser por schedule)
- Caching avançado / lazy loading no frontend
