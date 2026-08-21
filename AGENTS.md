# AGENTS.md

## Escopo

Este repositório reúne userscripts Tampermonkey próprios para `https://poke.idleworld.online/play` e mantém o PIW-QOL apenas como referência externa. Os scripts próprios observam e, quando explicitamente ativados, interagem com o WebSocket e as APIs que a própria página do Poke Idle World já utiliza. Também adicionam pequenos painéis sobre uma aplicação web que pode mudar sem aviso.

Estas instruções valem para todo o projeto. Se futuramente existir outro `AGENTS.md` em um subdiretório, ele poderá acrescentar regras específicas daquele escopo.

## Princípio central: não inventar o protocolo do jogo

- O protocolo REST/WebSocket do jogo não é uma API pública ou estável. Não deduza nomes de mensagens, payloads, IDs, unidades ou respostas apenas pela interface.
- Use como fonte de verdade, nesta ordem: captura real fornecida pelo usuário; mensagem observada no navegador; implementação já validada; logs do projeto `poke-manager`; teste baseado em fixture real; hipótese explicitamente confirmada pelo usuário.
- Se faltar informação para implementar uma chamada, peça exatamente a request ou mensagem necessária. Não preencha lacunas por semelhança com outro endpoint.
- IDs como `pendingId`, IDs de Pokémon, listings e solicitações podem ser strings alfanuméricas. Preserve-os como strings opacas; nunca aplique máscara numérica.
- HTTP 200 não implica automaticamente que o efeito esperado ocorreu. Valide apenas conforme o contrato observado e a confirmação que o fluxo realmente necessita.
- Mensagens WebSocket chegam de forma assíncrona e intercalada. Não presuma que a próxima mensagem é a resposta do último envio sem correlacionar tipo, ID e estado atual.

## Inventário atual dos scripts

### `auto-catch.user.js`

- Userscript próprio, namespace `poke-manager`, executado em `document-start`.
- Usa a API v1 de `window.piwScripts.wsBridge`, incorporada antes da feature pelo build. Mantém exatamente um subscriber durante toda a instalação, inclusive quando a automação está pausada.
- A mensagem `pending` mais recente substitui completamente a fila local e é a fonte de verdade dos alvos ainda disponíveis.
- Envia `{ type: 'catch', pendingId, ballId }`, com apenas uma captura em voo.
- Respeita jitter obrigatório de 4,2 a 5,0 segundos entre envios; o mínimo não deve ser reduzido.
- Cada `pendingId` pode ser enviado no máximo uma vez por conexão. O alvo é removido localmente assim que o envio é aceito; resultado, cooldown, indisponibilidade ou timeout apenas liberam a captura em voo, nunca autorizam retry do mesmo ID.
- Distingue shiny pelo booleano observado `pending.list[].shiny`. A bola normal e a bola shiny são configuradas separadamente por aba; os defaults são Ultra Ball 4 e Idle Ball 6, respectivamente.
- `balls` é a fonte de verdade do estoque. O script solicita `balls-get` ao conectar/ativar e não captura com estoque desconhecido ou zerado; não faz fallback automático para outra bola.
- `autohelper` com catch normal ou shiny ativo e `catch-result` com `auto: true` indicam autocatch VIP. Nessa situação a captura manual é bloqueada e a interface alerta o usuário; um resultado automático nunca libera nem contabiliza o `inFlight` manual.
- Pokébolas conhecidas: Poke Ball 1, Great Ball 2, Super Ball 3, Ultra Ball 4 e Idle Ball 6.
- Configuração fica em `piw-auto-catch-settings-v1`; API de diagnóstico/controle fica em `window.piwAutoCatch`.
- O script somente recebe o tráfego normal do socket até o usuário ativar/usar o autocatch. Não adicione requests auxiliares desnecessários.

### `auto-reconnect.user.js`

