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

## Decisão de arquitetura: scan sob demanda, SEM ingestão pro banco

**Modelo atual (a partir desta versão):** cada busca em `/unity` dispara um
scan **ao vivo, em tempo de requisição**, direto no agent do servidor — nada
do conteúdo desse log é armazenado no Postgres. O fluxo:

1. O front chama `POST /log-scan/start` com `{ serverId, directory, from, to,
   query? }` — `directory` é sempre o caminho fixo do FreeSWITCH acima,
   `query` é o call UUID (omitido no modo "chamadas recentes").
2. O backend (`backend/src/log-scan/`) responde IMEDIATAMENTE com um
   `{ sessionId }` e, em paralelo, manda o **agent** (via o mesmo canal de
   controle `/ws/control` usado por Docker/captura/terminal) rodar
   `logscan.run` — ver `agent/src/log-scan.ts`.
3. O agent lista os arquivos do diretório cujo nome começa com `unity.log`
   (pega o arquivo "vivo" + os rotacionados), decide quais precisa abrir
   olhando o **mtime** de cada um (arquivo rotacionado nunca é modificado de
   novo depois da rotação, então o mtime marca exatamente o fim do intervalo
   que aquele arquivo cobre) e lê **linha a linha** (nunca carrega o arquivo
   inteiro em memória) os que intersectam a janela `[from, to]` pedida, do
   mais antigo pro mais novo.
4. Cada lote de linhas casadas (modo busca) — ou o resumo agregado por UUID
   (modo listagem) — é repassado em tempo real pro backend via o canal
   genérico de streaming (`docker:stream`), que por sua vez repassa pro
   navegador via WebSocket dedicado `/ws/logscan`. O front conecta nesse WS
   assim que recebe o `sessionId` do passo 2.
5. Ao terminar (ou bater um teto de segurança), o agent resolve com um resumo
   final (`filesScanned`, `truncated`, etc.), que vira o evento `done` no WS.

**Por que essa mudança:** o modelo anterior (tailar `unity.log` linha a linha
pro `/ingest` normal, armazenando tudo na hypertable `logs` com um campo
`call_uuid` extraído por regex) foi **rejeitado explicitamente pelo usuário**
— ele não quer esse volume de dados de chamada persistido no banco. O scan
sob demanda resolve o mesmo caso de uso (achar todas as linhas de uma
chamada) sem gravar nada: os arquivos já existem no host, rotacionados, e o
scan só precisa saber "quais abrir" (mtime) e "o que procurar" (call UUID).

### O que isso significa na prática

- **Não é mais necessário** (e não é mais recomendado) colocar `unity.log` em
  `LOGWATCH_HOST_LOG_PATHS` do agent — essa variável ligava o tailer contínuo
  que empurrava cada linha pro `/ingest`. Isso ficou obsoleto para este caso
  de uso; se algum agent em produção ainda tiver essa variável apontando pro
  `unity.log`, pode ser removida sem impacto na tela `/unity` (ela não lê
  mais dessa fonte).
- **Único requisito no host:** o agent do `logwatch` precisa estar rodando e
  com `LOGWATCH_ALLOWED_PATHS` cobrindo o diretório do FreeSWITCH. No deploy
  real do cliente isso já é `LOGWATCH_ALLOWED_PATHS=/` (permissivo, decisão
  intencional já em produção) — ou seja, **nenhuma mudança de configuração é
  necessária** nos agents já implantados. Se um novo host for provisionado
  com uma allowlist mais restrita, garanta que ela inclua
  `/opt/digivox/unity/unity-sip-server/var/log/unity`.
- A hypertable `logs` e a coluna `call_uuid` (migration
  `027_unity_freeswitch_call_uuid.sql`) **continuam existindo** no backend —
  `GET /logs?callUuid=` e `GET /logs/calls` não foram removidos, só **a tela
  `/unity` parou de chamá-los**. Ficam disponíveis para outros usos futuros
  (ex.: correlação com logs de container que passam pelo `/ingest` normal).

## Como funciona por baixo (arquivos-chave)

- `agent/src/log-scan.ts` — lógica de seleção de arquivo por mtime, leitura
  linha a linha via `readline`/`fs.createReadStream`, modo busca (`query`) e
  modo listagem (agregação por UUID), tetos de segurança (máx. 300 arquivos
  / ~2GB por scan, máx. de linhas casadas configurável).
- `agent/src/control.ts` — despacha `logscan.run`/`logscan.stop` (mesmo
  envelope `docker:invoke`/`docker:reply`/`docker:stream` usado por
  Docker/captura/terminal).
- `backend/src/log-scan/log-scan.service.ts` — dispara o agent via
  `ControlGateway.invokeStream()` e devolve `{ sessionId }` na hora.
- `backend/src/log-scan/log-scan.gateway.ts` — WebSocket `/ws/logscan`, só
  repassa os batches pra quem estiver assistindo aquela sessão (com um
  pequeno buffer de catch-up, sem persistência).
- `backend/src/log-scan/log-scan.controller.ts` — `POST /log-scan/start` e
  `POST /log-scan/:sessionId/stop`, exigindo a permissão `logs:read` (mesma
  da tela `/logs`) e registrando a tentativa em `audit_events` (servidor,
  diretório, se tinha `query`, quem pediu) — é leitura de arquivo de host,
  então entra no mesmo padrão de auditoria de outras ações sensíveis do Zero
  Trust (captura, terminal).
- `frontend/app/unity/page.tsx` — dispara o scan e conecta no WS,
  acumulando os lotes conforme chegam (já em ordem cronológica).

## Como usar a busca por call UUID

### Tela dedicada `/unity`

1. Selecione o servidor (`ocisp-sip-server1`).
2. Escolha a janela de tempo (padrão: última 1 hora; teto de 48h — janelas
   maiores são ajustadas automaticamente pra as últimas 48h a partir do
   "até").
3. Cole o call UUID no campo de busca e clique em **Buscar** — ou escolha uma
   chamada no painel **"Chamadas recentes"** (que lista `callUuid`,
   `firstSeen`/`lastSeen` estimados e a contagem de linhas detectadas na
   janela escolhida); clicar numa linha já preenche o campo e dispara a
   busca.
4. As linhas aparecem **conforme chegam** (já em ordem cronológica
   ascendente — arquivo mais antigo primeiro), num painel estilo terminal.
   Use **Copiar tudo** ou **Exportar .txt** para levar o resultado pra fora
   da plataforma (ex.: anexar num ticket).
5. Um aviso fixo na tela deixa claro que **nada disso é armazenado no
   banco** — é leitura ao vivo no servidor a cada busca.

### Alternativa: tela `/logs` genérica

A busca `q=<uuid>` na tela `/logs` continua funcionando (via `ILIKE`) para
qualquer servidor que envie seus logs pelo pipeline normal de ingestão — mas
o FreeSWITCH/Unity **não está mais** configurado para mandar `unity.log` por
esse caminho (ver seção acima), então essa alternativa só é útil se algum
outro log desse mesmo host for ingerido normalmente no futuro.
