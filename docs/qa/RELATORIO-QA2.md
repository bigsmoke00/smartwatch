# Relatório QA-2: aplicação SmartGard (sem o canal do agent)

Data: 05/10/2026. Repositório: `logwatch/`, estado atual com mudanças não commitadas (CD v2 e uso). Nenhum arquivo do repositório foi alterado.

## Como foi testado

- **Backend:** compilado com `tsc --outDir /tmp/qa2-backend`; o único erro é o TS2307 de `@aws-sdk/client-ses`, que é conhecido.
- **Banco:** os services rodaram contra um Postgres 18 real e descartável, com **todas as 42 migrations aplicadas em ordem**. O TimescaleDB foi neutralizado pelo `schema.js`, que reescreve as chamadas `create_hypertable`, `*_policy` e `drop_chunks` e remove os `ALTER ... timescaledb.*`. Todas as migrations aplicam sem erro.
- **Preload:** `preload2.js` é o preload do kit mais um stub forçado de bcrypt (o binding nativo carregava como Proxy e quebrava no `gen_salt`).
- **Integrações falsas:**
  - SmartOne: servidor `node:http` com resposta programável por token (200, 404, 400, 500→200, 302 e porta fechada).
  - Agent: `ControlGateway` falso, com `fs.listDir`, `fs.execute`, `readFile` e `writeFile`.
- **Guards e pipes reais:** `PermissionsGuard` com `ExecutionContext` falso, `AuditInterceptor` real e `ValidationPipe` real (`whitelist` + `forbidNonWhitelisted`).
- **Varredura de rotas:** os metadados de todos os controllers compilados foram varridos em busca de rotas sem `@RequirePermission` e sem `@Public`. O resultado está em `rotas_sem_permissao.txt`.
- **Monitor, certificados e notificações:** testados por um auxiliar, com scripts em `aux-monitor/` (Postgres na porta 54671 e servidores locais).
- **Contratos do frontend:** checados por outro auxiliar, com scripts em `aux-frontend/`.
- **Typecheck do frontend:** `cd frontend && ./node_modules/.bin/tsc --noEmit` terminou com rc=0.

Scripts (todos em `/sessions/nice-sleepy-shannon/mnt/outputs/qa/qa2/`; as saídas estão em `out_*.txt`):

| Script | O que cobre | Porta |
|---|---|---|
| `t_auth_rbac.js` | autenticação, RBAC por ambiente, isolamento de servidores, CRUD de ambientes | 54611 |
| `t_refresh_same_second.js` | rotação do refresh token | 54612 |
| `t_usage.js` | métricas de uso | 54613 |
| `t_deploy.js` | CD / SmartOne | 54614 |
| `t_invite_secret.js` | link de convite, exposição no detalhe de execução, `limit` | 54615 |
| `t_routes_noperm.js` | varredura de rotas sem permissão | — |

Comando: `NODE_PATH=<repo>/backend/node_modules node -r ./preload2.js <script>`. É preciso compilar antes em `/tmp/qa2-backend`.

---

## 1. Tabela de cenários

Legenda da coluna Evidência: **T** = teste executado; **A** = análise de código; **Aux-M** = teste do auxiliar de monitor, certificados e notificações; **Aux-F** = análise do auxiliar de frontend.

