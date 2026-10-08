# Diagnóstico: "AGENT OFFLINE" com o agent rodando

_05/10/2026 · backend, agent 0.7.4 e frontend_

## Sintoma

As telas que dependem do agent (Docker manager, Scripts, Terminal, Captura, Scan de logs, Certificados, Deploys) mostram "agent offline", mas o container `logwatch-agent` está rodando e os logs e métricas continuam chegando.

Logs e métricas vão por **HTTP**, com retry. As telas usam outro caminho: o **canal de controle**, um WebSocket persistente (socket.io em `/ws/control`). O problema era que esse canal morria e não voltava, enquanto o HTTP seguia normal.

## Causas encontradas (todas reproduzidas em teste)

| # | Causa | Efeito | Lado |
|---|---|---|---|
| 1 | Quando a validação da API key no handshake falhava por **qualquer** motivo, inclusive banco lento ou pool esgotado, o backend dava `disconnect(true)`. Pela regra do socket.io-client, depois de `io server disconnect` **o cliente não reconecta sozinho**. | O canal morria de vez e só voltava reiniciando o agent. É a causa principal. | backend + agent |
| 2 | A allowlist de IP **nunca casava**: o Postgres devolve `10.0.0.5/32` e o código comparava com `10.0.0.5`; conexões diretas chegam como `::ffff:10.0.0.5`. | Qualquer servidor com allowlist configurada ficava offline para sempre. | backend |
| 3 | Limite padrão de mensagem do socket.io = **1 MB**. O agent responde `fs.readFile` (até 5 MB), journalctl, inspect e lotes de scan acima disso, e cada resposta grande **derrubava o socket**. | Quedas a cada leitura de arquivo, log de host ou inspect grande. | backend |
| 4 | `validateApiKey` rodava `bcrypt.compare` + 2 UPDATEs **em toda requisição** de ingest, heartbeat e métricas. | Com dezenas de agents, isso saturava o threadpool e o pool do Postgres. Aí a validação do handshake estourava o tempo e caía na causa 1. | backend |
| 5 | Promessas sem `.catch` (`void this.pool.query(...)`, `void runExecution(...)`). No Node 22, uma rejeição sem tratamento **derruba o processo**. | Um soluço do banco derrubava o backend inteiro e todos os agents juntos. Pode explicar o 502 que apareceu antes. | backend |
| 6 | Corrida no handshake: um handshake antigo que terminava depois de um novo trocava o socket vivo por um morto. | O servidor aparecia offline com o agent conectado. | backend |
| 7 | Pedidos em voo não eram cancelados quando o socket caía. | A tela ficava travada até o timeout (30 s a 10 min). | backend |

## O que foi corrigido

**Backend** (resolve as causas 1–7 mesmo com os agents antigos):
- **Erro transitório** na validação não derruba mais o socket: o backend tenta de novo com backoff (1 s → 60 s). Só chave inválida, revogada ou IP fora da allowlist derrubam.
- **Allowlist** comparada como rede, com CIDR e `/32`, IPv4 e IPv6, e normalizando `::ffff:`. Se há allowlist e o IP é desconhecido, a conexão é recusada. O IP vem do último hop do proxy, não do 1º valor do `X-Forwarded-For`, que o cliente controla.
- **Limite de mensagem de 16 MB** para todos os gateways (`WS_MAX_MESSAGE_BYTES`), com ping a cada 20 s e timeout de 30 s.
- **Cache de 60 s da chave validada:** o bcrypt sai de cada requisição. Os UPDATEs de `last_seen` passam a no máximo 1 a cada 30 s por chave e nunca derrubam o processo. Revogar a chave ou remover o servidor limpa o cache **e derruba os sockets abertos** desse servidor. Chave de servidor removido deixa de valer.
- **Rede de segurança** para `unhandledRejection`, que agora só é registrada no log.
- **Canal de controle mais robusto:**
  - vários sockets por servidor;
  - pedidos em voo falham na hora quando o socket cai, com o motivo;
  - resposta só é aceita do socket que recebeu o pedido;
  - eventos de sockets não autenticados são ignorados;
  - sessões (terminal, captura, scan) ficam presas ao socket que as abriu. Isso fecha a injeção de saída de terminal vinda de outro servidor e as sessões órfãs com agent duplicado.
- **Diagnóstico na tela.** `GET /docker/:id/status` agora devolve quando conectou, quando caiu, o motivo e o erro de autenticação. A tela do Docker mostra isso em vez do texto genérico.

**Agent 0.7.4** (precisa atualizar nos servidores):
- reconecta sozinho depois de `io server disconnect` e de handshake recusado;
- tem um watchdog a cada 60 s;
- o backoff só zera depois de 30 s de conexão estável, então chave inválida não fica martelando o backend a cada 2 s;
- respostas maiores que 12 MB viram erro em vez de derrubar o socket.

