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