| # | Área | Cenário | Resultado | Evidência / motivo |
|---|---|---|---|---|
| 1 | Auth | Login OK, e-mail case-insensitive, emite access + refresh + sessão | PASSOU | T |
| 2 | Auth | 4 falhas não bloqueiam; a 5ª bloqueia por 15 min | PASSOU | T |
| 3 | Auth | Conta bloqueada recusa a senha correta (403) | PASSOU | T |
| 4 | Auth | Depois que o bloqueio expira, 1 erro **não** deveria re-bloquear | FALHOU | T: `failed_logins=6`, bloqueado de novo (B1) |
| 5 | Auth | `requirePasswordReset` zera `failed_logins`/`locked_until` e marca `must_change_password` | PASSOU | T |
| 6 | Auth | Após o reset, login com a senha antiga é bloqueado | PASSOU | T |
| 7 | Auth | Após o reset, o refresh token antigo é revogado | FALHOU | T: refresh ainda emite sessão nova (A4) |
| 8 | Auth | Verify e consume do token de set-password, depois login com a senha nova | PASSOU | T |
| 9 | Auth | Token de set-password é de uso único | FALHOU | T: o 2º consume troca a senha de novo (A3) |
| 10 | Auth | `changePassword` (admin) desbloqueia, login OK | PASSOU | T |
| 11 | Auth | Refresh rotaciona e o token antigo é recusado | FALHOU | T: no mesmo segundo o token "novo" é igual ao antigo (M1) |
| 12 | Auth | Refresh após logout é recusado | PASSOU | T |
| 13 | Auth | 2 logins no mesmo segundo geram tokens distintos; logout de uma aba não derruba as outras | FALHOU | T: tokens idênticos; o logout revogou as 4 sessões (M1) |
| 14 | Auth | Usuário desativado não renova sessão | PASSOU | T |
| 15 | Auth | Desativado + senha errada responde igual a credencial inválida | FALHOU | T: 403 "User disabled" (B2) |
| 16 | Auth | E-mail inexistente → 401 | PASSOU | T |
| 17 | Auth | MFA obrigatório: login devolve `mfaSetupRequired` | PASSOU | T |
| 18 | Auth | Com 2FA: sem código → 401; com código correto → OK | PASSOU | T |
| 19 | Auth | MFA obrigatório é imposto no backend | FALHOU | T: o guard libera rota protegida sem 2FA (A5) |
| 20 | Auth | Link de convite/reset não serve como access token | FALHOU | T: aceito pela `JwtStrategy` quando `JWT_INVITE_SECRET` não está definido (M2) |
| 21 | Auth | `JWT_INVITE_SECRET` em branco cai no `JWT_SECRET` | PASSOU | T |
| 22 | RBAC | `setUserRoles` no mesmo escopo é idempotente; escopos diferentes coexistem | PASSOU | T |
| 23 | RBAC | Índices únicos parciais (global e escopado) impedem duplicata | PASSOU | T |
| 24 | RBAC | `permissionsOf(env)` = globais + do ambiente | PASSOU | T |
| 25 | RBAC | Guard: header prod, sem header ou header desconhecido → 403 para admin só do Lab | PASSOU | T |
| 26 | RBAC | Guard: header `lab` (slug ou uuid) passa e preenche `req.environmentId` | PASSOU | T |
| 27 | RBAC | `/me/permissions` escopado; `GET /environments` só lista os acessíveis | PASSOU | T |
| 28 | RBAC | Admin só do Lab **não** consegue se conceder Super Admin global | FALHOU | T: escalou para 61 permissões em Prod (C1) |
| 29 | RBAC | `roles:write` só no Lab não altera papel usado em Prod | FALHOU | T: o Viewer de Prod ganhou `users:write` (C1) |
| 30 | RBAC | `users:write` só no Lab não age sobre usuários globais | FALHOU | A (C1) |
| 31 | Isolamento | Servidores: list, get, patch, delete, restore e criar/revogar API key Lab×Prod → 404 | PASSOU | T (7 casos) |
| 32 | Isolamento | Monitor: CRUD, results, events, series e runNow por ID de Prod; `environmentId` no body; importYaml | PASSOU | Aux-M |
| 33 | Isolamento | Monitor `GET endpoints/:id/uptime` escopado | FALHOU | Aux-M (M11) |
| 34 | Isolamento | Status page pública por ambiente | FALHOU | Aux-M (M12) |
| 35 | Isolamento | Certs: update, rescan e remove por ID de Prod → 404 | PASSOU | Aux-M |
| 36 | Isolamento | Cert target com servidor de outro ambiente | FALHOU | Aux-M (A7) |
| 37 | Isolamento | Logs, métricas, docker, scripts, terminal e deploy com `serverId`/app de outro ambiente | FALHOU | T (varredura de rotas) + A (A1, A2) |
| 38 | Ambientes | Slug duplicado ou inválido → 400; `isDefault` troca o default | PASSOU | T |
| 39 | Ambientes | Excluir ambiente em uso ou o default → 400; só com concessões → cascade | PASSOU | T |
| 40 | Ambientes | Desmarcar `isDefault` do default é recusado | FALHOU | T: ficam 0 defaults (B6) |
| 41 | CD | Guard do webhook: token ausente no servidor, sem header ou token errado → 401; Bearer, bearer minúsculo e x-api-key → OK | PASSOU | T (cenário 4 do contrato) |
| 42 | CD | Campos desconhecidos são aceitos (`body: any` escapa do `forbidNonWhitelisted`) | PASSOU | T |
| 43 | CD | `test_connection` → 2xx sem executar; evento desconhecido → ignorado | PASSOU | T (cenário 8) |
| 44 | CD | Cenário 1: preparar → callback `accepted` com `pipeline_id` | PASSOU | T |
| 45 | CD | Preparar reenviado com a mesma `callback_url` é idempotente | PASSOU | T |
| 46 | CD | Cenário 3: componente fora do catálogo → `rejected` com motivo | PASSOU | T |
| 47 | CD | Cenário 1: execução com 2 componentes → 1 callback `success` por componente, `completed_at`, sem header de auth | PASSOU | T |
| 48 | CD | Script recebe a versão como argv[1], cwd = path; `GMUD_ENV_DESCRIPTION` (envMode=script) | PASSOU | T |
| 49 | CD | Execução reenviada com o mesmo token não reexecuta | PASSOU | T |
| 50 | CD | Cenário 2: falha → `error` com motivo; rollback parcial usa só o componente listado e `versao_anterior` | PASSOU | T |
| 51 | CD | Cenário 7: execução refeita com tokens novos | PASSOU | T |
| 52 | CD | Versão insegura, path divergente, script com caminho, sem versão, envMode=block, agent offline, cadastro desativado → `error` | PASSOU | T (7 casos) |
| 53 | CD | Script do payload diferente do cadastrado é recusado | FALHOU | T: executou `evil.sh` (M4) |
| 54 | CD | Disparo manual de cadastro desativado é recusado | FALHOU | T (B4) |
| 55 | CD | Cenário 5: callback 404 → done, sem repetir | PASSOU | T |
| 56 | CD | Cenário 6: callback 400 → failed, sem repetir | PASSOU | T |
| 57 | CD | Callback 500 → pending, cron reenvia até 200; rede → pending; desiste após 6 tentativas | PASSOU | T |
| 58 | CD | Execuções órfãs no boot → `error` + callback | PASSOU | T |
| 59 | CD | Payload legado (sem `componentes`) não executa fora do catálogo | FALHOU | T: rodou `/tmp/qualquer/run.sh` (A6) |
| 60 | CD | Detalhe da execução não expõe o token de callback | FALHOU | T (M3) |
| 61 | CD | `GET /deploy/executions?limit=abc` | FALHOU | T: 500 (B3) |
| 62 | Uso | Beat: várias abas no mesmo minuto contam 1 minuto; view: repetição < 5 s é ignorada | PASSOU | T |
| 63 | Uso | `moduleOf` normaliza path, query e settings | PASSOU | T |
| 64 | Uso | Totais de logins e falhas; logins por usuário pelo e-mail do metadata (case-insensitive) | PASSOU | T |
| 65 | Uso | Falhas de login **por usuário** (summary e userDetail) | FALHOU | T: sempre 0 (M5) |
| 66 | Uso | Usuários sem atividade aparecem com zeros; série com N dias; clamp de `days`; userDetail inexistente → 404 | PASSOU | T |
| 67 | Uso | Total de ações == soma da série diária | FALHOU | T: 1 vs 0 (B5) |
| 68 | Uso | Fuso horário na quebra por dia | FALHOU | T: 22:30 BRT cai no dia seguinte com banco em UTC (M6) |
| 69 | Uso | `PathDto` com `ValidationPipe` real (válido, vazio, campo extra, >300, não-string) | PASSOU | T (5 casos) |
| 70 | Uso | `usage:read` em summary e users/:id; beat/view só autenticado; 042 concede ao Super Admin | PASSOU | T |
| 71 | Monitor | DSL: operadores, placeholders, `len()`, `[BODY]` com caminho, duração do cert, entradas inválidas | PASSOU | Aux-M (58 casos) |
| 72 | Monitor | DSL: `pat()`/`any()` e coerções (null, "" e "false") | FALHOU | Aux-M (M16) |
| 73 | Monitor | Probers HTTP, TLS, TCP, SSH, STARTTLS, WS, bloqueio de injeção ICMP e tipo desconhecido | PASSOU | Aux-M |
| 74 | Monitor | HTTPS expõe `[CERTIFICATE_EXPIRATION]` | FALHOU | Aux-M (M14) |
| 75 | Monitor | UDP em porta fechada, SSH com linha antes do banner, método em minúsculas, timeout HTTP total | FALHOU | Aux-M (B7) |
| 76 | Monitor | ICMP, DNS e RDAP | NÃO TESTÁVEL | Sandbox sem ping e sem DNS local; RDAP é externo |
| 77 | Monitor | Thresholds de falha e sucesso, sem alerta repetido, remove apaga histórico | PASSOU | Aux-M |
| 78 | Monitor | Tick + runNow concorrentes | FALHOU | Aux-M: 2 alertas DOWN (M13) |
| 79 | Monitor | importYaml: `!!js/function` rejeitado, itens vazios ignorados | PASSOU | Aux-M |
| 80 | Monitor | importYaml: mapeamento de tipos e durações | FALHOU | Aux-M (M15) |
| 81 | Monitor/Cert/CD | Validação do PATCH (body `any`) | FALHOU | Aux-M + Aux-F (M17) |
| 82 | Certs | Parse de PEM, bundle, chave privada e DER; `.key` ignorado; alerta deduplicado por `not_after` | PASSOU | Aux-M |
| 83 | Certs | Agent offline não apaga o inventário | FALHOU | Aux-M (M18) |
| 84 | Notificações | Constraint de kind (038) == DTO == `ChannelKind`; payload do Teams | PASSOU | Aux-M |
| 85 | Notificações | HTTP 4xx/5xx do destino reportado como falha | FALHOU | Aux-M (M19) |
| 86 | Notificações | Telegram e PagerDuty ao vivo | NÃO TESTÁVEL | URLs externas (só análise) |
| 87 | Frontend | `tsc --noEmit` | PASSOU | rc=0 |
| 88 | Frontend | Payloads de 10 telas contra os DTOs (`forbidNonWhitelisted`); rotas e campos de uso, deploy, usuários, ambientes, monitor, certs, canais e docker | PASSOU | Aux-F |
| 89 | Frontend | Visão geral chama `/patroni/cluster` | FALHOU | A: rota inexistente (M20) |
| 90 | Frontend | Logout e login de outro usuário sem reload | FALHOU | A (M7) |
| 91 | Frontend | 1º acesso de usuário só do Lab | FALHOU | A (M8) |
| 92 | Frontend | Permissão do menu == permissão do endpoint (terminal, docker, credrot, exports, environments, captures) | FALHOU | A (M21, B8) |
| 93 | Frontend | Telas com permissão parcial (users sem `roles:read`, certs sem `servers:*`, terminal sem `users:read`) | FALHOU | A (M22) |
| 94 | Frontend | Downloads (exports, pcap) enviam `X-Environment` | FALHOU | A (M9) |
| 95 | Notificações | Edição parcial de canal preserva os segredos | FALHOU | A (M10) |

