# Commit plan — todas as fases

Conventional Commits, em sequência, branches separadas por escopo.

```bash
cd logwatch

# ============================================================
# Branch 1: bug fixes anteriores (já cobria Tarefa 1)
# ============================================================
git checkout -b fix/critical-bugs

# 1
git add backend/src/automation/semaphore.client.ts backend/src/servers/servers.controller.ts
git commit -m "fix(backend): finalizar semaphore client e endpoints de servers"

# 2
git add frontend/app/logs/page.tsx
git commit -m "fix(frontend): wrap useSearchParams in Suspense (Next.js 14 build)"

# 3
git add frontend/lib/utils.ts frontend/app/page.tsx frontend/app/audit/page.tsx \
        frontend/app/alerts/page.tsx frontend/app/automation/page.tsx \
        frontend/app/metrics/page.tsx frontend/app/metrics/[id]/page.tsx \
        frontend/app/containers/page.tsx frontend/app/patroni/page.tsx \
        frontend/app/settings/page.tsx frontend/app/users/page.tsx \
        frontend/app/servers/page.tsx frontend/app/servers/[id]/page.tsx
git commit -m "fix(frontend): defensive null checks em sort/map/filter sobre dados de API"

# 4
git add frontend/Dockerfile docker-compose.yml
git commit -m "fix(infra): bind frontend Next em 0.0.0.0 + healthcheck"

# 5
git add frontend/app/logs/page.tsx
git commit -m "feat(frontend): WS reconnect com exponential backoff + status badge"

# 6
git add frontend/lib/api.ts frontend/app/login/page.tsx frontend/app/logs/page.tsx
git commit -m "fix(frontend): redirect global em 401 sem loop + preserva rota"

git push -u origin fix/critical-bugs

# ============================================================
# Branch 2: Fase 1 desta rodada (build fixes restantes)
# ============================================================
git checkout main && git pull
git checkout -b fix/phase1-build-and-runtime

git add backend/src/automation/semaphore.client.ts \
        backend/src/terraform/github.client.ts \
        backend/src/servers/servers.controller.ts \
        frontend/app/logs/page.tsx \
        docker-compose.yml \
        .env.example

git commit -m "$(cat <<'EOF'
fix(build): cast undici method, DTO independente, types em safeArray, compose hardening

- semaphore.client/github.client: `method: method as any` para satisfazer o
  union literal de undici.Dispatcher.HttpMethod
- servers.controller: UpdateServerDto declarado independente (sem extends)
  para evitar conflito de override + class-validator com forbidNonWhitelisted
- frontend/app/logs/page.tsx: tipos genéricos explícitos em safeArray<T>(),
  comentário sobre uso correto de `ts` (não `@timestamp`)
- docker-compose.yml: remove publish 5432:5432 (postgres só na rede interna)
- docker-compose.yml: agent recebe `group_add: ${DOCKER_GID}` p/ ler socket
  como user não-root
- .env.example: documenta DOCKER_GID

Closes #FASE-1
EOF
)"

git push -u origin fix/phase1-build-and-runtime

# ============================================================
# Branch 3: Fase 2 — métricas corretas
# ============================================================
git checkout main && git pull
git checkout -b fix/phase2-metrics-audit

git add agent/src/metrics.ts agent/src/index.ts \
        backend/src/metrics/metrics.service.ts \
        frontend/app/metrics/[id]/page.tsx

git commit -m "$(cat <<'EOF'
fix(metrics): coleta correta de CPU/RAM/disco/rede, swap, e UI completa

Agent (agent/src/metrics.ts):
- 1 chamada de si.currentLoad() por ciclo (era chamado 2x e zerava contador)
- load1/5/15 vem de os.loadavg() — currentLoad.avgLoad é CPU%, não load
- warmup() estabelece baseline de net/cpu antes do primeiro push (evita 0)
- filtra mounts virtuais (overlay, snap, tmpfs) e fs <1MB
- mem_used = mem.active (mais preciso em Linux que mem.used)
- net inclui rxBytes/txBytes acumulados além de rxBps/txBps

Backend (metrics.service.ts):
- HostMetricSample: tipos detalhados HostDiskSample / HostNetSample
- aceita campos extras (fs, type, rxBytes, txBytes) via jsonb

Frontend (metrics/[id]):
- novas seções: Swap, Procs, Rede por interface (rx/tx por segundo + total)
- coluna FS na tabela de discos + barra de uso
- fmtBps helper

Validado contra `top`, `df -h`, `free -h`, `cat /proc/loadavg`.
EOF
)"

git push -u origin fix/phase2-metrics-audit

# ============================================================
# Branch 4: Fase 3 — RBAC granular
# ============================================================
git checkout main && git pull
git checkout -b feat/phase3-rbac-granular

git add backend/migrations/003_rbac_granular.sql \
        backend/src/roles/ \
        backend/src/auth/permissions.decorator.ts \
        backend/src/auth/permissions.guard.ts \
        backend/src/app.module.ts \
        frontend/lib/perms.ts \
        frontend/components/AppShell.tsx \
        frontend/app/settings/roles/page.tsx \
        frontend/app/users/page.tsx

git commit -m "$(cat <<'EOF'
feat(rbac): permissions granulares + 7 roles padrão + UI de gestão

Backend:
- migration 003: tabelas permissions / roles / role_permissions / user_roles
- catálogo de 36 permissions (logs:*, servers:*, docker:*, finops:*, etc)
- 7 perfis padrão (system roles): Super Admin, Cloud Admin, DevOps Engineer,
  SRE, Developer, FinOps Analyst, Viewer — com permissões pré-mapeadas
- compat: usuários com role legacy (admin/operator/viewer) ganham automaticamente
  a role correspondente
- @RequirePermission('key1', 'key2'): qualquer-uma-dessas
- PermissionsGuard global (APP_GUARD) → Forbidden 403 com mensagem clara
- RolesService com CRUD de roles + atribuição user×role
- endpoint GET /me/permissions

Frontend:
- /settings/roles: lista + editor com checkboxes agrupados por categoria
- AppShell: filtra menu pelas permissions do usuário (loadMyPermissions cache)
- lib/perms.ts: hasPerm helper

Closes #FASE-3
EOF
)"

git push -u origin feat/phase3-rbac-granular

# ============================================================
# Branch 5: Fase 4 — Docker manager (Portainer-like)
# ============================================================
git checkout main && git pull
git checkout -b feat/phase4-docker-manager

git add agent/src/control.ts agent/src/index.ts agent/package.json \
        backend/src/docker-manager/ \
        backend/src/app.module.ts \
        frontend/app/docker/page.tsx \
        frontend/components/AppShell.tsx

git commit -m "$(cat <<'EOF'
feat(docker): gerenciamento estilo Portainer via canal de controle WS

Arquitetura:
- agent abre socket.io persistente em /ws/control com auth via API key
- backend mantém Map<serverId, Socket>; UI invoca operações via REST e
  ControlGateway.invoke() proxia para o agent correto e aguarda reply
  correlacionado por reqId. Streaming (pull progress) via docker:stream.
- vantagens vs HTTP local no agent: funciona atrás de NAT/firewall, sem
  precisar abrir portas no host, e mantém auth única (API key)

Operações suportadas (todas com @RequirePermission + @Audit):
- containers: list, inspect, start, stop, restart, remove, logs, stats, create
- images: list, pull (com progresso), remove
- volumes: list, create, remove
- status: GET /docker/:serverId/status (online?)

UI /docker:
- selector de servidor + indicador online/offline
- 4 abas: Containers, Images, Volumes, Deploy
- containers: tabela com estado/portas + ações (start/stop/restart/remove)
- modais de logs e inspect
- images: pull com input de tag, lista com tamanhos, remove
- volumes: criação + lista + remove
- deploy: form com imagem, portas (host:container/proto), env, binds,
  restart policy, network — gera HostConfig completo

Permissions novas usadas: containers:read, docker:control, docker:deploy.

Closes #FASE-4
EOF
)"

git push -u origin feat/phase4-docker-manager
```

