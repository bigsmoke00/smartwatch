# Relatório QA-1: agent e canal agent ↔ backend (SmartGard)

Data: 2026-10-05. Código testado: o repositório atual, compilado fora do repo (`/tmp/qa1-backend`, `/tmp/qa1-agent`). Nenhum arquivo do repositório foi alterado.

## Como os testes foram feitos

Todos os scripts estão em `outputs/qa/qa1/`.

| Script | O que roda | Log |
|---|---|---|
| `t01_servers_service.js` | `ServersService` real contra um Postgres 18 real (embedded-postgres, porta 54511) | saída no console |
| `t02_connect.js` | `ControlGateway` real num socket.io 4.8.3 com a mesma fiação do Nest. O cliente é o `control.js` real do agent, rodando em outro processo (`agent-runner.mjs`) | `t02.log` |
| `t03_races_size.js` | Corridas, vários sockets, eventos forjados, mensagens grandes, streams e encoding. Mistura agent real e clientes socket.io crus | `t03.log` |
| `t04_preauth_exec.js` | Frames grandes antes da autenticação e `executeScript` real do agent | `t04.log` |

Para rodar: `NODE_PATH=<repo>/backend/node_modules node tNN_*.js`.

Atenção: **não** use `-r ../preload.js` nos testes de socket. O stub genérico do preload substitui o `bufferutil` opcional do `ws` por um Proxy, e o WebSocket passa a cair com "transport close" logo após conectar. Em vez disso, use o `bcrypt-stub.js`, que só troca o bcrypt.

Legenda: **[TESTE]** = confirmado por teste executado. **[CÓDIGO]** = análise de código.

---

## 1. Cenários testados