**Contagem: 95 cenários, sendo 54 PASSOU, 39 FALHOU e 2 NÃO TESTÁVEL.** Cada linha agrupa um ou mais casos; o total de asserções automatizadas foi 120 só nos scripts T, mais 58 casos de DSL e cerca de 40 de probers e banco no Aux-M.

---

## 2. Achados por severidade

### CRÍTICO

#### C1. Escalada de privilégio: quem é admin de um ambiente (Lab) vira admin global e de Prod. Confirmado por teste.
- **Onde:**
  - `backend/src/roles/roles.controller.ts:87-96`: `PUT users/:userId/roles` aceita `environmentId: null` (global) ou qualquer uuid.
  - `backend/src/roles/roles.service.ts:157-205`: `setUserRoles` não confere o escopo de quem concede.
  - `roles.service.ts:72-96` (`updateRole`): papéis são globais.
  - `backend/src/users/users.controller.ts:503-548`: reset, troca de senha, MFA e exclusão de qualquer usuário.
  - `environments.controller.ts:48-67`: criar, editar e excluir ambientes.
  - Causa comum: `auth/permissions.guard.ts:91-92` só exige a permissão **no ambiente do header**.
- **Reprodução (`t_auth_rbac.js`):** criei o usuário `lab@x` com o papel "Lab Admin" (com `users:write` e `roles:write`) só no Lab. Com o header `X-Environment: lab`:
  - O guard passou e `ctl.setUserRoles(lab.id, {roleIds:[SuperAdmin], environmentId:null})` funcionou. Resultado: `ESCALOU: agora em Prod tem 61 permissões (users:write=true, deploy:trigger=true)`.
  - Com `roles.updateRole(Viewer, +users:write)`, o papel Viewer (concedido em Prod) passou a dar `users:write` em Prod.
