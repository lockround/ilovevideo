import { getFFmpeg, trimToMp4 } from './ffmpegClient.js';

const $ = (sel, root = document) => root.querySelector(sel);

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const frac = Math.round((s - whole) * 10);
  return `${m}:${whole.toString().padStart(2, '0')}.${frac}`;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function buildUI(root) {
  root.innerHTML = `
    <header>
      <h1>ilovevideo</h1>
      <p>In-browser trim and export (ffmpeg.wasm). Load a clip, set in/out, export MP4.</p>
    </header>

    <div class="toolbar">
      <label class="file-label">Open video<input id="file" type="file" accept="video/*" /></label>
      <button type="button" id="btn-load-ffmpeg" title="Download ffmpeg core (~31 MB)">Load ffmpeg</button>
      <span id="ffmpeg-state" style="font-size:0.85rem;color:var(--muted)">ffmpeg: not loaded</span>
    </div>

    <div class="preview-wrap" id="preview-wrap">
      <video id="video" playsinline controls></video>
      <div class="preview-placeholder">Open a video to preview</div>
    </div>

    <div class="transport">
      <button type="button" id="btn-play">Play</button>
      <button type="button" id="btn-pause">Pause</button>
      <span class="time"><span id="cur">0:00.0</span> / <span id="dur">0:00.0</span></span>
    </div>

    <section class="trim-panel">
      <h2>Trim</h2>
      <div class="range-row">
        <label for="in-slider">In (start)</label>
        <input type="range" id="in-slider" min="0" max="1000" value="0" step="1" />
      </div>
      <div class="range-row">
        <label for="out-slider">Out (end)</label>
        <input type="range" id="out-slider" min="0" max="1000" value="1000" step="1" />
      </div>
      <div class="range-actions">
        <button type="button" id="btn-in">Set in from playhead</button>
        <button type="button" id="btn-out">Set out from playhead</button>
        <button type="button" id="btn-reset-trim">Reset full length</button>
      </div>
      <div style="margin-top:0.75rem;display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">
        <button type="button" class="primary" id="btn-export" disabled>Export trimmed MP4</button>
        <a id="download-link" href="#" download="trimmed.mp4" style="display:none;font-size:0.9rem;color:var(--accent)">Download last export</a>
      </div>
    </section>

    <div class="status-bar" id="status"></div>
  `;

  const status = $('#status', root);
  const progWrap = document.createElement('div');
  progWrap.className = 'progress-outer';
  progWrap.id = 'prog-wrap';
  const prog = document.createElement('div');
  prog.className = 'progress-inner';
  prog.id = 'prog';
  progWrap.appendChild(prog);
  status.appendChild(progWrap);

  const video = $('#video', root);
  const fileInput = $('#file', root);
  const previewWrap = $('#preview-wrap', root);
  const curEl = $('#cur', root);
  const durEl = $('#dur', root);
  const inSlider = $('#in-slider', root);
  const outSlider = $('#out-slider', root);
  const btnLoadFfmpeg = $('#btn-load-ffmpeg', root);
  const ffmpegState = $('#ffmpeg-state', root);
  const btnPlay = $('#btn-play', root);
  const btnPause = $('#btn-pause', root);
  const btnIn = $('#btn-in', root);
  const btnOut = $('#btn-out', root);
  const btnResetTrim = $('#btn-reset-trim', root);
  const btnExport = $('#btn-export', root);
  const downloadLink = $('#download-link', root);

  let objectUrl = null;
  /** @type {File | null} */
  let currentFile = null;
  let durationSec = 0;
  let inSec = 0;
  let outSec = 0;
  let ffmpegReady = false;

  function setStatus(text, showProgress = false) {
    const msg = document.createElement('div');
    msg.textContent = text;
    status.replaceChildren(msg, progWrap);
    progWrap.classList.toggle('visible', showProgress);
    if (!showProgress) prog.style.width = '0%';
  }

  setStatus('Ready. Open a video, then load ffmpeg to export.');

  function syncSlidersFromState() {
    const d = durationSec || 1;
    inSlider.max = String(Math.max(1000, Math.round(d * 1000)));
    outSlider.max = inSlider.max;
    inSlider.value = String(Math.round((inSec / d) * Number(inSlider.max)));
    outSlider.value = String(Math.round((outSec / d) * Number(outSlider.max)));
  }

  function readSliders() {
    const d = durationSec || 1;
    const imax = Number(inSlider.max) || 1000;
    inSec = (Number(inSlider.value) / imax) * d;
    outSec = (Number(outSlider.value) / imax) * d;
    if (outSec <= inSec) {
      outSec = Math.min(d, inSec + 0.1);
      outSlider.value = String(Math.round((outSec / d) * imax));
    }
  }

  function updateExportEnabled() {
    btnExport.disabled = !ffmpegReady || !currentFile || durationSec <= 0 || outSec <= inSec;
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    currentFile = file;
    video.src = objectUrl;
    previewWrap.classList.add('has-video');
    setStatus(`Loaded "${file.name}".`);
    downloadLink.style.display = 'none';
  });

  video.addEventListener('loadedmetadata', () => {
    durationSec = video.duration || 0;
    inSec = 0;
    outSec = durationSec;
    durEl.textContent = formatTime(durationSec);
    syncSlidersFromState();
    updateExportEnabled();
  });

  video.addEventListener('timeupdate', () => {
    curEl.textContent = formatTime(video.currentTime);
    readSliders();
    if (video.currentTime > outSec - 0.04) {
      video.pause();
      video.currentTime = outSec;
    }
  });

  ['input', 'change'].forEach((ev) => {
    inSlider.addEventListener(ev, () => {
      readSliders();
      if (inSec > video.currentTime) video.currentTime = inSec;
      updateExportEnabled();
    });
    outSlider.addEventListener(ev, () => {
      readSliders();
      updateExportEnabled();
    });
  });

  btnPlay.addEventListener('click', () => {
    readSliders();
    if (video.currentTime < inSec || video.currentTime >= outSec) video.currentTime = inSec;
    video.play();
  });

  btnPause.addEventListener('click', () => video.pause());

  btnIn.addEventListener('click', () => {
    readSliders();
    const t = clamp(video.currentTime, 0, durationSec);
    inSec = t;
    if (outSec <= inSec) outSec = Math.min(durationSec, inSec + 0.1);
    syncSlidersFromState();
    updateExportEnabled();
  });

  btnOut.addEventListener('click', () => {
    readSliders();
    const t = clamp(video.currentTime, 0, durationSec);
    outSec = t;
    if (outSec <= inSec) inSec = Math.max(0, outSec - 0.1);
    syncSlidersFromState();
    updateExportEnabled();
  });

  btnResetTrim.addEventListener('click', () => {
    inSec = 0;
    outSec = durationSec;
    syncSlidersFromState();
    updateExportEnabled();
  });

  btnLoadFfmpeg.addEventListener('click', async () => {
    btnLoadFfmpeg.disabled = true;
    ffmpegState.textContent = 'ffmpeg: loading…';
    setStatus('Loading ffmpeg (~31 MB). First run may take a minute.', true);
    try {
      await getFFmpeg();
      ffmpegReady = true;
      ffmpegState.textContent = 'ffmpeg: ready';
      setStatus('ffmpeg loaded. You can export trimmed MP4.');
    } catch (e) {
      console.error(e);
      ffmpegState.textContent = 'ffmpeg: error';
      setStatus(`Failed to load ffmpeg: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      btnLoadFfmpeg.disabled = false;
      updateExportEnabled();
    }
  });

  btnExport.addEventListener('click', async () => {
    if (!currentFile || !ffmpegReady) return;
    readSliders();
    btnExport.disabled = true;
    setStatus('Encoding…', true);
    try {
      const blob = await trimToMp4(currentFile, inSec, outSec, (p) => {
        prog.style.width = `${Math.round(p * 100)}%`;
      });
      const url = URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.download = `trim-${Math.round(inSec)}-${Math.round(outSec)}.mp4`;
      downloadLink.style.display = 'inline';
      downloadLink.textContent = 'Download trimmed MP4';
      setStatus('Export finished. Use the download link.');
    } catch (e) {
      console.error(e);
      setStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      progWrap.classList.remove('visible');
      updateExportEnabled();
    }
  });
}

const app = $('#app');
if (app) buildUI(app);