| # | Cenário | Resultado | Evidência / observação |
|---|---|---|---|
| 1 | Agent conecta e faz `invoke` (fs.listDir) | PASSOU | T02 s1: ok, 189 itens |
| 2 | Op desconhecida | PASSOU | `Unknown op: naoExiste` |
| 3 | Erro do agent (ENOENT, docker indisponível) | PASSOU | A mensagem do agent chega ao chamador |
| 4 | Timeout do `invoke` e resposta que chega depois | PASSOU | Timeout em 502 ms. A resposta tardia é ignorada e `pending` volta a 0 |
| 5 | Backend faz `disconnect(true)` | PASSOU | Pendente rejeitado em 217 ms ("server namespace disconnect"). O agent reconecta em cerca de 3 s |
| 6 | Transport close | PASSOU | Pendente rejeitado ("forced close"). Reconecta em 1,1 s |
| 7 | Ping timeout (agent congelado com SIGSTOP) | PASSOU | Pendente rejeitado em 2 s ("ping timeout"). O diag registra o motivo. Reconecta em 1,6 s após SIGCONT |
| 8 | Backend reinicia | PASSOU | Pendente rejeitado ("server shutting down"). Reconecta em 117 ms |
| 9 | Falha transitória de banco na validação (2x) | PASSOU | Conecta na 3ª tentativa, sem derrubar o socket |
| 10 | Falha transitória cuja mensagem contém "allowlist" | FALHOU | Tratada como erro de autenticação (achado B3) |
| 11 | Chave inválida: ritmo de reconexão | FALHOU | 8 validações em 20 s, sem backoff crescente (achado M6) |
| 12 | Allowlist de IP com o IP exato | FALHOU | O IP correto é recusado (achado C1) |
| 13 | Allowlist de IP com CIDR | FALHOU | Recusado (achado C1) |
| 14 | Cache de chave após revogação (sequencial) | PASSOU | "Key revoked" na hora |
| 15 | Revogação com validação em voo | FALHOU | A chave revogada continua aceita por até 60 s (achado A3) |
| 16 | Chave de servidor removido (soft-delete) | FALHOU | Continua aceita (achado A2) |
| 17 | Socket já conectado quando a chave é revogada ou o servidor é removido | FALHOU [CÓDIGO] | Ninguém derruba o socket (achado A4) |
| 18 | Handshake antigo termina depois do novo, com o socket antigo já caído | PASSOU | Só o socket vivo fica na lista |
| 19 | Dois handshakes do mesmo agent: a ordem de término define o socket preferido | FALHOU | O socket antigo vira o preferido (achado B2) |
| 20 | Agent duplicado com a mesma chave | PASSOU (canal) / FALHOU (sessões) | `connections=2`. Os pedidos migram para o socket mais novo (achado A6) |
| 21 | Resposta vinda de um socket diferente do que recebeu o pedido | PASSOU | Ignorada. O pedido termina por timeout |
| 22 | Socket não autenticado (sem apiKey, ou com validação em andamento) emite `term:*` / `docker:reply` | PASSOU | 0 eventos repassados |
| 23 | Agent autenticado de outro servidor emite `term:output/command/closed` numa sessão alheia | FALHOU | Os 3 eventos são repassados (achado A5) |
| 24 | Mensagens maiores que 1 MB nos dois sentidos (leitura de 4 MB, escrita de 3 MB) | PASSOU | Ok, o socket não cai |
| 25 | Resposta de 70 MB do agent real | PASSOU | Vira erro "muito grande (70 MB > 48 MB)" e o socket continua online |
| 26 | Resposta de 65 MB de um cliente cru (sem o limite do agent) | PASSOU (esperado) | O socket cai ("transport error") e o pendente é rejeitado na hora com mensagem clara |
| 27 | Backend com `WS_MAX_MESSAGE_BYTES` menor que o limite do agent (16 MB contra 48 MB) | FALHOU | Uma resposta de 20 MB derruba o socket (achado M4) |
| 28 | Ler e salvar de volta um arquivo latin1 pelo editor | FALHOU | Arquivo corrompido (achado M3) |
| 29 | `invokeStream` com chunks de 2 MB | PASSOU | Chunks entregues |
| 30 | `invokeStream`: timeout com stream ativo e cancelamento no agent | FALHOU | O timeout é absoluto e não há cancelamento (achado M5) |
| 31 | Frames de 60 MB antes da autenticação | FALHOU | +818 MB de RSS e event loop bloqueado 468 ms com 6 clientes (achado A7) |
| 32 | `executeScript`: timeout com processo filho ou em background | FALHOU | Timeout de 1 s retornou só em 6 s. Um script terminado ficou preso 5 s pelo filho em background (achado A8) |
| 33 | Path traversal com `../` no fs-ops | PASSOU [CÓDIGO] | `normalize`/`resolve` antes da checagem de prefixo |
| 34 | Symlink no fs-ops | FALHOU [CÓDIGO] | Sem `realpath` (achado A9) |
| 35 | `GET /docker/:id/status` e mensagem no frontend | PASSOU / FALHOU | O diag está correto, mas duas mensagens enganam o usuário (achado M7) |
| 36 | Vazamento de segredo | FALHOU [CÓDIGO] | `LOGWATCH_API_KEY` é herdada por scripts e pelo shell (achado A10). Os logs do gateway não imprimem a chave (ok) |
| 37 | Injeção em args de scripts e no CD | FALHOU [CÓDIGO] | Args com quoting ok; env livre no CD legado (achado C3) |
| 38 | Allowlist via X-Forwarded-For | FALHOU [CÓDIGO] | Cabeçalho controlado pelo cliente (achado A1) |
| 39 | Terminal real (node-pty), docker real, modo chroot `HOST_ROOT` | NÃO TESTÁVEL | Sandbox sem docker.sock, sem node-pty compilado e sem root/chroot. Coberto por análise de código |
| 40 | Backend com várias réplicas (cache e lock por processo) | NÃO TESTÁVEL | Só existe um processo no sandbox. Análise de código (B5) |

