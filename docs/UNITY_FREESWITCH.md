# Unity / FreeSWITCH — busca de chamada por call UUID

## O que é isso e por quê

O cliente tem um servidor FreeSWITCH (host `ocisp-sip-server1`) que escreve um
log de trace de dialplan/chamada extremamente verboso em:

```
/opt/digivox/unity/unity-sip-server/var/log/unity/unity.log
```

Esse arquivo rotaciona a cada poucos minutos (`unity.log.<timestamp>.1`, ~10MB
por rotação) e a maioria das linhas começa com o **UUID da chamada** como
primeiro token, ex.:

```
eedd879e-067e-4213-838f-1531a4637d1d Dialplan: sofia/external/4419@177.47.29.113 parsing [public->ROTA_X] continue=false
```

Nem toda linha tem esse prefixo — canais de outros subsistemas do FreeSWITCH
não carregam UUID nenhum, e isso é esperado.

O objetivo: colar o UUID de uma chamada e ver **todas as linhas daquela
chamada**, numa tela dedicada (`/unity`).

### Decisões de arquitetura

- **Reaproveita a hypertable `logs` já existente**, só com um campo
  estruturado a mais (`call_uuid`), em vez de um módulo/tabela novos —
  mais barato e mantém retenção/FTS/rate-limit de graça (migration
  `027_unity_freeswitch_call_uuid.sql`).
- **Ingestão continua linha a linha**, sem agrupar por chamada em memória no
  agent: a linha de hangup não carrega o UUID, então não dá pra fechar um
  agrupamento de forma confiável. Em vez disso: (a) a cota de linhas
  armazenadas/minuto tem um override por servidor
  (`servers.log_rate_limit_per_minute`) para acomodar o volume gigante desse
  servidor, e (b) a busca por call UUID na UI **exige uma janela de tempo**
  (from/to, teto de 48h) — não é uma busca livre sem limite.
- **O agent não precisa de nenhuma mudança de código.** Ele já tem um tailer
  genérico de arquivos de host (`agent/src/host-logs.ts`) que manda linhas
  cruas pro mesmo endpoint `/ingest` que os logs de container já usam. A
  extração do `call_uuid` acontece no **backend** (`LogsService.ingest`), a
  partir da mensagem já recebida — assim dá pra ajustar o regex no futuro sem
  redeployar o agent em produção.

## Passo a passo: instalar o logwatch-agent do zero em `ocisp-sip-server1`

Esse host ainda não tem nenhum agent rodando. No painel do LogWatch:

1. **Servidores → Novo servidor**. Dê um nome claro (ex.: `ocisp-sip-server1`).
   Configure já de cara (ver seção seguinte) uma retenção baixa e o
   `logRateLimitPerMinute` alto.
2. **Gerar API key** para esse servidor. Copie a chave (`sk_xxxx.yyyy`).
3. No host `ocisp-sip-server1`, rode (baseado no exemplo de
   [`README.md`](../README.md#conectar-um-servidor-agent), com as variáveis
   específicas deste caso):

```bash
docker run -d \
  --name logwatch-agent \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/host:ro \
  -e LOGWATCH_BASE_URL=https://logwatch.suainfra.com/api \
  -e LOGWATCH_API_KEY=sk_xxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyy \
  -e LOGWATCH_SERVER_NAME=ocisp-sip-server1 \
  -e LOGWATCH_HOST_LOG_ENABLED=true \
  -e LOGWATCH_HOST_LOG_PATHS=/opt/digivox/unity/unity-sip-server/var/log/unity/unity.log \
  -e LOGWATCH_MAX_LINES_PER_SOURCE_PER_SECOND=20000 \
  ghcr.io/suaorg/logwatch-agent:latest
```

Notas sobre essas variáveis (ver `agent/src/config.ts` e `agent/src/host-logs.ts`):

- `-v /:/host:ro` — bind read-only da raiz do host (`LOGWATCH_HOST_ROOT`,
  default `/host`). Necessário pro tail de arquivo de host funcionar; sem
  isso o agent loga "bind /host não encontrado" e o tail de host fica
  desabilitado por completo.
- `LOGWATCH_HOST_LOG_ENABLED=true` — liga o tailer genérico de arquivos de
  host (desligado por padrão).
- `LOGWATCH_HOST_LOG_PATHS` aponta pro **arquivo exato** `unity.log`, não
  para o diretório `.../var/log/unity/` inteiro — esse diretório tem outras
  subpastas (`cdr-csv/`, `ciosp/`, `xml_cdr/`, etc.) que não interessam pra
  esse caso de uso. Os arquivos já rotacionados (ex.:
  `unity.log.2026-07-13-00-02-50.1`) são ignorados automaticamente pelo
  filtro `SKIP_ROTATED` do agent — só o arquivo `unity.log` "vivo" precisa
  ser tailado. A rotação em si é detectada automaticamente por mudança de
  inode (ver `readNew()` em `host-logs.ts`), então não tem gap quando o
  unity.log rotaciona.
- `LOGWATCH_MAX_LINES_PER_SOURCE_PER_SECOND=20000` — bem acima do default
  (200). É só um **teto de segurança** contra runaway de um source
  (proteção do buffer do agent), não uma meta de volume esperado — o volume
  real desse log costuma ficar bem abaixo disso na maior parte do tempo,
  mas picos de tráfego de chamadas podem gerar rajadas grandes.

## Configuração do servidor na tela Servidores

Depois de cadastrar o servidor, ajuste (na listagem de Servidores, ícone de
lápis ao lado de cada badge, ou no formulário de criação):

- **`logRateLimitPerMinute`**: um valor alto, ex. **200000** — o teto padrão
  global (`LOGWATCH_MAX_STORED_ROWS_PER_MINUTE`, default 5000) é pensado pra
  fontes normais e descartaria a maior parte do volume desse FreeSWITCH.
- **Retenção (`retentionDays`)**: um valor **baixo**, ex. **1 a 2 dias** —
  dado o volume gigante (~10MB a cada poucos minutos), reter por muito tempo
  incha o banco rapidamente. Como a busca por call UUID já exige uma janela
  de tempo curta (teto de 48h), reter mais do que isso tem pouco valor
  prático pra esse caso de uso específico.

## Como usar a busca por call UUID

### Tela dedicada `/unity`

1. Selecione o servidor (`ocisp-sip-server1`).
2. Escolha a janela de tempo (padrão: última 1 hora; teto de 48h — janelas
   maiores são ajustadas automaticamente pra as últimas 48h a partir do
   "até").
3. Cole o call UUID no campo de busca e clique em **Buscar** — ou escolha uma
   chamada no painel **"Chamadas recentes"** (que lista `callUuid`,
   `startedAt`, `endedAt` e `lineCount` para todas as chamadas com UUID
   detectado na janela escolhida); clicar numa linha já preenche o campo e
   dispara a busca.
4. As linhas aparecem em **ordem cronológica ascendente** (do início ao fim
   da chamada), num painel estilo terminal. Use **Copiar tudo** ou
   **Exportar .txt** para levar o resultado pra fora da plataforma (ex.:
   anexar num ticket).

### Alternativa: tela `/logs` genérica

A busca `q=<uuid>` na tela `/logs` já funciona hoje via `ILIKE` mesmo sem os
campos estruturados novos (não usa o índice `idx_logs_call_uuid_ts`, então é
mais lenta em janelas grandes) — útil quando você quer ver o UUID misturado
com outras linhas de contexto (ex.: outros canais do FreeSWITCH no mesmo
período), em vez de isoladas por chamada.
