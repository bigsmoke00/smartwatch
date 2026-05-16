# Tela /logs — guia rápido

## Filtros

### Servidor
Combobox simples. "Todos" agrega logs de todos os servidores monitorados.

### Query (FTS)
Aceita texto livre e operadores estilo Postgres `websearch_to_tsquery`:
- `OutOfMemory` — encontra a palavra
- `"connection refused"` — frase exata (com aspas)
- `panic OR crash` — qualquer um
- `nginx AND 502` — os dois
- `-debug` — exclui

A query ainda usa `ILIKE` como fallback, então buscas simples por substring
sempre funcionam.

### Janela (TimeRangePicker)
Botão com a janela atual. Clique para abrir o popover.

**Aba "Presets"**:
- Últimos 5/15/30 min · 1/4/12/24h · 2/7/30 dias
- Hoje (00:00 até agora)
- Ontem (dia completo, 00:00 às 23:59)

Presets usam tempo **relativo** (`now-1h`, `now`) — quando o tail ao vivo
está ativo, a janela vai se deslocando junto com o tempo.

**Aba "Data específica"**:
- Dois campos `datetime-local` (date picker do navegador).
- Datas **absolutas** — janela fixa. Útil pra investigar um incidente que
  aconteceu, por exemplo, "ontem entre 14:00 e 14:30".

### Fonte
Toggle entre **Tudo / Host (/var/log) / Containers**.
- **Host**: só logs vindos do tail de `/var/log/syslog`, `/auth.log` etc.
  (linhas com `containerName` começando em `host:`)
- **Containers**: só logs vindos de `docker logs --follow`
- **Tudo**: sem filtro

### Levels
Chips coloridos: error, warn, info, debug, trace, fatal, unknown.

## Tail ao vivo

Botão "Tail ao vivo / Pausar tail" controla o WebSocket. Quando ativo:
- Cada nova linha aparece no topo
- Status do WS no header (conectado / reconectando N / offline)
- Reconnect automático com backoff exponencial
- Honra os mesmos filtros (level, query, fonte)

## Coleta de /var/log (host logs)

O agent v0.3+ faz tail incremental dos arquivos abaixo (configurável):

```
/var/log/syslog
/var/log/auth.log
/var/log/messages
/var/log/kern.log
/var/log/dpkg.log
/var/log/nginx/        (todos os *.log dentro)
/var/log/apache2/      (todos os *.log dentro)
```

Cada linha vira um registro em `logs` com `containerName = host:<arquivo>`
(ex: `host:syslog`, `host:auth.log`, `host:nginx/access.log`).

### Configurar paths

```bash
-e LOGWATCH_HOST_LOG_PATHS=/var/log/syslog,/var/log/myapp/,/var/log/nginx/
-e LOGWATCH_HOST_LOG_ENABLED=true            # default
-e LOGWATCH_HOST_LOG_POLL_MS=2000             # frequência do polling
-e LOGWATCH_HOST_LOG_MAX_LINE=8192            # bytes/linha
```

Diretórios terminados em `/` são expandidos (pega todos os `*.log` +
syslog/messages/auth/kern). Arquivos terminados em `.gz` ou rotacionados
são **ignorados** automaticamente.

### docker run completo

```bash
docker run -d \
  --name logwatch-agent \
  --restart unless-stopped \
  --pid host \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/host:rw,rslave \
  --group-add $(stat -c '%g' /var/run/docker.sock) \
  -e LOGWATCH_BASE_URL=https://smartwatch.smartspace.us/api \
  -e LOGWATCH_API_KEY='sk_xxxxxxxx.yyyyyyyyyyyy' \
  -e LOGWATCH_SERVER_NAME="$(hostname)" \
  -e LOGWATCH_HOST_ROOT=/host \
  -e LOGWATCH_ALLOWED_PATHS=/ \
  logwatch-agent
```

`/var/log` é lido via `/host/var/log/...` graças ao bind. Sem `-v /:/host`,
o agent loga `host log tail ignorado: bind /host não encontrado`.

### Detecção de rotação

O tail detecta rotação automaticamente:
- inode do arquivo mudou → reinicia do zero
- arquivo encolheu → reinicia do zero (logrotate truncou)

### Posicionamento inicial

Ao iniciar, os cursores ficam no **EOF**. Só linhas **novas** vão para o
backend (não importa logs antigos). Para forçar import histórico, use o
download manual via `/exports`.

## Performance / limites

- Backend devolve até **300 linhas** por busca; tail mantém até 1000 em
  memória no navegador
- Backend tem rate limit (300 hits/s + 600/min)
- A coluna `ts` é indexada (BRIN no hypertable); buscas com janela
  pequena são instantâneas mesmo em bilhões de linhas
- Logs ficam 90 dias (retention policy do TimescaleDB), comprimidos
  após 7 dias

## Troubleshooting

| Sintoma | Causa | Solução |
|---|---|---|
| "Nenhum log encontrado" mesmo com agent rodando | Janela muito curta ou levels demais | Volta pra "Últimas 24h" e remove filtros |
| Logs do `/var/log` não chegam | Agent sem `-v /:/host` ou env `LOGWATCH_HOST_LOG_ENABLED=false` | Recriar com bind correto |
| `auth.log` permission denied | Agent não-root no host (raro) | Confirma que Dockerfile não tem `USER node` |
| Tail ativo mas nada aparece | Sem novas linhas no período | Normal. Force gerar log: `logger "test"` no host |
| Lentidão na busca | Janela muito grande (>30 dias) | Use preset menor ou data específica |
