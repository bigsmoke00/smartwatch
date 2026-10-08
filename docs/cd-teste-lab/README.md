# Teste da integração SmartOne × SmartGard — produção + componentes de teste no Lab

O teste roda no **SmartGard de produção**, mas os componentes vivem num **servidor do ambiente Lab** e executam o script `smartgard-teste.sh`. Esse script não mexe em nenhuma aplicação: ele só grava a versão num arquivo e registra um histórico. Assim, a URL de homologação para o SmartOne passa a ser a mesma URL de produção.

| Componente de teste | `componente_id` (enquanto o SmartOne não criar os deles) | Diretório no servidor Lab |
|---|---|---|
| Teste A | `5a1e0000-0000-4000-8000-00000000000a` | `/opt/smartgard-teste/A` |
| Teste B | `5a1e0000-0000-4000-8000-00000000000b` | `/opt/smartgard-teste/B` |

O comportamento depende da versão enviada. Uma versão que contém `fail` ou `erro` gera callback `error`, e uma que contém `timeout` fica parada por 15 minutos. Qualquer outra versão dá `success` em cerca de 5 segundos.

## 1. Preparar o servidor Lab

1. Escolha um servidor do ambiente **Lab** com agent online.
2. Crie os diretórios e copie o script:
   ```bash
   sudo mkdir -p /opt/smartgard-teste/A /opt/smartgard-teste/B
   sudo cp smartgard-teste.sh /opt/smartgard-teste/A/
   sudo cp smartgard-teste.sh /opt/smartgard-teste/B/
   sudo chmod +x /opt/smartgard-teste/*/smartgard-teste.sh
   ```
   Se esquecer o `chmod`, o SmartGard executa o script com `bash` do mesmo jeito.
3. No agent desse servidor, confira duas variáveis e reinicie o agent:
   - `LOGWATCH_ALLOWED_PATHS` precisa incluir `/opt/smartgard-teste`.
   - `LOGWATCH_EXEC_TIMEOUT=660000` (o padrão de 120 s corta pipelines longas).

## 2. Cadastrar em Deploys (SmartGard)

Primeiro troque o seletor do topo para **Lab**, porque a lista de servidores do formulário mostra só o ambiente ativo. Depois, em **Deploys → Nova aplicação**, cadastre os dois componentes:

| Campo | Teste A | Teste B |
|---|---|---|
| Nome | `Teste A · LAB` | `Teste B · LAB` |
| Sistema | `SmartGard Teste` | `SmartGard Teste` |
| Componente | `Teste A` | `Teste B` |
| Ambiente | `lab` | `lab` |
| Servidor | o servidor Lab do passo 1 | o mesmo |
| Diretório | `/opt/smartgard-teste/A` | `/opt/smartgard-teste/B` |
| componente_id | `5a1e0000-0000-4000-8000-00000000000a` | `5a1e0000-0000-4000-8000-00000000000b` |
| Script padrão | `smartgard-teste.sh` | `smartgard-teste.sh` |
| Configuração exigida | O script aplica | O script aplica |

Opcional: dispare um deploy manual (botão **Disparar**, versão `1.0.0`) em cada componente para confirmar agent, diretório e permissão antes de tudo.

## 3. Ensaio sozinho (sem o SmartOne)

Rode da sua máquina. Os callbacks vão para um endereço do webhook.site, onde você vê exatamente o que o SmartOne receberia.

```bash
export SMARTONE_WEBHOOK_TOKEN='<o token>'                # não salve o token em arquivo do repo
export CALLBACK_BASE='https://webhook.site/<seu-id>'
./simular-smartone.sh            # roda os 6 passos
./simular-smartone.sh 4          # ou um passo só
```

Resultado esperado no webhook.site: `prep-rej` = `rejected`, `prep-ok` = `accepted`, `exec-a` = `success`, `exec-b` = `error` e `rb-b` = `success`. O passo 6, que reenvia a mesma execução, não gera callback novo. Em **Deploys → Execuções** aparecem todos os passos com o log do script.

Esse roteiro foi executado localmente contra o `DeployService` real, com Postgres e o script de verdade, e todos os resultados bateram.

## 4. Teste conjunto com o SmartOne

1. Pedir ao SmartOne que crie, no catálogo deles, dois componentes de teste com `sistema` = `SmartGard Teste`, `path` = `/opt/smartgard-teste/A` ou `/B` e `script` = `smartgard-teste.sh`.
2. Quando eles passarem os `componente_id` reais, **trocar o componente_id** nos dois cadastros em Deploys.
3. Eles cadastram a URL de produção e o token (enviado por canal seguro) e montam uma GMUD de teste com versão alvo `1.0.1` para o A e `1.0.1-fail` para o B.
4. Roteiro: testar conexão → aprovar a GMUD → iniciar a execução (A `success`, B `error`) → rollback parcial do B para `1.0.0`.

## 5. Depois do teste

Os cadastros de teste podem ficar, porque não atrapalham nada. Para remover, apague os dois cadastros em Deploys e a pasta `/opt/smartgard-teste` do servidor Lab.