- Userscript próprio que acompanha a hunt atual pelo `enter-hunt` enviado pelo jogo.
- Usa a API v1 de `window.piwScripts.wsBridge`, incorporada antes da feature pelo build. Mantém exatamente um subscriber durante toda a instalação, inclusive quando o monitoramento está pausado.
- Considera atividade os tipos `field`, `field-init`, `field-kill`, `poke-xp`, `pending` e `catch-result`.
- Após 10 segundos sem mensagem de hunt, envia `leave-hunt`, espera 500 ms e envia `enter-hunt` com o último slug.
- Usa cooldown de 5 segundos para impedir recuperações concorrentes.
- Também pode sair e voltar quando um `field` contém Mega Sableye. Essa fuga é ativada por padrão, pode ser desligada no painel e persiste por aba.
- Pausar preserva o contexto da hunt para que retomar volte a monitorá-la imediatamente. Um `leave-hunt` manual, inclusive durante a pausa, encerra o contexto e limpa o slug salvo; a saída interna de uma recuperação preserva o slug.
- Configuração do slug fica em `piw_hunt_watchdog_v1`; API pública fica em `window.piwHuntWatchdog`.

### `auto-boss.user.js`

- Userscript de boss executado em `document-idle`.
- Usa a API v1 de `window.piwScripts.wsBridge`, incorporada antes da feature pelo build. Mantém exatamente um subscriber durante toda a instalação e adiciona um painel no `nav.game-dock`.
- Entra no slug configurado, acompanha HP, vitórias, derrotas e até dez registros de loot.
- `field.bossOutcome` é a única confirmação de término: `won` é vitória e qualquer outro valor truthy é derrota. `fainted` de Pokémon individuais não encerra a luta e não controla o lifecycle.
- Após qualquer `bossOutcome`, sai, envia `joy-heal` fora da luta e então reentra ou conclui a parada agendada.
- A parada forçada interrompe somente a automação e nunca envia `leave-hunt`; se a limpeza pós-resultado já começou, ela termina a cura mas bloqueia a reentrada.
- O watchdog de 45 segundos atualmente apenas pausa e alerta; não o transforme silenciosamente em recuperação automática.
- Configuração fica em `piw_boss_farm_v1`. O estado `running`/`stopping` é deliberadamente restaurado como falso após reload.

### `auto-refill.user.js`

- Userscript próprio, namespace `poke-manager`, executado em `document-start` e instalado em modo pausado por padrão.
- Usa um subscriber persistente do bridge e confia somente nas mensagens espontâneas `inventory` e `balls`; não adicione polling de estoque.
- Possui configurações independentes de produto, threshold e quantidade para potion e ball. Quantidades aceitas vão de 1 a 10.000 e são divididas sequencialmente em requests de no máximo 1.000.
- Permanece dentro da hunt. Quando ambas as categorias precisam de refill, potion é comprada antes de ball.
- Antes de cada lote, preserva a reserva de gold configurada. Resposta parcial, falta de gold, erro ou confirmação incompleta interrompem os lotes restantes.
- Cada categoria é desarmada antes do ciclo. Depois de uma tentativa, só rearma automaticamente quando o estoque observado sobe acima do threshold; o usuário também pode rearmar manualmente.
- Venda de lixo é opcional e ocorre antes da consulta da loja. A ativação explícita da automação com essa opção marcada autoriza vender toda a quantidade de itens `loot` com `npcPrice` entre 1 e 4.000.
- Usa `GET /api/game/shop`, `POST /api/game/shop/buy`, `POST /api/game/shop/sell`, `/game/items.json` e o refresh autenticado já observado. Nunca registre tokens nem o inventário completo.
- Configuração fica em `piw-auto-refill-settings-v1`; API pública fica em `window.piwAutoRefill`.

### `piw-qol.js` — referência externa somente leitura

- Script grande de terceiros, atualmente PIW-QOL 10.1.0, autor Desjunior/JulianoCLI, com `@updateURL` e `@downloadURL` próprios.
- Não pertence a este projeto e nunca deve ser modificado, formatado, versionado, empacotado ou distribuído por nossos agentes. Trate o arquivo como somente leitura, mesmo quando uma tarefa parece simples.
- Pode ser consultado para entender como a página se comporta, descobrir seletores já conhecidos, observar uma abordagem de UX ou conferir coexistência. Reimplemente apenas o comportamento necessário no código próprio; não transforme o arquivo em fork e não copie blocos extensos.
- Substitui `window.WebSocket` por um wrapper e também intercepta o `send` do WebSocket nativo.
- Mantém snapshots de inventário, Pokémon e família; oferece waiters por evento; faz melhorias de mapa, teleporte, dex, depot, shop, mercado, qualidade/potencial, fontes, chat e Hunt Analyzer.
- Consulta dados oficiais em `/game/creatures.json`, `/game/items.json` e `/api/game/map-markers`.
- Usa a sessão da página para chamadas autenticadas e pode renovar o token por `/api/auth/refresh`. Nunca registre ou exporte esses tokens.
- Possui seu próprio auto-reconnect de hunt: silêncio de 10 segundos, reentrada após 500 ms, cooldown de 5 segundos e reload apenas se o socket permanecer fechado por 45 segundos.

