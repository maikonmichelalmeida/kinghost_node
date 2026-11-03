# Entregas Unifarma

Interface na raiz de `www`, arquivos em `www/entregas`. API independente em `/api/entregas/*`, integrada ao `main.js`. Node 22 e MySQL/InnoDB.

## Primeira configuração

1. Configurar `config.local.env` com as credenciais do MySQL. O host validado é `mysql.maikontech.com.br`.
2. Executar `npm run setup:entregas`. Cria somente tabelas com prefixo `delivery_`, sem alterar os dados dos demais projetos.
3. O arquivo **ignorado pelo Git** `entregas/accounts.local.json` contém os hashes scrypt das contas iniciais Maikon e unifarma. A inicialização usa INSERT IGNORE, sem redefinir senhas existentes. O BAT transfere esse arquivo via SCP, com permissão 600.
4. Abrir o site por HTTPS válido. No painel Maikon → Ajustes, cadastrar a chave do plano Free do Geoapify e confirmar no mapa a entrada da farmácia/casa. Nenhuma coordenada aproximada é assumida como endereço exato.
5. Abrir atendimento ou agendar a próxima abertura. A farmácia pode então montar o pacote.

## Regras

- Sessões opacas de 30 dias em localStorage; o banco armazena apenas SHA-256 do token. Logout revoga a sessão. Senhas em scrypt com salt individual. Cada endpoint verifica o perfil.
- Disponibilidade persistida no banco. Fechamento diário às 20h30, horário America/Sao_Paulo. Agendamento é aplicado pelo servidor a cada minuto e também ao consultar o estado. Não depende de manter o navegador aberto.
- Atendimento aberto aceita automaticamente novos pacotes na fila. “Visualizei” é confirmação separada. Apenas um pacote pode estar em execução. Encomendas tornam-se aceitas na abertura; não são iniciadas automaticamente.
- A farmácia confirma de 1 a 5 pontos e informa número, complemento e observação. Apenas endereço e coordenadas seguem para Geoapify; observações não são enviadas.
- Preço sugerido por distância de ida da base até cada destinatário: até 4 km R$7; até 7 km R$10; até 10 km R$15; acima disso, 2 × quilômetros, arredondado ao múltiplo inferior de R$5. A farmácia pode editar cada preço entre R$0 e R$1.000. Sugestão e valor final ficam no histórico.
- Uma matriz de tempos/distâncias no modo carro, com tráfego aproximado, alimenta a comparação das até 120 ordens no próprio servidor. Sempre considera o retorno. Prioridade opcional fixa a primeira parada.
- Cotação expira em 15 minutos. O envio é idempotente pelo ID da cotação. Valores finais da farmácia são validados em centavos, sem aceitar totais fornecidos pelo cliente.
- Google Maps recebe coordenadas confirmadas. Link conservador: até 3 paradas intermediárias e um destino; pacotes maiores continuam pelo botão da próxima entrega. Retorno separado quando necessário. A ordem é preservada, mas o Google pode escolher ruas diferentes do provedor.
- Histórico em `delivery_history`, com cópia às 23h55 e recuperação automática ao reiniciar. Pedidos antigos em andamento continuam visíveis e atualizam a cópia arquivada. Não há exclusão de histórico na virada. Total diário considera pedidos criados naquele dia, excluindo cancelados.
- Atualização a cada 12 segundos enquanto a página está visível. Notificações com alarme estão fora desta versão.

## Geoapify

Chave fica em `config.local.env`, nunca no navegador. Busca acionada pelo botão Buscar; tiles passam pela API autenticada. Créditos reservados em banco antes de cada chamada, com limite conservador de 2.500/dia em UTC. Tiles têm cache em memória; chamadas externas são serializadas abaixo de 5/s. Quotas reservadas não são estornadas em falhas. Usar projeto exclusivo para que o contador reflita o consumo do app. Os limites locais não contabilizam uso da mesma chave fora deste sistema.

## Testes

`npm run test:entregas` testa preços, retorno, prioridade, horário e agenda. A integração usa um conjunto temporário de tabelas com prefixo aleatório e remove apenas essas tabelas ao terminar:

```sh
TEST_DB_HOST=mysql.maikontech.com.br TEST_DB_PORT=3306 npm run test:entregas
```

Credenciais do teste são lidas de `config.local.env`. O teste de integração substitui apenas as respostas Geoapify; banco, transações e servidor HTTP são reais. Sem TEST_DB_PORT, ele é pulado.

## Publicação

O BAT único na pasta `site` permite publicar frontend, backend ou ambos. A opção 3 publica o backend antes do frontend. Configuração SSH está no início do arquivo; o BAT menor foi absorvido. Configurações e chaves não são enviadas ao Git. O deploy preserva alterações remotas em stash, instala pelo lockfile, aplica a migração e reinicia o PM2.

Requer certificado HTTPS válido do domínio configurado na KingHost. A chave Geoapify e a confirmação da base são necessárias para testar buscas e trajetos reais.