- **Impacto:** o isolamento Prod/Lab, que é o objetivo da migration 039, é contornável por qualquer administrador de ambiente. Ele vira Super Admin global, pode resetar a senha ou excluir admins de Prod e editar ou excluir ambientes.
- **Correção:**
  - Administração de identidade e autorização (`users:*`, `roles:write`, `environments:write`) deve exigir concessão **global**: no guard, um flag `@RequireGlobalPermission` que chama `permissionsOf(user, null)` e filtra `environment_id IS NULL`.
  - Se quiserem admin delegado por ambiente: em `setUserRoles`, exigir que o concedente tenha `users:write` no `envId` alvo (global quando `null`), e proibir conceder papéis com permissões que ele não tem.
  - No frontend (`app/users/page.tsx:201-209`), esconder a opção "Global" para quem não tem concessão global.

### ALTO

#### A1. Logs e métricas sem nenhuma permissão e sem escopo de ambiente. Confirmado pela varredura de metadados.
- **Onde:**
  - `backend/src/logs/logs.controller.ts:98-231`: `GET /logs`, `/logs/calls`, `/logs/containers`, `/logs/files`, `/logs/histogram` e `/logs/export.csv`.
  - `backend/src/metrics/metrics.controller.ts:36-61`: `/metrics/host/:id/series`, `/last` e `/metrics/fleet`.
  - Lista completa em `rotas_sem_permissao.txt`.
- **Reprodução:** `node -r ./preload2.js t_routes_noperm.js` lista essas rotas como sem `@RequirePermission` e sem `@Public`. O `PermissionsGuard` retorna `true` quando não há metadata (`permissions.guard.ts:84`).
- **Impacto:** qualquer usuário autenticado (até um Viewer só do Lab, ou alguém que só tem `usage:read`) lê e exporta em CSV os logs de todos os servidores de todos os ambientes. O menu exige `logs:read`, mas a API não.
- **Correção:**
  - `@RequirePermission('logs:read')` nas rotas de logs (e `logs:export` no CSV) e `@RequirePermission('metrics:read')` nas de métricas.
  - Receber `@ActiveEnvironment()` e validar o `serverId` com `servers.assertEnv`, ou filtrar com `JOIN servers` por `environment_id` quando não houver `serverId`.

#### A2. Módulos por servidor e por recurso ignoram o ambiente (Lab opera em Prod). Análise de código.
- **Onde:**
  - `docker-manager/docker-manager.controller.ts:18-155`, `scripts/scripts.controller.ts:24-118`, `zero-trust`, `capture`, `pg-monitor` e `log-scan`: recebem `serverId` e não verificam o ambiente.
  - `deploy/deploy.module.ts:53-99`: apps e execuções globais (`deploy_apps.environment` é texto solto, sem ligação com `environments`).
  - `notifications`: canais globais.
- **Raciocínio:** o escopo só foi implementado em servers, monitor e certs (`grep ActiveEnvironment`). Quem tem `docker:destroy`, `scripts:execute` ou `deploy:trigger` **só no Lab** manda `X-Environment: lab` (o guard passa) e o `serverId` ou `appId` de Prod. O UUID vaza, por exemplo, pela lista de logs (A1) ou pelo histórico de deploy.
- **Impacto:** parar ou remover containers, executar scripts e fazer deploy em produção com permissão de laboratório.
- **Correção:** um helper `assertServerInEnv(serverId, envId)` (já existe `ServersService.assertEnv`, só falta torná-lo público) chamado em todos os controllers por servidor. Para deploy, `deploy_apps` deve herdar o `environment_id` do servidor e `listApps`, `trigger` e `executions` devem filtrar por ele.

#### A3. Link de definição/redefinição de senha não é de uso único. Confirmado por teste.
- **Onde:** `backend/src/users/users.service.ts:372-388` (`consumeSetPasswordToken`) e `:344-351`.
- **Reprodução:** consumi o token, fiz login com a senha nova e chamei `consumeSetPasswordToken(tok, 'Atacante#2026xx')` de novo: **aceito**, e o login com a senha do atacante funcionou.
- **Impacto:** por 3 dias (`JWT_INVITE_EXPIRES`), quem tiver o link (e-mail encaminhado, histórico do navegador, logs de proxy ou de e-mail) troca a senha de novo e toma a conta, mesmo depois que o dono já usou o link. O comentário do código diz "uso único", mas não é.
- **Correção:**
  - Ao consumir, exigir que `payload.iat*1000 > password_changed_at` (ou `must_change_password = true`) e gravar `password_changed_at`.
  - Melhor ainda: incluir um `jti` e uma tabela ou coluna `set_password_nonce` que é anulada no consumo.

#### A4. Reset ou troca de senha não revoga as sessões existentes. Confirmado por teste.
- **Onde:**
  - `users.service.ts:241-253` (`requirePasswordReset`) e `:329-338` (`changePassword`).
  - `auth/auth.service.ts:67-94`: `refresh` não verifica `must_change_password`, `locked_until` nem `password_changed_at`.
