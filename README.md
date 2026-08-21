# KAT-500 Web App Remote

A browser-based remote control panel for the [Elecraft KAT500](https://elecraft.com/products/kat500) automatic antenna tuner — operate it from any browser tab (Chrome, Safari, mobile) instead of Elecraft's desktop-only utility.

Created by **K2COP**.

![KAT-500 Web App Remote control panel](docs/screenshot.png)

## Why this exists

The KAT500 has no display and no network interface of its own — it's a serial-only device, reachable exclusively over its rear-panel "PC DATA" RS-232 port. Elecraft's own `KAT500 Utility` covers that, but it's Windows/Mac desktop software tied to whatever machine it's installed on.

This project is the missing bridge: a small Node.js server with a USB-serial connection to the tuner, exposing a live control panel over HTTP/WebSocket so you can operate the tuner (antenna select, mode, tune, SWR, fault handling) from a browser anywhere on your network — or remotely, tunneled alongside your station's other remote-operating tools.

It talks to the KAT500 using the ASCII command set documented in Elecraft's own [KAT500 Serial Command Reference](https://ftp.elecraft.com/KAT500/Manuals%20Downloads/KAT500%20Automatic%20Antenna%20Tuner%20Serial%20Command%20Reference.pdf).

## Features

- **Power on/off** — logically power the KAT500 on or off over serial, same as holding the front-panel MODE button
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

This app runs on whatever computer the KAT500's USB/serial cable is plugged into — that machine acts as the server, and any browser (on that machine or elsewhere on your network) connects to it. You don't need any programming experience to set it up, just the steps below.

### 1. Install Node.js

This is the program the server runs on top of.

1. Go to **https://nodejs.org** and download the version marked **LTS** (not "Current")
2. Run the installer with the default options

**Check it worked** — open a terminal (see below) and run:
```
node --version
```
You should see something like `v20.x.x`.

- **Windows:** open the Start Menu, type `cmd`, press Enter
- **macOS:** press `Cmd+Space`, type `Terminal`, press Enter

### 2. Get the code onto your computer

On this GitHub page, click the green **`<> Code`** button → **Download ZIP**, then extract it:
- **Windows:** right-click the downloaded ZIP → **Extract All**
- **macOS:** double-click the downloaded ZIP in Finder — it extracts automatically. Note the extracted folder will be named `kat-500-web-app-remote-main`.

*(If you're comfortable with git, `git clone https://github.com/K2COP/kat-500-web-app-remote.git` works too.)*

### 3. Open a terminal in that folder

- **Windows:** open the extracted folder in File Explorer, click in the address bar at the top, type `cmd`, press Enter — a command prompt opens already pointed at that folder.
- **macOS:** right-click the extracted folder in Finder → **New Terminal at Folder**. (If that option isn't there, open Terminal and type `cd ` followed by dragging the folder into the window, then press Enter.)

### 4. Install and start the app

In that terminal, run:
```
npm install
```
Wait for it to finish (downloads some files, ~30 seconds), then:
```
npm start
```
You should see `KAT500 web control listening on http://localhost:8500`. **Leave this window open** — closing it stops the app.

### 5. Plug in the KAT500 and connect

1. Connect the KAT500 to this computer via USB (through your USB-to-serial adapter, if that's how it's wired) and power it on.
2. Open Chrome or Safari and go to **http://localhost:8500**
3. In the **Connection** panel, pick your device from the port dropdown, leave baud on **Auto-detect**, and click **Connect**.

If the port doesn't show up in the list, the USB-to-serial adapter's driver probably isn't installed. Check what chip it uses (Windows: Device Manager; macOS: it'll be obvious from the port name, e.g. `SLAB_USBtoUART` = Silicon Labs, `usbserial` = FTDI) and grab the driver from [Silicon Labs](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers), [FTDI](https://ftdichip.com/drivers/vcp-drivers/), or your adapter's manufacturer.

### Next time

You don't need to repeat steps 1–2. Just repeat steps 3–4 (open a terminal in the folder, `npm start`) whenever you want to use it, then open the browser page again.

The server remembers your serial port and baud rate (in a `config.json` it creates on first connect — see `config.example.json` for the shape) and reconnects automatically every time it starts. Change `httpPort` there if `8500` conflicts with something else on your machine.

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
