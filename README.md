# Poke Standalone Scripts

Userscripts independentes para uso com Tampermonkey no Poke Idle World e no PokeDream.

## Instalação

Com o repositório público, abra o script desejado e confirme a instalação no Tampermonkey:

### Poke Idle World

- [Instalar Auto Catch](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-catch.user.js)
- [Instalar Auto Boss](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-boss.user.js)
- [Instalar Auto Reconnect](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-reconnect.user.js)
- [Instalar Auto Refill](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-refill.user.js)
- [Instalar Auto Pokédex](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-pokedex.user.js)
- [Instalar Hunt Recommender](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/hunt-recommender.user.js)
- [Instalar Calculadora de IVs](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/iv-calculator.user.js)

### PokeDream

Os painéis do Auto Refill podem ser movidos pelo cabeçalho e redimensionados pelo canto inferior direito. Posição e tamanho são salvos por aba, separadamente para Resumo, Configurações e Itens protegidos. Duplo clique no cabeçalho restaura a posição; no canto, restaura o tamanho.

- [Instalar PokeDream Auto Refill](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/pokedream-auto-refill.user.js)

Os scripts verificam atualizações usando esses mesmos endereços. Uma atualização só é reconhecida pelo Tampermonkey quando o campo `@version` do userscript aumenta.

## Uso sem Tampermonkey