- **Reprodução:** com um refresh token emitido antes, `users.requirePasswordReset(id)` e depois `auth.refresh(firstRefresh)` resultou em **nova sessão emitida**.
- **Impacto:** o reset é justamente o que o admin faz quando a conta foi comprometida. O invasor continua renovando a sessão por até 7 dias.
- **Correção:**
  - Em `requirePasswordReset` e `changePassword`: `UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`.
  - No `refresh`: recusar se `must_change_password` ou se a conta estiver bloqueada.

#### A5. "MFA obrigatório" só existe no frontend, e o 2FA pode ser removido ou trocado sem o código atual. Confirmado por teste.
- **Onde:**
  - `frontend/components/AppShell.tsx:203-207` (só um `router.replace('/settings')`).
  - Backend sem nenhuma checagem: `grep mfaRequired` em guards dá vazio.
  - `auth/auth.controller.ts:297-302`: `DELETE /auth/mfa` sem código.
  - `:284-295`: `POST /auth/mfa/verify` substitui um segredo existente sem provar o atual.
- **Reprodução:** com o usuário `mfa_required=true`, removi o 2FA (`setMfaSecret(null)`, equivalente ao `DELETE /auth/mfa`). O login emite tokens e o `PermissionsGuard` **libera** `deploy:read` (`t_auth_rbac.js`).
- **Impacto:** a obrigatoriedade de 2FA é contornável chamando a API diretamente. Um access token roubado permite desligar ou trocar o 2FA da vítima.
- **Correção:**
  - No guard global, se `mfa_required && totp_secret IS NULL`, permitir só `/auth/me`, `/auth/mfa/*`, `/auth/logout` e `/me/permissions`; nas demais rotas, 403 "configure o 2FA". Também pode ir como claim no JWT, emitido no login.
  - `DELETE /auth/mfa` deve exigir um código TOTP válido e ser proibido quando `mfa_required`.
  - `mfa/verify` deve exigir o código atual quando já houver segredo.

#### A6. Webhook do SmartOne em formato legado executa scripts fora do catálogo. Confirmado por teste.
- **Onde:** `backend/src/deploy/deploy.service.ts:237-241` (fallback para `handleLegacy`) e `:461-503` / `:505-526`.
- **Reprodução (`t_deploy.js`):** o payload `{event:'gmud_execution_started', servidor:'srv-unity', diretorio:'/tmp/qualquer', versao:'1.0', callback_url:...}` (sem `componentes`) executou `/tmp/qualquer/run.sh`.
- **Impacto:** o catálogo `deploy_apps`, que deveria ser a lista branca do que o SmartOne pode disparar, é ignorado. Quem tem o token do webhook roda qualquer `*.sh`, ou `docker compose pull/up` com reescrita de `.env`, em **qualquer diretório de qualquer servidor** cadastrado. O contrato v1.0 não prevê esse formato.
- **Correção:** remover o caminho legado; se for preciso para smoke test, manter atrás de uma flag `DEPLOY_LEGACY_WEBHOOK=1`, desligada por padrão. Para eventos sem `componentes`, responder 2xx com `status:'ignored'`, como já é feito no preparar.

#### A7. Alvo de certificado aceita servidor de outro ambiente. Confirmado por teste (Aux-M).
- **Onde:** `backend/src/cert-watch/cert.service.ts:78-87` (create) e `:93-111` (update de `serverId`, PATCH `any`).
- **Reprodução:** com `envId=Lab` e `serverId` de um servidor de Prod, o agent de Prod foi acionado, e `listCerts(Lab)` devolveu `/certs/site.pem|srv-prod`.
- **Impacto:** um usuário do Lab lê o inventário de certificados (CN, SAN, issuer e caminhos) de Prod e pode varrer diretórios de Prod.
- **Correção:** `SELECT 1 FROM servers WHERE id=$1 AND environment_id=$2` no create e no update, e um DTO com `@IsUUID()` no PATCH.

### MÉDIO

#### M1. Refresh tokens sem `jti`: dois emitidos no mesmo segundo são idênticos. Confirmado por teste.
- **Onde:** `auth/auth.service.ts:125-146`. O payload é `{sub,email,role}` + `iat`/`exp` em segundos.
- **Reprodução (`t_refresh_same_second.js`):**
  - Dois logins seguidos geram tokens IDÊNTICOS.
  - `refresh(a)` devolve o mesmo token `a` como "novo", e `refresh(a)` de novo é aceito.
  - O logout de uma aba revogou as 4 sessões, porque o `UPDATE ... WHERE refresh_token_hash` acerta todas.
- **Impacto:** a rotação não invalida o token antigo quando o refresh cai no mesmo segundo da emissão. Abas e dispositivos que logam juntos compartilham a sessão (o logout ou a revogação de um derruba os outros).
- **Correção:** `jwtid: randomUUID()` no `signAsync` do refresh (e do access).

#### M2. Link de convite/reset vale como access token quando `JWT_INVITE_SECRET` não está definido. Confirmado por teste.
- **Onde:** `users/users.service.ts:348,359,376` (fallback para `JWT_SECRET`) e `auth/jwt.strategy.ts:17-19`, que não rejeita `payload.purpose`.
- **Reprodução (`t_invite_secret.js`):** o token do link é validado com `JWT_SECRET`, e `JwtStrategy.validate` devolve o usuário. Resultado: "aceito ... (must_change_password=true, sem senha/MFA), válido por 3 dias".
- **Impacto:** o link enviado por e-mail dá acesso à API por 3 dias, sem senha e sem 2FA, inclusive para um usuário ainda "pendente". Depende da configuração: o `.env.example` define o segredo, mas o código aceita a ausência.
- **Correção:**
  - Na `JwtStrategy.validate`: `if (payload.purpose) throw new UnauthorizedException()`.
  - Tornar `JWT_INVITE_SECRET` obrigatório (`requireSecret`), diferente do `JWT_SECRET`.

