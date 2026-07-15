# Changelog

Formato livre, em português, focado em rastrear **o que a plataforma faz hoje**
por versão — não é changelog de commit, é changelog de feature. Os 3
`package.json` (`backend/`, `frontend/`, `agent/`) são sempre bumpados juntos
com o mesmo número; é esse número que aparece no rodapé do menu (frontend) e
no `GET /health` (backend) e no heartbeat do agent (`agentVersion`).

## [Não lançado]

### Feature: busca de chamada FreeSWITCH/Unity por call UUID
- Migration `027_unity_freeswitch_call_uuid.sql`: coluna `logs.call_uuid`
  (uuid) + índice parcial `idx_logs_call_uuid_ts`, e
  `servers.log_rate_limit_per_minute` (override opcional por servidor do
  teto de linhas armazenadas/minuto).
- `LogsService.ingest` extrai o call UUID do primeiro token da mensagem
  (ex.: trace de dialplan do FreeSWITCH) — sem nenhuma mudança no agent, que
  continua mandando as linhas cruas do jeito que já manda hoje via
  `agent/src/host-logs.ts`.
- Endpoints novos: `GET /logs?callUuid=...` (filtro exato) e
  `GET /logs/calls?serverId&from&to` (chamadas distintas vistas numa janela,
  teto de 48h).
- Tela nova **Unity (FreeSWITCH)** (`/unity`): busca por call UUID numa
  janela de tempo, painel "Chamadas recentes", copiar/exportar .txt.
- Ver [`docs/UNITY_FREESWITCH.md`](./docs/UNITY_FREESWITCH.md) para o passo
  a passo completo de deploy do agent nesse tipo de servidor.

### Correção: exclusão de usuário retornava 500
- `DELETE /api/users/:id` quebrava com 500 cru quando o usuário tinha pedidos
  de acesso a banco, capturas ou sessões de terminal vinculados — a constraint
  tinha `NOT NULL` + `ON DELETE SET NULL` ao mesmo tempo (contraditório:
  Postgres tenta zerar a coluna e viola o `NOT NULL`). `terminal_sessions`
  estava ainda peor, com `ON DELETE CASCADE` (excluiria a sessão/gravação
  inteira ao excluir o usuário).
- Migrations `020_fix_requested_by_fk_action.sql` e
  `021_requested_by_keep_audit_on_delete.sql`: `requested_by` agora aceita
  NULL com `ON DELETE SET NULL` nas 3 tabelas, e cada uma ganhou uma coluna
  `requested_by_email` (snapshot do e-mail no momento do pedido). Resultado:
  **dá pra excluir o usuário e o histórico de auditoria continua legível**
  (mostra o e-mail de quem pediu mesmo depois da conta não existir mais).
  `UsersService.remove()` também não deixa mais erro de FK/constraint virar
  500 — responde 400 com mensagem clara nesse caso.
- Retenção de auditoria, pra referência: `audit_events` expira em 365 dias
  (purga automática); `db_query_requests`, `capture_sessions` e
  `terminal_sessions` **não expiram** (ficam pra sempre, salvo limpeza manual).

### Manutenção: disco não encolhia após a retenção de logs
- A purga horária de `logs` (por servidor, `retention_days`) faz `DELETE`, que
  libera espaço pro Postgres reutilizar mas **não devolve disco ao SO** — só
  uma reescrita da tabela/chunk (`VACUUM FULL` ou `pg_repack`) faz isso.
- Testamos `pg_repack` em produção (evita o lock exclusivo do VACUUM FULL) e
  ele **não é compatível com chunks do TimescaleDB** — erro
  `operation not supported on chunk tables` no `ALTER TABLE ... ENABLE ALWAYS
  TRIGGER` que o pg_repack precisa internamente. Não é problema de
  configuração, é incompatibilidade conhecida.
- Solução: `DbMaintenanceService` novo (`backend/src/db/db-maintenance.service.ts`),
  job noturno (3h, `@Cron`) que roda `VACUUM (FULL, ANALYZE)` em **toda a
  base** — chunks de hypertable com mais de 2 dias de idade (nunca no chunk
  atual, que recebe insert em tempo real) + todas as tabelas normais do
  schema `public`. Desligado por padrão — `LOGWATCH_VACUUM_FULL_ENABLED=true`
  pra ativar (ver `.env.example`).