## Conflitos e coexistência

Os quatro scripts próprios podem rodar na mesma página e o usuário também instala o PIW-QOL original. Trate coexistência com essa referência externa como requisito, não como acaso.

### Deve existir um único responsável por cada automação

- `auto-reconnect.user.js` e o auto-reconnect do `piw-qol.js` não devem ficar ativos ao mesmo tempo. Ambos usam limiares equivalentes e podem enviar sequências duplicadas de `leave-hunt`/`enter-hunt`.
- Antes de criar uma feature nova, pesquise se o PIW-QOL ou outro script já faz a mesma coisa. Como o PIW-QOL é intocável, resolva sobreposição somente no script próprio: deixe uma implementação desativável, detecte conflito com segurança quando possível ou explique qual opção o usuário deve desligar.
- `auto-boss` controla entrada/saída de hunt por conta própria. Um watchdog externo não deve interpretar suas transições planejadas como travamento.
- Autocatch manual e autocatch VIP server-side são modos distintos. Não ative o manual automaticamente quando o jogo já estiver capturando server-side; o usuário deve escolher conscientemente.

### Interceptação do WebSocket deve ser cooperativa

- O PIW-QOL ainda mantém hooks próprios no WebSocket; a ordem de carregamento do Tampermonkey pode mudar o encadeamento. Os quatro scripts próprios usam exclusivamente o bridge.
- Ao manter os arquivos atuais, capture a implementação anterior, encaminhe com o mesmo `this` e `arguments`, e nunca engula um envio do jogo sem decisão explícita da feature.
- Não faça `WebSocket.prototype.send = originalSend` no uninstall se outro script instalou um wrapper depois do seu. Só restaure quando o valor atual ainda for exatamente o wrapper daquele módulo.
- Não use uma variável global genérica nova como `window.myGameSocket`. Use namespace do projeto, por exemplo `window.piwScripts`, e mantenha aliases legados apenas para compatibilidade documentada.
- Anexe listeners uma vez por instância com `WeakSet`. Ao trocar de socket, invalide fila, estado em voo e referências do socket antigo.
- Um `close` não significa necessariamente logout. O próprio jogo pode reconectar; diferencie socket fechado temporariamente, silêncio da hunt e reload completo.
- Chamadas internas que precisam contornar observação de saída devem usar deliberadamente a função nativa capturada. Chamadas que devem atualizar o estado compartilhado devem passar pelo bridge normal. Documente a escolha.

`src/shared/ws-bridge.js` implementa isoladamente a API v1 em `window.piwScripts.wsBridge`, responsável por:

- detectar sockets do jogo;
- publicar mensagens recebidas e enviadas para subscribers;
- fornecer `send(payload)` seguro;
- informar open/close e troca de socket;
- deduplicar listeners;
- permitir cleanup por feature.

O bridge por si só é passivo: instalar não abre conexão nem envia mensagens. Ele encadeia o construtor e o `send` encontrados, aceita wrapper externo antes ou depois, isola erros de subscribers e ignora mensagens do socket substituído. Atualmente é incorporado aos quatro userscripts; todos usam `subscribe` para lifecycle/mensagens e `sendJson` para seus envios, sem hooks próprios. Uma feature nunca deve chamar `bridge.uninstall()`; seu cleanup remove somente o próprio subscriber.

## Estado e persistência no navegador

