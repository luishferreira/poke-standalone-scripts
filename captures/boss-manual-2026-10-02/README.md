# Captura manual de um boss — 2026-10-02

Conta observada: Keita. Chrome, https://poke.idleworld.online/play.
Escopo: exatamente um Giant Cruel, recompensa aceita, cura pela Nurse Joy. Nenhuma implementação de automação foi alterada. Não houve leitura de WebSocket nem envio direto de protocolo; o usuário mantém o tráfego no Caido.

## Fluxo observado

1. Em Cerulean, clicar no botão Bosses do dock: button[data-guide="dock-bosses"].
2. A janela .boss-window abriu com Ancient Aero selecionado. Clicar em button.boss-litem cuja .boss-lname corresponde a Giant Cruel. O item recebeu .on e o título .boss-hname mostrou Giant Cruel. Disponíveis: Ancient Aero e Giant Cruel; demais itens com .soon/Em Breve.
3. Entrada exibida: 1 Bronze Boss Token, estoque 17. Time 6.0/6 no nível. Clicar uma única vez em button.boss-challenge, texto atual "⚔️ Desafiar Boss" (a interface está em português).
4. A localização mudou de Cerulean para Giant Cruel. Estoque passou de 17 para 16. A janela de seleção ainda apareceu na primeira observação após o clique e depois desapareceu quando o combate ficou visível: não tratar fechamento instantâneo como requisito de entrada.
5. Combate: .bhp-panel-main contém .bhp-panel-name, .bhp[role="progressbar"] com aria-valuenow, .bhp-txt e .bhp-panel-pct. Percentuais observados: 90, 77, 51, 21, 7. Pokémon que caíram foram substituídos sem cliques nossos: Rhydon, Tyranitar, Shiny Ditto, Golem e então Charizard ativo.
6. A tela final exibiu a janela .boss-window.bvic-window, título "🏆 Vitória", .bvic-desc "Boss Giant Cruel derrotado!". Loot: 3 Water Stone, 1 Venom Stone e 1 10.000 Carat Emerald. .bvic-chip-qty e .bvic-chip-name identificam quantidade/nome.
7. Antes de clicar no OK, a localização já estava em Cerulean e todo o time já aparecia com HP completo. Isso ocorreu sem ação nossa de saída/cura. A captura visual não determina se essa restauração veio do jogo ou de outra automação já instalada; o Caido pode esclarecer. Não foi observada uma etapa separada de saída obrigatória após a vitória.
8. Clicar uma vez em button.bvic-ok, texto "OK", fechou a janela de vitória. A recompensa já estava exibida antes do clique; esta captura não determina em qual evento o servidor creditou o loot.
9. Abrir a conversa com o NPC que, nesta sessão, correspondeu ao primeiro botão .npc-plate-btn "Conversar". Sua .field-plate estava com left:50% e top:-1.68269%. Esses valores e a posição na lista não são uma identificação estável para futuras sessões. A etiqueta do NPC é desenhada em canvas, sem nome textual no botão.
10. Confirmar que a conversa é .npc-dialog com .npc-dlg-name "Nurse Joy", descrição "Cura todos os Pokémon da sua equipe.". Clicar em button.npc-dlg-btn, texto "💊 Curar equipe".
11. A interface confirmou "💊 Seus Pokémon foram curados!" e o diálogo desapareceu depois. Estado final: Cerulean, Rhydon ativo, seis Pokémon com HP cheio. Nenhum novo boss foi iniciado.

## Estado final

- Rhydon: 16884/16884
- Tyranitar: 15840/15840
- Shiny Ditto: 19860/19860
- Golem: 8592/8592
- Charizard: 12396/12396
- Vileplume: 12564/12564

## Evidências e limites

observations.json guarda HTML dos elementos das etapas e horários UTC. combat.jpg, victory.jpg e healed.jpg registram as telas.
Os cliques foram feitos pela ferramenta do navegador. Não foram instalados listeners para capturar pointerdown/mousedown/mouseup/click, nem foi testada a equivalência de element.click() ou dispatchEvent() em JavaScript. O fluxo e os seletores foram observados; a estratégia de clique do userscript ainda precisa de validação.
A janela de vitória também usa a classe boss-window: futuramente distinguir a seleção da janela .bvic-window. Não procurar o boss no mapa de hunts normais.
Nesta execução não houve derrota do time inteiro, portanto o fluxo visual de derrota não foi capturado. A instrução de pausar após derrota e não iniciar outro boss continua válida.
