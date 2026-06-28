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

O agent faz tail incremental dos arquivos abaixo (configurável), quando
`LOGWATCH_HOST_LOG_ENABLED=true`:

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
-e LOGWATCH_HOST_LOG_ENABLED=true            # default é "false" — precisa habilitar
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

- Sem limite artificial de linhas no backend. O frontend mantém até
  **5000 hits** em memória no tail ao vivo, e renderiza em páginas de 500
  (botão "mostrar mais 500") em vez de jogar tudo na tela de uma vez.
- Rate limit do backend é **global** (não específico de logs), via
  `@nestjs/throttler`: **30 requisições/s** + **600/min** por IP.
- A coluna `ts` é indexada (BRIN no hypertable); buscas com janela
  pequena são instantâneas mesmo em bilhões de linhas.
- Retenção é **configurável por servidor** (1 a 365 dias, campo
  `servers.retention_days` — migration 019), aplicada por um job de hora em
  hora (`LogsService.purgeExpiredLogs`) que faz `DELETE` linha a linha por
  servidor — TimescaleDB não tem retenção nativa por linha, só por chunk
  inteiro. A retention_policy nativa do TimescaleDB fica só como rede de
  segurança a 400 dias (cobre servidor sem `retention_days` configurado).
  Comprime automaticamente algumas horas após a ingestão.
- **Importante**: esse `DELETE` libera espaço para o Postgres reutilizar
  internamente, mas **não devolve o disco ao SO** — o arquivo do chunk não
  encolhe. Por isso existe um `VACUUM (FULL, ANALYZE)` noturno (3h, opt-in via
  `LOGWATCH_VACUUM_FULL_ENABLED=true`, ver `DbMaintenanceService`) que
  reescreve as tabelas/chunks mais antigos e devolve o espaço de fato.
  Testamos `pg_repack` antes (evitaria o lock exclusivo do VACUUM FULL), mas
  ele é incompatível com chunks do TimescaleDB — rejeita o
  `ALTER TABLE ... ENABLE ALWAYS TRIGGER` que precisa pra rodar sem lock.

## Troubleshooting

| Sintoma | Causa | Solução |
|---|---|---|
| "Nenhum log encontrado" mesmo com agent rodando | Janela muito curta ou levels demais | Volta pra "Últimas 24h" e remove filtros |
| Logs do `/var/log` não chegam | Agent sem `-v /:/host` ou env `LOGWATCH_HOST_LOG_ENABLED=false` | Recriar com bind correto |
| `auth.log` permission denied | Agent não-root no host (raro) | Confirma que Dockerfile não tem `USER node` |
| Tail ativo mas nada aparece | Sem novas linhas no período | Normal. Force gerar log: `logger "test"` no host |
| Lentidão na busca | Janela muito grande (>30 dias) | Use preset menor ou data específica |
