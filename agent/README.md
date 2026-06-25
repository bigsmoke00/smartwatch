# LogWatch Agent

Processo Node.js/TypeScript que roda em cada host monitorado. Faz duas
coisas bem diferentes:

1. **Telemetria** (envia pro backend via HTTP, em batch): logs de
   containers, logs de arquivos do host (opt-in), métricas de host,
   heartbeat/inventário de containers.
2. **Controle remoto** (canal Socket.IO persistente `/ws/control`, sob
   comando do backend): gerenciamento Docker, terminal web (Zero Trust),
   leitura/escrita/execução de scripts no host, introspecção do host
   (conexões/processos/`journalctl`), captura de rede/SIP.

A versão exibida no heartbeat (`agentVersion`) é lida do `package.json` em
runtime — sempre igual à versão do backend/frontend quando os 3
`package.json` são bumpados juntos (ver `../CHANGELOG.md`).

## Rodar em qualquer servidor monitorado

```bash
docker run -d \
  --name logwatch-agent \
  --restart unless-stopped \
  --pid host \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/host:rw,rslave \
  -e LOGWATCH_BASE_URL=https://logwatch.suainfra.com/api \
  -e LOGWATCH_API_KEY=sk_xxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyy \
  -e LOGWATCH_SERVER_NAME=$(hostname) \
  -e LOGWATCH_HOST_ROOT=/host \
  -e LOGWATCH_ALLOWED_PATHS=/ \
  ghcr.io/seu-org/logwatch-agent:latest
```

`-v /:/host:rw,rslave` é obrigatório para Terminal Web em modo host e Script
Manager navegarem no Linux do host. A UI usa caminhos reais do host
(`/opt`, `/etc`, `/var/log`) e o agent traduz internamente para
`/host/opt`, `/host/etc`, `/host/var/log` via `chroot`.

`--network host` é necessário para a captura de rede/SIP enxergar as
interfaces reais do host (sem isso, `tcpdump` só veria a rede interna do
container do agent).

## O que o agent expõe

### Telemetria (push HTTP, sem o backend precisar pedir)
- **Logs de containers**: descobre containers ao subir, escuta eventos
  `start`/`die` pra anexar/desanexar dinamicamente, demultiplexa
  stdout/stderr, envia em batch com gzip + retry exponencial.
- **Logs de arquivos do host** (`host-logs.ts`, opt-in via
  `LOGWATCH_HOST_LOG_ENABLED=true`): tail incremental de arquivos sob
  `LOGWATCH_HOST_LOG_PATHS`, com detecção de rotação/truncamento. Enviado no
  mesmo formato/endpoint dos logs de container.
- **Métricas de host** (`metrics.ts`, via `systeminformation`): CPU, mem,
  disco, rede, load, uptime — sem depender de `procps` no host.
- **Heartbeat/inventário**: junto com o push de métricas, manda
  `hostname`/`os`/`arch`/`agentVersion` pra popular o cadastro do servidor.

### Controle remoto (canal `/ws/control`, comandado pelo backend)
Implementado em `control.ts`, que despacha por `op` recebido do backend:

| Área | Operações |
|---|---|
| Docker manager | `listContainers`, `inspectContainer`, `startContainer`, `stopContainer`, `restartContainer`, `removeContainer`, `containerLogs`, `containerStats`, `listImages`, `pullImage`, `removeImage`, `listVolumes`, `createVolume`, `removeVolume`, `createContainer` |
| Script Manager (`fs-ops.ts`) | `fs.listDir`, `fs.readFile`, `fs.writeFile`, `fs.execute` — restrito a `LOGWATCH_ALLOWED_PATHS`, com timeout e cap de tamanho de leitura/escrita |
| Terminal Web (`host-shell.ts`) | `term.start`, `term.input`, `term.resize`, `term.close` — sessão de shell real (host via `chroot`/`sudo`, ou exec dentro de um container), sempre sob sessão já aprovada pelo backend |
| Introspecção do host | `host.connections`, `host.processes`, `host.journalctl` |
| Captura de rede/SIP (`capture.ts`) | `capture.run` — roda `tcpdump -w -` com filtro BPF, transmite os pacotes em chunks pelo próprio canal, nunca escreve em arquivo |

O backend correlaciona pedido/resposta por `reqId`; o mesmo canal é
compartilhado por docker-manager, scripts, zero-trust e capture.

## Variáveis de ambiente

