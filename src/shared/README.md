# Módulos compartilhados

Esta pasta é reservada para código-fonte incorporado pelo build em mais de um userscript.

Um módulo entra nos artefatos quando seu caminho é adicionado à lista global `shared` ou à lista `shared` de uma entrada em `scripts/userscripts.config.js`. Atualmente `ws-bridge.js` e `ui-menu.js` são incorporados e consumidos pelos quatro userscripts do Poke Idle World.

## WebSocket bridge

`ws-bridge.js` instala uma API passiva e versionada em `window.piwScripts.wsBridge`. Seu contrato atual oferece:

- `subscribe(listener)` com eventos `socket`, `replaced`, `open`, `close`, `error`, `incoming`, `outgoing` e `send-error`;
- `getSocket()` e `isOpen()`;
- `send(data)` e `sendJson(payload)`;
- `attach(socket)` para adoção explícita de um socket já existente;
- `status()` para diagnóstico e `uninstall()` para testes/cleanup global.

A instalação não abre conexão nem envia mensagens. Subscribers recebem erros isoladamente e devem executar a função retornada por `subscribe` no próprio cleanup.

## Menu lateral compartilhado

`ui-menu.js` instala `window.piwScripts.uiMenu`. Cada feature registra seu botão com `register()` e executa o cleanup retornado no próprio uninstall.

O módulo reutiliza `#script-sidebar` quando o PIW-QOL já o criou. Caso contrário, cria o mesmo contêiner e aplica localmente o visual da barra lateral. Se o QOL carregar depois, ele encontra e reutiliza esse contêiner. O módulo não chama funções internas do QOL, não lê suas configurações e recria somente seus próprios controles quando a SPA remove a sidebar.
