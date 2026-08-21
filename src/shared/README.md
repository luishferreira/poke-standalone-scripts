# Módulos compartilhados

Esta pasta é reservada para código-fonte incorporado pelo build em mais de um userscript.

Um módulo entra nos artefatos quando seu caminho é adicionado à lista global `shared` ou à lista `shared` de uma entrada em `scripts/userscripts.config.js`. Atualmente `ws-bridge.js` é incorporado somente ao Auto Catch como canário passivo; Auto Boss e Auto Reconnect não o recebem.

## WebSocket bridge

`ws-bridge.js` instala uma API passiva e versionada em `window.piwScripts.wsBridge`. Seu contrato atual oferece:

- `subscribe(listener)` com eventos `socket`, `replaced`, `open`, `close`, `error`, `incoming`, `outgoing` e `send-error`;
- `getSocket()` e `isOpen()`;
- `send(data)` e `sendJson(payload)`;
- `attach(socket)` para adoção explícita de um socket já existente;
- `status()` para diagnóstico e `uninstall()` para testes/cleanup global.

A instalação não abre conexão nem envia mensagens. Subscribers recebem erros isoladamente e devem executar a função retornada por `subscribe` no próprio cleanup.
