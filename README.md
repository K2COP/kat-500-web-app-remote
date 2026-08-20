# KAT-500 Web App Remote

A browser-based remote control panel for the [Elecraft KAT500](https://elecraft.com/products/kat500) automatic antenna tuner — operate it from any browser tab (Chrome, Safari, mobile) instead of Elecraft's desktop-only utility.

Created by **K2COP**.

## Why this exists

The KAT500 has no display and no network interface of its own — it's a serial-only device, reachable exclusively over its rear-panel "PC DATA" RS-232 port. Elecraft's own `KAT500 Utility` covers that, but it's Windows/Mac desktop software tied to whatever machine it's installed on.

This project is the missing bridge: a small Node.js server with a USB-serial connection to the tuner, exposing a live control panel over HTTP/WebSocket so you can operate the tuner (antenna select, mode, tune, SWR, fault handling) from a browser anywhere on your network — or remotely, tunneled alongside your station's other remote-operating tools.

It talks to the KAT500 using the ASCII command set documented in Elecraft's own [KAT500 Serial Command Reference](https://ftp.elecraft.com/KAT500/Manuals%20Downloads/KAT500%20Automatic%20Antenna%20Tuner%20Serial%20Command%20Reference.pdf).

## Features

- **Antenna select** — ANT 1/2/3, or cycle like the front-panel ANT button
- **Mode** — Bypass / Manual / Auto, with instant visual feedback on change
- **Band override**
- **Full search tune** — start/cancel, with a live tuning-in-progress indicator
- **Live telemetry** — SWR (matched and bypass/antenna), fault display with one-click clear
- **Device info** — firmware revision, serial number, connected port
- **Baud auto-detection** — probes 38400 / 19200 / 9600 / 4800, the same sequence Elecraft's own utility uses, so you don't need to know the tuner's configured speed
- **Auto-reconnect** — remembers the last working serial port and baud rate, and reconnects automatically after a server restart or a dropped connection
- **Advanced raw command console** — every GET command in Elecraft's reference works here (`AKIP`, `ST05A`, `DM`, etc.), for anything outside the main panel

## How it works

```
Browser (Chrome/Safari/mobile) <--HTTP/WebSocket--> Node.js server <--RS-232 (USB-serial)--> KAT500
```

The server owns a single serial connection to the tuner and enforces the flow-controlled request/response pacing the KAT500 expects, so multiple browser tabs can safely share one connection. It polls live values (SWR, fault, tune status) on an interval and pushes updates to every connected browser over a WebSocket, so the panel stays live without manual refreshing.

## Requirements

- An Elecraft KAT500, connected to your computer via its "PC DATA" serial port (USB-to-serial adapter or native serial port)
- [Node.js](https://nodejs.org/) (LTS)

## Setup

```
npm install
npm start
```

Then open `http://localhost:8500` in a browser on that machine. Use the **Connection** panel to pick the serial port (e.g. `COM5` on Windows, `/dev/tty.usbserial-XXXX` on macOS/Linux) and click **Connect**. Leave baud on "Auto-detect" unless you know the tuner's configured rate.

The server writes its own `config.json` (git-ignored, see `config.example.json` for the shape) the first time you connect, and reconnects to that same port/baud automatically on every future start. Change `httpPort` there if `8500` conflicts with something else on your machine.

## Remote operation

If you're already running a remote-station setup (e.g. [TCI Remote Compactor](https://pure-editions.com/on7off/TCI-Remote-Compactor/) alongside Thetis/openHPSDR for a Hermes Lite 2 or Apache Labs ANAN), you likely don't need a separate VPN for this. Compactor's **Remote Web Shortcuts** feature proxies local web interfaces (it lists "antenna tuner" as a built-in example) through its existing tunnel. Point one of its shortcut slots at `http://localhost:8500` and the control panel becomes reachable from wherever you're operating, alongside your SDR control.

Any other tunnel/VPN that can reach the server's port (Tailscale, WireGuard, SSH port-forward, etc.) works just as well.

## Scope

This covers the "operate" surface — what you'd use remotely during a QSO. It intentionally does not cover the full configuration surface (per-band antenna enable/preference, VSWR thresholds, memory management) that Elecraft's desktop utility handles; those are one-time setup tasks best done locally with the KAT500 Utility.

## Related

A web control app for the Elecraft KPA-500 amplifier is planned as a follow-on project, using the same bridge-server pattern (the KPA-500 also has a documented serial Programmer's Reference).

## Disclaimer

This is an independent, community project and is not affiliated with, endorsed by, or supported by Elecraft, Inc. "Elecraft" and "KAT500" are trademarks of Elecraft, Inc. Use at your own risk — this software drives relays in your antenna tuner over a live RF path.

## License

[GPL-3.0](LICENSE) © K2COP
