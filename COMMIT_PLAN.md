# Commit plan — bug fixes (Tarefa 1)

Sequência sugerida (atomic commits, Conventional Commits). Aplique com:

```bash
cd logwatch
git checkout -b fix/critical-bugs

# Commit 1
git add backend/src/automation/semaphore.client.ts backend/src/servers/servers.controller.ts
git commit -m "$(cat <<'EOF'
fix(backend): finalizar semaphore client e endpoints de servers

- semaphore.client.ts: cliente fino com auth Bearer, métodos para projects/templates/tasks/output/run/stop, throwing em status>=400 com excerpt da resposta
- servers.controller.ts: cobertura de RBAC (admin/operator), audit decorators, suporte a IP allowlist e scopes em apikey

Refs: WIP do dia anterior já parcialmente comitado.
EOF
)"

# Commit 2
git add frontend/app/logs/page.tsx
git commit -m "fix(frontend): wrap useSearchParams in Suspense (Next.js 14 build)

useSearchParams() em client component requer Suspense boundary, senão build
de produção falha com 'should be wrapped in a suspense boundary'."

# Commit 3
git add frontend/lib/utils.ts frontend/app/page.tsx frontend/app/audit/page.tsx \
        frontend/app/alerts/page.tsx frontend/app/automation/page.tsx \
        frontend/app/metrics/page.tsx frontend/app/metrics/[id]/page.tsx \
        frontend/app/containers/page.tsx frontend/app/patroni/page.tsx \
        frontend/app/settings/page.tsx frontend/app/users/page.tsx \
        frontend/app/servers/page.tsx frontend/app/servers/[id]/page.tsx
git commit -m "fix(frontend): defensive null checks em sort/map/filter sobre dados de API

- novo helper safeArray<T>() em lib/utils
- todas as páginas envolvem dados externos com safeArray + .catch(() => [])
- evita whitepage quando endpoint retorna 5xx/timeout"

# Commit 4
git add frontend/Dockerfile docker-compose.yml
git commit -m "fix(infra): bind frontend Next em 0.0.0.0 + healthcheck

- Dockerfile: ENV HOSTNAME=0.0.0.0 e PORT=3000 (next standalone bind em
  localhost por default), user não-root, healthcheck via wget
- docker-compose.yml: environment HOSTNAME/PORT explícitos, FRONTEND_PORT
  configurável, healthcheck no compose"

# Commit 5
git add frontend/app/logs/page.tsx
git commit -m "feat(frontend): WS reconnect com exponential backoff + status badge

socket.io configurado com reconnection: true, reconnectionDelay: 1s,
reconnectionDelayMax: 30s, randomizationFactor: 0.5, attempts: Infinity.
UI mostra status (connected/connecting/offline) e tentativa atual."

# Commit 6
git add frontend/lib/api.ts frontend/app/login/page.tsx
git commit -m "fix(frontend): redirect global em 401 sem loop + preserva rota

- refreshInflight: coalesce N pedidos paralelos em 1 refresh
- redirectToLogin protegido contra loop em /login
- preserva path via ?next= e login redireciona de volta
- handleUnauthorized() exportado para WS/fetch direto (não-apiFetch)"

# Push
git push -u origin fix/critical-bugs
```

## Observação

Em prod, recomendo proteger a branch `main` e abrir PR pelas correções acima.
Se quiser, posso também gerar um `.github/PULL_REQUEST_TEMPLATE.md` com checklist.
