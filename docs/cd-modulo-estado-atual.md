# Módulo CD (Continuous Deployment) — Estado atual

_Atualizado em 2026-09-21 · Projeto SmartGard (logwatch)_

Este documento descreve **tudo o que já está implementado** no módulo de CD do SmartGard — a integração que recebe uma GMUD aprovada no **SmartOne** e executa o deploy/rollback no servidor de destino, via agent. É um resumo técnico do que existe hoje no código; o contrato voltado ao dev do SmartOne está em [`integracao-smartone-smartwatch.md`](./integracao-smartone-smartwatch.md).

---

## 1. Objetivo

Fechar o ciclo de mudança sem intervenção manual: quando uma GMUD é aprovada e iniciada no SmartOne, o SmartGard aplica a nova versão (ou volta a versão anterior) diretamente no host, detecta sozinho se o alvo é `docker-compose` ou script `.sh`, aplica variáveis de ambiente, executa e devolve o resultado ao SmartOne. **Não há aprovação extra dentro do SmartGard** — quem autoriza é a GMUD; o disparo do webhook já executa.

## 2. Visão do fluxo

```
SmartOne (GMUD aprovada → "Iniciar")
   │  POST /api/webhooks/smartone/gmud   (Bearer SMARTONE_WEBHOOK_TOKEN)
   ▼
SmartGard (backend NestJS)
   1. autentica o token do webhook
   2. registra a execução (deploy_executions, status=received)
   3. resolve o servidor pelo host informado (nome/hostname/ip)
   4. valida servidor + diretório + versão
   5. pipeline adaptativo via agent:
        - lista o diretório
        - detecta compose vs script
        - aplica envs no .env (upsert)
        - aplica a versão (3 estratégias)
        - executa (docker compose up -d  ou  ./script.sh <versao>)
   6. POST no callback_url do SmartOne (sucesso/erro)
```

A resposta ao webhook é **imediata (202)**; o pipeline roda em background e o resultado final chega pelo callback.

## 3. Componentes implementados

| Camada | Arquivo | O que faz |
|---|---|---|
| Migration | `backend/migrations/031_cd_deploy.sql` | Tabelas `deploy_apps` e `deploy_executions`, permissões `deploy:*` e seeds de papéis |
| Migration | `backend/migrations/032_cd_deploy_adaptive.sql` | Colunas adaptativas em `deploy_executions` (`server_host`, `working_dir`, `envs`, `detected_mode`) |
| Guard | `backend/src/deploy/smartone-webhook.guard.ts` | Autentica o webhook por token (timing-safe), `Authorization: Bearer` ou `x-api-key` |
| Service | `backend/src/deploy/deploy.service.ts` | Núcleo: webhook, resolução de servidor, pipeline adaptativo, callback, CRUD, disparo manual |
| Controller/Module | `backend/src/deploy/deploy.module.ts` | Rotas do webhook + CRUD de aplicações + histórico de execuções |
| Frontend | `frontend/app/deploy/page.tsx` | Tela **Deploys (CD)**: aplicações, disparo manual, histórico e detalhe da execução |
| Doc de contrato | `docs/integracao-smartone-smartwatch.md` | Lado SmartGard do contrato entregue ao dev do SmartOne |

## 4. Fluxo do webhook (ida)

Endpoint público (sem login), autenticado por token de sistema:

```
POST /api/webhooks/smartone/gmud
Authorization: Bearer <SMARTONE_WEBHOOK_TOKEN>
```

O payload é **normalizado com aliases PT/EN** — o SmartGard aceita variações de nome de campo:

- `aplicacao` / `sistema` / `application` / `app`
- `componente` / `component`
- `servidor` / `server` / `host` / `hostname`
- `diretorio` / `directory` / `dir` / `path` / `working_dir`
- `versao` / `version`; `versao_anterior` / `previousVersion` (rollback)
- `ambiente` / `environment` / `env`
- `envs` / `variaveis` / `env_changes` / `environmentVariables` (aceita `[{chave,valor}]` **ou** objeto `{CHAVE:"valor"}`)
- `callback_url` / `callbackUrl`

O `event` decide a operação: `gmud_execution_started` → **deploy**; `gmud_rollback_started` → **rollback** (usa `versao_anterior`).

**Resposta imediata (HTTP 202):** `{ "pipeline_id": "<id>", "status": "received", "server": "<nome>" }`.
Se faltar algo essencial (sem servidor, servidor não encontrado, sem diretório, sem versão), a execução é marcada como `error`, o mesmo erro segue no callback e a resposta traz `{ "status": "error", "message": "..." }`.

