const BANDS = [
  { code: '00', label: '160m' },
  { code: '01', label: '80m' },
  { code: '02', label: '60m' },
  { code: '03', label: '40m' },
  { code: '04', label: '30m' },
  { code: '05', label: '20m' },
  { code: '06', label: '17m' },
  { code: '07', label: '15m' },
  { code: '08', label: '12m' },
  { code: '09', label: '10m' },
  { code: '10', label: '6m' },
];

const el = (id) => document.getElementById(id);

const bandSelect = el('bandSelect');
BANDS.forEach((b) => {
  const opt = document.createElement('option');
  opt.value = b.code;
  opt.textContent = b.label;
  bandSelect.appendChild(opt);
});

let suppressBandChange = false;
let currentState = {};

async function postCommand(action, value) {
  const res = await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error('command failed', action, body.error);
  }
}

el('powerOnBtn').addEventListener('click', () => postCommand('power', true));
el('powerOffBtn').addEventListener('click', () => postCommand('power', false));

document.querySelectorAll('.antenna-btn').forEach((btn) => {
  btn.addEventListener('click', () => postCommand('antenna', Number(btn.dataset.ant)));
});

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => postCommand('mode', btn.dataset.mode));
});

bandSelect.addEventListener('change', () => {
  if (suppressBandChange) return;
  postCommand('band', bandSelect.value);
});

el('tuneBtn').addEventListener('click', () => postCommand('tune'));
el('cancelTuneBtn').addEventListener('click', () => postCommand('cancelTune'));
el('clearFaultBtn').addEventListener('click', () => postCommand('clearFault'));

el('refreshPortsBtn').addEventListener('click', loadPorts);
el('connectBtn').addEventListener('click', async () => {
  const portSelect = el('portSelect');
  const baudSelect = el('baudSelect');
  const path = portSelect.value;
  if (!path) return;
  const res = await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, baud: baudSelect.value ? Number(baudSelect.value) : null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Connect failed: ${body.error || res.statusText}`);
  }
});

el('rawSendBtn').addEventListener('click', sendRaw);
el('rawInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendRaw();
});
function sendRaw() {
  const input = el('rawInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  postCommand('raw', cmd);
  input.value = '';
}

async function loadPorts() {
  const res = await fetch('/api/ports');
  const ports = await res.json();
  const select = el('portSelect');
  select.innerHTML = '';
  ports.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}`;
    select.appendChild(opt);
  });
  syncPortSelection();
}

function syncPortSelection() {
  const select = el('portSelect');
  if (currentState.path && [...select.options].some((o) => o.value === currentState.path)) {
    select.value = currentState.path;
  }
}

function renderState(state) {
  currentState = state;
  syncPortSelection();

  const indicator = el('connIndicator');
  const connText = el('connText');
  indicator.classList.remove('connected', 'connecting', 'disconnected');
  if (state.connected) {
    indicator.classList.add('connected');
    connText.textContent = `Connected @ ${state.baud} baud`;
  } else if (state.connecting) {
    indicator.classList.add('connecting');
    connText.textContent = 'Connecting…';
  } else {
    indicator.classList.add('disconnected');
    connText.textContent = state.lastError ? `Disconnected: ${state.lastError}` : 'Disconnected';
  }

  el('powerOnBtn').classList.toggle('active', state.power === true);
  el('powerOffBtn').classList.toggle('active', state.power === false);

  document.querySelectorAll('.antenna-btn[data-ant]').forEach((btn) => {
    const n = Number(btn.dataset.ant);
    btn.classList.toggle('active', n !== 0 && n === state.antenna);
  });

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });

  if (state.band) {
    suppressBandChange = true;
    bandSelect.value = state.band;
    suppressBandChange = false;
  }

  const tuning = Boolean(state.tuning);
  el('tuningIndicator').classList.toggle('hidden', !tuning);
  el('tuneBtn').disabled = tuning;

  const fault = state.fault || 0;
  const faultBanner = el('faultBanner');
  if (fault !== 0) {
    faultBanner.classList.remove('hidden');
    el('faultText').textContent = state.faultMessage || `Fault ${fault}`;
  } else {
    faultBanner.classList.add('hidden');
  }

  el('vswrValue').textContent = state.vswr != null ? `${state.vswr.toFixed(2)}:1` : '—';
  el('vswrBypassValue').textContent =
    state.vswrBypass != null ? `${state.vswrBypass.toFixed(2)}:1` : '—';

  const bar = el('swrBar');
  const swr = state.vswr != null ? state.vswr : 1;
  const pct = Math.max(0, Math.min(100, ((swr - 1) / (5 - 1)) * 100));
  bar.style.width = `${pct}%`;

  el('fwValue').textContent = state.firmware || '—';
  el('snValue').textContent = state.serialNumber || '—';
  el('portValue').textContent = state.path || '—';
}

function appendLog(line) {
  const out = el('logOutput');
  out.textContent += `${line}\n`;
  out.scrollTop = out.scrollHeight;
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'state') renderState(msg.payload);
    if (msg.type === 'log') appendLog(msg.payload);
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

async function init() {
  await loadPorts();
  const res = await fetch('/api/state');
  renderState(await res.json());
  connectWs();
}

init();