- Os scripts próprios usam `sessionStorage` para manter preferências e histórico isolados por aba. Não volte a usar `localStorage` para slug, bola, contadores ou qualquer estado associado à conta aberta, pois ele é compartilhado por todas as abas da mesma origem.
- Estado transitório — socket, timer, promise, `inFlight`, `transitioning`, `running` — deve ficar em memória e começar em modo seguro após reload.
- Só persista preferências e histórico que realmente precisem sobreviver. Use chaves únicas, versionadas e prefixadas (`piw-...-vN`).
- Mudança do formato salvo exige migração tolerante. Leitura inválida deve voltar ao default, nunca impedir o userscript de iniciar.
- Limite coleções persistidas e em memória. Históricos precisam de tamanho máximo; Maps e Sets de deduplicação precisam ser podados.
- O PIW-QOL usa IndexedDB para arquivos de fonte e muitas chaves `script_*_v1`; consulte suas chaves somente para evitar colisão. Nunca as migre, apague ou renomeie a partir deste projeto.

## Timers, performance e lifecycle

- Um contador de UI atualizado a cada segundo é aceitável e não causa crescimento de RAM sozinho. O risco real são intervals duplicados, observers recriados, listeners acumulados e históricos ilimitados.
- Todo `setInterval`, timeout recorrente, `MutationObserver` e listener global deve ter ownership claro e cleanup idempotente.
- Observers de `document.body`/`documentElement` devem apenas agendar uma inspeção curta e deduplicada. Mantenha debounce/throttle; nunca percorra o DOM inteiro em cada mutation.
- Atualize texto/atributos somente quando o valor mudou. Evite substituir grandes blocos de `innerHTML` em loops de um segundo.
- Timers que disparam chamadas ao jogo precisam de trava de concorrência e cooldown marcados antes do primeiro `await`.
- Quando a aba estiver oculta, não invente comportamento novo. Entenda primeiro se timers throttled pelo navegador afetam a feature e se mensagens WS continuam suficientes.
- Reload, navegação SPA e reinjeção do Tampermonkey devem ser idempotentes. Use uma flag global própria e IDs DOM únicos.

## Interface e DOM do jogo

- O jogo é uma SPA e recria partes do DOM. Inserções precisam ser idempotentes e capazes de reaparecer após rerender.
- O dock observado atualmente é `nav.game-dock`. Trate seletores do jogo como frágeis; tenha fallback seguro e falhe sem quebrar a página.
- IDs e classes injetados devem usar prefixo exclusivo da feature (`pac-`, `phw-`, `pba-`, `piw-...`). Não estilize tags/classes genéricas do jogo sem escopo.
- Prefira `textContent` para texto vindo do jogo. Se for necessário construir HTML, passe nomes/loot/mensagens por uma função de escape; dados do servidor não são HTML confiável.
- Use botões `type="button"`, labels claros, estado ativado/desativado visível e mensagens de erro que indiquem se falta socket, slug ou permissão.
- Não deixe um painel fechado continuar executando uma ação que o usuário razoavelmente entenderia como pausada, salvo quando isso estiver explicitamente indicado.
- Preserve acessibilidade básica: `title`, foco, contraste, áreas clicáveis e uso por teclado.

## Chamadas REST e credenciais

- Com `@grant none`, o código roda no contexto da página e usa a autenticação da sessão do jogo. Isso aumenta o impacto de qualquer chamada incorreta.
- Não envie dados, tokens, inventário ou identidade da conta para domínios externos. Recursos públicos atualmente conhecidos devem permanecer restritos ao domínio oficial do jogo, salvo autorização explícita.
- Não copie cookies, `Authorization`, `cf_clearance` ou tokens para o código-fonte.
- O helper do PIW-QOL lê `sessionStorage['pokeweb:tokens']` e tenta `/api/auth/refresh`. Isso é apenas referência de comportamento; se um script próprio precisar de REST autenticado, confirme o fluxo atual e implemente-o fora do PIW-QOL, lidando com 401/403 sem loop de refresh.
- Operações de venda, compra, lock, depot e mercado são destrutivas. Exija confirmação na UI e nunca as use como “teste” de integração.
- Requests de inventário/Pokémon devem reutilizar snapshots quando forem apenas exibição, mas buscar um snapshot fresco antes de uma operação destrutiva quando o fluxo permitir.
- Evite polling de APIs. Prefira mensagens que o jogo já recebe normalmente, refresh manual ou cache com invalidação explícita.
- Auto Refill autentica chamadas same-origin com `sessionStorage['pokeweb:tokens']`, tenta exatamente um refresh em 401 e valida o gold retornado pela loja e por cada lote antes de continuar.

