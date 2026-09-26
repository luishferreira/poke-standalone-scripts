'use strict';

module.exports = {
  // Módulos globais são incorporados, nesta ordem, antes de todas as features.
  // Entradas também podem declarar sua própria lista shared para rollout gradual.
  shared: ['src/shared/panel-interaction.js'],
  userscripts: [
    {
      input: 'src/auto-catch.js',
      output: 'auto-catch.user.js',
      shared: ['src/shared/ws-bridge.js', 'src/shared/ui-menu.js'],
    },
    {
      input: 'src/auto-boss.js',
      output: 'auto-boss.user.js',
      shared: ['src/shared/ws-bridge.js', 'src/shared/ui-menu.js'],
    },
    {
      input: 'src/auto-reconnect.js',
      output: 'auto-reconnect.user.js',
      shared: ['src/shared/ws-bridge.js', 'src/shared/ui-menu.js'],
    },
    {
      input: 'src/auto-refill.js',
      output: 'auto-refill.user.js',
      shared: ['src/shared/ws-bridge.js', 'src/shared/ui-menu.js'],
    },
    {
      input: 'src/auto-pokedex.js',
      output: 'auto-pokedex.user.js',
      shared: ['src/shared/ws-bridge.js', 'src/shared/ui-menu.js'],
    },
    {
      input: 'src/hunt-recommender.js',
      output: 'hunt-recommender.user.js',
      shared: ['src/shared/ws-bridge.js', 'src/shared/ui-menu.js'],
    },
    {
      input: 'src/iv-calculator.js',
      output: 'iv-calculator.user.js',
      shared: ['src/shared/ws-bridge.js', 'src/shared/ui-menu.js'],
    },
    {
      input: 'src/pokedream-auto-refill.js',
      output: 'pokedream-auto-refill.user.js',
    },
  ],
};
