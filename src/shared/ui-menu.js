(function installPiwUiMenu() {
  'use strict';

  const namespace = window.piwScripts = window.piwScripts || {};
  const attachedPanels = new WeakMap();

  function createPanelDragHandler(panel, {
    storageKey,
    sizeStorageKey = null,
    handle = panel?.querySelector?.('header'),
    margin = 8,
    minWidth = 240,
    minHeight = 160,
  } = {}) {
    if (!panel || !handle || !storageKey) {
      throw new TypeError('Configuração de painel móvel inválida.');
    }

    attachedPanels.get(panel)?.();
    const safeMargin = Math.max(0, Number(margin) || 0);
    const originalHandleStyle = {
      cursor: handle.style.cursor,
      touchAction: handle.style.touchAction,
      userSelect: handle.style.userSelect,
    };
    const body = Array.from(panel.children || []).find((child) => child !== handle) || null;
    const originalPanelStyle = {
      display: panel.style.display,
      flexDirection: panel.style.flexDirection,
      overflow: panel.style.overflow,
      width: panel.style.width,
      height: panel.style.height,
      maxWidth: panel.style.maxWidth,
      maxHeight: panel.style.maxHeight,
    };
    const originalHandleFlex = handle.style.flex;
    const originalBodyStyle = body ? {
      flex: body.style.flex,
      minHeight: body.style.minHeight,
      maxHeight: body.style.maxHeight,
      overflow: body.style.overflow,
    } : null;
    const safeMinWidth = Math.max(160, Number(minWidth) || 240);
    const safeMinHeight = Math.max(100, Number(minHeight) || 160);
    let dragging = null;
    let resizing = null;
    let resizeHandle = null;
    let lastSize = { width: 0, height: 0 };

    function readPosition() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        const left = Number(saved?.left);
        const top = Number(saved?.top);
        return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
      } catch {
        return null;
      }
    }

    function savePosition(position) {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(position));
      } catch {
        // O movimento continua funcionando mesmo quando o storage está indisponível.
      }
    }

    function removeSavedPosition() {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        // A posição visual ainda pode ser restaurada sem acesso ao storage.
      }
    }

    function readSize() {
      if (!sizeStorageKey) return null;
      try {
        const saved = JSON.parse(sessionStorage.getItem(sizeStorageKey) || 'null');
        const width = Number(saved?.width);
        const height = Number(saved?.height);
        return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
      } catch {
        return null;
      }
    }

    function saveSize(size) {
      if (!sizeStorageKey) return;
      try {
        sessionStorage.setItem(sizeStorageKey, JSON.stringify(size));
      } catch {
        // O redimensionamento continua funcionando mesmo quando o storage está indisponível.
      }
    }

    function removeSavedSize() {
      if (!sizeStorageKey) return;
      try {
        sessionStorage.removeItem(sizeStorageKey);
      } catch {
        // O tamanho visual ainda pode ser restaurado sem acesso ao storage.
      }
    }

    function getPanelSize() {
      const rect = panel.getBoundingClientRect();
      const computed = typeof getComputedStyle === 'function' ? getComputedStyle(panel) : null;
      const measured = {
        width: rect.width || panel.offsetWidth || parseFloat(computed?.width) || 0,
        height: rect.height || panel.offsetHeight || parseFloat(computed?.height) || 0,
      };
      if (measured.width > 0) lastSize.width = measured.width;
      if (measured.height > 0) lastSize.height = measured.height;
      return {
        width: measured.width || lastSize.width,
        height: measured.height || lastSize.height,
      };
    }

    function clampPosition(left, top) {
      const { width, height } = getPanelSize();
      const viewportWidth = Number(window.innerWidth) || document.documentElement?.clientWidth || width;
      const viewportHeight = Number(window.innerHeight) || document.documentElement?.clientHeight || height;
      const minLeft = Math.min(safeMargin, Math.max(0, viewportWidth - width));
      const minTop = Math.min(safeMargin, Math.max(0, viewportHeight - height));
      const maxLeft = Math.max(minLeft, viewportWidth - width - safeMargin);
      const maxTop = Math.max(minTop, viewportHeight - height - safeMargin);
      return {
        left: Math.round(Math.min(maxLeft, Math.max(minLeft, Number(left) || 0))),
        top: Math.round(Math.min(maxTop, Math.max(minTop, Number(top) || 0))),
      };
    }

    function applyPosition(left, top, { persist = false } = {}) {
      const position = clampPosition(left, top);
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.transform = 'none';
      if (persist) savePosition(position);
      return position;
    }

    function clampSize(width, height) {
      const rect = panel.getBoundingClientRect();
      const viewportWidth = Number(window.innerWidth) || document.documentElement?.clientWidth || width;
      const viewportHeight = Number(window.innerHeight) || document.documentElement?.clientHeight || height;
      const anchoredLeft = panel.style.left ? rect.left : safeMargin;
      const anchoredTop = panel.style.top ? rect.top : safeMargin;
      const maxWidth = Math.max(safeMinWidth, viewportWidth - Math.max(safeMargin, anchoredLeft) - safeMargin);
      const maxHeight = Math.max(safeMinHeight, viewportHeight - Math.max(safeMargin, anchoredTop) - safeMargin);
      return {
        width: Math.round(Math.min(maxWidth, Math.max(safeMinWidth, Number(width) || safeMinWidth))),
        height: Math.round(Math.min(maxHeight, Math.max(safeMinHeight, Number(height) || safeMinHeight))),
      };
    }

    function applySize(width, height, { persist = false } = {}) {
      const size = clampSize(width, height);
      panel.style.width = `${size.width}px`;
      panel.style.height = `${size.height}px`;
      panel.style.maxWidth = `calc(100vw - ${safeMargin * 2}px)`;
      panel.style.maxHeight = `calc(100vh - ${safeMargin * 2}px)`;
      if (persist) saveSize(size);
      return size;
    }

    function isInteractive(target) {
      let current = target;
      while (current && current !== handle) {
        if (current.matches?.('button,a,input,select,textarea,label,[data-piw-no-drag]')) return true;
        current = current.parentElement;
      }
      return false;
    }

    function stopDragging(event) {
      if (!dragging || (event?.pointerId != null && event.pointerId !== dragging.pointerId)) return;
      const position = applyPosition(panel.getBoundingClientRect().left, panel.getBoundingClientRect().top);
      savePosition(position);
      dragging = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    }

    function stopResizing(event) {
      if (!resizing || (event?.pointerId != null && event.pointerId !== resizing.pointerId)) return;
      const size = applySize(panel.getBoundingClientRect().width, panel.getBoundingClientRect().height);
      saveSize(size);
      const position = applyPosition(panel.getBoundingClientRect().left, panel.getBoundingClientRect().top);
      savePosition(position);
      resizing = null;
      window.removeEventListener('pointermove', onResizePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
    }

    function onPointerMove(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      applyPosition(event.clientX - dragging.offsetX, event.clientY - dragging.offsetY);
      event.preventDefault?.();
    }

    function onPointerDown(event) {
      if ((event.button != null && event.button !== 0) || event.isPrimary === false || isInteractive(event.target)) {
        return;
      }
      const rect = panel.getBoundingClientRect();
      dragging = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      applyPosition(rect.left, rect.top);
      handle.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', stopDragging);
      window.addEventListener('pointercancel', stopDragging);
      event.preventDefault?.();
    }

    function onResizePointerMove(event) {
      if (!resizing || event.pointerId !== resizing.pointerId) return;
      applySize(
        resizing.width + event.clientX - resizing.startX,
        resizing.height + event.clientY - resizing.startY,
      );
      event.preventDefault?.();
    }

    function onResizePointerDown(event) {
      if ((event.button != null && event.button !== 0) || event.isPrimary === false) return;
      const rect = panel.getBoundingClientRect();
      applyPosition(rect.left, rect.top);
      resizing = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: rect.width,
        height: rect.height,
      };
      resizeHandle.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onResizePointerMove);
      window.addEventListener('pointerup', stopResizing);
      window.addEventListener('pointercancel', stopResizing);
      event.stopPropagation?.();
      event.preventDefault?.();
    }

    function resetPosition(event) {
      if (isInteractive(event?.target)) return;
      dragging = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.transform = '';
      removeSavedPosition();
      event?.preventDefault?.();
    }

    function resetSize(event) {
      resizing = null;
      window.removeEventListener('pointermove', onResizePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
      panel.style.width = originalPanelStyle.width;
      panel.style.height = originalPanelStyle.height;
      panel.style.maxWidth = originalPanelStyle.maxWidth;
      panel.style.maxHeight = originalPanelStyle.maxHeight;
      removeSavedSize();
      keepInsideViewport();
      event?.stopPropagation?.();
      event?.preventDefault?.();
    }

    function keepInsideViewport() {
      if (sizeStorageKey && panel.style.width && panel.style.height) {
        const rect = panel.getBoundingClientRect();
        applySize(rect.width, rect.height, { persist: true });
      }
      if (!panel.style.left || !panel.style.top) return;
      const rect = panel.getBoundingClientRect();
      const styledLeft = parseFloat(panel.style.left);
      const styledTop = parseFloat(panel.style.top);
      const position = applyPosition(
        Number.isFinite(styledLeft) ? styledLeft : rect.left,
        Number.isFinite(styledTop) ? styledTop : rect.top,
      );
      savePosition(position);
    }

    handle.dataset.piwDraggableHandle = 'true';
    handle.title = handle.title || 'Arraste para mover · duplo clique para restaurar';
    handle.style.cursor = 'move';
    handle.style.touchAction = 'none';
    handle.style.userSelect = 'none';
    if (sizeStorageKey) {
      panel.dataset.piwResizablePanel = 'true';
      panel.style.display = 'flex';
      panel.style.flexDirection = 'column';
      panel.style.overflow = 'hidden';
      handle.style.flex = '0 0 auto';
      if (body) {
        body.style.flex = '1 1 auto';
        body.style.minHeight = '0';
        body.style.maxHeight = 'none';
        body.style.overflow = 'auto';
      }
      resizeHandle = document.createElement('span');
      resizeHandle.dataset.piwResizeHandle = 'true';
      resizeHandle.title = 'Arraste para redimensionar · duplo clique para restaurar';
      resizeHandle.setAttribute('aria-hidden', 'true');
      Object.assign(resizeHandle.style, {
        position: 'absolute',
        right: '1px',
        bottom: '1px',
        width: '15px',
        height: '15px',
        zIndex: '3',
        cursor: 'nwse-resize',
        touchAction: 'none',
        userSelect: 'none',
        background: 'linear-gradient(135deg, transparent 0 45%, #718096 46% 54%, transparent 55% 65%, #a0aec0 66% 74%, transparent 75%)',
      });
      resizeHandle.addEventListener('pointerdown', onResizePointerDown);
      resizeHandle.addEventListener('dblclick', resetSize);
      panel.appendChild(resizeHandle);
    }
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('dblclick', resetPosition);
    window.addEventListener('resize', keepInsideViewport);
    const visibilityObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (!panel.hidden) keepInsideViewport();
        })
      : null;
    visibilityObserver?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    const savedSize = readSize();
    if (savedSize) applySize(savedSize.width, savedSize.height);
    const savedPosition = readPosition();
    if (savedPosition) applyPosition(savedPosition.left, savedPosition.top);

    let active = true;
    const cleanup = () => {
      if (!active) return false;
      active = false;
      dragging = null;
      resizing = null;
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('dblclick', resetPosition);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
      window.removeEventListener('pointermove', onResizePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
      window.removeEventListener('resize', keepInsideViewport);
      visibilityObserver?.disconnect();
      handle.style.cursor = originalHandleStyle.cursor;
      handle.style.touchAction = originalHandleStyle.touchAction;
      handle.style.userSelect = originalHandleStyle.userSelect;
      handle.style.flex = originalHandleFlex;
      resizeHandle?.removeEventListener('pointerdown', onResizePointerDown);
      resizeHandle?.removeEventListener('dblclick', resetSize);
      resizeHandle?.remove();
      panel.style.display = originalPanelStyle.display;
      panel.style.flexDirection = originalPanelStyle.flexDirection;
      panel.style.overflow = originalPanelStyle.overflow;
      panel.style.width = originalPanelStyle.width;
      panel.style.height = originalPanelStyle.height;
      panel.style.maxWidth = originalPanelStyle.maxWidth;
      panel.style.maxHeight = originalPanelStyle.maxHeight;
      if (body && originalBodyStyle) {
        body.style.flex = originalBodyStyle.flex;
        body.style.minHeight = originalBodyStyle.minHeight;
        body.style.maxHeight = originalBodyStyle.maxHeight;
        body.style.overflow = originalBodyStyle.overflow;
      }
      delete handle.dataset.piwDraggableHandle;
      delete panel.dataset.piwResizablePanel;
      attachedPanels.delete(panel);
      return true;
    };
    attachedPanels.set(panel, cleanup);
    return cleanup;
  }

  if (namespace.uiMenu?.apiVersion === 1) {
    if (
      typeof namespace.uiMenu.makePanelDraggable !== 'function'
      || Number(namespace.uiMenu.panelInteractionVersion) < 2
    ) {
      namespace.uiMenu.makePanelDraggable = createPanelDragHandler;
      namespace.uiMenu.panelInteractionVersion = 2;
    }
    return;
  }

  const SIDEBAR_ID = 'script-sidebar';
  const GROUP_ID = 'piw-tools-sidebar-group';
  const STYLE_ID = 'piw-tools-menu-styles';
  const entries = new Map();
  let observer = null;
  let observerTimer = null;
  let domReadyListenerInstalled = false;
  let entriesDirty = false;

  function installStyles() {
    if (!document.documentElement || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${SIDEBAR_ID} {
        position:fixed;left:8px;top:50%;transform:translateY(-50%);
        display:flex;flex-direction:column;align-items:center;gap:6px;
        padding:8px 6px;background:rgba(20,16,10,.85);
        border:2px solid rgb(120,90,40);border-radius:10px;
        z-index:9000;backdrop-filter:blur(4px);
      }
      #${GROUP_ID} { display:contents; }
      #${GROUP_ID} .piw-tools-sidebar-item {
        position:relative;
        display:inline-flex;align-items:center;justify-content:center;
        width:36px;height:36px;padding:0;background:transparent;border:0;
        border-radius:8px;box-shadow:none;color:#e2e8f0;font-size:17px;
        cursor:pointer;transition:background .15s;
      }
      #${GROUP_ID} .piw-tools-sidebar-item:hover,
      #${GROUP_ID} .piw-tools-sidebar-item:focus-visible {
        background:rgba(255,255,255,.12);
        outline:none;
      }
      [data-piw-draggable-handle="true"] {
        cursor:move;touch-action:none;user-select:none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getOrCreateSidebar() {
    let sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar) return sidebar;
    sidebar = document.createElement('div');
    sidebar.id = SIDEBAR_ID;
    sidebar.dataset.piwToolsHost = 'true';
    document.body.appendChild(sidebar);
    return sidebar;
  }

  function renderEntries(group) {
    group.replaceChildren();
    const sorted = [...entries.values()].sort((left, right) =>
      left.order - right.order || left.label.localeCompare(right.label),
    );
    for (const entry of sorted) {
      const item = document.createElement('button');
      item.id = entry.id;
      item.className = 'dock-btn piw-tools-sidebar-item';
      item.type = 'button';
      item.textContent = entry.icon;
      item.title = entry.label;
      item.setAttribute('aria-label', entry.label);
      item.addEventListener('click', entry.onClick);
      group.appendChild(item);
      entry.onMount?.(item);
    }
  }

  function createGroup(sidebar) {
    const group = document.createElement('span');
    group.id = GROUP_ID;
    sidebar.appendChild(group);
    return group;
  }

  function ensureMounted() {
    if (!document.body || entries.size === 0) return;
    installStyles();
    const sidebar = getOrCreateSidebar();
    let group = document.getElementById(GROUP_ID);
    let created = false;
    if (!group) {
      group = createGroup(sidebar);
      created = true;
    }
    else if (group.parentElement !== sidebar) sidebar.appendChild(group);
    if (created || entriesDirty) {
      renderEntries(group);
      entriesDirty = false;
    }
  }

  function scheduleMount() {
    if (!document.body) {
      if (!domReadyListenerInstalled) {
        domReadyListenerInstalled = true;
        document.addEventListener('DOMContentLoaded', () => {
          domReadyListenerInstalled = false;
          ensureMounted();
          startObserver();
        }, { once: true });
      }
      return;
    }
    if (observerTimer) return;
    observerTimer = setTimeout(() => {
      observerTimer = null;
      ensureMounted();
    }, 0);
    startObserver();
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => {
      if (document.getElementById(GROUP_ID) || entries.size === 0) return;
      scheduleMount();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function removeEntry(id) {
    if (!entries.delete(id)) return false;
    document.getElementById(id)?.remove();
    if (entries.size > 0) {
      const group = document.getElementById(GROUP_ID);
      if (group) renderEntries(group);
      return true;
    }
    document.getElementById(GROUP_ID)?.remove();
    const sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar?.dataset.piwToolsHost === 'true' && sidebar.childElementCount === 0) sidebar.remove();
    return true;
  }

  namespace.uiMenu = {
    apiVersion: 1,
    panelInteractionVersion: 2,
    register({ id, label, icon = '•', order = 100, onClick, onMount = null }) {
      if (!id || !label || typeof onClick !== 'function') {
        throw new TypeError('Registro de menu inválido.');
      }
      entries.set(String(id), {
        id: String(id),
        label: String(label),
        icon: String(icon),
        order: Number.isFinite(Number(order)) ? Number(order) : 100,
        onClick,
        onMount: typeof onMount === 'function' ? onMount : null,
      });
      entriesDirty = true;
      scheduleMount();
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        return removeEntry(String(id));
      };
    },
    refresh() {
      ensureMounted();
    },
    makePanelDraggable: createPanelDragHandler,
    status() {
      return {
        installed: true,
        entries: [...entries.keys()],
        mounted: Boolean(document.getElementById(GROUP_ID)),
        sharedSidebar: Boolean(document.getElementById(SIDEBAR_ID)),
      };
    },
  };
})();
