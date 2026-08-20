// ==UserScript==
// @name         Auto Boss Farmer PIW
// @version      1.0.4
// @description  Painel de interface para farmar Bosses com reconexão automática, HUD de HP e Parada Agendada.
// @author       Gemini
// @match        https://poke.idleworld.online/play
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Previne injeção dupla
    if (window.piwBossFarmInjected) return;
    window.piwBossFarmInjected = true;

    const STORAGE_KEY = 'piw_boss_farm_v1';
    
    let state = readState();
    let isTransitioning = false;
    let lastActivity = Date.now();
    let watchdogTimer = null;

    // ==========================================
    // ESTADO E PERSISTÊNCIA
    // ==========================================
    function blankState() {
        return {
            slug: 'cruel_boss',
            wins: 0,
            losses: 0,
            running: false,
            stopping: false, // NOVO: Flag de parada agendada
            lastMessage: 'Aguardando inicialização...',
            lootHistory: []
        };
    }

    function readState() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (!saved) return blankState();
            // Sempre inicia totalmente pausado, mesmo se fechou a aba agendando
            return { ...blankState(), ...saved, running: false, stopping: false }; 
        } catch {
            return blankState();
        }
    }

    function saveState() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    // ==========================================
    // LÓGICA DO JOGO E WEBSOCKET
    // ==========================================
    function handleSocketMessage(event) {
        // Se não estiver rodando, ignora tudo
        if (!state.running) return;

        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        // Qualquer pacote recebido significa que a conexão está viva (Watchdog)
        lastActivity = Date.now();

        if (isTransitioning) return;

        // 1. Time Morreu (Auto-Cura)
        if (msg.type === 'field' && msg.fainted) {
            isTransitioning = true;
            setMessage("💀 Time desmaiou! Indo ao Centro Pokémon...", true);
            
            sendWs({ type: 'leave-hunt' });
            
            setTimeout(() => {
                sendWs({ type: 'joy-heal' });
                
                setTimeout(() => {
                    // Verifica se o usuário pediu para parar
                    if (state.running && !state.stopping) {
                        setMessage("🏥 Curado! Reentrando no Boss...");
                        sendWs({ type: 'enter-hunt', slug: state.slug });
                    } else if (state.stopping) {
                        state.running = false;
                        state.stopping = false;
                        setMessage("🛑 Parada concluída. Time foi curado.");
                        saveState();
                        renderPanel();
                    }
                    isTransitioning = false;
                }, 1500);
            }, 1500);
            return;
        }

        // 2. Boss Finalizado
        if (msg.type === 'field' && msg.bossOutcome) {
            isTransitioning = true;
            
            if (msg.bossOutcome === 'won') {
                state.wins++;
                let lootStr = 'Sem loot';
                if (msg.bossLoot && msg.bossLoot.length > 0) {
                    lootStr = msg.bossLoot.map(l => `${l.qty}x ${l.name}`).join(', ');
                }
                
                // Adiciona ao topo do histórico (máx 10 itens)
                const hora = new Date().toLocaleTimeString('pt-BR');
                state.lootHistory.unshift(`[${hora}] ${lootStr}`);
                if (state.lootHistory.length > 10) state.lootHistory.pop();
                
                setMessage(`🏆 Boss Derrotado! Coletando e saindo...`);
            } else {
                state.losses++;
                setMessage(`🔴 Boss Falhou! Saindo...`, true);
            }

            saveState();
            renderPanel();

            // Sai da sala
            sendWs({ type: 'leave-hunt' });
            
            // Coreografia de Reentrada ou Parada
            setTimeout(() => {
                if (state.running && !state.stopping) {
                    sendWs({ type: 'enter-hunt', slug: state.slug });
                } else if (state.stopping) {
                    state.running = false;
                    state.stopping = false;
                    setMessage("🛑 Parada concluída após finalizar a luta.");
                    saveState();
                    renderPanel();
                }
                isTransitioning = false;
            }, 1500);
            return;
        }

        // 3. HUD: Atualizar a vida do Boss em Tempo Real
        if (msg.type === 'field' && !msg.bossOutcome && msg.mobs && msg.mobs.length > 0) {
            const bossMob = msg.mobs[0];
            if (bossMob && bossMob.maxHp > 0) {
                const hpAtual = bossMob.hp.toLocaleString('pt-BR');
                const hpMax = bossMob.maxHp.toLocaleString('pt-BR');
                const porcentagem = Math.max(0, Math.floor((bossMob.hp / bossMob.maxHp) * 100));
                
                if (!isTransitioning) {
                    setMessage(`⚔️ HP: ${hpAtual} / ${hpMax} (${porcentagem}%)`);
                }
            }
        }
    }

    // Interceptação Nativa do WebSocket
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
        if (!window.myGameSocket && this.url && this.url.includes('/ws')) {
            window.myGameSocket = this;
            this.addEventListener('message', handleSocketMessage);
            console.log("🔌 [Bot] Conexão WebSocket interceptada com sucesso!");
            setMessage('✅ Conexão capturada! Pronto para iniciar.');
        }
        return originalSend.apply(this, arguments);
    };

    function sendWs(payload) {
        if (window.myGameSocket && window.myGameSocket.readyState === 1) {
            originalSend.call(window.myGameSocket, JSON.stringify(payload));
        }
    }

    // ==========================================
    // CONTROLES DE INTERFACE E ROTINA
    // ==========================================
    function startFarm() {
        if (!window.myGameSocket) {
            setMessage('Aguarde o jogo conectar ou dê 1 passo no mapa para capturar a conexão!', true);
            return;
        }
        
        const slugInput = document.querySelector('#pba-slug');
        if (slugInput) state.slug = slugInput.value.trim();

        state.running = true;
        state.stopping = false; // Garante que inicia sem intenção de parar
        isTransitioning = false;
        lastActivity = Date.now();
        setMessage(`🚀 Iniciando farm em: ${state.slug}`);
        saveState();
        renderPanel();

        // Entra na sala
        sendWs({ type: 'enter-hunt', slug: state.slug });

        // Inicia Watchdog Apenas de Alerta (Não Reseta a Sala)
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = setInterval(() => {
            if (!state.running || isTransitioning) return;
            
            // Se passar de 45 segundos em silêncio, trava o script e avisa
            if (Date.now() - lastActivity > 45000) {
                setMessage("⚠️ Jogo travou! Farm pausado para evitar gastos indevidos.", true);
                state.running = false;
                state.stopping = false;
                saveState();
                renderPanel();
            }
        }, 5000);
    }

    function stopFarm() {
        if (!state.stopping) {
            // Primeiro Clique: Agenda a parada
            state.stopping = true;
            setMessage('⏳ Parada agendada para o fim da luta atual...');
        } else {
            // Segundo Clique: Força a parada imediata
            state.running = false;
            state.stopping = false;
            if (watchdogTimer) clearInterval(watchdogTimer);
            setMessage('🛑 Parada forçada imediata efetuada.');
        }
        saveState();
        renderPanel();
    }

    function setMessage(msg, isError = false) {
        state.lastMessage = msg;
        const statusEl = document.querySelector('#piw-boss-panel .pba-status');
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.classList.toggle('error', isError);
        }
    }

    function resetStats() {
        state.wins = 0;
        state.losses = 0;
        state.lootHistory = [];
        saveState();
        renderPanel();
    }

    // ==========================================
    // RENDERIZAÇÃO DA INTERFACE (HTML/CSS)
    // ==========================================
    function renderPanel() {
        const panel = document.querySelector('#piw-boss-panel');
        if (!panel) return;

        panel.querySelector('#pba-wins').textContent = state.wins;
        panel.querySelector('#pba-losses').textContent = state.losses;
        
        panel.querySelector('.pba-start').hidden = state.running;
        
        // Lógica do botão de pausa
        const pauseBtn = panel.querySelector('.pba-pause');
        pauseBtn.hidden = !state.running;
        pauseBtn.textContent = state.stopping ? "Forçar Parada" : "Agendar Parada";
        
        // Muda a cor do botão se estiver agendado para parar (vermelho mais agressivo)
        if (state.stopping) {
            pauseBtn.style.backgroundColor = '#9b2c2c';
            pauseBtn.style.borderColor = '#742a2a';
        } else {
            pauseBtn.style.backgroundColor = '';
            pauseBtn.style.borderColor = '';
        }

        const lootContainer = panel.querySelector('.pba-loot');
        lootContainer.innerHTML = state.lootHistory.length > 0 
            ? state.lootHistory.map(l => `<div class="pba-loot-row">${l}</div>`).join('')
            : '<div class="pba-empty">Nenhum loot recente.</div>';
    }

    function createPanel() {
        if (document.querySelector('#piw-boss-panel')) return;

        const panel = document.createElement('section');
        panel.id = 'piw-boss-panel';
        panel.hidden = true;
        panel.innerHTML = `
            <header><span>☠️ Auto Boss</span><button class="pba-close" type="button">×</button></header>
            <div class="pba-body">
                <div class="pba-input-group">
                    <label>Slug do Boss:</label>
                    <input type="text" id="pba-slug" value="${state.slug}" ${state.running ? 'disabled' : ''} />
                </div>
                
                <div class="pba-summary">
                    <span>🏆 <b id="pba-wins" class="text-green">${state.wins}</b></span>
                    <span>💀 <b id="pba-losses" class="text-red">${state.losses}</b></span>
                    <button class="pba-reset" type="button" title="Zerar Status">🔄</button>
                </div>

                <div class="pba-actions">
                    <button class="pba-start primary" type="button">Iniciar Farm</button>
                    <button class="pba-pause warn" type="button" hidden>Agendar Parada</button>
                </div>
                
                <div class="pba-status">${state.lastMessage}</div>
                
                <div class="pba-loot-header">Últimos Loots:</div>
                <div class="pba-loot"></div>
            </div>`;
        document.body.appendChild(panel);

        // Event Listeners
        panel.querySelector('.pba-close').addEventListener('click', () => { panel.hidden = true; });
        panel.querySelector('.pba-start').addEventListener('click', startFarm);
        panel.querySelector('.pba-pause').addEventListener('click', stopFarm);
        panel.querySelector('.pba-reset').addEventListener('click', resetStats);
        
        // Atualiza o estado quando digita no input
        panel.querySelector('#pba-slug').addEventListener('change', (e) => {
            state.slug = e.target.value.trim();
            saveState();
        });

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
            panel.hidden = !panel.hidden;
            if (!panel.hidden) renderPanel();
        });

        dock.appendChild(button);
    }

    function installStyles() {
        if (document.querySelector('#piw-boss-route-styles')) return;
        const style = document.createElement('style');
        style.id = 'piw-boss-route-styles';
        style.textContent = `
            #piw-boss-route-button { background:transparent;border:0;box-shadow:none;font-size:16px; }
            #piw-boss-panel[hidden] { display:none !important; }
            #piw-boss-panel { position:fixed;right:18px;top:140px;z-index:10020;width:300px;display:flex;flex-direction:column;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);overflow:hidden;font:13px/1.35 system-ui,sans-serif; }
            #piw-boss-panel header { display:flex;align-items:center;gap:8px;padding:11px 13px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#f56565; }
            #piw-boss-panel header span { flex:1; }
            #piw-boss-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
            #piw-boss-panel button:hover { border-color:#4aa3c7;background:#1d3748; }
            #piw-boss-panel .pba-close { width:29px;height:29px;padding:0;background:#44212a;border-color:#74313d;color:#feb2b2;font-size:19px; }
            #piw-boss-panel .pba-body { padding:11px;overflow:auto; max-height: 400px; }
            
            #piw-boss-panel .pba-input-group { margin-bottom: 10px; display:flex; flex-direction:column; gap:4px; }
            #piw-boss-panel .pba-input-group label { font-size: 11px; color:#a0aec0; text-transform: uppercase; font-weight: bold; }
            #piw-boss-panel .pba-input-group input { background:#0a1219; border:1px solid #315269; color:#fff; padding:6px 8px; border-radius:6px; font-family:monospace; }
            
            #piw-boss-panel .pba-summary { display:flex;align-items:center;justify-content:space-around;background:#101f2a;border:1px solid #20394b;border-radius:8px;padding:9px 11px;margin-bottom:8px; font-size: 16px; }
            #piw-boss-panel .text-green { color:#48bb78; }
            #piw-boss-panel .text-red { color:#f56565; }
            #piw-boss-panel .pba-reset { padding: 2px 6px; font-size: 12px; background: transparent; border: 1px solid #4a5568; }
            
            #piw-boss-panel .pba-actions { display:flex;gap:6px; }
            #piw-boss-panel .pba-actions button { flex:1; padding: 10px; font-size: 14px; transition: background-color 0.2s; }
            #piw-boss-panel .primary { background:#176342;border-color:#299263; }
            #piw-boss-panel .warn { background:#654b16;border-color:#987024; }
            
            #piw-boss-panel .pba-status { color:#90cdf4;background:#0a1219;border-radius:6px;padding:7px 9px;margin:7px 0; text-align:center; font-weight:bold; }
            #piw-boss-panel .pba-status.error { color:#feb2b2; }
            
            #piw-boss-panel .pba-loot-header { font-size: 11px; color:#a0aec0; margin-top: 10px; margin-bottom: 4px; text-transform: uppercase; font-weight: bold; }
            #piw-boss-panel .pba-loot { display:grid;gap:4px; }
            #piw-boss-panel .pba-loot-row { background:#111f29;border-left:3px solid #d6b35c;border-radius:5px;padding:4px 6px; font-size: 11px; color: #cbd5e0; word-break: break-word; white-space: normal; line-height: 1.4; }
            #piw-boss-panel .pba-empty { color:#718096;text-align:center;padding:7px;font-size:11px; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    let observerTimer = null;
    function initialize() {
        if (document.querySelector('#piw-boss-panel')) return;

        installStyles();
        createPanel();
        injectDockButton();
        
        const observer = new MutationObserver(() => {
            if (observerTimer) return;
            observerTimer = setTimeout(() => {
                observerTimer = null;
                injectDockButton();
            }, 150);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }

})();