#### M3. O detalhe da execução de deploy expõe o token de uso único do callback do SmartOne. Confirmado por teste.
- **Onde:** `deploy/deploy.service.ts:210-214` (`SELECT *`). A migration 031 dá `deploy:read` ao perfil **Viewer**.
- **Reprodução:** `getExecution(id).callback_url` traz `...callback?token=SECRETO`.
- **Impacto:** um Viewer pode chamar a `callback_url` pendente com `{"status":"success"}`, o que faz o SmartOne marcar o componente como concluído e **finalizar a GMUD** sem que o deploy tenha ocorrido.
- **Correção:** não devolver `callback_url` nem `callback_body`, ou mascarar o `?token=`. Na listagem isso já é feito.

#### M4. O script enviado pelo SmartOne sobrepõe o script cadastrado no catálogo. Confirmado por teste.
- **Onde:** `deploy/deploy.service.ts:431` (`const script = c.script ?? app.script`).
- **Reprodução:** o cadastro tem `unity.sh` e o payload `script: 'evil.sh'`; o resultado foi a execução de `/opt/digivox/docker-scripts/evil.sh`.
- **Impacto:** fica inconsistente com o `path`, que é validado contra o cadastro (`:428-430`). Qualquer `.sh` do diretório pode ser executado com o token do webhook.
- **Correção:** se o cadastro tiver `script` e o payload trouxer outro, falhar com "script divergente", como já é feito com o path. Só usar o script do payload quando o cadastro não tiver um.

#### M5. Métricas de uso: falhas de login por usuário sempre 0. Confirmado por teste.
- **Onde:**
  - `audit/audit.interceptor.ts:76-87`: no erro, o `metadata` é `{error,status}`, sem `body.email`; `actor_email` também é nulo em `/auth/login`.
  - `usage/usage.service.ts:171-176` e `:249-255`, que dependem de `metadata->'body'->>'email'`.
- **Reprodução (`t_usage.js`, com o `AuditInterceptor` real):** os totais dão `failedLogins=3`, mas `ana.failedLogins=0`, `bia.failedLogins=0` e `userDetail.failedLogins=0`. O teste do kit (`usagetest.js`) inseria um `metadata` com body nas falhas, o que não acontece em produção.
- **Correção:** no ramo `error` do interceptor, gravar também `body: redact(req.body)` (ou `actor_email = req.body?.email` em `auth.login`).

#### M6. Métricas de uso: quebra por dia segue o fuso do banco (UTC no Docker), não o do usuário (BRT). Confirmado por teste.
- **Onde:**
  - `usage/usage.service.ts:74-75,91-92`: `current_date`.
  - `:124,129,215,220`: `AT TIME ZONE current_setting('TimeZone')`.
  - `docker-compose.yml` e `Dockerfile.postgres` não definem TZ, então a imagem fica em UTC.
- **Reprodução:** com `SET TimeZone='UTC'`, uma ação às 22:30 BRT de 05/10 cai em 2026-10-06.
- **Impacto:** das 21h às 24h, tempo, ações e logins vão para o dia seguinte. "Hoje" vira às 21h.
- **Correção:** fixar o fuso de negócio: `(now() AT TIME ZONE 'America/Sao_Paulo')::date` nos INSERTs, `ts AT TIME ZONE 'America/Sao_Paulo'` e `generate_series` sobre essa data. Pode vir de uma env `USAGE_TZ`.

#### M7. Frontend: permissões, ambiente e menu do usuário anterior vazam no logout e login sem recarregar. Análise de código (Aux-F, conferido).
- **Onde:**
  - `components/AppShell.tsx:388-390`: logout com `router.push`.
  - `lib/perms.ts:5-20` e `lib/env.ts:15`: caches de módulo nunca limpos.
  - `lib/api.ts:24-28`: `clearTokens` não remove `lw_env`.
- **Impacto:** o próximo usuário vê o menu e as telas do anterior. O backend ainda barra as chamadas, mas a UI fica errada e confusa.
- **Correção:** em `Auth.logout` e `Auth.login`, chamar `clearPermsCache()`, `clearEnvCache()` e `setActiveEnv(null)`, ou usar `window.location.href='/login'`.

#### M8. Frontend: usuário só do Lab entra com menu vazio no 1º acesso. Análise de código.
- **Onde:** `components/AppShell.tsx:183`, onde `loadMyPermissions()` roda antes do `ensureActiveEnv()` de `EnvironmentSwitcher.tsx:18-25`. Sem header, o backend usa o default (Prod).
- **Impacto:** as permissões ficam cacheadas como vazias até o usuário recarregar a página à mão.
- **Correção:** `await ensureActiveEnv()` antes de `loadMyPermissions()`. Se o slug mudou, limpar o cache e recarregar. Alternativa no backend: sem header, usar o 1º ambiente acessível pelo usuário.

#### M9. Downloads via `fetch` cru não mandam `X-Environment`. Análise de código.
- **Onde:** `frontend/app/exports/page.tsx:40` e `app/captures/page.tsx:331`.
- **Impacto:** a permissão é avaliada no ambiente default. Usuário só do Lab toma 403; quem está no Lab baixa com as permissões de Prod.
- **Correção:** um helper que monte os headers como o `apiFetch`, incluindo `X-Environment`.

