# LogWatch — Modelo de Segurança

> Pensado para ambientes corporativos com múltiplos servidores em AWS + OCI,
> cluster Patroni e operação via Ansible Semaphore.

## 1. Identidade & Autenticação

| Camada | Implementação |
|---|---|
| Senhas | bcrypt cost 12, requisito mínimo 10 chars |
| JWT | HS256 access (15m) + refresh (7d) com rotação a cada uso |
| Sessões | tabela `sessions` com hash do refresh token; revogação imediata; lista por usuário |
| MFA | TOTP RFC 6238 (otplib) com QR code; obrigatório no login se ativo |
| Brute-force | conta `failed_logins`; lock por 15 min após 5 falhas (`locked_until`) |
| Logout | revoga sessão (idempotente) |

> Em produção: alterne para RS256 com chaves rotacionáveis (KMS) e habilite SSO OIDC.

## 2. Autorização (RBAC com herança)

- `admin` ⊇ `operator` ⊇ `viewer`
- Decorador `@Roles(...)` + `RolesGuard` (com `RANK`)
- Endpoints destrutivos exigem `admin` (delete user/server, gerenciar secrets/cloud sync)
- Endpoints operacionais exigem `operator` (criar servers, regras de alerta, rodar templates Semaphore)
- Endpoints de leitura exigem `viewer`

## 3. API Keys do agent

- Formato: `sk_<8 hex>.<24 base64url>` (~35 chars)
- Apenas o **prefixo** é guardado em claro; o segredo é hash bcrypt cost 10
- **IP allowlist** opcional (array `inet[]`) — bloqueio em validação
- **Scopes** (`ingest`, `metrics`, `inventory`) — extensível
- `last_used_at` atualizado em background; `last_seen_at` do server idem
- Revogação: marca `active=false`

> Recomendação: rotacionar a cada 90d. Use o vault interno para guardar a chave mestra ao distribuir via Ansible.

## 4. Hardening HTTP

- **Helmet** com CSP padrão e `crossOriginResourcePolicy: 'cross-origin'`
- **CORS** restrito a `CORS_ORIGIN` (CSV)
- **Rate limit** global (`@nestjs/throttler`): 30 req/s + 600 req/min
- **Validação rigorosa** com `whitelist + forbidNonWhitelisted` em todos os DTOs
- Body limit recomendado em proxy/nginx (`client_max_body_size 10m`)
- **Compressão** (gzip) em respostas; ingest também aceita `Content-Encoding: gzip`

## 5. Audit log

- Hypertable `audit_events` com retenção 365d
- `AuditInterceptor` global: cada endpoint marcado com `@Audit('action')` grava `{actor, ip, ua, action, target, metadata, result}`
- Redação automática de campos sensíveis (`password`, `secret`, `token`, `apiKey`, `key`)
- Resultado classificado em `ok | denied | error`

## 6. Vault interno (secrets)

- AES-256-GCM com IV de 12 bytes + auth tag (autenticidade garantida)
- Chave master via `SECRETS_MASTER_KEY` (hex 64 chars). **Falhar fechado** em prod se não definida.
- Versionamento (incrementa a cada `set`), auditável via `audit_events`
- Apenas `admin` pode ler/gravar

## 7. Logs estruturados

- **Pino** (nestjs-pino) com redação:
  - `req.headers.authorization`, `req.headers["x-api-key"]`
  - `*.password`, `*.passwordHash`, `*.secret`, `*.totpSecret`
- Formato JSON em prod; pretty em dev
- Endpoint Prometheus em `/api/metrics` para scraping

## 8. PostgreSQL / TimescaleDB

- Conexão via pool dedicado (configurável via `PG_POOL_MAX`)
- Schema com `pgcrypto` (UUIDs), `pg_trgm` (fuzzy), `btree_gin` (composição)
- Sem `synchronize` — schema controlado por migrations idempotentes em `migrations/*.sql`
- Hypertables com **compressão** (após 7d) e **retention** (logs 90d, métricas 180d, audit 365d)
- Para Patroni próprio: use usuário dedicado + `pg_hba.conf` restrito + TLS

## 9. Patroni (read-only)

- Backend só consome `/cluster` e `/history` (GET). Nunca emite POST/PUT.
- Configure `PATRONI_BASIC_AUTH=user:pass` e restrinja source IP no firewall do Patroni.
- Habilite TLS no REST (`patroni.yml: restapi.cafile/certfile/keyfile`).

## 10. Ansible Semaphore

- Tudo passa pela API do Semaphore via token de serviço (`SEMAPHORE_API_TOKEN`)
- O LogWatch **proxia** chamadas e registra `audit_events` com quem disparou e qual template
- O Semaphore mantém seu próprio RBAC e cofre de credenciais — não duplique segredos
- Recomendação: token com escopo de leitura + execução, restrito aos projetos operacionais

## 11. Multi-cloud (AWS + OCI)

- Endpoints `/inventory/cloud/aws/sync` e `/inventory/cloud/oci/sync` exigem `admin`
- Credenciais nunca são logadas (Pino + Audit interceptor redact)
- Para produção: leia as credenciais do **vault interno** (não envie no request) — ajuste o controller para `secrets.get('aws_<account>')`
- Use IAM/Identity Policy mínima (`ec2:DescribeInstances`, `compute.instances.list`, etc.)

## 12. Recomendações em produção

- TLS em **todas** as superfícies
- mTLS opcional entre agent e backend (cert por host, validação no proxy)
- WAF na frente (CloudFront, OCI WAF) com rate limit por IP e geo-blocking se aplicável
- Backup contínuo do Postgres (pgBackRest + S3/OCI Object Storage)
- Replicar o schema do LogWatch para um cluster separado do Patroni operacional
- Monitorar o LogWatch no LogWatch (agent local)
- Rotação anual de `SECRETS_MASTER_KEY` (re-encrypt em background — pode ser script à parte)

## 13. Threat model resumido

| Vetor | Mitigação |
|---|---|
| Vazamento de chave do agent | bcrypt no DB, IP allowlist, revogação, rotação |
| Replay de refresh token | rotação obrigatória + tabela `sessions` com revogação |
| MITM | TLS end-to-end, Helmet HSTS |
| SQL injection | parâmetros nativos do `pg`; sem string interpolation |
| Brute-force login | lock + rate limit |
| Pivot via Semaphore | token de escopo mínimo + audit log |
| Vazamento de credenciais cloud | vault AES-256-GCM + redaction |
| Acesso indevido a Patroni | basic-auth + IP allowlist + TLS |
| XSS no frontend | React com escape default; sem `dangerouslySetInnerHTML` |
| CSRF | API stateless com Bearer JWT (sem cookies) |
