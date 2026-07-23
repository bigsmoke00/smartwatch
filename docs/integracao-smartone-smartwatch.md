# Integração SmartOne → SmartWatch (módulo CD)

Lado **SmartWatch** da integração descrita em `integracao_smartwatch.md`. É o que você passa pro dev do SmartOne + o checklist de configuração da nossa infra.

## Visão geral do fluxo

1. No SmartOne, a GMUD é aprovada e o usuário clica em **Iniciar GMUD**.
2. O SmartOne faz `POST` no **webhook** do SmartWatch com os dados do deploy.
3. O SmartWatch **localiza o servidor** informado, **inspeciona o diretório**, detecta sozinho se é `docker-compose` ou script `.sh`, aplica as **envs** e a **versão**, e executa (deploy ou rollback).
4. Ao terminar, o SmartWatch faz `POST` no **callback_url**, com sucesso/erro.

Sem aprovação extra no SmartWatch — quem autoriza é a GMUD. O disparo do webhook já executa.

---

## 1. O que o SmartWatch fornece ao SmartOne

- **URL do webhook:** `POST https://<host-do-smartwatch>/api/webhooks/smartone/gmud`
- **Token de segurança:** Bearer token em `Authorization: Bearer <token>` (ou `x-api-key: <token>`). O valor é a env `SMARTONE_WEBHOOK_TOKEN` da nossa infra; o mesmo valor é cadastrado no SmartOne.

## 2. Requisição que o SmartOne envia (ida)

```
POST /api/webhooks/smartone/gmud
Content-Type: application/json
Authorization: Bearer <SMARTONE_WEBHOOK_TOKEN>
```

```json
{
  "event": "gmud_execution_started",
  "gmud_id": "550e8400-e29b-41d4-a716-446655440000",
  "numero_protocolo": "GMUD-2026-0899",

  "aplicacao": "Unity",
  "componente": "Manager",
  "ambiente": "production",

  "servidor": "ocisp-app-unity1",
  "diretorio": "/opt/digivox/docker-scripts/unity-manager",
  "versao": "2.119.4.195.68",

  "envs": [
    { "chave": "FEATURE_X", "valor": "true" },
    { "chave": "DB_POOL",   "valor": "20" }
  ],

  "callback_url": "https://smartone.smartspace.us/api/webhooks/gmud/550e8400.../callback"
}
```

Campos (o SmartWatch aceita alias em PT e EN):

| Campo | Obrigatório | O que é |
|---|---|---|
| `event` | sim | `gmud_execution_started` (deploy) ou `gmud_rollback_started` (rollback) |
| `aplicacao` (ou `sistema`) | sim | Nome da aplicação/sistema |
| `componente` | sim | Componente que sobe |
| `versao` | sim (deploy) | Versão/tag a aplicar |
| `versao_anterior` | sim (rollback) | Versão para onde voltar |
| `servidor` | **sim** | hostname, IP ou nome do servidor **como cadastrado no SmartWatch** |
| `diretorio` | **sim** | Caminho no host onde está o `docker-compose` ou o `.sh` |
| `envs` | não | Lista de variáveis a **adicionar ou trocar** (upsert). Aceita `[{chave,valor}]` ou objeto `{CHAVE: "valor"}` |
| `ambiente` | recomendado | `production`/`staging`/... (usado no histórico) |
| `gmud_id`, `numero_protocolo` | não | Só para rastreio/auditoria |
| `callback_url` | sim | Onde devolver o resultado |

**Resposta imediata (202):**
```json
{ "pipeline_id": "<id da execução>", "status": "received", "server": "ocisp-app-unity1" }
```
Se algo essencial faltar (servidor não encontrado, sem diretório/versão), volta `{ "status": "error", "message": "..." }` e o mesmo erro segue no callback.

## 3. Como o SmartWatch aplica (detecção automática)

No `diretorio` informado, o SmartWatch inspeciona os arquivos e decide:

- **Se acha um compose** (`docker-compose.yml/.yaml`, `compose.yml/.yaml`):
  1. Aplica as `envs` no `.env` do diretório (cria se não existir; troca se já existir).
  2. Aplica a **versão**, nesta ordem de tentativa:
     - a imagem usa variável na tag (`image: repo:${TAG}`) → seta `TAG=<versao>` no `.env`;
     - imagem com tag literal e repositório único → reescreve a tag no compose;
     - existe `TAG`/`VERSION`/`IMAGE_TAG`/`APP_VERSION` no `.env` → seta essa;
     - senão, falha com mensagem clara (para não subir a versão errada).
  3. Roda `docker compose pull && docker compose up -d` (detecta `docker compose` v2 ou `docker-compose` v1).
- **Senão, se acha um script** (`deploy.sh`, `start.sh`, `up.sh`, `run.sh`, ou o primeiro `.sh`):
  - Executa o script passando a **versão como 1º argumento** e as `envs` como variáveis de ambiente do processo.
- **Senão:** erro ("nenhum compose nem `.sh` encontrado").

Cada passo (arquivos vistos, envs aplicadas, edição da versão, saída do comando) fica registrado na aba **Execuções** da tela Deploys.

## 4. Callback que o SmartWatch envia (volta)

```
POST <callback_url>
Content-Type: application/json
Authorization: Bearer <SMARTONE_CALLBACK_TOKEN>   (só se configurado)
```
```json
{
  "status": "success",
  "message": "deploy concluído (versão 2.119.4.195.68, modo compose)",
  "pipeline_id": "<id da execução>",
  "completed_at": "2026-07-22T16:05:00Z"
}
```
Se o SmartOne exigir token no callback, ele nos passa e configuramos `SMARTONE_CALLBACK_TOKEN`.

## 5. Checklist da nossa infra

1. Aplicar migrations `031_cd_deploy.sql` e `032_cd_deploy_adaptive.sql`.
2. Envs do backend: `SMARTONE_WEBHOOK_TOKEN` (obrigatório) e `SMARTONE_CALLBACK_TOKEN` (opcional).
3. Agent online no servidor de cada aplicação; `docker`/`compose` no host.
4. O `diretorio` precisa estar dentro do `LOGWATCH_ALLOWED_PATHS` do agent (senão ele recusa ler/escrever/executar).
5. Permissões: `deploy:read` (ver), `deploy:write` (cadastrar), `deploy:trigger` (disparo manual).

## 6. Teste rápido (sem o SmartOne)

```bash
curl -X POST https://<host>/api/webhooks/smartone/gmud \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SMARTONE_WEBHOOK_TOKEN" \
  -d '{
    "event": "gmud_execution_started",
    "numero_protocolo": "GMUD-TESTE-1",
    "aplicacao": "Unity",
    "componente": "Manager",
    "ambiente": "staging",
    "servidor": "ocisp-app-unity1",
    "diretorio": "/opt/digivox/docker-scripts/unity-manager",
    "versao": "2.119.4.195.68",
    "envs": [{ "chave": "FEATURE_X", "valor": "true" }],
    "callback_url": "https://webhook.site/<seu-id>"
  }'
```
Acompanhe passos + logs na aba **Execuções** da tela Deploys.