#### M10. Canais de notificação: editar um campo apaga os demais segredos. Análise de código (Aux-F).
- **Onde:** `backend/src/notifications/notifications.service.ts:66` (`config = coalesce($3, config)` substitui o objeto inteiro) e `frontend/app/channels/page.tsx:69-72,119`, que manda só os campos preenchidos.
- **Impacto:** editar só o `chatId` do Telegram apaga o `botToken`, e os alertas param.
- **Correção:** `config = config || $3::jsonb` (merge), ignorando chaves vazias.

#### M11. `GET /monitor/endpoints/:id/uptime` sem escopo de ambiente. Confirmado por teste (Aux-M).
- **Onde:** `monitor/monitor.module.ts:90-93` e `monitor.service.ts:219-221`.
- **Correção:** `@ActiveEnvironment()` e `this.get(id, envId)`.

#### M12. Status page pública lista monitores de todos os ambientes. Confirmado por teste (Aux-M).
- **Onde:** `monitor.service.ts:90-100`.
- **Correção:** filtrar por um ambiente configurado (`MONITOR_PUBLIC_ENV`) ou por um flag `public` em cada endpoint.

#### M13. Monitor: corrida entre tick e runNow gera alertas DOWN duplicados e perde incrementos. Confirmado por teste (Aux-M).
- **Onde:** `monitor.service.ts:195-199` e `:290-311`.
- **Correção:**
  - Usar o `inFlight` também no `runNow`.
  - UPDATE atômico: `consecutive_failures = consecutive_failures + 1 ... RETURNING`.
  - Fazer a transição de estado com `WHERE last_status <> 'down'`.

#### M14. Monitor HTTPS não preenche `[CERTIFICATE_EXPIRATION]`. Confirmado por teste (Aux-M).
- **Onde:** `monitor.probers.ts:51-104`.
- **Impacto:** YAMLs do Gatus com essa condição ficam DOWN para sempre.
- **Correção:** capturar o certificado do peer (hook de `connect` no undici) ou fazer um handshake TLS extra quando a condição usar o placeholder.

#### M15. `importYaml` mapeia tipos e durações errado. Confirmado por teste (Aux-M).
- **Onde:** `monitor.service.ts:388-442`.
- **Problemas:**
  - `wss://` e `ssh://` viram http; `starttls://` vira tls.
  - O servidor DNS da URL é descartado.
  - `enabled:false` é ignorado.
  - `1m30s` vira 60 e `500ms` vira 1000.
  - URL vazia é aceita.
- **Correção:** mapear `ws`, `wss`, `ssh` e `starttls`; aceitar durações compostas; respeitar `enabled`; rejeitar target vazio.

#### M16. DSL de condições incompatível com o Gatus e com coerções erradas. Confirmado por teste (Aux-M).
- **Onde:** `monitor.conditions.ts:180-200`.
- **Problemas:**
  - `pat()` e `any()` não existem e sempre dão false.
  - `null`/`""` == 0 dá true.
  - `"false"` vira true.
- **Correção:**
  - Implementar `pat` (glob) e `any`.
  - Exigir que o lado esquerdo seja numérico e não vazio em comparações numéricas.
  - Comparar booleanos por string.
  - Rejeitar funções desconhecidas no DTO.

#### M17. PATCH sem DTO em monitor, cert e deploy (`@Body() patch: any`). Confirmado por teste (Aux-M) e análise (Aux-F).
- **Onde:** `monitor/monitor.module.ts:141-148`, `cert-watch/cert.module.ts:54-61` e `deploy/deploy.module.ts:69-72`.
- **Impacto:**
  - `intervalSeconds: 1` passa no PATCH, embora o POST exija `@Min(10)` (inundação de probes).
  - `environment` ou `serverId` inválidos geram 500 do banco.
  - Em certs, o `serverId` pode ser trocado para outro ambiente (A7).
- **Correção:** DTOs `PartialType(...)` com `@IsUUID` e `@Min`.

#### M18. Certificados: agent offline apaga o inventário e gera alertas duplicados na volta. Confirmado por teste (Aux-M).
- **Onde:** `cert.service.ts:180-204`.
- **Correção:** se o `listDir` da raiz falhar, gravar `last_scan_error` e não apagar nada.

#### M19. Notificações: HTTP 4xx/5xx do destino é reportado como `ok:true`. Confirmado por teste (Aux-M).
- **Onde:** `notifications.service.ts:141-231`.
- **Consequência:** `cert.service.ts:245-255` marca o alerta como enviado mesmo quando a entrega falhou, e aquele vencimento nunca mais é alertado.
- **Correção:**
  - Checar `statusCode >= 400` e consumir o body.
  - `sendToChannelIds` deve retornar os resultados, e o cert só marca o alerta se pelo menos um canal tiver `ok`.

#### M20. A Visão geral chama a rota inexistente `/patroni/cluster`. Confirmado por grep.
- **Onde:** `frontend/app/page.tsx:41`. O backend só tem `patroni/clusters`, `clusters/:id`, `/status` e `/history` (`patroni.controller.ts:52-92`).
- **Impacto:** o card mostra sempre "Patroni não configurado".
- **Correção:** chamar `GET /patroni/clusters` e depois `GET /patroni/clusters/{id}/status`.

