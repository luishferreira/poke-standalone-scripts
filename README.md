# Poke Standalone Scripts

Userscripts independentes para uso com Tampermonkey no Poke Idle World.

## Instalação

Com o repositório público, abra o script desejado e confirme a instalação no Tampermonkey:

- [Instalar Auto Catch](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-catch.user.js)
- [Instalar Auto Boss](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-boss.user.js)
- [Instalar Auto Reconnect](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-reconnect.user.js)

Os scripts verificam atualizações usando esses mesmos endereços. Uma atualização só é reconhecida pelo Tampermonkey quando o campo `@version` do userscript aumenta.

## Uso sem Tampermonkey

Código: [Auto Catch](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-catch.user.js) · [Auto Boss](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-boss.user.js) · [Auto Reconnect](https://github.com/luishferreira/poke-standalone-scripts/blob/master/auto-reconnect.user.js)

1. Abra o código desejado e copie todo o arquivo.
2. Abra o jogo e acesse o console do navegador (`F12` → **Console**).
3. Cole o código e pressione `Enter`.

O processo precisa ser repetido após recarregar a página e não possui atualização automática.

## Desenvolvimento e build

Os arquivos em `src/` são as fontes canônicas. Os `.user.js` da raiz são gerados e não devem ser editados manualmente.

```bash
npm run build
npm run verify
```

`npm run build` regenera os três userscripts. `npm run verify` confirma que os artefatos estão sincronizados, valida a sintaxe e executa os testes locais sem acessar o jogo.

O repositório fornece um pre-commit hook versionado. Ative-o uma vez em cada clone:

```bash
git config core.hooksPath .githooks
```

Antes de cada commit, ele executa `npm run verify`, exige que fontes e artefatos gerados sejam adicionados juntos e valida o incremento de `@version` dos userscripts alterados. A mesma checagem pode ser executada manualmente com `npm run check:commit`.

O build aceita módulos compartilhados globais ou por userscript em `scripts/userscripts.config.js`. Atualmente o WebSocket bridge é incorporado aos três userscripts. Cada feature mantém um subscriber persistente para lifecycle/mensagens e envia pelo próprio bridge; a contagem de diagnóstico corresponde à quantidade de features instaladas na aba.

## Observação

Não ative o Auto Reconnect standalone ao mesmo tempo que o auto-reconnect do PIW-QOL.

No painel do Auto Reconnect, a fuga automática do Mega Sableye pode ser ligada ou desligada por aba. Ela permanece ligada por padrão para preservar o comportamento anterior.