## [0.6.0] — 2026-06-25

Antes desta versão o projeto não tinha um número de versão único nem
changelog — `backend/package.json` estava em `0.2.0`, `frontend/package.json`
em `0.1.0` e o agent tinha um literal hardcoded (`agentVersion: '0.5.0'`) já
desincronizado do seu próprio `package.json` (`0.2.0`). Esta versão
**consolida tudo isso num só número** e documenta, de uma vez, tudo que já
tinha sido construído sem nunca ter sido escrito num changelog.

### Versionamento (esta entrega)
- Os 3 `package.json` sincronizados em `0.6.0`.
- `GET /health` do backend agora retorna `version` (lida do `package.json` em
  runtime via `import`, não hardcoded).
- Rodapé do menu lateral do frontend mostra `vX.Y.Z` (`NEXT_PUBLIC_APP_VERSION`,
  injetada no build a partir do `package.json` via `next.config.js`).
- `agent/src/config.ts`: `agentVersion` agora lê `package.json` em runtime em
  vez de um literal solto — elimina a classe de bug "esqueci de atualizar o
  número em dois lugares".

### Observabilidade
- Logs: ingestão via agent, full-text search (FTS + trigram + `ILIKE`
  fallback), filtro por servidor/container/host/level/janela de tempo, tail
  ao vivo via WebSocket com reconexão exponencial, export CSV/JSON/log/gz,
  saved queries (próprias ou compartilhadas).
- Sem limite artificial de linhas no backend; frontend carrega em páginas de
  500 ("mostrar mais 500"), mantém até 5000 em memória no tail ao vivo.
- Tail incremental de arquivos do host (`/var/log/...`) com detecção de
  rotação/truncamento (`LOGWATCH_HOST_LOG_*`).
- Métricas de host (CPU/mem/disco/rede/load/uptime) e inventário de
  containers, coletados pelo agent.
- `GET /api/metrics` Prometheus (`logwatch_http_requests_total`,
  `logwatch_logs_ingested_total`, `logwatch_pg_waiting`).

### Operações
- Alertas por query + threshold em janela, com notificação Slack / Discord /
  webhook HMAC / Telegram / PagerDuty.
- Audit log de toda ação sensível (auth, mudanças, MFA, aprovações).
- Docker manager completo via agent: containers (list/inspect/start/stop/
  restart/remove/logs/stats/create), imagens (list/pull com progresso
  streamado/remove), volumes (list/create/remove). Canal de controle
  WebSocket próprio (`/ws/control`) com correlação por `reqId` (mesmo canal
  usado por zero-trust, captura, scripts e log-export pra falar com o agent).
- **Script Manager**: navegação de arquivos do host via agent, leitura/escrita
  com versionamento (hash SHA-256 por versão, autor, comentário), execução
  com auto-aprovação em ambientes não-produção e fila de aprovação humana
  quando o servidor é `environment=production` (migration 004).
- **Log exports agendados**: destino email (SMTP) ou S3 (credenciais no
  vault), cron próprio, histórico de execuções.
- **FinOps**: dashboard de custo cloud (`finops_costs`/`finops_daily`) e
  budgets com alerta por percentual. *(coleta real AWS/OCI ainda é stub —
  ver "Dívida técica" abaixo, migration 002)*.
- **Rotação de credenciais**: CRUD + scheduler horário registrado, mas a
  rotação de fato (AWS IAM, OCI) ainda não está implementada — ver
  "Dívida técica".
- **Patroni**: dashboard multi-cluster (leader/replica/lag/timeline/
  switchovers), clusters cadastrados via UI (migration 007) em vez de só
  uma env var fixa.
- **PostgreSQL Monitor** (`pg-monitor`): detecção de extensões
  (`pg_stat_statements`, `pg_buffercache`, `pg_repack`), dashboard de séries,
  queries ativas, cadeia de locks, top queries, saúde de tabelas, sugestão de
  índices, `EXPLAIN`/`EXPLAIN ANALYZE` ad-hoc, `pg_terminate_backend`.
  Suporte a múltiplas databases por cluster (migration 012), soft delete sem
  perder histórico (migrations 010/011).