| Var | Default | Descrição |
|---|---|---|
| `LOGWATCH_BASE_URL` | `http://backend:4000/api` | URL base do backend (sem `/` no final) |
| `LOGWATCH_API_KEY` | — (obrigatória) | Chave `sk_<8>.<24>` gerada no painel |
| `LOGWATCH_SERVER_NAME` | `unknown` | Nome legível do host |
| `LOGWATCH_HOST_ROOT` | `/host` | Onde o `/` do host foi montado dentro do agent |
| `LOGWATCH_ALLOWED_PATHS` | `/` | CSV de caminhos do host liberados para Script Manager |
| `LOGWATCH_CHROOT_BIN` | `chroot` | Binário usado para shell/scripts no host real |
| `LOGWATCH_BATCH_SIZE` | `200` (cap 500) | Linhas de log por POST |
| `LOGWATCH_FLUSH_INTERVAL_MS` | `2000` | Intervalo entre flushes de logs |
| `LOGWATCH_MAX_BUFFER_ENTRIES` | `5000` | Buffer máximo de logs em memória |
| `LOGWATCH_MAX_LINE_LENGTH` | `4096` (cap 8192) | Tamanho máximo de uma linha de log |
| `LOGWATCH_MAX_LINES_PER_SOURCE_PER_SECOND` | `200` | Rate limit de ingestão por fonte |
| `LOGWATCH_METRICS_INTERVAL_MS` | `15000` | Intervalo de coleta/push de métricas (e heartbeat) |
| `LOGWATCH_EXCLUDE_SELF` | `true` | Não enviar logs do próprio agent |
| `LOGWATCH_HOST_LOG_ENABLED` | `false` | Liga o tail de arquivos de log do host |
| `LOGWATCH_HOST_LOG_PATHS` | `/var/log` | CSV de paths absolutos a vigiar |
| `LOGWATCH_HOST_LOG_POLL_MS` | `2000` | Intervalo de polling do tail |
| `LOGWATCH_HOST_LOG_MAX_LINE` | `4096` (cap 8192) | Tamanho máximo de linha no tail de host |
| `LOGWATCH_MAX_READ` / `LOGWATCH_MAX_WRITE` | `5000000` (5MB) | Cap de leitura/escrita do Script Manager |
| `LOGWATCH_EXEC_TIMEOUT` | `120000` | Timeout de execução de script (ms) |
| `LOGWATCH_MAX_CAPTURE_BYTES` | `52428800` (50MB) | Buffer de catch-up da captura de rede |
| `LOGWATCH_TCPDUMP_PATH` | `tcpdump` | Caminho do binário, se não estiver no `PATH` |

Endpoints específicos podem ser sobrescritos: `LOGWATCH_INGEST_URL`,
`LOGWATCH_METRICS_URL`, `LOGWATCH_HEARTBEAT_URL`.

## Segurança

- Socket Docker em **read-only** (`:ro`) no mount — quem cria/remove
  containers é o agent processando comandos do backend, não acesso direto
  externo ao socket.
- API key validada por bcrypt + IP allowlist no backend.
- TLS recomendado entre agent e backend (`LOGWATCH_BASE_URL=https://...`).
- Nenhum segredo é persistido em disco pelo agent — só em variável de
  ambiente.
- Terminal Web e Script Manager **não decidem sozinhos** o usuário do SO,
  modo (leitura/escrita) ou `sudo`: tudo isso é resolvido e travado pelo
  backend no momento da aprovação, e o agent só executa o que recebe.
- Captura de rede nunca grava em arquivo — nem no agent, nem no backend; é
  só streaming para quem estiver com a tela de captura aberta no momento.

## Distribuição via Ansible

```yaml
- name: LogWatch agent
  hosts: docker_hosts
  become: true
  vars:
    logwatch_base_url: "https://logwatch.suainfra.com/api"
    logwatch_api_key: "{{ vault_logwatch_api_key }}"
  tasks:
    - name: Pull image
      community.docker.docker_image:
        name: ghcr.io/seu-org/logwatch-agent:latest
        source: pull
    - name: Run agent
      community.docker.docker_container:
        name: logwatch-agent
        image: ghcr.io/seu-org/logwatch-agent:latest
        restart_policy: unless-stopped
        pid_mode: host
        network_mode: host
        volumes:
          - /var/run/docker.sock:/var/run/docker.sock:ro
          - /:/host:rw,rslave
        env:
          LOGWATCH_BASE_URL: "{{ logwatch_base_url }}"
          LOGWATCH_API_KEY:  "{{ logwatch_api_key }}"
          LOGWATCH_SERVER_NAME: "{{ inventory_hostname }}"
          LOGWATCH_HOST_ROOT: /host
          LOGWATCH_ALLOWED_PATHS: /
```

> Este playbook é um exemplo de distribuição via Ansible puro — não depende
> de Ansible Semaphore. O LogWatch não tem hoje nenhuma integração com
> Semaphore (não existe módulo `automation/` no backend, apesar de versões
> antigas desta documentação mencionarem isso).