## Branches dos 5 módulos novos

```bash
# ============================================================
# Branch 6: Migration 004 + permissões dos módulos novos
# ============================================================
git checkout main && git pull
git checkout -b feat/m004-permissions-and-schema

git add backend/migrations/004_modules_5.sql .env.example

git commit -m "$(cat <<'EOF'
feat(rbac): migration 004 — schema dos 5 módulos + 19 permissions novas

- Adiciona coluna `environment` na tabela servers (production/staging/...)
- Tabelas (todas idempotentes):
  M1 Scripts:    script_files, script_versions(hyper), script_executions(hyper)
  M2 Logs:       log_export_schedules, log_export_runs(hyper)
  M3 Zero Trust: terminal_sessions, terminal_session_events(hyper),
                 runbooks, runbook_executions(hyper), bastion_sessions(hyper)
  M4 PG Monitor: pg_clusters, pg_metrics(hyper), pg_top_queries(hyper),
                 pg_table_health(hyper)
  M5 Topologia:  topology_nodes, topology_edges
- 19 permissions novas distribuídas entre os 7 roles padrão
- Retention/compression por hypertable
EOF
)"

git push -u origin feat/m004-permissions-and-schema

# ============================================================
# Branch 7: M1 — Script Manager
# ============================================================
git checkout main && git pull
git checkout -b feat/m1-script-manager

git add agent/src/fs-ops.ts agent/src/control.ts \
        backend/src/scripts/ \
        backend/src/app.module.ts \
        frontend/app/scripts/ frontend/package.json \
        .env.example

git commit -m "$(cat <<'EOF'
feat(scripts): file ops no agent + Monaco editor + aprovação de prod

Agent:
- fs-ops.ts: listDir/readFile/writeFile/executeScript com guard ALLOWED_PATHS
- containment check (impede ../ traversal e symlink fora dos paths)
- max read/write/exec timeout configuráveis
- spawn (sem shell) pra evitar injection
- Ops adicionadas ao canal de controle: fs.listDir, fs.readFile,
  fs.writeFile, fs.execute

Backend:
- ScriptsService com versionamento (hypertable script_versions, sha256 dedupe)
- Aprovação de execução obrigatória se servidor.environment='production'
- Endpoints: GET ls, GET file, POST file, GET versions/:id,
  POST execute, POST executions/:id/{approve,reject}
- Permissions granulares: scripts:{read,write,execute,approve}

Frontend /scripts:
- File tree navegável + Monaco editor (dynamic import, ssr:false)
- Syntax highlight automático por extensão (sh/py/ts/sql/yaml/...)
- Diff visual antes de salvar
- Download/Upload do arquivo aberto
- Histórico de versões + execuções com aprovação inline
EOF
)"

git push -u origin feat/m1-script-manager

# ============================================================
# Branch 8: M2 — Log Downloader
# ============================================================
git checkout main && git pull
git checkout -b feat/m2-log-downloader

git add agent/src/control.ts \
        backend/src/log-export/ \
        backend/src/app.module.ts backend/package.json \
        frontend/app/exports/

git commit -m "$(cat <<'EOF'
feat(logs): export multi-formato + bundle ZIP + scheduler

Backend:
- GET /logs/export?serverId&containerName&q&from&to&format=log|csv|json|gz
  Streaming direto pra Response, content-disposition correto
- GET /servers/:id/logs/bundle: ZIP com all.log + 1 arquivo por container
  + journalctl do host (via agent)
- POST /logs/schedules: agendamento cron com destino email/S3
- @nestjs/schedule cron a cada minuto avalia schedules vencidos

Agent:
- nova op host.journalctl (executa journalctl, fallback /var/log/syslog)

Frontend /exports:
- modal de período (from/to) + formato + servidor opcional
- botão ZIP por servidor (bundle)
- CRUD de schedules (cron, formato, destino)
EOF
)"

git push -u origin feat/m2-log-downloader

# ============================================================
# Branch 9: M3 — Zero Trust (terminal web + runbooks + bastion)
# ============================================================
git checkout main && git pull
git checkout -b feat/m3-zero-trust

git add agent/src/control.ts \
        backend/src/zero-trust/ \
        backend/src/docker-manager/control.gateway.ts \
        backend/src/app.module.ts \
        frontend/app/terminal/ frontend/app/runbooks/ frontend/app/bastion/ \
        frontend/components/TerminalView.tsx \
        frontend/components/AppShell.tsx \
        frontend/package.json

git commit -m "$(cat <<'EOF'
feat(zero-trust): terminal web + aprovação N1/N2 + runbooks + bastion log

Agent:
- term.start: docker exec interativo com Tty, stream bidirecional
- term.input/term.close: I/O via canal de controle existente
- output do agent reenviado pro backend como term:output

Backend:
- TerminalGateway WS (/ws/terminal) autenticado por JWT + sessionId aprovado
- proxy bidi: agent ⇄ backend ⇄ UI; cada chunk gravado em
  terminal_session_events (hypertable, retention 180d)
- Fluxo: usuário com terminal:request POSTa /terminal/sessions com motivo;
  outro user com terminal:approve aprova; sessão expira em ttlMinutes
- Runbooks: comandos pré-aprovados com placeholders {{var}}; allowed_envs
  controla onde podem rodar (bloqueia prod por default)
- Bastion: POST /bastion/sessions registra qualquer SSH que passou pela
  plataforma (wrapper sshd ForceCommand)

Frontend:
- /terminal: lista de sessões + xterm.js conectado via WS
- /runbooks: catálogo + executor com vars dinâmicas
- /bastion: tabela de SSH passados pela plataforma
EOF
)"

git push -u origin feat/m3-zero-trust

# ============================================================
# Branch 10: M4 — PostgreSQL Monitor
# ============================================================
git checkout main && git pull
git checkout -b feat/m4-pg-monitor

git add backend/src/pg-monitor/ \
        backend/src/app.module.ts \
        frontend/app/databases/

git commit -m "$(cat <<'EOF'
feat(pg-monitor): poll de pg_stat_*, ações, alertas, dashboard /databases

Backend:
- pg_clusters CRUD; credenciais armazenadas no vault interno (vault_secret)
- MonitoredPgClient: tenta cada host do CSV (multi-host pra Patroni),
  statement_timeout curto pra não travar coleta
- @Cron a cada 10s: coleta pg_stat_database (delta TPS, cache hit),
  pg_stat_activity (conexões por estado), pg_stat_bgwriter,
  pg_stat_statements (top queries), pg_stat_user_tables (bloat),
  replica lag via pg_wal_lsn_diff
- Hypertables: pg_metrics, pg_top_queries, pg_table_health (compress 7d)
- Alertas automáticos: conexões >80%, cache hit <95%, replica lag >100MB,
  query >2min, lock chain, bloat >20% — notificam canais habilitados
- Ações: pg_terminate_backend(pid) com audit, EXPLAIN (analyze opcional,
  validação que é SELECT/WITH), sugestão de índice (seq_scan elevado)
- Permissions: pg:{read,write,terminate,explain}

Frontend /databases:
- Lista lateral de clusters; 6 abas:
  - Visão geral: stats + gráfico conexões/TPS
  - Queries ativas: live, com botão "matar"
  - Locks: tabela com pg_blocking_pids, kill da raiz
  - Top queries: ranking + EXPLAIN inline
  - Saúde: bloat + autovacuum atrasado + sugestões de índice
  - Histórico: 24h gráfico de conexões/TPS/cache hit
EOF
)"

git push -u origin feat/m4-pg-monitor

# ============================================================
# Branch 11: M5 — Topologia visual
# ============================================================
git checkout main && git pull
git checkout -b feat/m5-topology

git add backend/src/topology/ \
        backend/src/app.module.ts \
        frontend/app/topology/ \
        frontend/components/TopologyGraph.tsx \
        frontend/components/AppShell.tsx \
        frontend/package.json

git commit -m "$(cat <<'EOF'
feat(topology): mapa visual D3 + auto-discovery a cada 2min

Backend:
- topology_nodes / topology_edges com unique constraint para upsert
- @Cron a cada 2min: cria nó pra cada server / container ativo /
  pg cluster, e edges (server→container = hosts; pg = isolado por ora)
- Status do nó derivado de last_seen_at e state do container
- CRUD manual: POST nodes/edges, PATCH position (drag-and-drop persistido),
  DELETE — protegidos por topology:write

Frontend /topology:
- D3 force-directed graph com zoom/pan
- Drag para reposicionar nós (posição salvável)
- Cor por severidade (healthy/degraded/down/unknown)
- Filtro por tipo (server/container/database/lb/...)
- Drawer lateral ao clicar num nó com:
  - badges, JSON do recurso (servers/inspect, pg dashboard, container inspect)
  - link "Ver dashboard →" pra rota específica
EOF
)"

git push -u origin feat/m5-topology
```

## Notas

- **Migrations**: 003 é idempotente (todos os ON CONFLICT). Roda automaticamente
  pelo entrypoint do backend Docker. Já se proteje contra re-execução.
- **Build TypeScript**: as features novas reaproveitam tipos existentes.
  Os SDKs cloud (`@aws-sdk/client-cost-explorer`, `oci-usageapi`,
  `@aws-sdk/client-iam`) ficam como TODO documentado nos clients —
  build não exige sua presença.
- **Compat**: usuários antigos com `role` legacy continuam funcionando.
  O `RolesGuard` antigo coexiste com o novo `PermissionsGuard` (ambos no
  APP_GUARD). Endpoints sem `@RequirePermission` continuam regidos pelos
  guards legados.
