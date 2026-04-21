const statusEls = {
  connectionState: document.getElementById('bridge-connection-state'),
  hostTabSelect: document.getElementById('bridge-host-tab-select'),
  startHost: document.getElementById('bridge-start-host'),
  switchTab: document.getElementById('bridge-switch-tab'),
  showHostedTab: document.getElementById('bridge-show-hosted-tab'),
  stopHost: document.getElementById('bridge-stop-host'),
  peerId: document.getElementById('bridge-peer-id'),
  openViewer: document.getElementById('bridge-open-viewer'),
  copyPeerId: document.getElementById('bridge-copy-peer-id'),
  viewportSelect: document.getElementById('bridge-viewport-select'),
  applyViewport: document.getElementById('bridge-apply-viewport'),
  capturedTab: document.getElementById('bridge-captured-tab'),
  captureMode: document.getElementById('bridge-capture-mode'),
  viewerState: document.getElementById('bridge-viewer-state'),
  hostMessage: document.getElementById('bridge-host-message'),
  viewerPeerId: document.getElementById('bridge-viewer-peer-id'),
  connectViewer: document.getElementById('bridge-connect-viewer'),
  openCurrentViewer: document.getElementById('bridge-open-current-viewer'),
  viewerUrl: document.getElementById('bridge-viewer-url'),
  tabContext: document.getElementById('bridge-tab-context'),
  tabsBody: document.getElementById('bridge-tab-table-body'),
  refreshAll: document.getElementById('bridge-refresh-all'),
  refreshTabs: document.getElementById('bridge-refresh-tabs'),
  clearDiagnostics: document.getElementById('bridge-clear-diagnostics'),
  lastErrorBadge: document.getElementById('bridge-last-error-badge'),
  lastError: document.getElementById('bridge-last-error'),
  diagnosticsLog: document.getElementById('bridge-diagnostics-log'),
  stepSelect: document.getElementById('bridge-step-select'),
  stepHost: document.getElementById('bridge-step-host'),
  stepPeer: document.getElementById('bridge-step-peer'),
  stepFocus: document.getElementById('bridge-step-focus')
};

const state = {
  status: null,
  tabs: [],
  selectedTabId: null,
  bridgeLogs: [],
  backgroundLogs: [],
  backgroundLastError: null,
  bridgeLastError: null,
  refreshInFlight: false,
  refreshQueued: false
};

const REFRESH_INTERVAL_MS = 1500;
const MAX_BRIDGE_LOGS = 80;

function isForbiddenTab(tab) {
  if (!tab || !tab.url) return true;
  return tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('edge://') ||
    tab.url.startsWith('about:');
}

function pushBridgeLog(event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    source: 'bridge',
    event,
    details
  };
  state.bridgeLogs = [entry, ...state.bridgeLogs].slice(0, MAX_BRIDGE_LOGS);
  if (details?.error) {
    state.bridgeLastError = entry;
  }
}

