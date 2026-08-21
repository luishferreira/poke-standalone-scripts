// ==UserScript==
// @name         Auto Boss Farmer PIW
// @version      1.3.0
// @description  Painel para farmar Bosses com HUD, cura entre lutas e parada agendada.
// @author       Luis
// @match        https://poke.idleworld.online/play
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-boss.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-boss.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function installPiwBossFarm() {
    'use strict';

    if (window.piwBossFarm?.installed || window.piwBossFarmInjected) return;

    const bridge = window.piwScripts?.wsBridge;
    if (!bridge || bridge.apiVersion !== 1) {
        console.warn('[PIW Auto Boss] PIW WS Bridge v1 indisponível. Auto Boss não instalado.');
        return;
    }

    window.piwBossFarmInjected = true;

    const STORAGE_KEY = 'piw_boss_farm_v1';
    const TRANSITION_DELAY_MS = 1500;
    const WATCHDOG_SILENCE_MS = 45000;
    const WATCHDOG_CHECK_MS = 5000;

    let state = readState();
    let gameSocket = null;
    let isTransitioning = false;
    let transitionGeneration = 0;
    let transitionTimer = null;
    let lastActivity = Date.now();
    let watchdogTimer = null;
    let interfaceObserver = null;
    let observerTimer = null;
    let unsubscribeBridge = null;

    function blankState() {
        return {
            slug: 'cruel_boss',
            wins: 0,
            losses: 0,
            running: false,
            stopping: false,
            lastMessage: 'Aguardando inicialização...',
            lootHistory: []
        };
    }

    function normalizeCount(value) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
    }

    function readState() {
        try {
            const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
            if (!saved || typeof saved !== 'object') return blankState();
            const slug = typeof saved.slug === 'string' ? saved.slug.trim() : '';
            const lootHistory = Array.isArray(saved.lootHistory)
                ? saved.lootHistory.filter(item => typeof item === 'string').slice(0, 10)
                : [];
            return {
                slug: slug || 'cruel_boss',
                wins: normalizeCount(saved.wins),
                losses: normalizeCount(saved.losses),
                running: false,
                stopping: false,
                lastMessage: typeof saved.lastMessage === 'string'
                    ? saved.lastMessage
                    : 'Aguardando inicialização...',
                lootHistory
            };
        } catch {
            return blankState();
        }
    }

    function saveState() {
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                slug: state.slug,
                wins: state.wins,
                losses: state.losses,
                lastMessage: state.lastMessage,
                lootHistory: state.lootHistory
            }));
        } catch (error) {
            console.warn('[PIW Auto Boss] Não foi possível salvar o estado da aba.', error);
        }
    }

    function getStatus() {
        return {
            running: state.running,
            stopping: state.stopping,
            transitioning: isTransitioning,
            socketOpen: gameSocket?.readyState === WebSocket.OPEN,
            slug: state.slug,
            wins: state.wins,
            losses: state.losses,
            lastActivityAt: lastActivity,
            lootHistory: [...state.lootHistory]
        };
    }

    function clearWatchdog() {
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = null;
    }

    function cancelTransition() {
        transitionGeneration += 1;
        if (transitionTimer) clearTimeout(transitionTimer);
        transitionTimer = null;
        isTransitioning = false;
    }

    function scheduleTransitionStep(generation, callback) {
        transitionTimer = setTimeout(() => {
            transitionTimer = null;
            if (generation !== transitionGeneration) return;
            callback();
        }, TRANSITION_DELAY_MS);
    }

    function pauseFarm(message) {
        clearWatchdog();
        cancelTransition();
        state.running = false;
        state.stopping = false;
        setMessage(message, true);
        saveState();
        renderPanel();
    }

    function startWatchdog() {
        clearWatchdog();
        watchdogTimer = setInterval(() => {
            if (!state.running || isTransitioning) return;
            if (Date.now() - lastActivity <= WATCHDOG_SILENCE_MS) return;
            pauseFarm('⚠️ Boss sem mensagens de batalha por 45 segundos. Automação pausada.');
        }, WATCHDOG_CHECK_MS);
    }

    function adoptSocket(socket) {
        if (!socket || gameSocket === socket) return;
        const replacedActiveSocket = Boolean(gameSocket && (state.running || isTransitioning));
        if (replacedActiveSocket) {
            pauseFarm('⚠️ O WebSocket foi substituído. Automação pausada sem iniciar outro Boss.');
        }
        gameSocket = socket;
        if (!replacedActiveSocket && !state.running && !isTransitioning) {
            setMessage('✅ Conexão capturada! Pronto para iniciar.');
            renderPanel();
        }
    }

    function sendWs(payload) {
        gameSocket = bridge.getSocket();
        if (!gameSocket || !bridge.isOpen()) return false;
        const sent = bridge.sendJson(payload);
        if (!sent) {
            console.warn('[PIW Auto Boss] Falha ao enviar mensagem.', { type: payload?.type });
        }
        return sent;
    }

    function buildLootText(message) {
        if (!Array.isArray(message.bossLoot) || message.bossLoot.length === 0) return 'Sem loot';
        return message.bossLoot.map(item => {
            const quantity = Number.isFinite(Number(item?.qty)) ? Number(item.qty) : 0;
            const name = typeof item?.name === 'string' ? item.name : 'Item desconhecido';
            return `${quantity}x ${name}`;
        }).join(', ');
    }

    function failOutcomeCleanup(message) {
        pauseFarm(`⚠️ ${message} Automação pausada para evitar uma transição incorreta.`);
    }

    function finishOutcome(message) {
        isTransitioning = true;
        const generation = ++transitionGeneration;
        const won = message.bossOutcome === 'won';

        if (won) {
            state.wins += 1;
            const time = new Date().toLocaleTimeString('pt-BR');
            state.lootHistory.unshift(`[${time}] ${buildLootText(message)}`);
            state.lootHistory = state.lootHistory.slice(0, 10);
            setMessage('🏆 Boss derrotado! Saindo para curar o time...');
        } else {
            state.losses += 1;
            setMessage('🔴 Boss finalizado com derrota. Saindo para curar o time...', true);
        }

        saveState();
        renderPanel();
        if (!sendWs({ type: 'leave-hunt' })) {
            failOutcomeCleanup('Não foi possível enviar leave-hunt.');
            return;
        }

        scheduleTransitionStep(generation, () => {
            if (!sendWs({ type: 'joy-heal' })) {
                failOutcomeCleanup('Não foi possível enviar joy-heal.');
                return;
            }
            setMessage('🏥 Time curado. Preparando o próximo passo...');
            saveState();
            renderPanel();

            scheduleTransitionStep(generation, () => {
                isTransitioning = false;
                if (state.running && !state.stopping) {
                    if (!sendWs({ type: 'enter-hunt', slug: state.slug })) {
                        failOutcomeCleanup('Não foi possível reentrar no Boss.');
                        return;
                    }
                    lastActivity = Date.now();
                    setMessage(`⚔️ Nova luta iniciada em: ${state.slug}`);
                } else {
                    state.running = false;
                    state.stopping = false;
                    clearWatchdog();
                    setMessage('🛑 Automação encerrada após sair e curar o time.');
                }
                saveState();
                renderPanel();
            });
        });
    }

    function handleSocketMessage(socket, message) {
        if (socket !== gameSocket || !state.running) return;
        if (message?.type !== 'field') return;
        lastActivity = Date.now();
        if (isTransitioning) return;

        // bossOutcome é a única confirmação de que a luta terminou.
        if (message.bossOutcome) {
            finishOutcome(message);
            return;
        }

        if (!Array.isArray(message.mobs) || message.mobs.length === 0) return;
        const bossMob = message.mobs[0];
        const hp = Number(bossMob?.hp);
        const maxHp = Number(bossMob?.maxHp);
        if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return;
        const percentage = Math.max(0, Math.floor((hp / maxHp) * 100));
        setMessage(
            `⚔️ HP: ${hp.toLocaleString('pt-BR')} / ${maxHp.toLocaleString('pt-BR')} (${percentage}%)`
        );
    }

    function handleSocketClose(socket) {
        if (gameSocket !== socket) return;
        gameSocket = null;
        if (state.running || isTransitioning) {
            pauseFarm('⚠️ WebSocket fechado. Automação pausada sem reentrada automática.');
        } else {
            setMessage('⚠️ WebSocket fechado. Aguardando uma nova conexão.', true);
            renderPanel();
        }
    }

    unsubscribeBridge = bridge.subscribe({
        socket(event) {
            adoptSocket(event.socket);
        },
        open(event) {
            adoptSocket(event.socket);
        },
        close(event) {
            handleSocketClose(event.socket);
        },
        incoming(event) {
            handleSocketMessage(event.socket, event.message);
        }
    });
    adoptSocket(bridge.getSocket());

    function startFarm() {
        if (isTransitioning) {
            setMessage('Aguarde a finalização da cura atual antes de iniciar novamente.', true);
            return false;
        }
        if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) {
            setMessage('Aguarde o WebSocket do jogo conectar antes de iniciar.', true);
            renderPanel();
            return false;
        }

        const slugInput = document.querySelector('#pba-slug');
        const slug = String(slugInput?.value ?? state.slug).trim();
        if (!slug) {
            setMessage('Informe o slug do Boss antes de iniciar.', true);
            renderPanel();
            return false;
        }

        cancelTransition();
        state.slug = slug;
        state.running = true;
        state.stopping = false;
        lastActivity = Date.now();
        if (!sendWs({ type: 'enter-hunt', slug: state.slug })) {
            state.running = false;
            setMessage('Não foi possível enviar enter-hunt. Automação não iniciada.', true);
            saveState();
            renderPanel();
            return false;
        }

        setMessage(`🚀 Farm iniciado em: ${state.slug}`);
        startWatchdog();
        saveState();
        renderPanel();
        return true;
    }

    function stopFarm() {
        if (!state.running && !isTransitioning) return getStatus();
        if (!state.stopping) {
            state.stopping = true;
            setMessage('⏳ Parada agendada para depois de sair e curar o time...');
        } else {
            const cleanupInProgress = isTransitioning;
            state.running = false;
            state.stopping = false;
            clearWatchdog();
            if (cleanupInProgress) {
                setMessage('🛑 Automação interrompida. A cura atual será concluída, sem reentrada.');
            } else {
                cancelTransition();
                setMessage('🛑 Automação interrompida. A luta atual continua no jogo.');
            }
        }
        saveState();
        renderPanel();
        return getStatus();
    }

    function setMessage(message, isError = false) {
        state.lastMessage = String(message || '');
        const statusElement = document.querySelector('#piw-boss-panel .pba-status');
        if (!statusElement) return;
        statusElement.textContent = state.lastMessage;
        statusElement.classList.toggle('error', isError);
    }

    function resetStats() {
        state.wins = 0;
        state.losses = 0;
        state.lootHistory = [];
        saveState();
        renderPanel();
        return getStatus();
    }

    function renderLoot(container) {
        container.replaceChildren();
        if (state.lootHistory.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pba-empty';
            empty.textContent = 'Nenhum loot recente.';
            container.appendChild(empty);
            return;
        }
        for (const entry of state.lootHistory) {
            const row = document.createElement('div');
            row.className = 'pba-loot-row';
            row.textContent = entry;
            container.appendChild(row);
        }
    }

    function renderPanel() {
        const panel = document.querySelector('#piw-boss-panel');
        const dockButton = document.querySelector('#piw-boss-route-button');
        if (dockButton) {
            dockButton.classList.toggle('pba-running', state.running);
            dockButton.title = state.running ? 'Auto Boss Farm ativo' : 'Auto Boss Farm pausado';
        }
        if (!panel) return;

        panel.querySelector('#pba-wins').textContent = String(state.wins);
        panel.querySelector('#pba-losses').textContent = String(state.losses);
        const slugInput = panel.querySelector('#pba-slug');
        slugInput.disabled = state.running || isTransitioning;
        if (slugInput.value !== state.slug) slugInput.value = state.slug;

        const startButton = panel.querySelector('.pba-start');
        startButton.hidden = state.running || isTransitioning;
        const pauseButton = panel.querySelector('.pba-pause');
        pauseButton.hidden = !state.running;
        pauseButton.textContent = state.stopping ? 'Parar Somente Automação' : 'Agendar Parada';
        pauseButton.style.backgroundColor = state.stopping ? '#9b2c2c' : '';
        pauseButton.style.borderColor = state.stopping ? '#742a2a' : '';
        renderLoot(panel.querySelector('.pba-loot'));
    }

    function createPanel() {
        if (!document.body || document.querySelector('#piw-boss-panel')) return;
        const panel = document.createElement('section');
        panel.id = 'piw-boss-panel';
        panel.hidden = true;
        panel.innerHTML = `
            <header><span>☠️ Auto Boss</span><button class="pba-close" type="button">×</button></header>
            <div class="pba-body">
                <div class="pba-input-group">
                    <label for="pba-slug">Slug do Boss:</label>
                    <input type="text" id="pba-slug" />
                </div>
                <div class="pba-summary">
                    <span>🏆 <b id="pba-wins" class="text-green">0</b></span>
                    <span>💀 <b id="pba-losses" class="text-red">0</b></span>
                    <button class="pba-reset" type="button" title="Zerar estatísticas">🔄</button>
                </div>
                <div class="pba-actions">
                    <button class="pba-start primary" type="button">Iniciar Farm</button>
                    <button class="pba-pause warn" type="button" hidden>Agendar Parada</button>
                </div>
                <div class="pba-status"></div>
                <div class="pba-loot-header">Últimos Loots:</div>
                <div class="pba-loot"></div>
            </div>`;
        document.body.appendChild(panel);

        panel.querySelector('.pba-close').addEventListener('click', () => { panel.hidden = true; });
        panel.querySelector('.pba-start').addEventListener('click', startFarm);
        panel.querySelector('.pba-pause').addEventListener('click', stopFarm);
        panel.querySelector('.pba-reset').addEventListener('click', resetStats);
        panel.querySelector('#pba-slug').addEventListener('change', event => {
            if (state.running || isTransitioning) return;
            state.slug = String(event.target.value || '').trim();
            saveState();
            renderPanel();
        });
        panel.querySelector('.pba-status').textContent = state.lastMessage;
        renderPanel();
    }

    function injectDockButton() {
        const dock = document.querySelector('nav.game-dock');
        if (!dock || dock.querySelector('#piw-boss-route-button')) return;
        const button = document.createElement('button');
        button.id = 'piw-boss-route-button';
        button.className = 'dock-btn';
        button.type = 'button';
        button.textContent = '☠️';
        button.title = 'Auto Boss Farm';
        button.addEventListener('click', () => {
            const panel = document.querySelector('#piw-boss-panel');
            if (!panel) return;
            panel.hidden = !panel.hidden;
            if (!panel.hidden) renderPanel();
        });
        dock.appendChild(button);
        renderPanel();
    }

    function installStyles() {
        if (document.querySelector('#piw-boss-route-styles')) return;
        const style = document.createElement('style');
        style.id = 'piw-boss-route-styles';
        style.textContent = `
            #piw-boss-route-button { background:transparent;border:0;box-shadow:none;font-size:16px;position:relative; }
            #piw-boss-route-button::after { content:'';position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:#718096; }
            #piw-boss-route-button.pba-running::after { background:#48bb78;box-shadow:0 0 6px #48bb78; }
            #piw-boss-panel[hidden] { display:none !important; }
            #piw-boss-panel { position:fixed;right:18px;top:140px;z-index:10020;width:300px;display:flex;flex-direction:column;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);overflow:hidden;font:13px/1.35 system-ui,sans-serif; }
            #piw-boss-panel header { display:flex;align-items:center;gap:8px;padding:11px 13px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#f56565; }
            #piw-boss-panel header span { flex:1; }
            #piw-boss-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
            #piw-boss-panel button:hover { border-color:#4aa3c7;background:#1d3748; }
            #piw-boss-panel button:disabled { cursor:not-allowed;opacity:.5; }
            #piw-boss-panel .pba-close { width:29px;height:29px;padding:0;background:#44212a;border-color:#74313d;color:#feb2b2;font-size:19px; }
            #piw-boss-panel .pba-body { padding:11px;overflow:auto;max-height:400px; }
            #piw-boss-panel .pba-input-group { margin-bottom:10px;display:flex;flex-direction:column;gap:4px; }
            #piw-boss-panel .pba-input-group label { font-size:11px;color:#a0aec0;text-transform:uppercase;font-weight:bold; }
            #piw-boss-panel .pba-input-group input { background:#0a1219;border:1px solid #315269;color:#fff;padding:6px 8px;border-radius:6px;font-family:monospace; }
            #piw-boss-panel .pba-summary { display:flex;align-items:center;justify-content:space-around;background:#101f2a;border:1px solid #20394b;border-radius:8px;padding:9px 11px;margin-bottom:8px;font-size:16px; }
            #piw-boss-panel .text-green { color:#48bb78; }
            #piw-boss-panel .text-red { color:#f56565; }
            #piw-boss-panel .pba-reset { padding:2px 6px;font-size:12px;background:transparent;border:1px solid #4a5568; }
            #piw-boss-panel .pba-actions { display:flex;gap:6px; }
            #piw-boss-panel .pba-actions button { flex:1;padding:10px;font-size:14px;transition:background-color .2s; }
            #piw-boss-panel .primary { background:#176342;border-color:#299263; }
            #piw-boss-panel .warn { background:#654b16;border-color:#987024; }
            #piw-boss-panel .pba-status { color:#90cdf4;background:#0a1219;border-radius:6px;padding:7px 9px;margin:7px 0;text-align:center;font-weight:bold; }
            #piw-boss-panel .pba-status.error { color:#feb2b2; }
            #piw-boss-panel .pba-loot-header { font-size:11px;color:#a0aec0;margin-top:10px;margin-bottom:4px;text-transform:uppercase;font-weight:bold; }
            #piw-boss-panel .pba-loot { display:grid;gap:4px; }
            #piw-boss-panel .pba-loot-row { background:#111f29;border-left:3px solid #d6b35c;border-radius:5px;padding:4px 6px;font-size:11px;color:#cbd5e0;word-break:break-word;white-space:normal;line-height:1.4; }
            #piw-boss-panel .pba-empty { color:#718096;text-align:center;padding:7px;font-size:11px; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function initialize() {
        if (!document.body) return;
        installStyles();
        createPanel();
        injectDockButton();
        if (interfaceObserver) return;
        interfaceObserver = new MutationObserver(() => {
            if (observerTimer) return;
            observerTimer = setTimeout(() => {
                observerTimer = null;
                createPanel();
                injectDockButton();
            }, 150);
        });
        interfaceObserver.observe(document.body, { childList: true, subtree: true });
    }

    function uninstall() {
        clearWatchdog();
        cancelTransition();
        state.running = false;
        state.stopping = false;
        saveState();
        unsubscribeBridge?.();
        unsubscribeBridge = null;
        gameSocket = null;
        interfaceObserver?.disconnect();
        interfaceObserver = null;
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = null;
        document.querySelector('#piw-boss-panel')?.remove();
        document.querySelector('#piw-boss-route-button')?.remove();
        document.querySelector('#piw-boss-route-styles')?.remove();
        delete window.piwBossFarm;
        delete window.piwBossFarmInjected;
    }

    window.piwBossFarm = {
        installed: true,
        start: startFarm,
        stop: stopFarm,
        resetStats,
        status: getStatus,
        uninstall
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
