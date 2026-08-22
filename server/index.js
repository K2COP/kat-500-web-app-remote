const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const KAT500 = require('./kat500');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    return { httpPort: 8500, serialPath: null, baudRate: null };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const config = loadConfig();
const kat = new KAT500();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/state', (req, res) => {
  res.json(kat.getState());
});

app.get('/api/ports', async (req, res) => {
  try {
    const ports = await kat.listPorts();
    res.json(ports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connect', async (req, res) => {
  const { path: serialPath, baud } = req.body || {};
  if (!serialPath) return res.status(400).json({ error: 'path is required' });
  try {
    await kat.connect({ path: serialPath, baud: baud || null });
    config.serialPath = serialPath;
    config.baudRate = baud || null;
    saveConfig(config);
    res.json(kat.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  kat.disconnect();
  res.json(kat.getState());
});

app.post('/api/command', async (req, res) => {
  const { action, value } = req.body || {};
  try {
    switch (action) {
      case 'power':
        await kat.setPower(Boolean(value));
        break;
      case 'antenna':
        await kat.setAntenna(Number(value));
        break;
      case 'mode':
        await kat.setMode(value);
        break;
      case 'bypass':
        await kat.setBypass(Boolean(value));
        break;
      case 'band':
        await kat.setBand(value);
        break;
      case 'tune':
        await kat.tune();
        break;
      case 'cancelTune':
        await kat.cancelTune();
        break;
      case 'clearFault':
        await kat.clearFault();
        break;
      case 'raw':
        await kat.raw(String(value));
        break;
      default:
        return res.status(400).json({ error: `unknown action: ${action}` });
    }
    res.json(kat.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(config.httpPort, () => {
  console.log(`KAT500 web control listening on http://localhost:${config.httpPort}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
}

kat.on('state', (state) => broadcast('state', state));
kat.on('log', (line) => {
  console.log(`[wire] ${line}`);
  broadcast('log', line);
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', payload: kat.getState() }));
});

process.on('SIGINT', () => {
  kat.disconnect();
  process.exit(0);
});

function attemptConnect() {
  if (!config.serialPath) return;
  kat
    .connect({ path: config.serialPath, baud: config.baudRate || null })
    .then(() => {
      // Persist whatever baud we ended up on so the next process start
      // (e.g. the LaunchAgent firing at login/reboot) reuses it via
      // openAt() instead of re-running autoBaud(). autoBaud() blindly
      // probes multiple rates every restart with no idea what state the
      // tuner is in - skipping it once a rate is known avoids that.
      const { baud } = kat.getState();
      if (baud && baud !== config.baudRate) {
        config.baudRate = baud;
        saveConfig(config);
      }
    })
    .catch((err) => console.error(`Auto-connect failed: ${err.message}`));
}

// The official Elecraft KAT500 Utility.app wants exclusive access to the
// same physical serial line: it opens /dev/cu.usbserial-*, we open
// /dev/tty.usbserial-* for the same port, and on macOS those two device
// nodes can't both be open at once. Unlike this server (which fails fast
// and retries), the native app doesn't handle losing that race gracefully -
// it just hangs waiting for the tuner. Since this server normally runs
// all the time via LaunchAgent, that means the native app can never open
// unless something proactively gets out of its way. Poll for the app and
// release the port the moment it's running, then reclaim it once the app
// closes.
const NATIVE_APP_PATTERN = 'Elecraft KAT500 Utility.app';
const NATIVE_APP_POLL_MS = 1000;

function isNativeAppRunning() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', NATIVE_APP_PATTERN], (err) => resolve(!err));
  });
}

async function checkNativeApp() {
  const running = await isNativeAppRunning();
  const state = kat.getState();
  if (running) {
    if (state.connected || state.connecting) {
      console.log(`${NATIVE_APP_PATTERN} detected - releasing serial port`);
      kat.disconnect();
    }
  } else if (!state.connected && !state.connecting) {
    attemptConnect();
  }
}

setInterval(checkNativeApp, NATIVE_APP_POLL_MS);
checkNativeApp();