### Resolução do servidor
O host informado é casado (case-insensitive) contra `servers.name`, `servers.hostname` ou o IP (`host(ip)`), ignorando servidores deletados. Se não achar, a execução falha com mensagem clara.

## 5. Pipeline adaptativo (o coração)

Roda em background depois do 202. Passos, todos registrados em `steps`/`log` da execução:

1. **Checa o agent** — se o agent do servidor está offline, falha na hora.
2. **Inspeciona o diretório** (`fs.listDir` via agent).
3. **Detecta o modo:**
   - **compose** se encontrar `docker-compose.yml/.yaml` ou `compose.yml/.yaml`;
   - **script** se encontrar `deploy.sh`, `start.sh`, `up.sh`, `run.sh` (nessa prioridade) ou o primeiro `.sh` do diretório;
   - senão, erro (“nenhum docker-compose nem script .sh encontrado”).
4. **Aplica envs** (só no modo compose, se vierem) — upsert no `.env` do diretório (cria a linha ou substitui o valor, respeitando `export VAR=`).
5. **Aplica a versão** (modo compose) — tenta em ordem:
   1. imagem com variável na tag (`image: repo:${TAG}`) → seta `TAG=<versao>` no `.env`;
   2. tag literal com **repositório único** no compose → reescreve a tag da imagem no próprio `docker-compose.yml`;
   3. variável de versão conhecida já presente no `.env` (`TAG`, `VERSION`, `IMAGE_TAG`, `APP_VERSION`) → seta essa;
   4. senão, **falha com mensagem clara** (para nunca subir a versão errada por adivinhação).
6. **Executa:**
   - compose: detecta `docker compose` (v2) ou `docker-compose` (v1) e roda `pull && up -d`;
   - script: executa o `.sh` passando a **versão como 1º argumento** e as envs como variáveis de ambiente do processo.
7. **Finaliza:** `status=success` (ou `error`), grava `detected_mode`, `steps`, `log` e `completed_at`, e dispara o callback.

Timeout de execução: **10 minutos** (deploy pode envolver `docker pull` de imagem grande).

## 6. Callback (volta)

Ao terminar, o SmartGard faz `POST` no `callback_url`:

```json
{ "status": "success|error", "message": "...", "pipeline_id": "<id>", "completed_at": "<ISO>" }
```

Se `SMARTONE_CALLBACK_TOKEN` estiver configurado, o callback vai com `Authorization: Bearer <token>`. O resultado do POST (HTTP status ou falha) é gravado em `deploy_executions.callback_status`.

## 7. Disparo manual (UI)

Além do webhook, dá pra disparar pela tela: `POST /deploy/apps/:id/trigger` com `{ version, kind }`. Usa o **servidor e diretório do cadastro** da aplicação e roda o mesmo pipeline adaptativo (origem `manual`, sem callback).

## 8. Modelo de dados

### `deploy_apps` (catálogo/alvo — usado no disparo manual e como referência)
`id`, `name`, `sistema`, `componente`, `environment` (`production|staging|development|sandbox`), `server_id` → `servers`, `working_dir`, `strategy` (`compose_env|compose_image|script`), `config` (jsonb), `image_repo`, `enabled`, `created_by`, timestamps. **Único por** (`sistema`, `componente`, `environment`).

### `deploy_executions` (uma por GMUD/rollback ou disparo manual)
`id`, `app_id`, `kind` (`deploy|rollback`), `source` (`smartone|manual`), snapshot do contexto (`gmud_id`, `numero_protocolo`, `sistema`, `componente`, `environment`, `version`, `previous_version`, `callback_url`, `pipeline_id`), `status` (`received|running|success|error`), `steps` (jsonb), `log`, `error_text`, `callback_status`, `requested_by`, `started_at`, `completed_at`, `created_at` e — da 032 — `server_host`, `working_dir`, `envs`, `detected_mode`.

## 9. API

| Método | Rota | Permissão | Uso |
|---|---|---|---|
| POST | `/api/webhooks/smartone/gmud` | token do webhook | Recebe a GMUD do SmartOne (público + guard) |
| GET | `/deploy/apps` | `deploy:read` | Lista aplicações |
| POST | `/deploy/apps` | `deploy:write` | Cadastra aplicação |
| PATCH | `/deploy/apps/:id` | `deploy:write` | Edita aplicação |
| DELETE | `/deploy/apps/:id` | `deploy:write` | Remove aplicação |
| POST | `/deploy/apps/:id/trigger` | `deploy:trigger` | Dispara deploy/rollback manual |
| GET | `/deploy/executions` | `deploy:read` | Histórico (limit configurável) |
| GET | `/deploy/executions/:id` | `deploy:read` | Detalhe de uma execução (steps/log) |

