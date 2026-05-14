# Script Manager — Guia de uso

A tela **/scripts** permite navegar, editar, fazer upload/download e executar
arquivos diretamente no filesystem do **host Linux** onde o agent está
instalado. Tudo passa pelo agent via canal de controle WebSocket; nada é
exposto por HTTP no host.

## Quando você consegue ver TODO o host?

Quando o agent for executado com o bind do filesystem do host em `/host` e
com `LOGWATCH_HOST_ROOT=/host`. Sem isso, o "host" que aparece na tela é o
próprio container do agent (que tem só Alpine e poucos arquivos).

## Como rodar o agent com acesso total ao host

```bash
docker rm -f logwatch-agent

docker run -d \
  --name logwatch-agent \
  --restart unless-stopped \
  --pid host \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/host:rw,rslave \
  -e LOGWATCH_BASE_URL=https://smartwatch.smartspace.us/api \
  -e LOGWATCH_API_KEY='sk_xxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyy' \
  -e LOGWATCH_SERVER_NAME="$(hostname)" \
  -e LOGWATCH_HOST_ROOT=/host \
  -e LOGWATCH_ALLOWED_PATHS=/ \
  ghcr.io/seu-org/logwatch-agent:latest
```

Pontos importantes:

| Flag | Por quê |
|---|---|
| `-v /:/host:rw,rslave` | bind do filesystem real do host dentro do container |
| `LOGWATCH_HOST_ROOT=/host` | diz ao agent: "traduza qualquer path virtual `/X` → `/host/X` internamente" |
| `LOGWATCH_ALLOWED_PATHS=/` | libera o host inteiro. Para restringir: `/opt/digivox,/etc/nginx,/var/log` |
| `--pid host` | necessário para o terminal de host enxergar processos reais |
| `--network host` | usa a rede do host; o backend é alcançado como `127.0.0.1:4000` |
| sem `USER node` | o agent precisa ser **root** dentro do container para chrootear `/host` |

A UI **nunca** mostra `/host`. Os paths exibidos são sempre os reais do
Linux (`/opt`, `/etc/nginx`, `/var/log`). A tradução para `/host/X` é interna
do agent.

## O que você pode fazer na tela

### Navegar (árvore à esquerda)

- Digite um path absoluto no campo (`/etc`, `/var/log`, `/opt/algo`) e
  pressione Enter
- Setinha ↑ vai para o diretório pai
- Ícone ↻ recarrega o diretório atual
- Pastas aparecem em cima, depois arquivos (ordenado por nome)
- Cada arquivo mostra o **último editor** ao lado (`✎ usuario`) — passe o
  mouse para ver email completo e horário

Permissão necessária: `scripts:read`.

### Visualizar e editar arquivos

Clique num arquivo → carrega no editor Monaco com syntax highlight
automático por extensão (.sh, .py, .ts, .yaml, .conf, .sql, .ini, etc).

No header do editor aparece:
- caminho completo
- `●` em amarelo se há alterações não salvas
- "Última edição por usuario@email em DD/MM/YYYY HH:MM — 'comentário'"

Permissão para editar e salvar: `scripts:write`.

### Salvar

Botão **"Salvar"** (ícone de disquete). Pede um comentário (opcional) que
fica registrado na versão. Cada save com SHA diferente cria uma nova linha
em `script_versions` com `author_email`, `ts`, `comment`. Você pode ver o
histórico no card "Versões" embaixo.

### Upload e Download

- **Upload** (ícone seta para cima): seleciona um arquivo local; o
  conteúdo substitui o editor. Você ainda precisa clicar em "Salvar" para
  gravar no host.
- **Download** (ícone seta para baixo): baixa o conteúdo atual do editor
  como arquivo local.

### Executar

Botão **"Executar"** (▶). Confirma e dispara o script no servidor.

- Em ambientes não-prod: roda imediatamente.
- Em ambientes marcados como `production` (campo `environment` do
  servidor): cria uma execução com status `pending` e exige aprovação de
  alguém com permissão `scripts:approve`.

Resultado aparece no card "Execuções recentes" com:
- timestamp
- caminho
- status (`succeeded` / `failed` / `pending`)
- botões `aprovar` / `rejeitar` (se você tem `scripts:approve`)

Permissão para disparar: `scripts:execute`.

## Auditoria — "quem fez o quê"

Tudo é registrado em três lugares:

1. **`script_versions`** (hypertable): cada save grava `author_id`,
   `author_email`, `ts`, `sha256`, `comment` e o **conteúdo completo** da
   versão.
2. **`script_executions`** (hypertable): cada disparo grava
   `requested_by`, `approved_by` (se aplicável), `status`, `exit_code`,
   `stdout`, `stderr`, `duration_ms`.
3. **`audit_events`** (hypertable global): `scripts.write`,
   `scripts.execute_request`, `scripts.execute_approve`,
   `scripts.execute_reject` — com IP, user-agent e payload redatado.

Na **árvore** da UI, cada arquivo mostra o último editor inline para você
saber visualmente quem mexeu por último, sem abrir o histórico.

Para ver histórico completo de um arquivo: abra-o e role até "Versões" no
card abaixo do editor.

## Limites e segurança

- Tamanho máx de leitura: 5 MB (`LOGWATCH_MAX_READ`)
- Tamanho máx de escrita: 5 MB (`LOGWATCH_MAX_WRITE`)
- Timeout de execução: 120 s (`LOGWATCH_EXEC_TIMEOUT`)
- Proteção contra path traversal (resolve symlinks + valida prefixos)
- Execução usa `chroot /host` quando o bind está montado, garantindo que
  o script enxergue o filesystem do host (não o do container do agent)
- Endpoints `POST /scripts/.../file` e `POST /scripts/.../execute` exigem
  os scopes RBAC corretos (`scripts:write`, `scripts:execute`)

## Restringir o acesso (recomendado para prod)

Em vez de `LOGWATCH_ALLOWED_PATHS=/`, liste apenas o que precisa:

```bash
-e LOGWATCH_ALLOWED_PATHS=/opt/digivox,/etc/nginx,/var/log/myapp
```

Tentar abrir qualquer path fora disso retorna `path not allowed` com a
lista de paths permitidos.

## Troubleshooting

| Sintoma | Causa | Solução |
|---|---|---|
| Tela vazia ao abrir `/` ou `/opt` | Bind `/:/host` não foi montado | Recriar agent com `-v /:/host:rw,rslave` (não basta `docker restart`) |
| "path not allowed" | Path fora de `LOGWATCH_ALLOWED_PATHS` | Adicionar ao CSV ou usar `/` para liberar tudo |
| "file too large" | Arquivo > 5 MB | Ajustar `LOGWATCH_MAX_READ` no agent ou abrir via terminal |
| Executar falha com permission denied | Script sem +x | Faça `chmod +x` via terminal antes (`/terminal`) |
| Edit + Save em produção mas não rodou | Aprovação pendente | Card "Execuções": peça a um admin/operator aprovar |
| Não aparece "Última edição por…" | Arquivo nunca foi salvo via Script Manager (só editado por fora) | A info aparece a partir do 1º save pela UI |
