# Poke Standalone Scripts

Userscripts independentes para uso com Tampermonkey no Poke Idle World.

## Instalação

Com o repositório público, abra o script desejado e confirme a instalação no Tampermonkey:

- [Instalar Auto Catch](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-catch.user.js)
- [Instalar Auto Boss](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-boss.user.js)
- [Instalar Auto Reconnect](https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-reconnect.user.js)

Os scripts verificam atualizações usando esses mesmos endereços. Uma atualização só é reconhecida pelo Tampermonkey quando o campo `@version` do userscript aumenta.

> Enquanto o repositório estiver privado, os links públicos de instalação e atualização não funcionarão para o Tampermonkey.

## Desenvolvimento e build

Os arquivos em `src/` são as fontes canônicas. Os `.user.js` da raiz são gerados e não devem ser editados manualmente.

```bash
npm run build
npm run verify
```

`npm run build` regenera os três userscripts. `npm run verify` confirma que os artefatos estão sincronizados, valida a sintaxe e executa os testes locais sem acessar o jogo.

O build aceita módulos compartilhados globais ou por userscript em `scripts/userscripts.config.js`. No rollout canário atual, o WebSocket bridge é incorporado somente ao Auto Catch, mas permanece passivo: a feature ainda usa seus hooks anteriores e não registra subscriber no bridge. Auto Boss e Auto Reconnect continuam sem o módulo.

## Observação

Não ative o Auto Reconnect standalone ao mesmo tempo que o auto-reconnect do PIW-QOL.
