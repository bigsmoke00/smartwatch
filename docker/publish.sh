#!/usr/bin/env bash
# Builda e publica as imagens do SmartGard no Docker Hub (digivoxbr).
#
# Uso (na máquina de build, na raiz do repo):
#   docker login
#   ./docker/publish.sh 1.7            # publica backend e frontend com a tag 1.7 (e latest)
#   ./docker/publish.sh 1.7 agent      # publica também o agent com a tag 1.7
set -euo pipefail

TAG="${1:?informe a tag. Ex.: ./docker/publish.sh 1.7}"
WITH_AGENT="${2:-}"
cd "$(dirname "$0")/.."

# O frontend usa o próprio domínio (/api) por padrão, então a imagem serve para
# qualquer servidor. Só defina NEXT_PUBLIC_API_URL/WS_URL se a API ficar em OUTRO domínio.
[ -f .env ] || touch .env

SERVICES="backend frontend"   # o postgres não vai para o Hub (é buildado no servidor)
[ "$WITH_AGENT" = "agent" ] && SERVICES="$SERVICES agent"
export SMARTGARD_TAG="$TAG" AGENT_TAG="$TAG"

echo ">> build ($TAG): $SERVICES"
docker compose --profile agent build $SERVICES
echo ">> push ($TAG)"
docker compose --profile agent push $SERVICES

# também publica como latest
REG="${SMARTGARD_REGISTRY:-digivoxbr}"
for s in $SERVICES; do
  img="$REG/smartgard-$s"
  docker tag "$img:$TAG" "$img:latest"
  docker push "$img:latest"
done
echo ">> publicado: $(for s in $SERVICES; do printf '%s ' "$REG/smartgard-$s:$TAG"; done)"