## 10. Segurança

- **Webhook:** token dedicado (`SMARTONE_WEBHOOK_TOKEN`), comparado com `timingSafeEqual`. Sem token configurado, o webhook recusa (401). Não reaproveita o guard de API key dos agents (aquele é sempre atrelado a um server).
- **RBAC:** permissões `deploy:read`, `deploy:write`, `deploy:trigger`. Seeds por papel: Super Admin / DevOps / Cloud Admin têm as três; SRE tem read+trigger; Developer e Viewer só read.
- **Callback:** token opcional (`SMARTONE_CALLBACK_TOKEN`).
- **Execução no host:** tudo passa pelo agent e respeita o `LOGWATCH_ALLOWED_PATHS` — o diretório precisa estar liberado, senão o agent recusa ler/escrever/executar.
- Todas as ações de CRUD/disparo são auditadas (`@Audit`).

## 11. Tela Deploys (CD)

- **Aplicações de deploy:** tabela com Nome, Sistema·componente, Ambiente (badge — produção em vermelho), Servidor, Diretório, e botão **Disparar**. Formulário “Nova aplicação” com seletor de servidor (ServerPicker) e diretório.
- **Execuções:** histórico com Quando, Origem (SmartOne/manual + badge de rollback), Sistema·componente, Versão, GMUD, Status (badge com cor por estado).
- **Detalhe da execução:** modo detectado, passos e log acumulado (arquivos vistos, envs aplicadas, edição da versão, saída dos comandos).

## 12. Configuração / infra necessária

1. Aplicar migrations `031_cd_deploy.sql` e `032_cd_deploy_adaptive.sql` (rodam no boot).
2. Envs do backend: `SMARTONE_WEBHOOK_TOKEN` (obrigatório) e `SMARTONE_CALLBACK_TOKEN` (opcional).
3. Agent online no servidor de cada aplicação, com `docker`/`compose` no host.
4. O diretório de deploy dentro do `LOGWATCH_ALLOWED_PATHS` do agent.

## 13. Teste rápido (sem o SmartOne)

```bash
curl -X POST https://<host>/api/webhooks/smartone/gmud \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SMARTONE_WEBHOOK_TOKEN" \
  -d '{
    "event": "gmud_execution_started",
    "numero_protocolo": "GMUD-TESTE-1",
    "aplicacao": "Unity", "componente": "Manager", "ambiente": "staging",
    "servidor": "ocisp-app-unity1",
    "diretorio": "/opt/digivox/docker-scripts/unity-manager",
    "versao": "2.119.4.195.68",
    "envs": [{ "chave": "FEATURE_X", "valor": "true" }],
    "callback_url": "https://webhook.site/<seu-id>"
  }'
```

Acompanhe passos + logs na aba **Execuções** da tela Deploys.

## 14. Estado atual — o que está pronto

- ✅ Webhook autenticado + resposta 202 assíncrona.
- ✅ Normalização de payload com aliases PT/EN.
- ✅ Resolução de servidor por nome/hostname/IP.
- ✅ Pipeline adaptativo: detecção compose vs script.
- ✅ Aplicação de envs (upsert no `.env`).
- ✅ Aplicação de versão com 3 estratégias + falha segura.
- ✅ Execução via agent com timeout de 10 min e captura de stdout/stderr por passo.
- ✅ Callback ao SmartOne (com token opcional) e registro do resultado.
- ✅ Disparo manual pela UI.
- ✅ CRUD de aplicações + histórico + detalhe (steps/log).
- ✅ RBAC (`deploy:read/write/trigger`) e auditoria.
- ✅ Migrations 031/032 e doc de contrato para o SmartOne.

## 15. Limitações e próximos passos (candidatos)

- **Rollback de compose** volta a versão pela mesma lógica de “aplicar versão” — depende de a versão anterior existir/estar acessível no registry; não guarda snapshot do compose anterior.
- **Sem health-check pós-deploy** integrado (não confirma que o container subiu saudável antes de reportar sucesso — sucesso = comando saiu com código 0). Integrar com o módulo de Monitoramento seria o próximo passo natural.
- **Sem fila/serialização** por servidor: dois webhooks simultâneos no mesmo diretório podem competir.
- **Escopo por ambiente (RBAC novo):** o módulo ainda não foi migrado para o escopo por `environment_id` (tabela `environments`) — usa o campo `environment` textual próprio. Plugável no mesmo esquema quando for a vez do CD.
- **`config`/`strategy` do cadastro** existem no schema, mas o pipeline hoje é totalmente adaptativo (detecta na hora); o cadastro serve de catálogo/disparo manual.
