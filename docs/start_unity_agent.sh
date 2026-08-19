#!/bin/bash
# LOGWATCH_HOST_LOG_ENABLED fica false: desde o pivô pra scan sob demanda
# (docs/UNITY_FREESWITCH.md) o tail contínuo de /var/log + unity.log pro
# /ingest ficou obsoleto. Ligado, ele gerava 429 constante (quota/min) e
# sobrecarregava o backend o suficiente pra derrubar o canal de controle
# (/ws/control), o que fazia logscan.run dar timeout. Não reative sem
# reconfirmar com o time — a tela /unity não depende mais dessa fonte.
IMAGE="digivoxbr/smartwatch-agent:latest"
CONTAINER_NAME="smartwatch-agent"
docker rm -f ${CONTAINER_NAME} 2>/dev/null
docker run -d \
  --name ${CONTAINER_NAME} \
  --restart unless-stopped \
  --pid host \
  --network host \
  --cap-add NET_RAW \
  --cap-add NET_ADMIN \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /:/host:rw,rslave \
  --group-add $(stat -c '%g' /var/run/docker.sock) \
  -e LOGWATCH_BASE_URL="https://smartwatch.smartspace.us/api" \
  -e LOGWATCH_API_KEY="sk_xxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyy" \
  -e LOGWATCH_SERVER_NAME="$(hostname -s)" \
  -e LOGWATCH_HOST_ROOT="/host" \
  -e LOGWATCH_MAX_LINES_PER_SOURCE_PER_SECOND=500000 \
  -e LOGWATCH_HOST_LOG_ENABLED=false \
  -e LOGWATCH_ALLOWED_PATHS="/" \
  -e LOGWATCH_MAX_CAPTURE_BYTES=52428800 \
  ${IMAGE}
