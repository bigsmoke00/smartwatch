#!/bin/bash
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
  -e LOGWATCH_API_KEY="sk_03985776.LXcw8idFsvYgb-MdZhJRU2Rbv14Ht0Z8" \
  -e LOGWATCH_SERVER_NAME="$(hostname -s)" \
  -e LOGWATCH_HOST_ROOT="/host" \
  -e LOGWATCH_MAX_LINES_PER_SOURCE_PER_SECOND=500000 \
  -e LOGWATCH_HOST_LOG_ENABLED=true \
  -e LOGWATCH_HOST_LOG_PATHS="/var/log,/opt/digivox/unity/unity-sip-server/var/log/unity/unity.log" \
  -e LOGWATCH_ALLOWED_PATHS="/" \
  -e LOGWATCH_MAX_CAPTURE_BYTES=52428800 \
  ${IMAGE}
