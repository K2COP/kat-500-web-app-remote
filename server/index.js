const fs = require('fs');
const path = require('path');
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
kat.on('log', (line) => broadcast('log', line));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', payload: kat.getState() }));
});

process.on('SIGINT', () => {
  kat.disconnect();
  process.exit(0);
});

// Auto-connect on startup if a port was previously configured.
if (config.serialPath) {
  kat
    .connect({ path: config.serialPath, baud: config.baudRate || null })
    .catch((err) => console.error(`Auto-connect failed: ${err.message}`));
}