#### M21. Permissões do menu não batem com as do backend em telas principais. Análise de código (Aux-F, conferido).
- **`/terminal`** (`AppShell.tsx:91`): exige `terminal:request/open`. Aprovadores com só `terminal:approve`, como o Cloud Admin na migration 004, não conseguem abrir a tela de aprovação, embora o backend aceite `terminal:approve` (`zero-trust.module.ts:55,80-107`).
- **`/docker`** (`AppShell.tsx:68`): exige `docker:control|containers:read`, mas o backend lista com `containers:read`.
- **Correção:** alinhar as listas de `perms` dos itens com as do endpoint principal de cada tela.

#### M22. Telas quebram com permissão parcial. Análise de código (Aux-F).
- **Usuários:** `app/users/page.tsx:74` faz `Promise.all` com `/roles` sem `.catch`. Sem `roles:read`, a tela inteira dá erro.
- **Certificados:** o `GET /servers` (`servers.controller.ts:80-86`) não aceita `cert:*`, `deploy:*` nem `monitor:*`, então o seletor de servidor fica vazio.
- **Terminal:** o mapeamento de logins chama `/users`, que exige `users:read`.
- **Correção:** `.catch(() => [])` na chamada de `/roles` e incluir as chaves que faltam no `@RequirePermission` do `GET /servers`.

### BAIXO

- **B1. Bloqueio "pegajoso".** `users.service.ts:216-225`. `failed_logins` não zera quando `locked_until` expira, então 1 erro depois do desbloqueio re-bloqueia por mais 15 min (teste: `failed_logins=6`, bloqueado). Correção: `CASE WHEN locked_until < now() THEN 1 ELSE failed_logins+1 END`.
- **B2. Enumeração de contas.** `auth/auth.service.ts:38-48`. As respostas "User disabled", "Defina sua senha..." e "Account locked until <data>" saem **antes** da checagem de senha (teste: senha errada em conta desativada dá 403 "User disabled"). Correção: checar a senha primeiro e responder 401 genérico para senha errada.
- **B3. `?limit=abc` dá 500.** Em `deploy.module.ts:93` dá `invalid input syntax for type bigint: "NaN"` (teste); o mesmo acontece em `monitor.module.ts:70`. Correção: `Number.isFinite(n) ? n : 100`.
- **B4. Disparo manual ignora `enabled=false`.** `deploy.service.ts:544-585` (teste: executou `unity.sh` de um cadastro desativado). Correção: `if (!app.enabled) throw BadRequest`.
- **B5. Uso: total diverge da série.** `usage.service.ts:109,132` vs. `:124,127`: o total usa `now() - N dias` (rolante) e a série usa dias de calendário. Teste com `days=1`: `totals.actions=1` e soma da série = 0. Correção: usar o mesmo limite (`ts >= (current_date - (N-1))` no fuso de negócio).
- **B6. Ambiente sem default.** `environments.service.ts:244-261`: `PATCH {isDefault:false}` no default deixa 0 defaults (teste). Correção: recusar, ou exigir que outro seja marcado.
- **B7. Probers, Aux-M (confirmado).**
  - UDP em porta fechada dá UP (`monitor.probers.ts:166`).
  - SSH com linha antes do banner dá DOWN (`:305-309`).
  - Método `post` em minúsculas dá 400 (`:69`).
  - O timeout HTTP não é total, levou 5,6 s com limite de 1 s (`:73-74`).
  - O redact deixa visíveis segredos curtos (`notifications.service.ts:234-241`).
  - Telegram com `parse_mode: Markdown` sem escape (`:204-212`).
  - DNS: `ENODATA` é rotulado como NXDOMAIN (`monitor.probers.ts:222`).
- **B8. Menu com chaves erradas.**
  - `AppShell.tsx:93` usa `capture:approve`, removida na migration 026.
  - `:100` exige `credrot:read`, mas perfis com só `credrot:write` também usam a tela.
  - `:83` exige `logs:download`, enquanto os agendamentos exigem `logs:schedule`.
  - `:105` exige `environments:read`, mas o GET do backend não exige nada.
- **B9. `JWT_REFRESH_EXPIRES` mal interpretado.** `auth.service.ts:138-141`: o valor é tratado como dias, então `12h` vira 12 dias de sessão no banco (análise de código). Correção: usar o `exp` do próprio token (`to_timestamp(exp)`).
- **B10. Callback HTTP 3xx tratado como falha transitória.** `deploy.service.ts:800-811`: é repetido 6 vezes, por cerca de 1 h (teste: `pending`). Correção: tratar 3xx como "recusado", igual aos 4xx.
- **B11. `server_host` errado no disparo manual.** `deploy.service.ts:557`: grava `app.name`, e o detalhe mostra "servidor: <nome da app>".

---

## 3. Observações (não são bug)

- **CD:** todos os 8 cenários do contrato v1.0 se comportam como especificado. As exceções são A6, M3, M4 e B4.
  - Com o cadastro padrão (`envMode=block`), o componente "Unity Integration Server" do cenário 1 (que tem `env_variables_required=true`) é **recusado** na preparação e dá `error` na execução. É uma decisão de projeto documentada, mas no teste conjunto o caminho feliz só funciona com `envMode=script`.
- **Preparação com `componentes: []`:** responde `accepted` ("0 componente(s)"). O contrato diz que a lista nunca vem vazia; seria mais seguro responder `rejected`.
- **Papel legado (`users.role`):** é recalculado sobre **todas** as concessões, então um admin só do Lab recebe `role=admin` no JWT. Hoje não há `@Roles` em uso, então não há impacto, mas qualquer uso futuro de `RolesGuard` herdaria o furo.
- **Access token após logout ou reset:** continua válido até expirar (15 min), porque não há denylist. É aceitável se a expiração for curta.
