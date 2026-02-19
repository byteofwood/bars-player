# Bars Player

Android-first PWA music player built with React + Vite + TypeScript.

## Requirements

- Node.js 20+
- npm 10+

## Install

```bash
npm install
```

## Run on local network with HTTPS (Vite)

Start the dev server bound to all interfaces and with HTTPS enabled:

```bash
npm run dev:https -- --host 0.0.0.0 --port 5173
```

`dev:https` runs Vite in `https` mode, which enables TLS in `vite.config.ts`.

Vite will print both local and network URLs, for example:

- `https://localhost:5173`
- `https://192.168.1.25:5173`

On your Android device (same Wi-Fi network), open the network URL.

Notes:

- Your browser may show a warning for the local HTTPS certificate in development.
- Accept/trust the cert warning to continue.
- For PWA testing, use Chrome on Android.

## Build

```bash
npm run build
```

## Preview production build

```bash
npm run preview:https -- --host 0.0.0.0 --port 4173
```
