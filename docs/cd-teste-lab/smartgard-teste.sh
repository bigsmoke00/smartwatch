#!/bin/sh
# =====================================================================
# Componente de TESTE da integração SmartOne × SmartGard (CD).
# NÃO mexe em nenhuma aplicação: só grava a versão num arquivo e um histórico.
#
# O SmartGard chama:  ./smartgard-teste.sh <versao>
# com as variáveis GMUD_ACTION (deploy|rollback), COMPONENTE, COMPONENTE_ID,
# GMUD_PROTOCOLO, VERSAO e, se a GMUD pedir alteração de config, GMUD_ENV_DESCRIPTION.
#
# Comportamento controlado pela versão (para simular os cenários):
#   ...-fail  ou  ...-erro   -> termina com erro (callback "error")
#   ...-timeout              -> fica parado 15 min (testa o limite de tempo)
#   qualquer outra           -> sucesso em ~5 s
# =====================================================================
set -eu

VERSAO="${1:-}"
ACAO="${GMUD_ACTION:-deploy}"
DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$DIR/versao-atual.txt"
LOG="$DIR/historico.log"

if [ -z "$VERSAO" ]; then
  echo "versão não informada (esperado como 1º argumento)" >&2
  exit 2
fi

ANTERIOR="$(cat "$STATE" 2>/dev/null || echo nenhuma)"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $ACAO ${COMPONENTE:-?} $ANTERIOR -> $VERSAO gmud=${GMUD_PROTOCOLO:-manual}" >> "$LOG"

echo "Ação: $ACAO | componente: ${COMPONENTE:-?} | versão atual: $ANTERIOR -> $VERSAO"
if [ -n "${GMUD_ENV_DESCRIPTION:-}" ]; then
  echo "Alteração de configuração pedida pela GMUD: $GMUD_ENV_DESCRIPTION"
fi

case "$VERSAO" in
  *timeout*)
    echo "simulando pipeline travada..."
    sleep 900
    ;;
esac

sleep 5

case "$VERSAO" in
  *fail*|*erro*)
    echo "falha simulada: health check do componente de teste não respondeu (HTTP 502)" >&2
    exit 1
    ;;
esac

echo "$VERSAO" > "$STATE"
echo "OK: componente de teste agora em $VERSAO"
