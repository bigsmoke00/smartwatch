# LogWatch Agent v0.2

Container leve em Node.js que faz tudo num só lugar:

- **Logs** de todos os containers do host (via Docker socket)
- **Métricas de host** (CPU, memória, disco, rede, load, uptime, processos)
- **Inventário de containers** (estado, image, ports, labels, health)
- **Heartbeat** com hostname, OS, arch, versão do agent

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

`-v /:/host:rw,rslave` é obrigatório para Terminal Web em modo host e Script Manager navegarem no Linux host. A UI usa caminhos reais do host (`/opt`, `/etc`, `/var/log`), e o agent traduz internamente para `/host/opt`, `/host/etc`, `/host/var/log`.

## Variáveis de ambiente

| Var | Default | Descrição |
|---|---|---|
| `LOGWATCH_BASE_URL` | `http://backend:4000/api` | URL base do backend (sem `/`) |
| `LOGWATCH_API_KEY` | — | Chave `sk_<8>.<24>` gerada no painel |
| `LOGWATCH_SERVER_NAME` | `unknown` | Nome legível do host |
| `LOGWATCH_HOST_ROOT` | `/host` | Onde o `/` do host foi montado dentro do agent |
| `LOGWATCH_ALLOWED_PATHS` | `/` | CSV de caminhos do host liberados para Script Manager |
| `LOGWATCH_BATCH_SIZE` | `200` | Linhas por POST de logs |
| `LOGWATCH_FLUSH_INTERVAL_MS` | `2000` | Intervalo entre flushes de logs |
| `LOGWATCH_METRICS_INTERVAL_MS` | `15000` | Intervalo de coleta de métricas |
| `LOGWATCH_INVENTORY_INTERVAL_MS` | `60000` | Intervalo de sincronização de inventário |
| `LOGWATCH_EXCLUDE_SELF` | `true` | Não enviar logs do próprio agent |

Endpoints específicos podem ser sobrescritos individualmente:
`LOGWATCH_INGEST_URL`, `LOGWATCH_METRICS_URL`, `LOGWATCH_INVENTORY_URL`, `LOGWATCH_HEARTBEAT_URL`.

## Como o agent funciona

- Descobre containers ao subir e escuta eventos `start`/`die` para anexar/desanexar dinamicamente.
- Demultiplexa o stream Docker (stdout/stderr).
- Envia em batch com gzip + retry exponencial (até 6 tentativas, ~30s máx).
- Coleta métricas com `systeminformation` (sem dependência de procps no host).
- Faz heartbeat com `hostname`/`os`/`arch`/`agentVersion` para popular o inventário.

## Segurança

- Socket Docker em **read-only** (`:ro`) — agent não cria/remove containers.
- API key validada por bcrypt + IP allowlist no backend.
- TLS recomendado entre agent e backend (use `LOGWATCH_BASE_URL=https://...`).
- Nenhum segredo é persistido em disco — só em variável de ambiente.

## Distribuição via Ansible

Snippet de playbook para rolar o agent na frota:

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
