# Resposta do SmartGard — Integração SmartOne × SmartGard

_Referente ao documento "Integração SmartOne × SmartGard" v1.0 (24/09/2026) · Resposta de 28/09/2026_

Implementamos o contrato da versão 1.0 como está descrito no documento de vocês. Abaixo estão as informações pedidas na seção 2.2, nossas respostas aos pontos da seção 10 e três pedidos nossos.

---

## 1. Checklist da seção 2.1

| Item | Situação |
|---|---|
| Endpoint único para os eventos (`POST`, tipo no campo `event`) | Implementado |
| Validação do token (`Authorization: Bearer`), `401` se inválido | Implementado |
| `2xx` imediato e processamento em segundo plano | Implementado (respondemos `202` só com o registro do evento) |
| `test_connection` sem executar nada | Implementado |
| `gmud_pipeline_preparar` com callback de aceite | Implementado. Validamos cada componente no nosso catálogo, e a recusa lista o motivo de cada componente com problema |
| `gmud_execution_started` com um callback por componente | Implementado. Os componentes rodam em sequência, na ordem do array |
| `gmud_rollback_started` total ou parcial | Implementado |
| `callback_url` usada exatamente como veio | Implementado |
| Aplicação de variáveis (`env_variables_required`) | Implementado com uma limitação, explicada no item 4.1 |
| Campos desconhecidos são ignorados | Implementado. Eventos desconhecidos também recebem `2xx` e são ignorados |
| Respostas do callback conforme a 7.3 | Implementado: `404` conta como concluído, `400` não é repetido igual, e `500` ou falha de rede entram em reenvio |

## 2. Informações da seção 2.2

| Item | Resposta |
|---|---|
| URL de produção | `https://smartgard.smartspace.us/api/webhooks/smartone/gmud` (confirmada) |
| URL de homologação | **A mesma de produção.** O teste conjunto roda no SmartGard de produção, com componentes de teste dedicados, instalados num servidor do nosso ambiente Lab, que não mexem em nenhuma aplicação real (ver item 5) |
| Token de autenticação | Enviaremos por canal seguro, fora deste documento |
| Tempo por componente | Depende do script de cada componente (em geral, alguns minutos). Tempo máximo: **10 minutos por componente**. Depois disso enviamos `error` por timeout |
| O SmartGard reenvia callbacks que falharam? | **Sim**, só em `5xx` ou falha de rede, com intervalos de 15 s, 1 min, 5 min, 15 min e 30 min (até 6 tentativas, cerca de 50 min no total). `404` encerra como concluído e `400` não é repetido |

## 3. Pontos a combinar (seção 10)

| Ponto | Nossa proposta |
|---|---|
| Timeout do evento | Respondemos em menos de 2 s. Sugerimos que vocês usem 10 s como timeout |
| Retry de eventos | Não é necessário do nosso lado. Se um evento chegar de novo com a mesma `callback_url`, nós o reconhecemos como repetido e **não executamos duas vezes**, então um reenvio manual é seguro |
| Retry de callbacks | Conforme o item 2 |
| Pipeline que nunca retorna | Cada componente tem limite de 10 minutos e, ao estourar, enviamos `error`. Se o SmartGard reiniciar no meio de uma pipeline, enviamos `error` com a mensagem "Execução interrompida", e o operador refaz a ação |
| Recusa na preparação | De acordo que não bloqueie a execução. Se a execução for iniciada mesmo assim, o componente com problema recebe `error` pelo mesmo motivo |

## 4. Pedidos do SmartGard

### 4.1 Variáveis de ambiente estruturadas

Hoje `env_variables_description` é texto livre (por exemplo: "Alterar apigateway.base_url no unity-integration-server.conf de X para Y"). Não conseguimos aplicar isso de forma automática e segura. Enquanto isso não muda, cada componente é configurado no SmartGard de uma de duas formas:

- **O script aplica:** o deploy segue e o script recebe a descrição na variável `GMUD_ENV_DESCRIPTION`.
- **Bloquear:** a preparação é recusada com o motivo, e a execução recebe `error` até a alteração ser feita manualmente.

Para automatizar, propomos um campo opcional nos itens de `componentes`:

```json
"env_variables": [
  { "arquivo": "unity-integration-server.conf", "chave": "apigateway.base_url", "valor": "https://api-omni.smartspace.us/api-gateway/v1" }
]
```

### 4.2 Catálogo de componentes

Como o evento não traz o servidor, cada componente precisa estar cadastrado no SmartGard, associado ao `componente_id` de vocês. Pedimos a lista de componentes ativos com `componente_id`, `sistema`, `componente`, `path` e `script`.

### 4.3 `pipeline_id`

Nossos IDs seguem o formato `SG-XXXXXXXXXX`. É o mesmo valor que aparece na tela de Deploys do SmartGard, o que facilita cruzar os dois lados num atendimento.

## 5. Teste conjunto proposto (seção 11, passo 4)

Pedimos que vocês criem no catálogo do SmartOne **dois componentes de teste** e nos passem os `componente_id`:

| `componente` | `sistema` | `path` | `script` | Versão alvo na GMUD de teste |
|---|---|---|---|---|
| Teste A | SmartGard Teste | `/opt/smartgard-teste/A` | `smartgard-teste.sh` | `1.0.1` (retorna `success`) |
| Teste B | SmartGard Teste | `/opt/smartgard-teste/B` | `smartgard-teste.sh` | `1.0.1-fail` (retorna `error`) |

Nesses componentes, o resultado é controlado pela versão: uma versão que contém `fail` gera `error`, e qualquer outra gera `success`. Para o rollback parcial do Teste B, usem `versao_anterior` = `1.0.0`.

Roteiro:

1. `test_connection`
2. `gmud_pipeline_preparar` com um componente cadastrado e outro não cadastrado (esperado: `rejected` citando o segundo)
3. `gmud_execution_started` com um callback de sucesso e um de erro
4. `gmud_rollback_started` parcial do componente que falhou
5. Reenvio do mesmo `gmud_execution_started` (esperado: `2xx` sem executar de novo)
