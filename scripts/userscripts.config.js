'use strict';

module.exports = {
  // Módulos globais são incorporados, nesta ordem, antes de todas as features.
  // Entradas também podem declarar sua própria lista shared para rollout gradual.
  shared: [],
  userscripts: [
    {
      input: 'src/auto-catch.js',
      output: 'auto-catch.user.js',
      shared: ['src/shared/ws-bridge.js'],
    },
    {
      input: 'src/auto-boss.js',
      output: 'auto-boss.user.js',
      shared: ['src/shared/ws-bridge.js'],
    },
    {
      input: 'src/auto-reconnect.js',
      output: 'auto-reconnect.user.js',
      shared: ['src/shared/ws-bridge.js'],
    },
    {
      input: 'src/auto-refill.js',
      output: 'auto-refill.user.js',
      shared: ['src/shared/ws-bridge.js'],
    },
  ],
};
