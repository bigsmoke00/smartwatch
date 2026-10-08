#!/usr/bin/env bash
# =====================================================================
# Simula o SmartOne chamando o SmartGard de PRODUÇÃO com os componentes de
# teste do Lab. Segue o roteiro do teste conjunto (resposta-smartone, item 5).
#
# Uso:
#   export SMARTONE_WEBHOOK_TOKEN='<token>'                  # nunca coloque o token neste arquivo
#   export CALLBACK_BASE='https://webhook.site/<seu-id>'     # onde ver os callbacks
#   ./simular-smartone.sh [passo]                             # passo: 1..6 ou "todos" (padrão)
#
# Passos:
#   1 test_connection                    -> 2xx, nada executa
#   2 preparar (A, B e um inexistente)   -> callback "rejected" citando o inexistente
#   3 preparar (só A e B)                -> callback "accepted"
#   4 execução: A ok, B com falha        -> callback A "success", B "error"
#   5 rollback parcial só do B           -> callback B "success"
#   6 reenvio do mesmo evento do passo 4 -> 2xx com "duplicados", nada roda de novo
# =====================================================================
set -euo pipefail

URL="${SMARTGARD_URL:-https://smartgard.smartspace.us/api/webhooks/smartone/gmud}"
: "${SMARTONE_WEBHOOK_TOKEN:?defina SMARTONE_WEBHOOK_TOKEN}"
: "${CALLBACK_BASE:?defina CALLBACK_BASE (ex.: https://webhook.site/<id>)}"

# componente_id dos componentes de teste (os mesmos cadastrados em Deploys).
# Quando o SmartOne criar os componentes reais de teste, troque pelos IDs deles.
A_ID="${TESTE_A_ID:-5a1e0000-0000-4000-8000-00000000000a}"
B_ID="${TESTE_B_ID:-5a1e0000-0000-4000-8000-00000000000b}"
DIR="${TESTE_DIR:-/opt/smartgard-teste}"

GMUD_ID="${GMUD_ID:-$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || cat /proc/sys/kernel/random/uuid)}"
PROTO="TESTE-$(date +%Y%m%d%H%M%S)"
RUN="$(date +%s)"            # deixa as callback_url únicas a cada rodada
STATE_FILE="/tmp/simular-smartone-${GMUD_ID}.last"

tok() { echo "${1}-${RUN}"; }
cb()  { echo "${CALLBACK_BASE}/gmud/${GMUD_ID}/${1}?token=$(tok "$2")"; }

post() {
  local desc="$1" body="$2"
  echo
  echo "=== ${desc}"
  curl -sS -w '\n--> HTTP %{http_code} em %{time_total}s\n' -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${SMARTONE_WEBHOOK_TOKEN}" \
    -d "$body"
}

comp() { # comp <id> <nome> <campo_versao> <versao> [callback_url]
  local cbf=""
  [ -n "${5:-}" ] && cbf=", \"callback_url\": \"$5\""
  cat <<JSON
{ "componente_id": "$1", "componente": "$2", "sistema": "SmartGard Teste",
  "path": "$DIR/${2##* }", "script": "smartgard-teste.sh",
  "env_variables_required": false, "env_variables_description": null,
  "$3": "$4"$cbf }
JSON
}

p1() {
  post "1) test_connection" '{"event":"test_connection","integracao_id":"teste","sistema":"SmartGard","enviado_em":"'"$(date -u +%FT%TZ)"'"}'
}

p2() {
  post "2) preparar com componente inexistente (espera rejected)" "{
    \"event\": \"gmud_pipeline_preparar\", \"gmud_id\": \"$GMUD_ID\", \"numero_protocolo\": \"$PROTO\",
    \"titulo\": \"GMUD de teste SmartGard\", \"callback_url\": \"$(cb pipeline/callback prep-rej)\",
    \"componentes\": [ $(comp "$A_ID" "Teste A" versao_alvo 1.0.1), $(comp "$B_ID" "Teste B" versao_alvo 1.0.1-fail),
      { \"componente_id\": \"$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || cat /proc/sys/kernel/random/uuid)\", \"componente\": \"Componente Inexistente\", \"sistema\": \"X\", \"versao_alvo\": \"9.9\" } ]
  }"
}

p3() {
  post "3) preparar só A e B (espera accepted)" "{
    \"event\": \"gmud_pipeline_preparar\", \"gmud_id\": \"$GMUD_ID\", \"numero_protocolo\": \"$PROTO\",
    \"titulo\": \"GMUD de teste SmartGard\", \"callback_url\": \"$(cb pipeline/callback prep-ok)\",
    \"componentes\": [ $(comp "$A_ID" "Teste A" versao_alvo 1.0.1), $(comp "$B_ID" "Teste B" versao_alvo 1.0.1-fail) ]
  }"
}

exec_body() {
  echo "{
    \"event\": \"gmud_execution_started\", \"gmud_id\": \"$GMUD_ID\", \"numero_protocolo\": \"$PROTO\",
    \"integracao\": \"SmartGard\", \"titulo\": \"GMUD de teste SmartGard\",
    \"componentes\": [ $(comp "$A_ID" "Teste A" versao 1.0.1 "$(cb callback exec-a)"),
                       $(comp "$B_ID" "Teste B" versao 1.0.1-fail "$(cb callback exec-b)") ]
  }"
}

p4() { exec_body > "$STATE_FILE"; post "4) execução: A ok, B falha (espera success e error)" "$(cat "$STATE_FILE")"; }

p5() {
  post "5) rollback parcial só do B (espera success)" "{
    \"event\": \"gmud_rollback_started\", \"gmud_id\": \"$GMUD_ID\", \"numero_protocolo\": \"$PROTO\",
    \"integracao\": \"SmartGard\", \"rollback_instrucoes\": \"voltar o componente B\",
    \"componentes\": [ $(comp "$B_ID" "Teste B" versao_anterior 1.0.0 "$(cb callback rb-b)") ]
  }"
}

p6() {
  [ -f "$STATE_FILE" ] || exec_body > "$STATE_FILE"
  post "6) reenvio do mesmo evento de execução (espera duplicados, nada roda)" "$(cat "$STATE_FILE")"
}

case "${1:-todos}" in
  1) p1 ;; 2) p2 ;; 3) p3 ;; 4) p4 ;; 5) p5 ;; 6) p6 ;;
  todos)
    p1; p2; p3
    p4
    echo; echo "... aguardando 25s os deploys de A e B terminarem"; sleep 25
    p5
    sleep 2
    p6
    ;;
  *) echo "passo inválido: $1 (use 1..6 ou todos)"; exit 2 ;;
esac

echo
echo "GMUD de teste: $GMUD_ID ($PROTO)"
echo "Callbacks: ${CALLBACK_BASE}   ·   Execuções: SmartGard → Deploys"
