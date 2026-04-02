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

/** @typedef {{ id: string, file: File, url: string, name: string }} Clip */

function buildUI(root) {
  root.innerHTML = `
    <header>
      <h1>ilovevideo</h1>
      <p>Capture, upload, trim, and export (ffmpeg.wasm). Frame-by-frame on the timeline.</p>
    </header>

    <div class="toolbar">
      <label class="file-label">Upload video<input id="file" type="file" accept="video/*" multiple /></label>
      <button type="button" id="btn-camera-toggle" title="Record from webcam">Record camera</button>
      <button type="button" id="btn-load-ffmpeg" title="Download ffmpeg core (~31 MB)">Load ffmpeg</button>
      <span id="ffmpeg-state" style="font-size:0.85rem;color:var(--muted)">ffmpeg: not loaded</span>
    </div>

    <div class="camera-panel hidden" id="camera-panel">
      <video id="camera-preview" playsinline muted></video>
      <div class="camera-actions">
        <button type="button" id="btn-rec-start" disabled>Start recording</button>
        <button type="button" id="btn-rec-stop" disabled>Stop &amp; add clip</button>
        <button type="button" id="btn-camera-close" class="ghost">Close</button>
      </div>
      <p class="camera-hint">Allow camera access. Recording uses your browser’s default WebM codec.</p>
    </div>

    <section class="clips-panel" id="clips-panel">
      <h2 class="panel-title">Clips</h2>
      <ul class="clip-list" id="clip-list"></ul>
      <p class="clips-empty" id="clips-empty">No clips yet. Upload or record.</p>
    </section>

    <div class="preview-wrap" id="preview-wrap">
      <video id="video" playsinline controls></video>
      <div class="preview-placeholder">Upload, record, or pick a clip</div>
    </div>

    <section class="timeline-panel">
      <h2 class="panel-title">Timeline</h2>
      <div class="timeline-scrub-row">
        <input type="range" id="timeline-scrub" class="timeline-scrub" min="0" max="1000" value="0" step="any" disabled />
      </div>
      <div class="timeline-meta">
        <span id="timeline-frame">Frame —</span>
        <label class="fps-label">Step FPS <input type="number" id="fps-step" min="1" max="120" value="30" step="1" /></label>
      </div>
      <div class="frame-tools">
        <button type="button" id="btn-frame-prev" disabled>◀ Prev frame</button>
        <button type="button" id="btn-frame-next" disabled>Next frame ▶</button>
      </div>
    </section>

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

  const timelineScrub = $('#timeline-scrub', root);
  const fpsStepInput = $('#fps-step', root);
  const timelineFrameEl = $('#timeline-frame', root);
  const btnFramePrev = $('#btn-frame-prev', root);
  const btnFrameNext = $('#btn-frame-next', root);

  const clipListEl = $('#clip-list', root);
  const clipsEmptyEl = $('#clips-empty', root);
  const cameraPanel = $('#camera-panel', root);
  const btnCameraToggle = $('#btn-camera-toggle', root);
  const cameraPreview = $('#camera-preview', root);
  const btnRecStart = $('#btn-rec-start', root);
  const btnRecStop = $('#btn-rec-stop', root);
  const btnCameraClose = $('#btn-camera-close', root);

  /** @type {Clip[]} */
  let clips = [];
  let activeClipId = '';
  let objectUrl = null;
  /** @type {File | null} */
  let currentFile = null;
  let durationSec = 0;
  let inSec = 0;
  let outSec = 0;
  let ffmpegReady = false;
  /** @type {MediaStream | null} */
  let cameraStream = null;
  /** @type {MediaRecorder | null} */
  let mediaRecorder = null;
  const recordedChunks = [];
  let scrubbing = false;

  function setStatus(text, showProgress = false) {
    const msg = document.createElement('div');
    msg.textContent = text;
    status.replaceChildren(msg, progWrap);
    progWrap.classList.toggle('visible', showProgress);
    if (!showProgress) prog.style.width = '0%';
  }

  setStatus('Ready. Add a clip from upload or camera, then load ffmpeg to export.');

  function getStepSec() {
    const fps = Number(fpsStepInput.value);
    if (!Number.isFinite(fps) || fps < 1) return 1 / 30;
    return 1 / fps;
  }

  function updateFrameLabel() {
    const fps = Number(fpsStepInput.value);
    const f = Number.isFinite(fps) && fps > 0 ? Math.round(video.currentTime * fps) : 0;
    timelineFrameEl.textContent = `Frame ~${f} · ${formatTime(video.currentTime)}`;
  }

  function syncTimelineScrubFromVideo() {
    if (scrubbing || !durationSec) return;
    const max = Number(timelineScrub.max) || 1000;
    timelineScrub.value = String((video.currentTime / durationSec) * max);
    updateFrameLabel();
  }

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

  function updateClipsUI() {
    clipListEl.innerHTML = '';
    clips.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'clip-item' + (c.id === activeClipId ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'clip-name';
      name.textContent = c.name;
      const actions = document.createElement('div');
      actions.className = 'clip-actions';
      const sel = document.createElement('button');
      sel.type = 'button';
      sel.textContent = c.id === activeClipId ? 'Playing' : 'Use';
      sel.disabled = c.id === activeClipId;
      sel.addEventListener('click', () => selectClip(c.id));
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'danger-link';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => removeClip(c.id));
      actions.append(sel, rm);
      li.append(name, actions);
      clipListEl.appendChild(li);
    });
    clipsEmptyEl.style.display = clips.length ? 'none' : 'block';
  }

  function selectClip(id) {
    const c = clips.find((x) => x.id === id);
    if (!c) return;
    activeClipId = id;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = c.url;
    currentFile = c.file;
    video.src = objectUrl;
    previewWrap.classList.add('has-video');
    updateClipsUI();
    downloadLink.style.display = 'none';
  }

  function removeClip(id) {
    const idx = clips.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const [removed] = clips.splice(idx, 1);
    URL.revokeObjectURL(removed.url);
    if (activeClipId === id) {
      activeClipId = '';
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      currentFile = null;
      video.removeAttribute('src');
      video.load();
      previewWrap.classList.remove('has-video');
      durationSec = 0;
      inSec = 0;
      outSec = 0;
      durEl.textContent = formatTime(0);
      curEl.textContent = formatTime(0);
      timelineScrub.disabled = true;
      btnFramePrev.disabled = true;
      btnFrameNext.disabled = true;
      updateFrameLabel();
    }
    if (clips.length && activeClipId === '') {
      selectClip(clips[0].id);
    }
    updateClipsUI();
    updateExportEnabled();
  }

  function addClipFromFile(file) {
    const url = URL.createObjectURL(file);
    const id = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const clip = { id, file, url, name: file.name };
    clips.push(clip);
    selectClip(id);
    setStatus(`Added "${file.name}".`);
  }

  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files?.length) return;
    for (let i = 0; i < files.length; i++) addClipFromFile(files[i]);
    fileInput.value = '';
  });

  video.addEventListener('loadedmetadata', () => {
    durationSec = video.duration || 0;
    inSec = 0;
    outSec = durationSec;
    durEl.textContent = formatTime(durationSec);
    syncSlidersFromState();
    const max = Math.max(1000, Math.round(durationSec * 1000));
    timelineScrub.max = String(max);
    timelineScrub.disabled = false;
    btnFramePrev.disabled = false;
    btnFrameNext.disabled = false;
    timelineScrub.value = '0';
    updateExportEnabled();
    updateFrameLabel();
  });

  video.addEventListener('timeupdate', () => {
    curEl.textContent = formatTime(video.currentTime);
    readSliders();
    syncTimelineScrubFromVideo();
    if (video.currentTime > outSec - 0.04) {
      video.pause();
      video.currentTime = outSec;
    }
  });

  video.addEventListener('seeked', () => {
    updateFrameLabel();
    syncTimelineScrubFromVideo();
  });

  timelineScrub.addEventListener('pointerdown', () => {
    scrubbing = true;
    video.pause();
  });
  timelineScrub.addEventListener('pointerup', () => {
    scrubbing = false;
  });
  timelineScrub.addEventListener('pointercancel', () => {
    scrubbing = false;
  });
  timelineScrub.addEventListener('change', () => {
    const max = Number(timelineScrub.max) || 1;
    const t = (Number(timelineScrub.value) / max) * durationSec;
    video.currentTime = clamp(t, 0, durationSec);
    curEl.textContent = formatTime(video.currentTime);
    updateFrameLabel();
  });
  timelineScrub.addEventListener('input', () => {
    const max = Number(timelineScrub.max) || 1;
    const t = (Number(timelineScrub.value) / max) * durationSec;
    video.currentTime = clamp(t, 0, durationSec);
    curEl.textContent = formatTime(video.currentTime);
    updateFrameLabel();
  });

  fpsStepInput.addEventListener('change', () => updateFrameLabel());

  function stepFrame(dir) {
    if (!durationSec) return;
    video.pause();
    const step = getStepSec();
    const t = clamp(video.currentTime + dir * step, 0, durationSec);
    video.currentTime = t;
  }

  btnFramePrev.addEventListener('click', () => stepFrame(-1));
  btnFrameNext.addEventListener('click', () => stepFrame(1));

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

  async function openCameraPanel() {
    cameraPanel.classList.remove('hidden');
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      cameraPreview.srcObject = cameraStream;
      await cameraPreview.play();
      btnRecStart.disabled = false;
      setStatus('Camera ready. Start recording when you are.');
    } catch (e) {
      console.error(e);
      setStatus(`Camera error: ${e instanceof Error ? e.message : String(e)}`);
      closeCameraPanel();
    }
  }

  function closeCameraPanel() {
    cameraPanel.classList.add('hidden');
    stopRecorderIfAny();
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    cameraPreview.srcObject = null;
    btnRecStart.disabled = true;
    btnRecStop.disabled = true;
  }

  function stopRecorderIfAny() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop();
      } catch {
        /* ignore */
      }
    }
    mediaRecorder = null;
  }

  btnCameraToggle.addEventListener('click', () => {
    if (cameraPanel.classList.contains('hidden')) openCameraPanel();
    else closeCameraPanel();
  });
  btnCameraClose.addEventListener('click', () => closeCameraPanel());

  btnRecStart.addEventListener('click', () => {
    if (!cameraStream) return;
    recordedChunks.length = 0;
    const mime =
      MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus'
      : MediaRecorder.isTypeSupported('video/webm') ? 'video/webm'
      : '';
    try {
      mediaRecorder = mime ? new MediaRecorder(cameraStream, { mimeType: mime }) : new MediaRecorder(cameraStream);
    } catch (e) {
      console.error(e);
      setStatus(`Recorder error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const recMime = mediaRecorder.mimeType || 'video/webm';
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) recordedChunks.push(ev.data);
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: recMime });
      const name = `camera-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
      const file = new File([blob], name, { type: blob.type });
      addClipFromFile(file);
      setStatus(`Recording saved as "${name}".`);
      btnRecStart.disabled = false;
      btnRecStop.disabled = true;
    };
    mediaRecorder.start(200);
    btnRecStart.disabled = true;
    btnRecStop.disabled = false;
    setStatus('Recording…');
  });

  btnRecStop.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
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

  updateClipsUI();
}

const app = $('#app');
if (app) buildUI(app);
