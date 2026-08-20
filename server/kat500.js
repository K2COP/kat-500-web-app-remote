const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');

// KAT500 Serial Command Reference (Elecraft, rev 9/6/2023, fw 02.12):
// 4800/9600/19200/38400 8N1, no flow control, commands/responses are
// printable ASCII terminated by ';'. GETs always produce a RESPONSE.
// SET commands generally produce no response, except T;/FT; (full tune),
// which responds with a bare "FT;" whenever the tune completes.
const BAUD_RATES = [38400, 19200, 9600, 4800];

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

const FAULT_MESSAGES = {
  0: 'No fault',
  1: 'No match found during tune',
  2: 'Power above design limit for antenna SWR',
  3: 'Power above safe relay switch limit',
  4: 'SWR exceeds amplifier key interrupt threshold',
};

function bandLabel(code) {
  const band = BANDS.find((b) => b.code === code);
  return band ? band.label : `band ${code}`;
}

class KAT500 {
  constructor() {
    this.port = null;
    this.buffer = '';
    this.queue = [];
    this.waiting = null;
    this.actionLock = Promise.resolve();
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.pollTick = 0;
    this.events = new EventEmitter();
    this.configuredPath = null;
    this.configuredBaud = null;

    this.state = {
      connected: false,
      connecting: false,
      path: null,
      baud: null,
      lastUpdated: null,
      lastError: null,
      ...this.liveFieldDefaults(),
    };
  }

  on(event, handler) {
    this.events.on(event, handler);
  }

  /** Fields that describe the live device, not the connection itself.
   * Cleared on disconnect and before probing a new port so stale readings
   * (SWR, fault, antenna, etc.) never linger and look live. */
  liveFieldDefaults() {
    return {
      antenna: null,
      mode: null,
      bypass: null,
      vswr: null,
      vswrBypass: null,
      fault: 0,
      faultMessage: FAULT_MESSAGES[0],
      tuning: false,
      band: null,
      bandLabel: null,
      firmware: null,
      serialNumber: null,
    };
  }

  getState() {
    return { ...this.state };
  }

  setState(patch) {
    Object.assign(this.state, patch, { lastUpdated: Date.now() });
    this.events.emit('state', this.getState());
  }

  log(line) {
    this.events.emit('log', line);
  }

  async listPorts() {
    return SerialPort.list();
  }

  // --- connection lifecycle -------------------------------------------------

  async connect({ path, baud } = {}) {
    this.disconnect();
    this.configuredPath = path || this.configuredPath;
    if (!this.configuredPath) throw new Error('No serial port specified');

    // baud === undefined means "caller didn't specify, reuse last known
    // good rate" (used by the reconnect watchdog). An explicit null means
    // "auto-detect now" and must not be silently replaced by a stale value
    // remembered from a previous connect() call.
    const requestedBaud = baud !== undefined ? baud : this.configuredBaud;

    this.setState({ connecting: true, lastError: null, ...this.liveFieldDefaults() });
    try {
      if (requestedBaud) {
        await this.openAt(this.configuredPath, requestedBaud);
      } else {
        await this.autoBaud(this.configuredPath);
      }
    } catch (err) {
      this.setState({ connecting: false, lastError: err.message });
      throw err;
    }
  }

