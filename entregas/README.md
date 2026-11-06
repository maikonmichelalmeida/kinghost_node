# Entregas Unifarma

Node 22 / MySQL InnoDB, API autenticada `/api/entregas`, interface móvel no `www` da KingHost. O frontend não contém chaves Google. Use HTTPS.

## Atendimento

As contas independentes Maikon e unifarma usam senhas scrypt e tokens revogáveis de 30 dias. O servidor abre pelo botão ou no horário agendado e encerra novos chamados às 20h30 de Brasília. Pedidos já registrados continuam disponíveis. O aceite ocorre automaticamente quando o atendimento está aberto; visualizar, informar previsão, iniciar, marcar entregas e concluir são ações separadas. Só uma rodada pode estar em execução.

A farmácia confirma endereços progressivamente e informa o preço de cada entrega. Uma pausa de digitação dispara sugestões, no máximo quatro consultas por edição do endereço. A confirmação resolve o número e calcula separadamente o trajeto da farmácia ao destinatário. Preço sugerido: até 4 km R$7, até 7 km R$10, até 10 km R$15; acima, duas vezes a distância de ida em km, arredondada para baixo ao múltiplo de R$5. A farmácia sempre pode editar. Se faltar cota, pode informar endereço e preço manualmente. Endereço escrito não é exibido como confirmado pelo Google.

O servidor salva a rodada e seus preços antes de qualquer otimização. Um ID de envio impede criar dois pedidos com o mesmo conteúdo. O saldo soma os valores não cancelados do dia de criação (Brasília). O histórico exibe cada entrega em uma linha, inclusive quando várias foram enviadas juntas. O arquivo diário é preenchido a partir de 23h55 ou recuperado no próximo início; baixas posteriores atualizam o registro. SSE autenticado avisa as páginas abertas após alterações; atualização periódica e retorno à página cobrem reconexões e proxies. Não há alerta de sistema nem alarme.

## Rotas e navegação

Sem prioridade, a base é origem e destino. Com prioridade, o primeiro destino é fixo: otimiza-se o trecho da primeira entrega até a base passando pelas demais. Como o trecho da base à primeira entrega é fixo, ele não altera a escolha da sequência. Com menos de dois destinos livres, não há chamada de otimização. A consulta independente de distância para sugerir o preço ainda pode ocorrer.

Usa somente Routes v2 `computeRoutes`, `DRIVE`, `TRAFFIC_AWARE`, field mask explícita e, quando há escolha, `optimizeWaypointOrder`. Não usa Route Matrix. Acima da capacidade de 25 intermediários, divide em trechos com âncoras e otimiza cada trecho; a solução particionada não garante a melhor ordem global. Quando faltam coordenadas, a divisão pode seguir a ordem de entrada. Um erro deixa o pedido registrado, com rota pendente e opção explícita de calcular novamente.

Links oficiais de Directions omitem **sempre** a origem. Têm até três waypoints mais destino, no máximo 2.000 caracteres, preservam todas as entregas na ordem do servidor e terminam na casa apenas no último link. Depois da baixa, o painel mostra o trecho que falta. O Maps escolhe as ruas usando a localização atual; a sequência enviada não é recalculada pelo aplicativo. O botão de prioridade aparece com dois ou mais endereços e libera a confirmação depois de três segundos.

## Configuração

1. Manter MySQL e contas em `config.local.env` e `entregas/accounts.local.json`, fora do Git, permissão 600. `npm run setup:entregas` cria tabelas `delivery_*` sem redefinir contas existentes.
2. Usar um projeto de uso exclusivo. Habilitar Routes API, Places API (New), Geocoding API e Cloud Monitoring API. Não alterar cotas oficiais nem faturamento. Restringir cada chave à sua API e ao IP de saída confirmado da hospedagem. Configurar `GOOGLE_ROUTES_API_KEY`, `GOOGLE_PLACES_API_KEY`, `GOOGLE_GEOCODING_API_KEY` **somente** no Node.
3. A conta de serviço destinada à conferência de consumo requer somente leitura das métricas (`roles/monitoring.viewer`) no projeto. `GOOGLE_MONITORING_CREDENTIALS` aponta para JSON privado fora dos dois repositórios e da raiz web, modo 600; `GOOGLE_CLOUD_PROJECT=maikontech`. Reiniciar o PM2 e verificar a data da última leitura antes de usar as consultas externas.
4. O endereço de base já configurado é preservado. Sem coordenadas anteriores, usa o endereço informado da farmácia. Maikon pode confirmar outro ponto em Ajustes.

## Proteção financeira

Cada chamada é reservada numa transação antes da requisição HTTP, sob lock do monitor em InnoDB. A operação registra SKU, assinatura, data e instante. Uma operação concorrente, incerta ou expirada não é repetida automaticamente. Um timeout consome reserva. Respostas para repetição da mesma operação são temporárias; a manutenção remove o conteúdo após a janela de 15 minutos. O contador permanece após reinício. Seleções de endereço são privadas por usuário e expiram em 24 horas. O histórico da operação conserva valores, horários e endereços; não depende de uma nova consulta Google.

Routes: teto local 20/minuto, 100/dia e 2.000/mês, limitado ainda a 70% da franquia de referência. Sugestões, detalhes e geocoding têm orçamentos próprios (ver `google-policy.js`). O teto diário é calculado sobre saldo restante do mês, dias até a virada e consumo anterior ao dia atual. O aplicativo suspende sugestões antes de esgotar detalhes/rotas; ao esgotar o serviço essencial, resta entrada escrita com preço manual. A data de trabalho é Brasília; janelas de cota usam Pacífico.

O monitor lê os contadores do projeto aproximadamente a cada seis horas, excluindo a última hora para absorver atraso. A primeira conferência incorpora o consumo anterior em vez de zerá-lo. Ausência de configuração, dados gravemente divergentes ou mais de 48 horas sem sucesso impedem chamadas. A decisão por chamada usa o banco, não uma consulta síncrona ao Google. Limites do Node não abrangem outras aplicações, outras chaves ou outros projetos que compartilhem a conta de faturamento. Franquias e SKUs devem ser revisados em mudanças de preços.

## Verificação e implantação

`npm run test:entregas`: preços, agenda, prioridade, ordenação retornada, navegação de 1 a 51 entregas, trechos e política adaptativa. `TEST_DB_HOST=mysql.maikontech.com.br TEST_DB_PORT=3306 npm run test:entregas` inclui integração HTTP e MySQL reais, com prefixo aleatório dedicado e respostas Google simuladas. Testa corrida de envio, limites sob concorrência, reinicialização do gerenciador, incerteza e preservação de pedido sem rota. Não usa chaves reais.

Validar frontend e backend na branch de desenvolvimento antes de integrar `main`. O BAT único `atualiza_git.bat` publica o backend antes do frontend, aplica a migração e reinicia PM2. Nunca versionar chaves, contas ou JSON de monitoramento.