function formatShortTime(ts) {
  if (!ts) return '--:--:--';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function summarizeDetails(details) {
  if (!details || typeof details !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(details)) {
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(' ');
}

function setHostMessage(text, tone = '') {
  statusEls.hostMessage.textContent = text || '';
  statusEls.hostMessage.className = `message${tone ? ` ${tone}` : ''}`;
}

function getTabById(tabId) {
  return state.tabs.find((tab) => tab.id === tabId) || null;
}

function getSelectedTabId() {
  const raw = statusEls.hostTabSelect.value;
  return raw ? Number(raw) : null;
}

// buildViewerUrl and pickDefaultSelectedTab are provided as globals by
// lib/bridge-utils.js (loaded before this script in bridge.html).
// pickDefaultSelectedTab now takes `state` as an explicit argument.

function renderTabSelect() {
  const previous = state.selectedTabId;
  const options = state.tabs.map((tab) => {
    const selected = tab.id === previous;
    const marker = tab.id === state.status?.capturedTabId ? ' [captured]' : tab.active ? ' [active]' : '';
    const label = `${tab.title || tab.url || `Tab ${tab.id}`} (#${tab.id})${marker}`;
    return `<option value="${tab.id}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  });

  statusEls.hostTabSelect.innerHTML = options.length
    ? options.join('')
    : '<option value="">No capturable tabs</option>';

  if (!state.tabs.length) {
    state.selectedTabId = null;
    return;
  }

  if (!getTabById(previous)) {
    state.selectedTabId = pickDefaultSelectedTab(state);
    statusEls.hostTabSelect.value = String(state.selectedTabId);
  } else {
    state.selectedTabId = previous;
  }
}

function renderStatus() {
  const status = state.status || {};
  const capturedTab = getTabById(status.capturedTabId);
  const connectionState = !status.hosting
    ? 'Idle'
    : status.viewerConnected
      ? 'Viewer Connected'
      : 'Hosting';

  statusEls.connectionState.textContent = connectionState;
  statusEls.connectionState.className = `status-pill ${
    !status.hosting ? '' : status.viewerConnected ? 'ok' : 'warn'
  }`;

  statusEls.peerId.value = status.peerId || '';
  statusEls.captureMode.textContent = status.captureMode || 'Idle';
  statusEls.viewerState.textContent = status.viewerConnected ? 'Connected' : 'Disconnected';
  statusEls.capturedTab.textContent = capturedTab
    ? `${capturedTab.id} · ${capturedTab.title || capturedTab.url || 'Untitled tab'}`
    : status.capturedTabId
      ? `${status.capturedTabId} · unavailable`
      : 'None';

  const requestedViewerPeerId = statusEls.viewerPeerId.value.trim();
  statusEls.viewerUrl.textContent = status.viewerUrl ||
    (requestedViewerPeerId ? buildViewerUrl(requestedViewerPeerId) : 'No active host viewer URL');
  statusEls.tabContext.textContent = capturedTab
    ? [
        `tabId=${capturedTab.id}`,
        `windowId=${capturedTab.windowId}`,
        `title=${capturedTab.title || 'Untitled tab'}`,
        `url=${capturedTab.url || ''}`
      ].join('\n')
    : 'No captured tab';

  if (!statusEls.viewerPeerId.value && status.peerId) {
    statusEls.viewerPeerId.value = status.peerId;
  }

  renderTabSelect();

  const selectedTabId = getSelectedTabId();
  const hasSelectedTab = Number.isFinite(selectedTabId);
  const canStart = !status.hosting && hasSelectedTab;
  const canSwitch = Boolean(status.hosting && hasSelectedTab && selectedTabId !== status.capturedTabId);
  const canStop = Boolean(status.hosting);
  const canOpenViewer = Boolean(status.peerId);
  const canApplyViewport = Boolean(status.hosting && status.captureMode === 'screencast');
  const canShowHostedTab = Boolean(status.hosting && status.capturedTabId);

  statusEls.startHost.disabled = !canStart;
  statusEls.switchTab.disabled = !canSwitch;
  statusEls.showHostedTab.disabled = !canShowHostedTab;
  statusEls.stopHost.disabled = !canStop;
  statusEls.openViewer.disabled = !canOpenViewer;
  statusEls.openCurrentViewer.disabled = !canOpenViewer;
  statusEls.copyPeerId.disabled = !canOpenViewer;
  statusEls.applyViewport.disabled = !canApplyViewport || !statusEls.viewportSelect.value;

  renderAgentSteps();
}

function setStep(el, text, tone) {
  el.textContent = text;
  el.style.background = tone === 'ok'
    ? 'rgba(47, 199, 161, 0.18)'
    : tone === 'warn'
      ? 'rgba(255, 191, 95, 0.18)'
      : 'rgba(9, 14, 30, 0.3)';
  el.style.color = tone === 'ok'
    ? '#aaf0ca'
    : tone === 'warn'
      ? '#ffe0a8'
      : '#d7e2ff';
  el.style.borderColor = tone === 'ok'
    ? 'rgba(47, 199, 161, 0.45)'
    : tone === 'warn'
      ? 'rgba(255, 191, 95, 0.45)'
      : 'rgba(255,255,255,0.16)';
}

function renderAgentSteps() {
  const status = state.status || {};
  const selectedTabId = getSelectedTabId();
  const hasSelectedTab = Number.isFinite(selectedTabId);

  setStep(statusEls.stepSelect, hasSelectedTab ? `Selected #${selectedTabId}` : 'Waiting', hasSelectedTab ? 'ok' : '');
  setStep(statusEls.stepHost, status.hosting ? 'Hosting' : 'Waiting', status.hosting ? 'ok' : '');
  setStep(statusEls.stepPeer, status.peerId ? 'Ready' : 'Waiting', status.peerId ? 'ok' : '');

  if (!status.hosting || !status.capturedTabId) {
    setStep(statusEls.stepFocus, 'Waiting', '');
    return;
  }

  const capturedTab = getTabById(status.capturedTabId);
  if (capturedTab && capturedTab.active) {
    setStep(statusEls.stepFocus, `Active #${status.capturedTabId}`, 'ok');
  } else {
    setStep(statusEls.stepFocus, `Needs Focus #${status.capturedTabId}`, 'warn');
  }
}

function renderTabsTable() {
  if (!state.tabs.length) {
    statusEls.tabsBody.innerHTML = '<tr><td colspan="4" class="muted">No capturable tabs available.</td></tr>';
    return;
  }

  const hosting = Boolean(state.status?.hosting);
  const capturedTabId = state.status?.capturedTabId;

  statusEls.tabsBody.innerHTML = state.tabs.map((tab) => {
    const tags = [];
    if (tab.id === capturedTabId) tags.push('<span class="tag active">Captured</span>');
    if (tab.active) tags.push('<span class="tag">Active</span>');
    if (!tags.length) tags.push('<span class="tag idle">Ready</span>');

    const primaryAction = hosting
      ? (tab.id === capturedTabId
          ? '<button class="secondary" disabled>Captured</button>'
          : `<button class="secondary" data-action="switch" data-tab-id="${tab.id}">Switch</button>`)
      : `<button data-action="start" data-tab-id="${tab.id}">Start Host</button>`;

    const selectAction = `<button class="secondary" data-action="select" data-tab-id="${tab.id}">Select</button>`;

    return `
      <tr class="${tab.id === capturedTabId ? 'captured' : ''}" data-tab-id="${tab.id}">
        <td>${tags.join(' ')}</td>
        <td>
          <div class="tab-title">${escapeHtml(tab.title || 'Untitled tab')}</div>
          <div class="tab-url">${escapeHtml(tab.url || '')}</div>
        </td>
        <td>#${tab.id}</td>
        <td>
          <div class="tab-actions">
            ${primaryAction}
            ${selectAction}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function pickLastError() {
  if (!state.backgroundLastError) return state.bridgeLastError;
  if (!state.bridgeLastError) return state.backgroundLastError;
  return new Date(state.backgroundLastError.ts) >= new Date(state.bridgeLastError.ts)
    ? state.backgroundLastError
    : state.bridgeLastError;
}

function renderDiagnostics() {
  const combined = [...state.bridgeLogs, ...state.backgroundLogs]
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, 80);

  statusEls.diagnosticsLog.textContent = combined.length
    ? combined.map((entry) => {
        const detailText = summarizeDetails(entry.details);
        return `[${formatShortTime(entry.ts)}] ${entry.source}:${entry.event}${detailText ? ` ${detailText}` : ''}`;
      }).join('\n')
    : 'No diagnostics yet.';

  const lastError = pickLastError();
  if (lastError) {
    const details = summarizeDetails(lastError.details);
    statusEls.lastError.textContent = [
      `time=${lastError.ts}`,
      `source=${lastError.source}`,
      `event=${lastError.event}`,
      details || 'no additional details'
    ].join('\n');
    statusEls.lastErrorBadge.textContent = 'Error Present';
    statusEls.lastErrorBadge.className = 'status-pill error';
  } else {
    statusEls.lastError.textContent = 'No error recorded.';
    statusEls.lastErrorBadge.textContent = 'No Error';
    statusEls.lastErrorBadge.className = 'status-pill ok';
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function loadStatus() {
  state.status = await chrome.runtime.sendMessage({ action: 'getStatus' });
}

async function loadTabs() {
  const tabs = await chrome.tabs.query({});
  state.tabs = tabs
    .filter((tab) => !isForbiddenTab(tab))
    .sort((a, b) => (
      Number(b.active) - Number(a.active) ||
      a.windowId - b.windowId ||
      (a.index || 0) - (b.index || 0)
    ));

  if (!getTabById(state.selectedTabId)) {
    state.selectedTabId = pickDefaultSelectedTab(state);
  }
}

async function loadDiagnostics() {
  const diagnostics = await chrome.runtime.sendMessage({ action: 'getDiagnostics' });
  state.backgroundLogs = diagnostics?.logs || [];
  state.backgroundLastError = diagnostics?.lastError || null;
}

async function refreshAll() {
  if (state.refreshInFlight) {
    state.refreshQueued = true;
    return;
  }

  state.refreshInFlight = true;
  try {
    await Promise.all([loadStatus(), loadTabs(), loadDiagnostics()]);
    renderStatus();
    renderTabsTable();
    renderDiagnostics();
  } catch (error) {
    pushBridgeLog('refresh_failed', { error: error.message || String(error) });
    setHostMessage(error.message || String(error), 'error');
    renderDiagnostics();
  } finally {
    state.refreshInFlight = false;
    if (state.refreshQueued) {
      state.refreshQueued = false;
      refreshAll();
    }
  }
}

async function withAction(name, fn) {
  setHostMessage(`${name}...`);
  pushBridgeLog(`${name}_requested`);
  try {
    const result = await fn();
    pushBridgeLog(`${name}_completed`);
    return result;
  } catch (error) {
    const message = error.message || String(error);
    pushBridgeLog(`${name}_failed`, { error: message });
    setHostMessage(message, 'error');
    renderDiagnostics();
    throw error;
  } finally {
    await refreshAll();
  }
}

async function startHost(tabId) {
  const result = await chrome.runtime.sendMessage({
    action: 'startHostingCDP',
    tabId
  });
  if (result?.error) {
    throw new Error(result.error);
  }
  setHostMessage(`Hosting started on tab ${tabId}. Focus switched to the hosted tab.`, 'ok');
}

async function stopHost() {
  const result = await chrome.runtime.sendMessage({ action: 'stopHosting' });
  if (result?.error) {
    throw new Error(result.error);
  }
  setHostMessage('Hosting stopped.', 'ok');
}

async function switchCapturedTab(tabId) {
  await chrome.runtime.sendMessage({
    action: 'controlEvent',
    event: {
      type: 'switchTab',
      tabId
    }
  });
  setHostMessage(`Switched captured tab to ${tabId}.`, 'ok');
}

async function showHostedTab() {
  const tabId = state.status?.capturedTabId;
  if (!tabId) {
    throw new Error('No captured tab is active.');
  }
  await chrome.runtime.sendMessage({
    action: 'controlEvent',
    event: {
      type: 'focusTab',
      tabId
    }
  });
  setHostMessage(`Focused hosted tab ${tabId}.`, 'ok');
}

async function applyViewport(viewport) {
  const [width, height] = viewport.split('x').map(Number);
  if (!width || !height) {
    throw new Error('Select a viewport before applying it.');
  }
  await chrome.runtime.sendMessage({
    action: 'controlEvent',
    event: {
      type: 'setViewport',
      width,
      height
    }
  });
  setHostMessage(`Applied viewport ${width}x${height}.`, 'ok');
}

async function openViewerForPeer(peerId) {
  if (!peerId) {
    throw new Error('Peer ID is required to open the viewer.');
  }
  await chrome.tabs.create({
    url: buildViewerUrl(peerId)
  });
  setHostMessage(`Opened viewer for ${peerId}.`, 'ok');
}

async function copyPeerId() {
  const peerId = state.status?.peerId || '';
  if (!peerId) {
    throw new Error('No peer ID available to copy.');
  }

  try {
    await navigator.clipboard.writeText(peerId);
  } catch (error) {
    const fallback = document.createElement('textarea');
    fallback.value = peerId;
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand('copy');
    fallback.remove();
  }

  setHostMessage('Peer ID copied to clipboard.', 'ok');
}

function bindControls() {
  statusEls.hostTabSelect.addEventListener('change', () => {
    state.selectedTabId = getSelectedTabId();
    renderStatus();
  });

  statusEls.viewerPeerId.addEventListener('input', () => {
    const peerId = statusEls.viewerPeerId.value.trim();
    statusEls.viewerUrl.textContent = peerId
      ? buildViewerUrl(peerId)
      : (state.status?.viewerUrl || 'No active host viewer URL');
  });

  statusEls.startHost.addEventListener('click', () => {
    const tabId = getSelectedTabId();
    if (!tabId) {
      setHostMessage('Select a target tab first.', 'error');
      return;
    }
    withAction('start_host', () => startHost(tabId)).catch(() => {});
  });

  statusEls.switchTab.addEventListener('click', () => {
    const tabId = getSelectedTabId();
    if (!tabId) {
      setHostMessage('Select a target tab first.', 'error');
      return;
    }
    withAction('switch_tab', () => switchCapturedTab(tabId)).catch(() => {});
  });

  statusEls.showHostedTab.addEventListener('click', () => {
    withAction('show_hosted_tab', () => showHostedTab()).catch(() => {});
  });

  statusEls.stopHost.addEventListener('click', () => {
    withAction('stop_host', () => stopHost()).catch(() => {});
  });

  statusEls.applyViewport.addEventListener('click', () => {
    const viewport = statusEls.viewportSelect.value;
    withAction('set_viewport', () => applyViewport(viewport)).catch(() => {});
  });

  statusEls.viewportSelect.addEventListener('change', () => {
    renderStatus();
  });

  statusEls.openViewer.addEventListener('click', () => {
    withAction('open_viewer', () => openViewerForPeer(state.status?.peerId || '')).catch(() => {});
  });

  statusEls.openCurrentViewer.addEventListener('click', () => {
    withAction('open_viewer', () => openViewerForPeer(state.status?.peerId || '')).catch(() => {});
  });

  statusEls.connectViewer.addEventListener('click', () => {
    const peerId = statusEls.viewerPeerId.value.trim();
    withAction('connect_viewer', () => openViewerForPeer(peerId)).catch(() => {});
  });

  statusEls.copyPeerId.addEventListener('click', () => {
    withAction('copy_peer_id', () => copyPeerId()).catch(() => {});
  });

  statusEls.refreshAll.addEventListener('click', () => {
    pushBridgeLog('manual_refresh');
    refreshAll();
  });

  statusEls.refreshTabs.addEventListener('click', () => {
    pushBridgeLog('manual_refresh_tabs');
    refreshAll();
  });

  statusEls.clearDiagnostics.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'clearDiagnostics' });
    state.bridgeLogs = [];
    state.bridgeLastError = null;
    state.backgroundLogs = [];
    state.backgroundLastError = null;
    setHostMessage('Diagnostics cleared.', 'ok');
    renderDiagnostics();
  });

  statusEls.tabsBody.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const tabId = Number(button.dataset.tabId);
    if (!tabId) return;

    if (button.dataset.action === 'select') {
      state.selectedTabId = tabId;
      statusEls.hostTabSelect.value = String(tabId);
      renderStatus();
      setHostMessage(`Selected tab ${tabId}.`, 'ok');
      return;
    }

    if (button.dataset.action === 'start') {
      state.selectedTabId = tabId;
      statusEls.hostTabSelect.value = String(tabId);
      withAction('start_host', () => startHost(tabId)).catch(() => {});
      return;
    }

    if (button.dataset.action === 'switch') {
      state.selectedTabId = tabId;
      statusEls.hostTabSelect.value = String(tabId);
      withAction('switch_tab', () => switchCapturedTab(tabId)).catch(() => {});
    }
  });

  const scheduleRefresh = () => {
    refreshAll();
  };

  chrome.tabs.onCreated.addListener(scheduleRefresh);
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener(scheduleRefresh);
  window.addEventListener('focus', scheduleRefresh);
}

bindControls();
pushBridgeLog('bridge_loaded');
refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL_MS);
