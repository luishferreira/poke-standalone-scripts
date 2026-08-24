# Poke Standalone Scripts

Userscripts independentes para uso com Tampermonkey no Poke Idle World e no PokeDream.

## Instalação

Com o repositório público, abra o script desejado e confirme a instalação no Tampermonkey:

### Poke Idle World

- [Instalar Auto Catch](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-catch.user.js)
- [Instalar Auto Boss](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-boss.user.js)
- [Instalar Auto Reconnect](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-reconnect.user.js)
- [Instalar Auto Refill](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-refill.user.js)

### PokeDream

- [Instalar PokeDream Auto Refill](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/pokedream-auto-refill.user.js)

Os scripts verificam atualizações usando esses mesmos endereços. Uma atualização só é reconhecida pelo Tampermonkey quando o campo `@version` do userscript aumenta.

## Uso sem Tampermonkey

Código: [Auto Catch](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-catch.user.js) · [Auto Boss](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-boss.user.js) · [Auto Reconnect](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-reconnect.user.js) · [Auto Refill](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-refill.user.js) · [PokeDream Auto Refill](https://github.com/luishferreira/poke-standalone-scripts/blob/master/pokedream-auto-refill.user.js)

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

O build aceita módulos compartilhados globais ou por userscript em `scripts/userscripts.config.js`. Atualmente o WebSocket bridge é incorporado aos quatro userscripts. Cada feature mantém um subscriber persistente para lifecycle/mensagens e envia pelo próprio bridge; a contagem de diagnóstico corresponde à quantidade de features instaladas na aba.

O Auto Refill inicia pausado. No painel, escolha potion e ball, configure threshold, quantidade e reserva de gold e então ative. A venda automática de loot comum é opcional e vende itens de NPC dentro da regra indicada na interface.

O PokeDream Auto Refill também inicia pausado. Seus defaults são Small Potion com threshold 10, Poké Ball com threshold 20 e compra de 1.000 unidades por produto. Com a automação pausada, os dropdowns permitem escolher qualquer potion e ball compráveis descobertas no catálogo atual; isso controla o estoque reposto, não a configuração de consumo do bot oficial. Antes da venda, o script preserva todos os bloqueios oficiais existentes e permite escolher itens numa janela pesquisável separada. Os presets expansíveis de Stones e Shiny adicionam seus IDs à lista de proteções futuras e permitem retirar exceções individualmente; aplicar um preset não executa locks. A lista distingue itens já bloqueados no jogo das escolhas futuras do script. A venda só entra na fila depois que o jogo confirma os novos bloqueios. O script descobre dinamicamente o store e o catálogo principal já carregados e usa as mesmas funções e a mesma fila da interface oficial, sem interceptar rede e sem depender do hash da build.

## Observação

Não ative o Auto Reconnect standalone ao mesmo tempo que o auto-reconnect do PIW-QOL.

No painel do Auto Reconnect, a fuga automática do Mega Sableye pode ser ligada ou desligada por aba. Ela permanece ligada por padrão para preservar o comportamento anterior.