Código: [Auto Catch](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-catch.user.js) · [Auto Boss](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-boss.user.js) · [Auto Reconnect](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-reconnect.user.js) · [Auto Refill](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-refill.user.js) · [Auto Pokédex](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-pokedex.user.js) · [Hunt Recommender](https://github.com/luishferreira/poke-standalone-scripts/blob/master/hunt-recommender.user.js) · [Calculadora de IVs](https://github.com/luishferreira/poke-standalone-scripts/blob/master/iv-calculator.user.js) · [PokeDream Auto Refill](https://github.com/luishferreira/poke-standalone-scripts/blob/master/pokedream-auto-refill.user.js)

1. Abra o código desejado e copie todo o arquivo.
2. Abra o jogo e acesse o console do navegador (`F12` → **Console**).
3. Cole o código e pressione `Enter`.

O processo precisa ser repetido após recarregar a página e não possui atualização automática.

## Desenvolvimento e build

Os arquivos em `src/` são as fontes canônicas. Os `.user.js` da raiz são gerados e não devem ser editados manualmente.

```bash
npm run build
npm run verify
npm run extract:pokedream-items
```

O último comando baixa a build oficial atual do PokeDream e regenera `data/pokedream-items.json` com todos os campos observados no catálogo, metadados da build e contagens por categoria.

`npm run build` regenera os userscripts. `npm run verify` confirma que os artefatos estão sincronizados, valida a sintaxe e executa os testes locais sem acessar o jogo.

O repositório fornece um pre-commit hook versionado. Ative-o uma vez em cada clone:

```bash
git config core.hooksPath .githooks
```

Antes de cada commit, ele executa `npm run verify`, exige que fontes e artefatos gerados sejam adicionados juntos e valida o incremento de `@version` dos userscripts alterados. A mesma checagem pode ser executada manualmente com `npm run check:commit`.

O build aceita módulos compartilhados globais ou por userscript em `scripts/userscripts.config.js`. Atualmente os bridges de WebSocket e interface são incorporados aos sete userscripts do Poke Idle World. Cada feature mantém um subscriber persistente para lifecycle/mensagens e envia pelo próprio bridge; a contagem de diagnóstico corresponde à quantidade de features instaladas na aba.

Auto Catch, Auto Reconnect, Auto Boss, Auto Refill, Auto Pokédex, Hunt Recommender e Calculadora de IVs aparecem numa barra lateral compartilhada. Quando o PIW-QOL está instalado, os botões entram na mesma barra lateral dele; sem o PIW-QOL, os próprios scripts criam uma barra visualmente equivalente. A integração é apenas de interface: nenhuma automação depende do QOL para funcionar.

Os painéis podem ser movidos arrastando o cabeçalho. A posição é lembrada somente na aba atual; dê um duplo clique no cabeçalho para voltar à posição original.

O Auto Pokédex inicia pausado e não realiza capturas. Ao ser ativado, cruza a Pokédex da conta com as hunts acessíveis para o nível atual, ordena os alvos pelo menor valor de venda ao NPC e usa os marcadores do mapa do próprio jogo para trocar de hunt sem dessincronizar a tela. Ele permanece em cada hunt até a captura ser confirmada, foi pensado para uso com o autocatch VIP, ignora espécies sem hunt direta e permanece na última hunt ao concluir.

O Hunt Recommender analisa o Pokémon equipado, o nível, o clã e os eventos ativos da conta e calcula as hunts acessíveis de Kanto e Outland. Um checkbox opcional restringe a análise às hunts de nível igual ou menor ao Pokémon equipado. A lista mostra o melhor ataque, golpes por Pokémon, KOs/h, XP/h e se a hunt é letal. O Tipo do Dia é aplicado ao XP/h das hunts correspondentes; VIP e outros multiplicadores de XP da conta não são incluídos. O botão no fim de cada linha permite entrar manualmente na hunt pelo mapa do jogo. Ditto, TMs, Orre e Nightmare ficam fora da primeira versão.

A Calculadora de IVs é somente leitura. Ao abrir ou atualizar o painel, ela carrega os Pokémon atualmente na equipe, seleciona o líder e calcula os seis IVs de 0 a 32 com uma casa decimal, usando nível, quality, atributos atuais e atributos-base da espécie. O seletor permite conferir os demais slots sem fazer novas requests.

O Auto Refill inicia pausado. No painel, escolha potion e ball, configure threshold, quantidade e reserva de gold e então ative. A venda automática de loot comum é opcional e vende itens de NPC dentro da regra indicada na interface, exceto Fresh Herbs (ID 19354) e Wild Herbs (ID 19356); itens com preço NPC zero também ficam fora. Vendas parciais exibem as contagens confirmadas e não são repetidas automaticamente. Falhas de venda não impedem o refill quando há gold confirmado. O catálogo da loja fica em cache na aba após a primeira consulta; o saldo acompanha as mensagens `balls` do jogo e, quando antigo, é atualizado por um `balls-get` no próprio refill.

O PokeDream Auto Refill inicia pausado. Seus defaults são Small Potion com threshold 10, Poké Ball com threshold 20 e compra de 1.000 unidades por produto. O painel mostra um resumo compacto; as configurações só podem ser alteradas com a automação pausada. Os dropdowns permitem escolher qualquer potion e ball compráveis descobertas no catálogo atual; isso controla o estoque reposto, não a configuração de consumo do bot oficial. O botão de itens protegidos fica nas configurações e abre uma janela lateral pesquisável, que pode ser consultada enquanto o refill está ativo, mas não editada. Antes da venda, o script preserva todos os bloqueios oficiais existentes. Os presets expansíveis de Stones e Shiny adicionam seus IDs à lista de proteções futuras e permitem retirar exceções individualmente; aplicar um preset não executa locks. A lista distingue itens já bloqueados no jogo das escolhas futuras do script. A venda só entra na fila depois que o jogo confirma os novos bloqueios. O script descobre dinamicamente o store e o catálogo principal já carregados e usa as mesmas funções e a mesma fila da interface oficial, sem interceptar rede e sem depender do hash da build.

A opção **Retomar após recarregar esta aba** é desligada por padrão e salva a intenção apenas no `sessionStorage` daquela aba. Se o Auto Refill estava ativo, uma recarga aguarda o adaptador e um estado válido do jogo por pelo menos cinco segundos antes de retomar. Pausar cancela essa intenção; abrir uma navegação comum não ativa o script. Se havia uma compra ou venda possivelmente pendente, ele aguarda o estoque envolvido recuperar. Se continuar baixo, reavalia o estado e rearma sozinho após dois minutos desde a tentativa original, respeitando pelo menos 30 segundos de espera após a recarga. A data da tentativa sobrevive a recargas repetidas na mesma aba.

## Observação

Não ative o Auto Reconnect standalone ao mesmo tempo que o auto-reconnect do PIW-QOL.

No painel do Auto Reconnect, a fuga automática do Mega Sableye pode ser ligada ou desligada por aba. Ela permanece ligada por padrão para preservar o comportamento anterior.