**Contagem:** 40 cenários.
- 18 PASSOU, sendo 17 por teste e 1 por análise de código (#33).
- 18 FALHOU, sendo 13 por teste e 5 por análise de código (#17, #34, #36, #37, #38).
- 1 com resultado misto em teste (#20: o canal passou, as sessões falharam).
- 1 com resultado misto, metade teste e metade código (#35: o diag passou, as mensagens do frontend falharam).
- 2 NÃO TESTÁVEL.

---

## 2. Achados por severidade

### CRÍTICO

**C1. A allowlist de IP nunca casa. Qualquer chave com allowlist é sempre recusada [TESTE]**
- **Onde:** `backend/src/servers/servers.service.ts:325` (`k.ip_allowlist::text[]`) e as comparações nas linhas 313 e 338 (`includes(ip)`).
- **Reprodução:** o T01 cria uma chave com `ipAllowlist:['10.0.0.5']`. O banco devolve `'10.0.0.5/32'`, porque o cast `text(inet)` inclui a máscara. `validateApiKey(key,'10.0.0.5')` dá "IP 10.0.0.5 not in allowlist", e com CIDR `10.0.0.0/24` o resultado é o mesmo. Além disso, conexões diretas chegam como `::ffff:127.0.0.1` (visto no T02), formato que também não casaria.
- **Impacto:** quem configura allowlist derruba o próprio agent: ingest, métricas e canal de controle param, e a UI mostra "recusou… allowlist". Para não ficar sem agent, a saída prática é deixar a allowlist vazia, ou seja, o recurso de segurança fica inutilizável.
- **Correção:** fazer a checagem no SQL: `AND (cardinality(k.ip_allowlist)=0 OR $2::inet <<= ANY(k.ip_allowlist))`, com o IP normalizado (tirar `::ffff:`). Alternativa: selecionar `host(...)`/`set_masklen` e comparar com um parser CIDR (ex.: `ipaddr.js`). O cache precisa guardar a lista já em formato CIDR.

**C2. log-scan lê qualquer arquivo do host com a permissão `logs:read` [CÓDIGO, revisão de apoio]**
- **Onde:** `backend/src/log-scan/log-scan.controller.ts:15,49`, `agent/src/log-scan.ts:179,202-203` e `agent/src/fs-ops.ts:23` (`ALLOWED` padrão `'/'`).
- **Impacto:** `directory` e `filePrefix` são livres, então o papel viewer consegue ler arquivos sensíveis do host via stream.
- **Correção:**
  - allowlist própria do log-scan (ex.: `LOGWATCH_LOGSCAN_PATHS=/var/log/freeswitch`);
  - permissão dedicada;
  - `realpath` e checagem de contenção por arquivo.

**C3. O webhook legado do CD aceita servidor, diretório e variáveis de ambiente arbitrários, incluindo `BASH_ENV` e `LD_PRELOAD` [CÓDIGO, revisão de apoio]**
- **Onde:** `backend/src/deploy/deploy.service.ts:241` → `handleLegacy` (461-503) → `executeInDir` (605-606). `ENV_KEY_RE` (linha 76) só valida o formato do nome. No agent, `fs-ops.ts:162` faz `{...process.env, ...opts.env}`.
- **Impacto:** quem tem o token do webhook executa comandos em qualquer servidor.
- **Correção:**
  - desligar o caminho legado por padrão;
  - exigir o catálogo `deploy_apps`;
  - allowlist de chaves de env, ou no mínimo bloquear `LD_*`, `BASH_ENV`, `ENV`, `PATH`, `IFS`, `NODE_OPTIONS`, `DOCKER_*`.

**C4. Terminal zero-trust cai para shell root quando o usuário do SO é inválido [CÓDIGO, revisão de apoio]**
- **Onde:** `backend/src/zero-trust/zero-trust.service.ts:76` (fallback `email.split('@')[0]` sem validação) e `agent/src/host-shell.ts:168-171,217-224` (ramo legado).
- **Impacto:** um e-mail como `Fulano@…` ou `joao+ops@…` reprova na regex do agent e a sessão abre como root, mesmo em modo readonly.
- **Correção:** validar no backend com a mesma regex e recusar a sessão. No agent, lançar erro quando `targetUser` for inválido e remover o ramo legado.

### ALTO

**A1. A allowlist de IP usa o primeiro valor de X-Forwarded-For, que o cliente controla [CÓDIGO]**
- **Onde:** `backend/src/docker-manager/control.gateway.ts:89-90` e `backend/src/logs/api-key.guard.ts:22`.
- **Impacto:** quem tem uma chave vazada envia `X-Forwarded-For: <ip permitido>` e passa pela allowlist (depois que C1 for corrigido). O nginx acrescenta o IP real no fim da lista, não no começo.
- **Correção:**
  - HTTP: usar `req.ip` (o `trust proxy 1` já está configurado).
  - Gateway: pegar o último hop confiável (`xff.split(',').at(-1)`) quando o `handshake.address` for o proxy, ou ler um cabeçalho que o proxy sobrescreve (`X-Real-IP`).

**A2. A chave de servidor removido (soft-delete) continua válida [TESTE]**
- **Onde:** `servers.service.ts:323-330`. O SELECT não filtra `s.deleted_at IS NULL`.
- **Reprodução:** T01 `softDeleted`: "ACEITO após soft-delete".
- **Impacto:** um servidor "removido" continua enviando logs e métricas e mantém canal de controle.
- **Correção:** acrescentar `AND s.deleted_at IS NULL` na query, e desativar as chaves (`UPDATE api_keys SET active=false`) no soft-delete.

**A3. Uma validação em voo recoloca no cache uma chave recém-revogada, que vale por até 60 s [TESTE]**
- **Onde:** `servers.service.ts:269` (`invalidateKeyCache` antes de uma validação concorrente terminar) e `368` (`keyCache.set` sem conferir geração). Em `remove()` (195) a invalidação é feita **antes** do UPDATE/DELETE.
- **Reprodução:** T01 `revokeRace`: SELECT atrasado em 300 ms, revogação no meio, e a chave volta a ser aceita depois da revogação.
- **Correção:** usar um contador `cacheGen`. Capturar a geração antes do SELECT e só gravar no cache se ela não mudou; incrementar a geração na invalidação. Em `remove()`, invalidar **depois** do commit. Com várias réplicas, propagar a invalidação via Redis pub/sub ou `LISTEN/NOTIFY`.

**A4. Revogar a chave ou remover o servidor não derruba o socket de controle já conectado [CÓDIGO]**
- **Onde:** `control.gateway.ts`. A validação só acontece no handshake (100), e `revokeApiKey`/`remove` não avisam o gateway.
- **Impacto:** um agent comprometido continua recebendo comandos (fs.writeFile, execute, term) e emitindo eventos indefinidamente.
- **Correção:**
  - guardar `keyId` em `client.data`;
  - expor `gw.disconnectKey(keyId)` / `disconnectServer(serverId)` e chamá-los em revoke e remove (via EventEmitter, para evitar dependência circular);
  - opcionalmente, revalidar a cada N minutos.

**A5. Um agent de outro servidor injeta `term:output`, `term:command` e `term:closed` em sessão alheia [TESTE]**
- **Onde:** `control.gateway.ts:271-296`. Só há checagem de `authed(client)`, e os forwarders não recebem o `serverId`.
- **Reprodução:** T03 `r3_crossServerTermInjection`: o socket do servidor B emitiu os três eventos para `sessao-do-servidor-A` e os três foram repassados.
- **Impacto:** com o UUID da sessão, um agent comprometido pode forjar a tela do operador (prompts falsos, ANSI), gravar comandos falsos na trilha de auditoria e fechar a sessão.
- **Correção:**
  - mapa `sessionId → {serverId, socketId}` preenchido no `term.start`;
  - nos handlers, descartar quando `client.data.serverId` (e o socket) não baterem;
  - passar o `serverId` aos forwarders e validar contra `terminal_sessions.server_id`.

**A6. Com dois sockets do mesmo servidor, as operações de uma sessão vão para outro agent [TESTE]**
- **Onde:** `control.gateway.ts:166-170`. O `socketFor` escolhe o socket mais novo a cada chamada.
- **Reprodução:** T03 r2. O primeiro `invoke` foi para X; quando Y conectou, o pedido seguinte (`term.input`) foi para Y. Como a sessão foi aberta em X, Y responderia "session not found". O mesmo vale para `capture.stop`, `logscan.stop` e `term.close`.
- **Impacto:** o pty e o sudoers NOPASSWD ficam órfãos no agent X (o terminal gateway engole os erros com `.catch(()=>{})`), e não é possível parar uma captura em andamento.
- **Correção:**
  - fixar a sessão ao socket: `invoke(serverId, op, args, {socketId})`;
  - guardar o `socketId` retornado pelo `term.start`/`capture.run`/`logscan.run`;
  - se esse socket cair, encerrar a sessão em vez de redirecionar.

**A7. Frames de até 64 MB são aceitos de qualquer cliente antes da autenticação, em todos os gateways [TESTE]**
- **Onde:** `backend/src/main.ts:24`. O `maxHttpBufferSize` de 64 MB vale para o servidor socket.io inteiro: /ws/control, terminal, captures e logscan.
- **Reprodução:** T04 `a_preauth6x60MB`. Seis clientes com chave inválida, cada um enviando 60 MB, levaram o RSS do backend a +818 MB e bloquearam o event loop por 468 ms. Com algumas dezenas de clientes o backend sofre OOM, e com ele caem os canais de todos os agents.
- **Correção:**
  - limite baixo por padrão (ex.: 1 MB);
  - liberar 64 MB só para sockets autenticados de /ws/control. Hoje isso não é possível por namespace; a saída é um servidor socket.io (path) separado para o canal de controle com limite alto, e autenticação no middleware `io.use()`/`allowRequest` antes do upgrade;
  - rate-limit de conexões por IP.

**A8. O timeout do `executeScript` não mata a árvore de processos, e um filho em background trava a resposta [TESTE]**
- **Onde:** `agent/src/fs-ops.ts:159-189`. O `SIGKILL` vai só para o processo direto, e a resolução espera o `'close'` (pipes).
- **Reprodução:** T04.
  - `sh -c 'sleep 6; echo fim'` com `timeoutMs:1000` só retornou após 6047 ms.
  - `(sleep 5 &); echo pronto` terminou na hora, mas a resolução levou 5056 ms.
- **Impacto:** o backend marca timeout (scripts após 130 s, deploy após EXEC+15 s) com o processo ainda vivo, libera o lock do deploy e um segundo deploy roda por cima do primeiro. O teto de 600 s do deploy é cortado em 120 s no agent (`fs-ops.ts:154`).
- **Correção:**
  - `spawn(..., {detached:true})` e `process.kill(-child.pid,'SIGKILL')` no timeout;
  - resolver no `'exit'` e destruir os pipes após uma tolerância;
  - alinhar os tetos: o agent informa seu `EXEC_TIMEOUT` e o backend usa `invokeTimeout > agentTimeout + margem`.

**A9. O fs-ops não resolve symlinks, então a allowlist de paths é contornável [CÓDIGO]**
- **Onde:** `agent/src/fs-ops.ts:56-64`. O comentário da linha 6 diz "Resolve symlinks", mas a checagem é só léxica. `readFile`, `writeFile`, `deleteFile` e `listDir` seguem links. O `writeFile` (114) segue o symlink e sobrescreve o alvo.
- **Impacto:** com `LOGWATCH_ALLOWED_PATHS` restrito (ex.: `/opt/scripts`), um link dentro do diretório permitido dá leitura e escrita fora dele. No modo `HOST_ROOT`, um link absoluto ainda resolve dentro do container do agent.
- **Correção:**
  - `fs.realpath` do caminho (ou do diretório pai mais o nome, para arquivos novos);
  - repetir a checagem de contenção sobre o caminho real, já traduzido para `HOST_ROOT`;
  - abrir com `O_NOFOLLOW` na escrita e na remoção.

**A10. `LOGWATCH_API_KEY` é herdada por todo script, deploy e shell executado pelo agent [CÓDIGO]**
- **Onde:** `agent/src/fs-ops.ts:162,167` (`env:{...process.env,...}`) e `agent/src/host-shell.ts:231`.
- **Impacto:** a chave aparece em `env` ou `set -x` dentro de scripts, e esse stdout é gravado em `script_executions` e `deploy_executions`. Com a chave, um atacante conecta um agent falso que vira o socket preferido (A6) e passa a receber os `fs.writeFile` (ex.: `.env` com segredos).
- **Correção:** montar um env mínimo (`PATH`, `HOME`, `LANG`, `TERM`) mais `opts.env` filtrado, sem nenhuma variável `LOGWATCH_*`.

**A11. Outros achados ALTOS da revisão de apoio [CÓDIGO]**
- **Shell e comando de usuário sem validação:**
  - `zero-trust.module.ts:27` aceita qualquer `command`;
  - `host-shell.ts:206-208` interpola `requestedShell` sem quoting dentro de `su -c`, o que dá injeção e contorna o readonly;
  - `control.ts:254-258`: no modo container o comando é livre e roda sem `User`.
  - **Correção:** enum de shells, `shQuote`, readonly também no modo container.
- **sudoers NOPASSWD órfão quando o agent morre:** `host-shell.ts:257-264`, sem limpeza no boot. **Correção:** remover `/etc/sudoers.d/zerotrust-*` no startup do agent.
- **HISTFILE previsível em `/tmp`:** `host-shell.ts:164-166,238-255`, sujeito a ataque de symlink (ler ou truncar arquivo como root). **Correção:** diretório privado 0700 e `O_EXCL|O_NOFOLLOW`.
- **Aprovação:** autoaprovação no zero-trust (`zero-trust.service.ts:200-227`) e nos scripts (`scripts.service.ts:167-176`). **Correção:** `approver !== requested_by`.
- **Gate de produção dos scripts:** `scripts.service.ts:234-240` lê a coluna legada `servers.environment` (sempre `'staging'`), então nada exige aprovação. **Correção:** usar `environment_id` e falhar fechado.
- **Escopo X-Environment ignorado:** terminal, captura, log-scan, scripts, deploy e `docker-manager.controller.ts` invocam qualquer `serverId`. **Correção:** chamar `assertEnv(serverId, envId)` em todos os handlers.

### MÉDIO

**M1. O controller do docker repassa o `body` inteiro para `createContainer`/`createVolume` [CÓDIGO]**
- **Onde:** `docker-manager.controller.ts:95,134` (`@Body() body: any`) e `agent/src/control.ts:183-200`.
- **Impacto:** `binds:['/:/host']` com `docker:deploy` dá root no host. Pode ser intencional, mas não há validação nem audit dos binds.
- **Correção:** DTO com allowlist de campos e bloqueio de binds sensíveis (`/`, `/etc`, `/var/run/docker.sock`).

**M2. IDOR em sessões, transcripts e pcaps; tokens com `purpose` aceitos como access token [CÓDIGO, revisão de apoio]**
- **Onde:** `zero-trust.module.ts:55-65,107-119`, `capture.module.ts:69-109` e `auth/jwt.strategy.ts:17`.
- **Correção:** filtrar por `requested_by`, a menos que o usuário tenha permissão de aprovação; rejeitar tokens com `purpose` na strategy e nos gateways.

**M3. O editor de arquivos corrompe arquivos que não são UTF-8 (latin1, binários) [TESTE]**
- **Onde:** `agent/src/fs-ops.ts:104` (`buf.toString('utf-8')`) e `110` (`Buffer.from(content,'utf-8')`).
- **Reprodução:** T03 `r4_latin1RoundTrip`: `4a6fe36f` ("João" em latin1) virou `4a6fefbfbd6f` (U+FFFD). Ler e salvar sem editar destrói os acentos. O `sha256` devolvido é o do buffer original, não o do conteúdo exibido.
- **Correção:**
  - detectar UTF-8 inválido e devolver `encoding:'base64'` ou `'latin1'`;
  - o `writeFile` aceita `encoding`;
  - a UI bloqueia edição de binários;
  - opcionalmente, exigir no `writeFile` o `sha256` esperado (controle de concorrência otimista).

**M4. O limite de resposta do agent (48 MB) não acompanha o limite do backend [TESTE]**
- **Onde:** `agent/src/control.ts:33` contra `backend/src/main.ts:24`.
- **Reprodução:** T03 `r4_limitMismatch20MB`. Com o backend em 16 MB, uma leitura de 20 MB derruba o socket ("transport error") em vez de virar erro. O mesmo acontece com um proxy que limite frames, ou com os `docker:stream`, que não passam por nenhuma checagem de tamanho.
- **Correção:**
  - o backend anuncia `maxMessageBytes` ao agent após a autenticação (ex.: `emit('control:hello',{maxBytes})`) e o agent usa `min(local, anunciado) - margem`;
  - aplicar o mesmo teto em `docker:stream` e `term:output`.

**M5. O `invokeStream` tem timeout absoluto e não manda cancelamento ao agent [TESTE]**
- **Onde:** `control.gateway.ts:195-198`.
- **Reprodução:** T03 r5. O stream recebia chunks a cada 200 ms e mesmo assim deu timeout em 1000 ms. Os chunks seguintes foram descartados e o agent continuou trabalhando.
- **Impacto:**
  - log-scan e captura longos falham com o stream ainda ativo;
  - o agent segue lendo até 2 GB para ninguém (`log-scan.service.ts:80-87` não chama `logscan.stop` no timeout);
  - o pull de imagem continua após o timeout de 600 s.
- **Correção:**
  - timeout de inatividade, renovado a cada chunk, mais um teto absoluto separado;
  - ao rejeitar por timeout, emitir `docker:cancel {reqId}` e implementar o cancelamento no agent (mapa `reqId → AbortController`).

**M6. Chave inválida: o agent reconecta a cada 2–3 s para sempre, sem backoff [TESTE]**
- **Onde:** `agent/src/control.ts:69-71`. O `manualAttempts=0` no `connect` é zerado antes de o backend recusar, porque a recusa acontece depois do `connect` do namespace.
- **Reprodução:** T02 s7: 8 validações em 20 s, com "reconectando em 2s/3s" repetido. Cada tentativa custa um SELECT e, com prefixo válido, um bcrypt. Não há cache negativo nem rate-limit (T01: 5 tentativas = 5 SELECTs + bcrypt).
- **Correção:**
  - zerar `manualAttempts` só depois de uma confirmação de autenticação do backend (ex.: evento `control:ready` emitido após `validateApiKey`);
  - no backend, cache negativo curto por sha256 da chave e rate-limit por IP.

**M7. Mensagens de diagnóstico enganosas na tela do Docker [CÓDIGO]**
- **Onde:** `frontend/app/docker/page.tsx:581-585`, `control.gateway.ts:126,137-141` e `docker-manager.controller.ts:152`.
- **Problemas:**
  - **Falha de banco mostrada como chave inválida:** após 9 falhas transitórias o diag grava `authError:"falha transitória persistente…"`, e a UI mostra "O backend recusou a conexão do agent… Confira a API key e a allowlist". A orientação está errada: o problema é o banco.
  - **Erro de autenticação forjável:** `recordAuthErrorByPrefix` grava o erro no servidor dono do **prefixo** sem que o segredo esteja certo. Qualquer pessoa que conheça o prefixo (aparece na UI e em logs) consegue pôr "Invalid API key" no diag de outro servidor.
  - **Erro antigo não é limpo:** o `authError` só é limpo num `connect`, então um agent online (ex.: um agent duplicado antigo recusado) mantém o erro visível.
  - **Validação em andamento aparece como offline:** durante o retry transitório (até cerca de 153 s) o agent já se vê "connected", mas o status mostra offline sem indicar "validando, tentativa N".
  - **Motivo da queda com explicação imprecisa:** a UI explica "transport error" como "mensagem maior que o limite", e no teste esse foi de fato o motivo. Mas "forced close" (queda pelo `conn.close`) e "server shutting down" não têm explicação.
  - **Status de servidor inexistente:** `GET /docker/:serverId/status` não confere se o servidor existe nem se pertence ao ambiente ativo, e devolve offline para qualquer UUID.
- **Correção:**
  - separar `authError` (só para `UnauthorizedException`) de `transientError`, com texto próprio na UI;
  - só gravar `authError` por prefixo quando o segredo bater (motivo revogada ou allowlist), ou limitar a frequência;
  - expor `validating:{attempt,since}`;
  - validar `serverId` e ambiente no endpoint.

**M8. Outros achados MÉDIOS da revisão de apoio [CÓDIGO]**
- **Execuções de script presas em "running" após restart:** `scripts.service.ts:207`, sem varredura no boot.
- **Status do deploy preso:** `deploy.service.ts:358,569` atualizam o status fora do `try`.
- **Captura presa em "running" após restart:** `capture.service.ts:171-253`.
- **cert-watch apaga o inventário quando o agent está offline:** `cert.service.ts:180-207` (`.catch(()=>null)` seguido de DELETE).
- **Replay do webhook:** idempotência depende só do `callback_url`.
- **SSRF no `callback_url` e vazamento do `SMARTONE_CALLBACK_TOKEN`:** `deploy.service.ts:787-792,926-934`.
- **Segredos em respostas e auditoria:** `getExecution` faz `SELECT *` e devolve `callback_url`; `@Audit('scripts.write')` grava o `content` inteiro.
- **Filtro readonly contornável:** `host-shell.ts:82` (`echo x > /etc/...` com espaço, `r\m`, `find -delete`).
- **Duas abas no mesmo terminal deixam pty órfão:** o `term.start` com `sessionId` repetido sobrescreve o anterior (`control.ts:250`).

### BAIXO

**B1. A classificação "erro de auth ou transitório" é feita por regex na mensagem [TESTE]**
- **Onde:** `control.gateway.ts:38-40`.
- **Reprodução:** T02 s6b. Um timeout de banco com "ip_allowlist" na mensagem foi tratado como erro de auth: disconnect e `authError` gravado.
- **Correção:** usar só `instanceof UnauthorizedException`, ou um `code` próprio nos erros de `validateApiKey`.

**B2. O socket preferido depende da ordem em que as validações terminam, não da ordem de conexão [TESTE]**
- **Onde:** `control.gateway.ts:104-111,166-170`.
- **Reprodução:** T03 r1b. O socket antigo, cuja validação era mais lenta, terminou por último e virou o preferido. Com o retry transitório (até 60 s de espera) mais uma conexão meia-aberta, os pedidos vão para o socket morto e só falham no ping timeout (cerca de 50 s).
- **Correção:** inserir o socket ordenado por `handshake.issued`, ou preferir o de conexão mais recente; ao autenticar um socket novo do mesmo agent (mesmo `handshake.auth.instanceId`), derrubar os mais antigos.

**B3. A allowlist é ignorada quando o IP não é conhecido [TESTE]**
- **Onde:** `servers.service.ts:313,338` (`&& ip &&`).
- **Reprodução:** T01 `allowlistNoIp`.
- **Correção:** falhar fechado quando há allowlist e o IP está ausente.

**B4. Leitura e escrita de arquivo sem controle de concorrência, e o agent devolve `realPath`/`allowedPaths` [CÓDIGO]**
- **Onde:** `fs-ops.ts:88,100,117`.
- **Impacto:** vazamento de detalhes de infraestrutura para a UI, e salvar por cima de uma alteração feita por outra pessoa.
- **Correção:** remover esses campos da resposta e usar o `sha256` como If-Match.

**B5. Cache de chave e lock de deploy existem só no processo [CÓDIGO, não testável]**
- **Onde:** `servers.service.ts:280`, `deploy.service.ts:86`.
- **Impacto:** com várias réplicas, a revogação leva até 60 s nas outras réplicas e dois deploys podem rodar juntos.
- **Correção:** Redis pub/sub ou `LISTEN/NOTIFY` para invalidar o cache, e `pg_advisory_lock` para o deploy.

**B6. Argumento do ping/mtr não é separado com `--` [CÓDIGO]**
- **Onde:** `agent/src/capture.ts:235-236`.
- **Correção:** validar hostname/IP e passar `--` antes do host.

---

## 3. O que está correto (regressões a proteger com testes)

- **Pedidos em voo:** são rejeitados na hora, com o motivo da queda, nos casos de ping timeout, transport close, disconnect pelo servidor e shutdown (T02).
- **Retry de validação transitória:** funciona e não derruba o socket (T02 s6).
- **Reconexão do agent:** volta sozinho após "io server disconnect", transport close, ping timeout e restart do backend, em 0,1 a 3 s (T02).
- **Respostas e streams:** só são aceitos do socket que recebeu o pedido. Eventos de sockets não autenticados são ignorados (T03).
- **Mensagens grandes:** respostas de 1 a 48 MB passam. Acima de 48 MB, o agent converte em erro sem derrubar o socket (T03).
- **Revogação sequencial:** a chave revogada é recusada na hora (T01).
- **Path traversal:** `../` é neutralizado por `normalize`/`resolve`. O quoting dos argumentos no modo chroot está correto (`fs-ops.ts:158`).
