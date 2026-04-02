# ilovevideo

In-browser video editor using **ffmpeg.wasm** for encode/decode and standard browser APIs (`<video>`, File, Blob URLs) for playback and download.

## Features (current)

- Open a local video file
- Preview with native controls
- Trim with in/out sliders or “set in/out from playhead”
- Export selection to **MP4** (stream copy when possible, otherwise H.264/AAC re-encode)

## Run locally

```bash
npm install
npm run dev
```

Open the URL printed by Vite (default `http://localhost:5173`). The dev server sets COOP/COEP headers so **SharedArrayBuffer** is available if you later switch to the multi-thread ffmpeg core.

## Build

```bash
npm run build
npm run preview
```

## Cursor: Vercel agent plugin (optional)

The app does not depend on this. The [Vercel plugin for coding agents](https://vercel.com/docs/agent-resources/vercel-plugin) adds Vercel skills and slash commands in **Cursor** (and Claude Code).

```bash
npm run setup:vercel-plugin
```

That runs `npx plugins add vercel/vercel-plugin -y`. If the installer says **No supported targets** (no `claude` / `cursor` on your `PATH`), use an explicit target:

```bash
npx plugins add vercel/vercel-plugin -t cursor -s project -y
```

Restart Cursor after install.

## Deploy on Vercel

The repo includes `vercel.json` with **COOP** and **COEP** headers on all routes. Those headers match the dev server and are required for **ffmpeg.wasm** (and `SharedArrayBuffer`) in production.

1. Import the Git repository in [Vercel](https://vercel.com).
2. Use the defaults: **Framework Preset** Vite (or “Other” with `npm run build` and output directory `dist`).
3. Deploy.

No server runtime is required; the app is static files from `dist/`.

## Project layout

```
├── index.html
├── package.json
├── vercel.json
├── vite.config.js
└── src/
    ├── main.js          # UI and wiring
    ├── ffmpegClient.js  # ffmpeg load + trim export
    └── styles.css
```

First-time **Load ffmpeg** downloads the wasm core (~31 MB) from the CDN.

## Next steps (ideas)

- Timeline with waveform / thumbnails
- Multiple clips or concat
- Filters (scale, rotation) via ffmpeg filters
- Undo stack for trim edits