  async autoBaud(path) {
    let lastErr = null;
    for (const rate of BAUD_RATES) {
      try {
        await this.probeBaud(path, rate);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`Unable to find a working baud rate on ${path}`);
  }

  probeBaud(path, baud) {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
      let settled = false;
      let buf = '';

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        port.removeAllListeners();
        if (err) {
          try {
            port.close(() => {});
          } catch (e) {
            /* ignore */
          }
          reject(err);
        } else {
          this.attach(port, path, baud);
          resolve();
        }
      };

      const timer = setTimeout(() => finish(new Error('probe timeout')), 900);

      port.open((err) => {
        if (err) return finish(err);
        port.on('data', (chunk) => {
          buf += chunk.toString('ascii');
          if (buf.includes(';')) finish(null);
        });
        port.on('error', (err2) => finish(err2));
        // The KAT500's microcontroller may be asleep; wake + probe with nulls.
        port.write(';;;');
      });
    });
  }

  openAt(path, baud) {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
      port.open((err) => {
        if (err) return reject(err);
        this.attach(port, path, baud);
        resolve();
      });
    });
  }

  attach(port, path, baud) {
    this.port = port;
    this.buffer = '';
    this.pollTick = 0;
    this.configuredBaud = baud;
    this.setState({
      connected: true,
      connecting: false,
      path,
      baud,
      lastError: null,
    });
    this.log(`Connected to ${path} @ ${baud} baud`);

    port.on('data', (chunk) => this.onData(chunk));
    port.on('close', () => this.onDisconnect('port closed'));
    port.on('error', (err) => this.onDisconnect(err.message));

    this.startPolling();
    this.primeState();
  }

  onDisconnect(reason) {
    if (!this.state.connected && !this.state.connecting) return;
    this.setState({
      connected: false,
      connecting: false,
      lastError: reason,
      ...this.liveFieldDefaults(),
    });
    this.log(`Disconnected: ${reason}`);
    this.stopPolling();
    this.failQueue(new Error(reason));
    if (this.port) {
      try {
        this.port.removeAllListeners();
      } catch (e) {
        /* ignore */
      }
    }
    this.port = null;
    this.scheduleReconnect();
  }

  disconnect() {
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failQueue(new Error('disconnected'));
    if (this.port) {
      try {
        this.port.removeAllListeners();
        this.port.close(() => {});
      } catch (e) {
        /* ignore */
      }
    }
    this.port = null;
    this.setState({ connected: false, connecting: false, ...this.liveFieldDefaults() });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.configuredPath) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect({ path: this.configuredPath, baud: this.configuredBaud });
      } catch (err) {
        this.scheduleReconnect();
      }
    }, 3000);
  }

  // --- command queue ----------------------------------------------------

  enqueue(cmd, { awaitResponse = true, timeoutMs = 800 } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, awaitResponse, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.waiting || this.queue.length === 0) return;
    if (!this.port || !this.state.connected) {
      this.failQueue(new Error('not connected'));
      return;
    }
    const job = this.queue.shift();
    const wire = job.cmd.endsWith(';') ? job.cmd : `${job.cmd};`;
    this.port.write(wire);
    this.log(`> ${wire}`);

    if (!job.awaitResponse) {
      job.resolve(null);
      setTimeout(() => this.pump(), 15);
      return;
    }

    const timer = setTimeout(() => {
      this.waiting = null;
      job.reject(new Error(`timeout waiting for response to ${job.cmd}`));
      this.pump();
    }, job.timeoutMs);
    this.waiting = { job, timer };
  }

  failQueue(err) {
    const jobs = this.queue.splice(0, this.queue.length);
    jobs.forEach((job) => job.reject(err));
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.job.reject(err);
      this.waiting = null;
    }
  }

  /** GET command: always produces a response. */
  get(cmd, timeoutMs = 800) {
    return this.enqueue(cmd, { awaitResponse: true, timeoutMs });
  }

  /**
   * SET command: per Elecraft's guidance, most SET commands produce no
   * response. We follow each one with the null command (";"), which always
   * echoes back, giving us flow control without guessing per-command timing.
   */
  async set(cmd, { syncTimeoutMs = 500 } = {}) {
    this.enqueue(cmd, { awaitResponse: false });
    return this.enqueue(';', { awaitResponse: true, timeoutMs: syncTimeoutMs });
  }

  /** Start a full tune. Tuning can take several seconds; the KAT500 may not
   * service the serial port again until it completes, so we allow a long
   * timeout on the sync step rather than treating it as an error. */
  async startTune(cmd = 'T') {
    this.enqueue(cmd, { awaitResponse: false });
    this.setState({ tuning: true });
    try {
      await this.enqueue(';', { awaitResponse: true, timeoutMs: 30000 });
    } catch (err) {
      this.log(`tune sync: ${err.message}`);
    }
  }

  // --- incoming data ------------------------------------------------------

  onData(chunk) {
    this.buffer += chunk.toString('ascii');
    let idx;
    while ((idx = this.buffer.indexOf(';')) !== -1) {
      const token = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (token.length > 0) {
        this.log(`< ${token};`);
        this.handleMessage(token);
      }
      if (this.waiting) {
        clearTimeout(this.waiting.timer);
        this.waiting.job.resolve(token);
        this.waiting = null;
        this.pump();
      }
    }
  }

  handleMessage(token) {
    let m;

    if ((m = /^AN(\d)$/.exec(token))) {
      this.setState({ antenna: Number(m[1]) });
      return;
    }
    if ((m = /^MD([BMA])$/.exec(token))) {
      const mode = { B: 'bypass', M: 'manual', A: 'auto' }[m[1]];
      this.setState({ mode });
      return;
    }
    if ((m = /^BYP([NB])$/.exec(token))) {
      this.setState({ bypass: m[1] === 'B' });
      return;
    }
    if ((m = /^VSWRB\s*([\d.]+)$/.exec(token))) {
      this.setState({ vswrBypass: Number(m[1]) });
      return;
    }
    if ((m = /^VSWR\s*([\d.]+)$/.exec(token))) {
      this.setState({ vswr: Number(m[1]) });
      return;
    }
    if ((m = /^FLT(\d)$/.exec(token))) {
      const fault = Number(m[1]);
      this.setState({ fault, faultMessage: FAULT_MESSAGES[fault] || `Fault ${fault}` });
      return;
    }
    if ((m = /^TP([01])$/.exec(token))) {
      this.setState({ tuning: m[1] === '1' });
      return;
    }
    if (token === 'FT') {
      // Full tune completed (response to T; or FT;, may arrive unsolicited
      // relative to the queue if it followed a slow tune).
      this.setState({ tuning: false });
      this.get('VSWR').catch(() => {});
      this.get('FLT').catch(() => {});
      this.events.emit('tuneComplete');
      return;
    }
    if ((m = /^RV\s*(.+)$/.exec(token))) {
      this.setState({ firmware: m[1] });
      return;
    }
    if ((m = /^SN\s*(.+)$/.exec(token))) {
      this.setState({ serialNumber: m[1] });
      return;
    }
    if ((m = /^BN(\d{2})$/.exec(token))) {
      this.setState({ band: m[1], bandLabel: bandLabel(m[1]) });
      return;
    }
    // Unrecognized token (I;, DM, FY, etc.) - ignore for now, still logged above.
  }

  // --- polling --------------------------------------------------------------

  async primeState() {
    try {
      await this.get('I', 500).catch(() => {});
      await this.get('RV').catch(() => {});
      await this.get('SN').catch(() => {});
      await this.get('AN').catch(() => {});
      await this.get('MD').catch(() => {});
      await this.get('BYP').catch(() => {});
      await this.get('BN').catch(() => {});
      await this.get('VSWR').catch(() => {});
      await this.get('FLT').catch(() => {});
    } catch (err) {
      /* connection may have dropped mid-sequence; polling loop will retry */
    }
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.pollOnce(), 1000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollOnce() {
    if (!this.state.connected || this.queue.length > 2) return;
    this.pollTick += 1;
    try {
      await this.get('TP').catch(() => {});
      await this.get('VSWR').catch(() => {});
      if (this.pollTick % 3 === 0) {
        await this.get('FLT').catch(() => {});
      }
      if (this.pollTick % 5 === 0) {
        await this.get('AN').catch(() => {});
        await this.get('MD').catch(() => {});
        await this.get('BYP').catch(() => {});
        await this.get('BN').catch(() => {});
      }
    } catch (err) {
      /* ignore poll errors; connection watchdog handles real drops */
    }
  }

  // --- high level actions -------------------------------------------------

  // SET commands generally produce no response (see class doc comment at
  // top of file), so the UI's cached state would otherwise only catch up
  // on the next slow poll tick (up to several seconds, longer if the queue
  // is busy). Re-GET immediately after each SET so the UI reflects the new
  // state right away instead of waiting on the background poller.
  //
  // Each action below is a small sequence of enqueued commands (SET, then
  // one or more follow-up GETs). Two actions fired back to back (e.g. the
  // UI POSTing a second command before the first HTTP request returns)
  // could otherwise interleave their steps on the shared queue and leave
  // state reflecting neither action cleanly. withLock() forces actions to
  // run one at a time, in the order they arrive.
  withLock(fn) {
    const run = this.actionLock.then(fn, fn);
    this.actionLock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  setAntenna(n) {
    if (![0, 1, 2, 3].includes(n)) throw new Error('antenna must be 0-3');
    return this.withLock(async () => {
      await this.set(`AN${n}`);
      return this.get('AN').catch(() => {});
    });
  }

  setMode(mode) {
    const code = { bypass: 'B', manual: 'M', auto: 'A' }[mode];
    if (!code) throw new Error('mode must be bypass, manual, or auto');
    return this.withLock(async () => {
      await this.set(`MD${code}`);
      await this.get('MD').catch(() => {});
      return this.get('BYP').catch(() => {});
    });
  }

  setBypass(bypassed) {
    return this.withLock(async () => {
      await this.set(bypassed ? 'BYPB' : 'BYPN');
      return this.get('BYP').catch(() => {});
    });
  }

  setBand(code) {
    if (!BANDS.some((b) => b.code === code)) throw new Error('invalid band code');
    return this.withLock(async () => {
      await this.set(`BN${code}`);
      await this.get('BN').catch(() => {});
      return this.get('AN').catch(() => {});
    });
  }

  tune() {
    return this.withLock(() => this.startTune('T'));
  }

  cancelTune() {
    return this.withLock(() => this.set('CT'));
  }

  clearFault() {
    return this.withLock(() => this.set('FLTC'));
  }

  raw(cmd) {
    return this.withLock(() => this.get(cmd, 1500));
  }
}

KAT500.BANDS = BANDS;

module.exports = KAT500;