## Contratos WebSocket conhecidos

Só use estes contratos conforme já observados; ainda valide mudanças futuras com tráfego real.

- Hunt: `{ type: 'enter-hunt', slug }` e `{ type: 'leave-hunt' }`.
- Cura usada pelo boss: `{ type: 'joy-heal' }`.
- Inventário: envio `inv-get`, resposta `inventory` com `items`.
- Pokémon: envio `pokes-get`, resposta `pokes` com `list`.
- Família: envio `family-get`, resposta `family`.
- Catch manual: `{ type: 'catch', pendingId, ballId }`.
- `pending.list` substitui a fila capturável anterior.
- Catch pode produzir `catch-result`, `catch-cooldown`, erro de indisponibilidade e, no sucesso, `poke-delta` em mensagem separada.
- Catch VIP server-side usa `catch-result` com `auto: true`; no sucesso também chega `poke-delta`.
- Atividade de hunt inclui `field`, `field-init`, `field-kill`, `poke-xp`, `pending` e `catch-result`.
- Boss usa dados observados em `field.fainted`, `field.bossOutcome`, `field.bossLoot` e `field.mobs`.
- Refill usa `inventory.items` para o estoque da potion selecionada e `balls.counts` para o estoque da ball selecionada.

Eventos frequentes como `pending`, `field`, `field-kill` e `poke-xp` servem para estado local. Não responda a todos com uma nova request.

## Build e estrutura do projeto

Os arquivos canônicos ficam em `src`; os quatro `.user.js` da raiz são artefatos gerados e instaláveis:

```text
src/
  shared/                 # reservado para módulos incorporados no build
  auto-catch.js
  auto-reconnect.js
  auto-boss.js
  auto-refill.js
scripts/
  userscripts.config.js
  build-userscripts.js
auto-catch.user.js        # gerado
auto-reconnect.user.js    # gerado
auto-boss.user.js         # gerado
auto-refill.user.js       # gerado
test/
```

Regras do build:

- Edite somente a fonte correspondente em `src` e incremente ali o `@version`; nunca corrija diretamente um `.user.js` gerado.
- Execute `npm run build` para regenerar os quatro artefatos. O output é determinístico e não contém timestamp.
- `npm run build:check` não escreve arquivos e falha quando um artefato está ausente ou difere da fonte.
- Módulos da lista global `shared` são incorporados antes de todas as features; cada entrada também pode declarar sua própria lista para rollout gradual. O bridge está nas entradas dos quatro userscripts.
- O arquivo entregue ao Tampermonkey deve continuar sendo um único userscript autocontido; não introduza `@require` nem outro userscript obrigatório.
- O bloco `// ==UserScript==` deve ser o primeiro conteúdo do artefato e preservar `@name`, `@namespace`, `@match`, `@grant` e `@run-at` corretos.
- Não introduza framework/bundler pesado sem necessidade. O build atual usa somente módulos nativos do Node.js.
- Mantenha `piw-qol.js` fora de `src`, build, lint com autofix e qualquer comando de formatação.
- Features compartilhadas devem depender de interfaces pequenas (`socketBridge`, `storage`, `domHost`, `clock`) para permitir testes sem a página real.

## Convenções de código

- Siga o estilo da fonte própria ao fazer correção localizada. `src/auto-catch.js` usa 2 espaços; `src/auto-boss.js` e `src/auto-reconnect.js` têm trechos em 4 espaços. Não faça correções localizadas no PIW-QOL.
- Para módulos novos do projeto: 2 espaços, aspas simples, ponto e vírgula, `camelCase` para funções/variáveis, `PascalCase` para classes e `UPPER_SNAKE_CASE` para constantes.
- Use IIFE e `'use strict'` no bundle final.
- Prefira funções pequenas e puras para parse, seleção de alvo, cálculo de delay e decisão de recovery. Isole DOM e I/O nas bordas.
- Normalize valores numéricos nas fronteiras, mas não normalize IDs opacos.
- Não deixe `catch {}` silencioso em operações relevantes. Storage/parse tolerante pode cair no default; envio, compra, venda e recuperação precisam de diagnóstico.
- Não duplique propriedades em object literals. Defaults devem aparecer uma vez e ser sobrescritos de forma explícita.
- Comentários devem explicar invariantes e motivos, não repetir a linha seguinte.
- Sempre incremente `@version` quando alterar um userscript distribuível. Use uma convenção consistente para os scripts próprios.