## Verificação

| Teste (socket.io e Postgres reais, agent compilado em outro processo) | Antes | Depois |
|---|---|---|
| Servidor derruba a conexão (falha transitória) | agent **morre** (1 conexão) | reconecta em ~2 s |
| Resposta de 2 MB do agent | socket cai em **loop** | entregue |
| Allowlist `10.0.0.5` com o IP certo | **recusado** | aceito (também via CIDR) |
| Chave de servidor removido | aceita | recusada |
| Revogação durante validação em andamento | volta ao cache por 60 s | recusada na hora |
| Queda com pedido em voo | trava até o timeout | falha na hora com o motivo |
| Sessão aberta em X com agent duplicado Y | input vai para Y | continua em X; se X cai, erro claro |
| `term:output` forjado por outro socket | repassado | descartado |
| Chave inválida: validações em 20 s | 8 | 4 (com backoff) |

Os scripts de teste ficaram em `docs/qa/` (relatórios) e na pasta de trabalho do QA.

## Para colocar em produção

1. Fazer o deploy do **backend** (as migrations 040, 041 e 042 rodam no boot) e do **frontend**.
2. **Atualizar o agent para 0.7.4** em todos os servidores. Até isso acontecer, o backend novo já evita a maior parte das quedas, mas um agent antigo que levar `disconnect` por chave inválida ou allowlist ainda precisa de restart.
3. No proxy (nginx), garantir WebSocket em `/socket.io/`: `proxy_http_version 1.1`, `Upgrade`/`Connection "upgrade"`, `proxy_read_timeout` ≥ 60 s e `proxy_buffering off`. O proxy também precisa repassar `X-Forwarded-For`.
4. Se algum agent continuar offline, a tela do Docker passa a mostrar o **motivo**: auth recusada, ping timeout, queda de transporte etc.

## Backlog dos QAs (ainda não corrigido, por prioridade)

Detalhes completos em `docs/qa/RELATORIO-QA1.md` e `docs/qa/RELATORIO-QA2.md`.

**Críticos restantes**
- QA1-C2: o scan de logs lê qualquer arquivo do host com `logs:read`. Fazer uma allowlist própria e `realpath` por arquivo (agent + backend).
- QA1-C4: o terminal zero-trust abre shell **root** quando o usuário do SO é inválido. Validar no backend e falhar no agent.

**Altos**
- Escopo de ambiente (Lab/Prod) não aplicado em Docker, Scripts, Terminal, Captura, Scan, Deploy e no alvo de certificado (QA2-A2/A7, QA1-A11).
- Link de definir senha reutilizável (QA2-A3); reset de senha não derruba as sessões abertas (QA2-A4); MFA obrigatório imposto só no frontend (QA2-A5).
- Agent:
  - o timeout de execução não mata processos filhos e o teto é 120 s (A8);
  - symlinks não são resolvidos no fs-ops (A9);
  - a `LOGWATCH_API_KEY` vaza para os scripts executados (A10).
- Zero-trust:
  - autoaprovação (A11);
  - gate de produção dos scripts lendo a coluna antiga (A11).

**Médios e baixos:** mais de 30 itens, entre eles:
- IDOR em sessões e pcaps;
- `createContainer` sem DTO (bind `/` vira root);
- refresh token sem `jti`;
- cert-watch apagando o inventário com o agent offline;
- notificação 4xx/5xx reportada como ok;
- monitor: corrida entre execução agendada e "rodar agora" e conversões das condições;
- import YAML errado;
- rota `/patroni/cluster` inexistente na visão geral;
- vazamento do menu entre usuários no logout.

**Corrigidos nesta rodada** (além do canal do agent):
- QA2-C1: admin só do Lab virava Super Admin global. Administração de usuários, papéis, ambientes, vault, auditoria e uso passou a exigir concessão **global**.
- QA1-C3 / QA2-A6: o webhook legado do CD executava fora do catálogo. Agora fica desligado por padrão (`DEPLOY_LEGACY_WEBHOOK=true` liga) e variáveis perigosas (`LD_*`, `BASH_ENV`, `PATH`…) são bloqueadas.
- QA2-A1: logs e métricas sem permissão.
- QA2-M3: o token do callback do SmartOne aparecia no detalhe do deploy.
- QA2-M4: um script divergente do cadastro era aceito.
- QA2-B4: o disparo manual rodava cadastro desativado.
- Métricas de uso: fuso, janela e falhas de login por usuário (QA2-M5/M6/B5).
- QA1-A2/A3/A4/A5/A7/B1/B3/M6.
