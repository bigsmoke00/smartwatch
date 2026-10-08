# Configuração em tempo de execução (imagens do Docker Hub)

As imagens `digivoxbr/smartgard-frontend`, `smartgard-backend` e `smartgard-agent` são **genéricas**: a mesma imagem roda em qualquer servidor ou domínio. Toda a configuração vem do ambiente do container quando ele sobe, e nada fica preso ao build.

## Frontend

### O problema que existia
No Next.js, `process.env.NEXT_PUBLIC_*` escrito no código é **substituído no build** pelo valor da máquina que buildou. A imagem publicada sem essas variáveis caía em `http://localhost:4000/api`, e o login dava "Failed to fetch" em qualquer servidor, porque o navegador tentava acessar a própria máquina. O `.env` do servidor era ignorado.

### Como funciona agora
1. Ao subir, o container lê as variáveis dele com chave dinâmica (o Next não substitui essa forma no build). O código está em `frontend/lib/runtime-config.ts`.
2. A rota `/runtime-config.js`, calculada **a cada requisição**, entrega ao navegador `window.__SMARTGARD__ = { apiUrl, wsUrl }`.
3. O layout carrega esse script com `strategy="beforeInteractive"`, e o Next garante que ele roda antes do app.
4. O navegador resolve os endereços em `frontend/lib/endpoints.ts`, nesta ordem:
   1. configuração de execução;
   2. valor de build, se existir;
   3. **o próprio site** (`/api` e o host atual).

   Um endereço `localhost` é ignorado quando a página não está aberta em localhost.

### Variáveis (todas opcionais)

| Variável | Exemplo | Quando usar |
|---|---|---|
| `SMARTGARD_API_URL` | `https://smartgard.empresa.com/api` | API em outro domínio |
| `SMARTGARD_WS_URL` | `https://smartgard.empresa.com` | WebSocket em outro domínio |
| `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` | idem | aceitas por compatibilidade, também em runtime |

Sem nada definido, o frontend usa o próprio domínio, que é o cenário normal atrás do nginx (`/api` → backend, `/socket.io/` → backend, o resto → frontend). `SMARTGARD_*` tem prioridade sobre `NEXT_PUBLIC_*`. Valor inválido é ignorado e gera um aviso no log e no console do navegador.

### Como conferir
```bash
curl -s http://127.0.0.1:3000/healthz        # mostra API/WS efetivos e de onde vieram
docker compose logs frontend | grep smartgard
```
Exemplo de log:
```
[smartgard] configuração do frontend: API=/api (mesmo domínio) [padrão (mesmo domínio)] · WS=mesmo domínio [padrão (mesmo domínio)]
```
O healthcheck do container usa `/healthz`.

## Backend
Toda a configuração já vem do `.env` em runtime. Na subida, o log registra o CORS efetivo e avisa quando:
- `CORS_ORIGIN` não está definido. Isso só importa se o frontend estiver em outro domínio.
- `CORS_ORIGIN` contém `localhost` em produção.

## Agent
Configurado no `docker run` por `LOGWATCH_BASE_URL`, `LOGWATCH_API_KEY` etc., todas em runtime. Para não deixar a chave escrita no `start.sh`, prefira `--env-file /etc/smartgard-agent.env`, com o arquivo em `chmod 600`.

## Verificação feita
Build de produção do frontend e servidor standalone (igual ao container), testados com a **mesma build** em quatro situações:

| Cenário | Resultado |
|---|---|
| Sem nenhuma variável | `apiUrl: null` → usa `/api` do próprio domínio |
| `.env` com `NEXT_PUBLIC_*` em runtime | obedecido, sem rebuild |
| `SMARTGARD_*` junto com `NEXT_PUBLIC_*` | `SMARTGARD_*` vence; valor inválido gera aviso |
| Busca por `localhost:4000` nos bundles do navegador | nenhuma ocorrência |