## Testes e validação

O projeto possui build sem dependências e testes com o runner nativo do Node.js. O PIW-QOL não faz parte da matriz de build ou validação.

A validação completa após qualquer mudança é:

```bash
npm run build
npm run verify
```

O hook versionado em `.githooks/pre-commit` executa `scripts/pre-commit-check.js`. Ele deve permanecer sem ações de rede, não faz build nem staging automaticamente e recusa fonte/output relevante parcialmente adicionado ou mudança distribuível sem incremento de `@version`. Ative-o no clone com `git config core.hooksPath .githooks`.

Os comandos direcionados continuam disponíveis:

```bash
node scripts/build-userscripts.js --check
node --check auto-catch.user.js
node --test test/auto-catch.test.js
node --test test/auto-boss.test.js
```

Ao adicionar testes:

- Use um `FakeWebSocket` que registre envios e permita emitir `open`, `message` e `close`.
- Use relógio falso para jitter, timeout, watchdog, cooldown e sequências leave/enter.
- Teste ordem de instalação diferente dos hooks, troca de socket e uninstall.
- Teste `pending` substituindo a fila, uma captura em voo, timeout, cooldown e alvo indisponível.
- Teste silêncio de hunt, saída manual, slug ausente, socket fechado, recovery concorrente e Mega Sableye.
- Teste DOM ausente, dock recriado e reinjeção dupla.
- Teste storage inválido e migração entre versões.
- Use fixtures pequenas e anonimizadas baseadas em mensagens reais. Nunca inclua tokens, cookies ou dados de conta.

Validação manual no navegador deve ser progressiva:

1. Instale em uma aba de teste e confirme ausência de exceções no console.
2. Verifique que o jogo conecta e funciona normalmente com a feature desativada.
3. Confirme painel, rerender do dock, reload e persistência.
4. Observe frames recebidos sem enviar ações novas.
5. Só teste envio real após autorização explícita, com uma conta e uma ação reversível/limitada.
6. Teste coexistência com os demais scripts nas ordens de instalação relevantes.

Nunca teste compra, venda, transferência, liberação, catch, troca de hunt ou boss real apenas para verificar se um botão está conectado.

## Fluxo de desenvolvimento para agentes

1. Leia o arquivo próprio inteiro envolvido, pesquise a mesma responsabilidade nos outros scripts próprios e consulte o PIW-QOL somente como referência de coexistência/comportamento.
2. Identifique metadata, globals, storage keys, hooks, timers, observers, seletores e mensagens afetadas.
3. Declare qual script será a fonte única da feature e como coexistirá com os demais.
4. Se o protocolo não estiver comprovado, peça a captura exata antes de implementar.
5. Faça o menor diff possível e confirme que `piw-qol.js` não aparece no diff, no output do build nem como alvo de autofix.
6. Extraia lógica pura quando isso trouxer teste real; não modularize só para aumentar o número de arquivos.
7. Rode syntax check e testes direcionados. Depois valide o bundle final, não apenas os módulos-fonte.
8. Revise timers/listeners sem cleanup, globals genéricos, storage compartilhado entre abas, HTML não escapado e calls duplicadas.
9. No handoff, informe scripts alterados, versão, testes, validação manual e quais ações reais não foram executadas.

## Checklist de revisão

- O payload foi observado, sem campos inventados?
- Existe apenas um responsável por autocatch, reconnect ou boss?
- A instalação funciona independentemente da ordem dos outros userscripts?
- Um socket novo invalida corretamente o estado do anterior?
- Há no máximo uma ação em voo e uma recovery em andamento?
- Jitter, cooldown e limites mínimos foram preservados?
- A feature desativada permanece passiva?
- Timers, observers e listeners são únicos e têm cleanup?
- Histórico/Map/Set têm limite de crescimento?
- Todo estado associado à conta aberta continua isolado por aba em `sessionStorage`?
- Dados do jogo são escapados antes de entrar em `innerHTML`?
- Nenhum token/cookie/proxy foi incluído ou logado?
- Metadata e versão do userscript estão corretos?
- O artefato final passa em syntax check e continua instalável no Tampermonkey?