### Acesso (Zero Trust) — o bloco mais recente e mais sensível
- **Terminal Web**: sessão de shell (host ou container) via xterm.js, com
  fluxo pedido → aprovação humana. O usuário do SO é resolvido por mapeamento
  (`user_server_logins`: específico do servidor > default > fallback "email
  antes do @"), nunca informado livremente pelo cliente. `sudo` só é avaliado
  e concedido no momento da aprovação (nunca no pedido), e só em modo
  leitura-escrita; o mapeamento pode forçar `readonly` mesmo que o usuário
  peça escrita. Todo I/O é gravado (`terminal_session_events`) e os comandos
  digitados são capturados via `HISTFILE` (`terminal_session_commands`),
  com transcript em texto puro disponível depois. Cron mata sessões por TTL
  absoluto ou ociosidade (migration 013).
- **Console de banco** (`db-access`): `SELECT`/`WITH` roda direto (bloqueando
  múltiplas instruções via `;`, cap de 500 linhas de amostra, timeout 15s).
  Qualquer escrita (`UPDATE`/`INSERT`/`DELETE`) só pode ser registrada como
  pedido; quem aprova é sempre quem executa, dentro de transação, nunca quem
  pediu (migration 014).
- **Captura de rede/SIP** (estilo sngrep/Wireshark): pedido → aprovação →
  captura no agent via `tcpdump -w -` (nunca escreve em arquivo, nem no
  agent nem no backend) → streaming em tempo real por WebSocket
  (`/ws/captures`) pra quem estiver assistindo. Se ninguém estiver olhando
  quando a captura roda, o conteúdo se perde — por design. Suporta
  `ping`/`tcpdump`/`sip` com filtro BPF customizável, parser de pacotes SIP
  no frontend (dialogs estilo sngrep, call-flow com cores por
  método/estado, filtro de texto livre, painéis redimensionáveis por
  arraste) (migration 015).

### Segurança / plataforma
- RBAC granular baseado em tabelas (`permissions`/`roles`/`role_permissions`/
  `user_roles`), substituindo o enum fixo `admin`/`operator`/`viewer`
  (migration 003) — o enum continua existindo como "papel padrão" por
  compatibilidade.
- 2FA TOTP obrigatório por usuário (flag `mfa_required`, migration 009).
- Fluxo "defina sua senha" por link de uso único via email (migration 008).
- Vault interno AES-256-GCM para credenciais (cloud, SMTP, clusters PG).
- API keys com prefixo + bcrypt + IP allowlist para autenticação do agent.

### Dívida técica conhecida (documentada, não escondida)
- `finops/aws-cost.client.ts` e `oci-usage.client.ts` são **stubs**: logam
  aviso e retornam `[]`. Não há integração real com Cost Explorer / OCI
  Usage API ainda.
- `credential-rotation`: o scheduler roda, mas a rotação de fato está
  comentada como TODO — hoje só grava um evento `'todo'` ("rotação
  simulada"), nenhuma credencial é trocada.
- `opensearch/` é um módulo morto (não importado em `app.module.ts`),
  vestígio de uma arquitetura anterior — o storage real de logs é
  PostgreSQL/TimescaleDB.
- Migration 002 criou tabelas para "Terraform Control Plane", SLO/SLI e
  GitHub Actions (e o `Dockerfile` do backend instala o binário do
  Terraform), mas **não existe nenhum módulo NestJS** que use essas tabelas
  hoje — é schema reservado para um trabalho futuro, não uma feature ativa.
- `SECRETS_MASTER_KEY` ausente em produção cai num fallback de chave
  derivada de string fixa — funciona, mas é fraco/previsível; configure a
  env de verdade em produção.

## Antes do 0.6.0

Não rastreado por número de versão. O histórico real está nas migrations
`backend/migrations/001_init.sql` a `015_capture_sessions.sql` — cada arquivo
tem um comentário de cabeçalho explicando o que mudou e por quê.
