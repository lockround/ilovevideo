import { getFFmpeg, trimToMp4 } from './ffmpegClient.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const frac = Math.round((s - whole) * 10);
  return `${m}:${whole.toString().padStart(2, '0')}.${frac}`;
}

/** SMPTE-style timecode for default 30 fps display */
function formatTimecode(sec, fps) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00:00:00';
  const f = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(sec * f + 1e-9);
  const ff = totalFrames % f;
  const totalSec = Math.floor(totalFrames / f);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mi = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h.toString().padStart(2, '0')}:${mi.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${ff.toString().padStart(2, '0')}`;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** @typedef {{ id: string, file: File, url: string, name: string, thumbDataUrl?: string }} Clip */

const BLEND_MODES = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
];

function buildUI(root) {
  root.innerHTML = `
    <div class="app-titlebar">
      <h1>ilovevideo</h1>
      <span class="subtitle">In-browser trim &amp; export (ffmpeg.wasm)</span>
    </div>

    <div class="app-toolbar">
      <label class="file-label">Import media<input id="file" type="file" accept="video/*" multiple /></label>
      <button type="button" id="btn-camera-toggle" title="Record from webcam">Record</button>
      <button type="button" id="btn-load-ffmpeg" title="Download ffmpeg core (~31 MB)">Load ffmpeg</button>
      <span id="ffmpeg-state" style="font-size:0.75rem;color:var(--muted)">ffmpeg: not loaded</span>
    </div>

    <div class="camera-panel hidden" id="camera-panel">
      <video id="camera-preview" playsinline muted></video>
      <div class="camera-actions">
        <button type="button" id="btn-rec-start" disabled>Record</button>
        <button type="button" id="btn-rec-stop" disabled>Stop &amp; add</button>
        <button type="button" id="btn-camera-close" class="ghost">Close</button>
      </div>
      <p class="camera-hint">Webcam recording uses your browser default WebM codec.</p>
    </div>

    <div class="workspace">
      <div class="workspace-row-top">
        <div class="panel" id="panel-effects">
          <div class="panel-header">Effect Controls</div>
          <div class="panel-body">
            <div class="effect-section-title">Motion</div>
            <div class="effect-row">
              <label for="motion-pos-x">Position X</label><span class="effect-val" id="val-pos-x">50</span>
              <input type="range" id="motion-pos-x" min="0" max="100" value="50" step="0.1" />
            </div>
            <div class="effect-row">
              <label for="motion-pos-y">Position Y</label><span class="effect-val" id="val-pos-y">50</span>
              <input type="range" id="motion-pos-y" min="0" max="100" value="50" step="0.1" />
            </div>
            <div class="effect-row">
              <label for="motion-scale">Scale</label><span class="effect-val" id="val-scale">100</span>
              <input type="range" id="motion-scale" min="5" max="200" value="100" step="1" />
            </div>
            <div class="effect-row">
              <label for="motion-rot">Rotation</label><span class="effect-val" id="val-rot">0°</span>
              <input type="range" id="motion-rot" min="-180" max="180" value="0" step="0.5" />
            </div>
            <div class="effect-row">
              <label for="anchor-x">Anchor X</label><span class="effect-val" id="val-anchor-x">50</span>
              <input type="range" id="anchor-x" min="0" max="100" value="50" step="0.5" />
            </div>
            <div class="effect-row">
              <label for="anchor-y">Anchor Y</label><span class="effect-val" id="val-anchor-y">50</span>
              <input type="range" id="anchor-y" min="0" max="100" value="50" step="0.5" />
            </div>
            <div class="effect-section-title">Opacity</div>
            <div class="effect-row">
              <label for="opacity-range">Opacity</label><span class="effect-val" id="val-opacity">100%</span>
              <input type="range" id="opacity-range" min="0" max="100" value="100" step="1" />
            </div>
            <div class="effect-row">
              <label for="blend-mode">Blend mode</label>
              <select id="blend-mode" style="grid-column:1/-1;padding:0.2rem;font-size:0.72rem;background:#2a2a2a;border:1px solid var(--border);color:var(--text);border-radius:2px;">
                ${BLEND_MODES.map((b) => `<option value="${b.value}">${b.label}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>

        <div class="panel monitor-wrap" id="source-monitor">
          <div class="panel-header">Source</div>
          <div class="monitor-toolbar">
            <label>Zoom <select id="source-zoom"><option value="fit" selected>Fit</option><option value="25">25%</option><option value="50">50%</option><option value="100">100%</option></select></label>
            <label>Res <select id="source-res"><option value="full">Full</option><option value="half" selected>1/2</option><option value="quarter">1/4</option></select></label>
          </div>
          <div class="monitor-viewport" id="source-viewport">
            <canvas id="source-canvas" class="monitor-canvas"></canvas>
            <span class="monitor-placeholder">No clip</span>
          </div>
          <div class="monitor-transport">
            <button type="button" id="btn-mark-in" title="Mark in">[</button>
            <button type="button" id="btn-mark-out" title="Mark out">]</button>
            <span class="timecode" id="tc-source">00:00:00:00</span>
          </div>
        </div>

        <div class="panel monitor-wrap" id="program-monitor">
          <div class="panel-header">Program</div>
          <div class="monitor-toolbar">
            <label>Zoom <select id="program-zoom"><option value="fit" selected>Fit</option><option value="25">25%</option><option value="50">50%</option><option value="100">100%</option></select></label>
            <label>Res <select id="program-res"><option value="full">Full</option><option value="half" selected>1/2</option><option value="quarter">1/4</option></select></label>
          </div>
          <div class="monitor-viewport" id="program-viewport">
            <canvas id="program-canvas" class="monitor-canvas"></canvas>
            <span class="monitor-placeholder">Program preview</span>
          </div>
          <div class="monitor-transport">
            <button type="button" id="btn-play">Play</button>
            <button type="button" id="btn-pause">Pause</button>
            <span class="timecode" id="tc-program">00:00:00:00</span>
            <span style="color:var(--muted);font-size:0.72rem"><span id="cur">0:00.0</span> / <span id="dur">0:00.0</span></span>
          </div>
        </div>
      </div>

      <div class="workspace-row-bottom">
        <div class="panel" style="min-height:0;">
          <div class="project-tabs" role="tablist">
            <button type="button" class="active" id="tab-media" role="tab" aria-selected="true">Media</button>
            <button type="button" id="tab-effects-lib" role="tab" aria-selected="false">Effects</button>
          </div>
          <div class="project-panel-body" id="panel-media-body">
            <div class="clip-grid" id="clip-grid"></div>
            <p class="clips-empty" id="clips-empty" style="margin:0;font-size:0.75rem;color:var(--muted)">No clips. Import or record.</p>
          </div>
          <div class="project-panel-body hidden" id="panel-effects-lib-body">
            <p class="effects-placeholder">Effects library: use Effect Controls for Motion and Opacity. More effects can be added later.</p>
          </div>
        </div>

        <div class="edit-toolbar" aria-label="Editing tools">
          <button type="button" class="tool-btn" data-tool="select" title="Selection" aria-pressed="true">↖</button>
          <button type="button" class="tool-btn" data-tool="track" title="Track select">↔</button>
          <button type="button" class="tool-btn" data-tool="ripple" title="Ripple edit">⌒</button>
          <button type="button" class="tool-btn" data-tool="razor" title="Razor">✂</button>
          <button type="button" class="tool-btn" data-tool="slip" title="Slip">⧉</button>
          <button type="button" class="tool-btn" data-tool="pen" title="Pen">✎</button>
          <button type="button" class="tool-btn" data-tool="hand" title="Hand">✋</button>
          <button type="button" class="tool-btn" data-tool="type" title="Type">T</button>
        </div>

        <div class="panel timeline-stack">
          <div class="panel-header">Timeline</div>
          <div class="timeline-toolbar">
            <label class="file-label">Add media<input id="file-dup" type="file" accept="video/*" multiple /></label>
            <label class="fps-label">Step FPS <input type="number" id="fps-step" min="1" max="120" value="30" step="1" /></label>
            <button type="button" id="btn-frame-prev" disabled>◀</button>
            <button type="button" id="btn-frame-next" disabled>▶</button>
          </div>
          <div class="timeline-ruler"><div class="timeline-ruler-inner" id="timeline-ruler-inner"></div></div>
          <div class="tracks-header">
            <div class="track-label">V1</div>
            <div class="track-lane" id="track-v1">
              <span class="track-lane-label">Video 1</span>
              <div id="track-clip-block" style="display:none;position:absolute;top:18px;left:0;height:calc(100% - 20px);background:rgba(64,156,255,0.25);border:1px solid var(--accent);border-radius:2px;min-width:8px;"></div>
            </div>
          </div>
          <div class="tracks-header">
            <div class="track-label">A1</div>
            <div class="track-lane audio" id="track-a1">
              <span class="track-lane-label">Audio 1</span>
              <canvas id="waveform-canvas" style="position:absolute;left:0;right:0;top:18px;bottom:0;opacity:0.35;"></canvas>
            </div>
          </div>
          <div class="timeline-panel-inner">
            <p class="timeline-hint">Scrub the filmstrip; playhead snaps to frames. Trim handles match in/out.</p>
            <div class="filmstrip-wrap" id="filmstrip-wrap" hidden>
              <div class="filmstrip-scroll" id="filmstrip-scroll">
                <div class="filmstrip-track" id="filmstrip-track" role="slider" aria-label="Video timeline" tabindex="0">
                  <div class="filmstrip-thumbs" id="filmstrip-thumbs"></div>
                  <div class="filmstrip-trim filmstrip-trim-in" id="filmstrip-trim-in"></div>
                  <div class="filmstrip-trim filmstrip-trim-out" id="filmstrip-trim-out"></div>
                  <div class="filmstrip-playhead" id="filmstrip-playhead"></div>
                </div>
              </div>
              <div class="filmstrip-status" id="filmstrip-status"></div>
            </div>
            <div class="timeline-meta">
              <span id="timeline-frame">Frame —</span>
            </div>
            <div class="trim-panel-compact">
              <h3>Trim</h3>
              <div class="range-row">
                <label for="in-slider">In</label>
                <input type="range" id="in-slider" min="0" max="1000" value="0" step="1" />
              </div>
              <div class="range-row">
                <label for="out-slider">Out</label>
                <input type="range" id="out-slider" min="0" max="1000" value="1000" step="1" />
              </div>
              <div class="range-actions">
                <button type="button" id="btn-in">Set in @ playhead</button>
                <button type="button" id="btn-out">Set out @ playhead</button>
                <button type="button" id="btn-reset-trim">Reset</button>
              </div>
              <div class="export-row">
                <button type="button" class="primary" id="btn-export" disabled>Export trimmed MP4</button>
                <a id="download-link" href="#" download="trimmed.mp4" style="display:none;font-size:0.72rem;color:var(--accent)">Download</a>
              </div>
            </div>
          </div>
        </div>

        <div class="panel audio-meter-panel">
          <div class="panel-header">Audio</div>
          <div class="meter-wrap">
            <div class="meter-channel">
              <div class="meter-bar-bg"><div class="meter-bar-fill" id="meter-L"></div></div>
              <span class="meter-label">L</span>
            </div>
            <div class="meter-channel">
              <div class="meter-bar-bg"><div class="meter-bar-fill" id="meter-R"></div></div>
              <span class="meter-label">R</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <video id="video" class="video-source-hidden" playsinline preload="metadata" crossorigin="anonymous"></video>

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

  const video = /** @type {HTMLVideoElement} */ ($('#video', root));
  const fileInput = $('#file', root);
  const fileDup = $('#file-dup', root);
  const sourceViewport = $('#source-viewport', root);
  const programViewport = $('#program-viewport', root);
  const sourceCanvas = /** @type {HTMLCanvasElement} */ ($('#source-canvas', root));
  const programCanvas = /** @type {HTMLCanvasElement} */ ($('#program-canvas', root));
  const waveformCanvas = /** @type {HTMLCanvasElement} */ ($('#waveform-canvas', root));
  const curEl = $('#cur', root);
  const durEl = $('#dur', root);
  const tcSource = $('#tc-source', root);
  const tcProgram = $('#tc-program', root);
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
  const btnMarkIn = $('#btn-mark-in', root);
  const btnMarkOut = $('#btn-mark-out', root);

  const motionPosX = $('#motion-pos-x', root);
  const motionPosY = $('#motion-pos-y', root);
  const motionScale = $('#motion-scale', root);
  const motionRot = $('#motion-rot', root);
  const anchorX = $('#anchor-x', root);
  const anchorY = $('#anchor-y', root);
  const opacityRange = $('#opacity-range', root);
  const blendMode = $('#blend-mode', root);
  const valPosX = $('#val-pos-x', root);
  const valPosY = $('#val-pos-y', root);
  const valScale = $('#val-scale', root);
  const valRot = $('#val-rot', root);
  const valAnchorX = $('#val-anchor-x', root);
  const valAnchorY = $('#val-anchor-y', root);
  const valOpacity = $('#val-opacity', root);

  const fpsStepInput = $('#fps-step', root);
  const timelineFrameEl = $('#timeline-frame', root);
  const btnFramePrev = $('#btn-frame-prev', root);
  const btnFrameNext = $('#btn-frame-next', root);
  const filmstripWrap = $('#filmstrip-wrap', root);
  const filmstripScroll = $('#filmstrip-scroll', root);
  const filmstripTrack = $('#filmstrip-track', root);
  const filmstripThumbs = $('#filmstrip-thumbs', root);
  const filmstripPlayhead = $('#filmstrip-playhead', root);
  const filmstripTrimIn = $('#filmstrip-trim-in', root);
  const filmstripTrimOut = $('#filmstrip-trim-out', root);
  const filmstripStatus = $('#filmstrip-status', root);
  const clipGrid = $('#clip-grid', root);
  const clipsEmptyEl = $('#clips-empty', root);
  const tabMedia = $('#tab-media', root);
  const tabEffectsLib = $('#tab-effects-lib', root);
  const panelMediaBody = $('#panel-media-body', root);
  const panelEffectsLibBody = $('#panel-effects-lib-body', root);
  const trackClipBlock = $('#track-clip-block', root);
  const cameraPanel = $('#camera-panel', root);
  const btnCameraToggle = $('#btn-camera-toggle', root);
  const cameraPreview = $('#camera-preview', root);
  const btnRecStart = $('#btn-rec-start', root);
  const btnRecStop = $('#btn-rec-stop', root);
  const btnCameraClose = $('#btn-camera-close', root);
  const meterL = $('#meter-L', root);
  const meterR = $('#meter-R', root);

  /** @type {CanvasRenderingContext2D | null} */
  const sourceCtx = sourceCanvas.getContext('2d');
  /** @type {CanvasRenderingContext2D | null} */
  const programCtx = programCanvas.getContext('2d');

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
  let timelineScrubbing = false;
  let filmstripGen = 0;

  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {AnalyserNode | null} */
  let analyserNode = null;
  let audioHooked = false;

  function getEffectiveFps() {
    const fps = Number(fpsStepInput.value);
    return Number.isFinite(fps) && fps > 0 ? fps : 30;
  }

  function updateTimecodeDisplays() {
    const fps = getEffectiveFps();
    const tc = formatTimecode(video.currentTime, fps);
    tcSource.textContent = tc;
    tcProgram.textContent = tc;
  }

  function ensureAudioGraph() {
    if (audioHooked || !video) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      const src = audioCtx.createMediaElementSource(video);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 256;
      src.connect(analyserNode);
      analyserNode.connect(audioCtx.destination);
      audioHooked = true;
    } catch (e) {
      console.warn('Audio meter graph:', e);
    }
  }

  function meterUsesWidth() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches;
  }

  function updateMeters() {
    if (!analyserNode) {
      meterL.style.height = meterUsesWidth() ? '100%' : '0%';
      meterL.style.width = meterUsesWidth() ? '0%' : '100%';
      meterR.style.height = meterUsesWidth() ? '100%' : '0%';
      meterR.style.width = meterUsesWidth() ? '0%' : '100%';
      return;
    }
    const buf = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(buf);
    let sumL = 0;
    let sumR = 0;
    const half = Math.floor(buf.length / 2);
    for (let i = 0; i < half; i++) sumL += buf[i];
    for (let i = half; i < buf.length; i++) sumR += buf[i];
    const nL = sumL / half / 255;
    const nR = sumR / (buf.length - half) / 255;
    const v = (n) => Math.min(100, Math.round(n * 140));
    if (meterUsesWidth()) {
      meterL.style.width = `${v(nL)}%`;
      meterL.style.height = '100%';
      meterR.style.width = `${v(nR)}%`;
      meterR.style.height = '100%';
    } else {
      meterL.style.height = `${v(nL)}%`;
      meterL.style.width = '100%';
      meterR.style.height = `${v(nR)}%`;
      meterR.style.width = '100%';
    }
  }

  function snapTimeToFrame(t) {
    const fps = getEffectiveFps();
    const maxIdx = Math.max(0, Math.floor(durationSec * fps - 1e-9));
    const idx = clamp(Math.round(t * fps), 0, maxIdx);
    return idx / fps;
  }

  function seekVideoPromise(t) {
    return new Promise((resolve) => {
      const target = clamp(t, 0, durationSec);
      if (Math.abs(video.currentTime - target) < 1e-6) {
        resolve();
        return;
      }
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = target;
    });
  }

  function readMotionState() {
    return {
      posX: Number(motionPosX.value),
      posY: Number(motionPosY.value),
      scale: Number(motionScale.value),
      rotation: Number(motionRot.value),
      ax: Number(anchorX.value),
      ay: Number(anchorY.value),
      opacity: Number(opacityRange.value) / 100,
      blend: String(blendMode.value || 'source-over'),
    };
  }

  function drawSourceFromVideo() {
    if (!sourceCtx || !video.videoWidth || !video.videoHeight) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (sourceCanvas.width !== vw || sourceCanvas.height !== vh) {
      sourceCanvas.width = vw;
      sourceCanvas.height = vh;
    }
    sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
    sourceCtx.globalCompositeOperation = 'source-over';
    sourceCtx.globalAlpha = 1;
    sourceCtx.drawImage(video, 0, 0, vw, vh);
  }

  function drawProgramFromVideo() {
    if (!programCtx || !video.videoWidth || !video.videoHeight) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (programCanvas.width !== vw || programCanvas.height !== vh) {
      programCanvas.width = vw;
      programCanvas.height = vh;
    }
    const m = readMotionState();
    programCtx.setTransform(1, 0, 0, 1, 0, 0);
    programCtx.globalCompositeOperation = 'source-over';
    programCtx.fillStyle = '#000';
    programCtx.fillRect(0, 0, vw, vh);
    programCtx.globalCompositeOperation = /** @type {GlobalCompositeOperation} */ (m.blend) || 'source-over';
    programCtx.globalAlpha = m.opacity;
    const px = (m.posX / 100) * vw;
    const py = (m.posY / 100) * vh;
    const ax = (m.ax / 100) * vw;
    const ay = (m.ay / 100) * vh;
    programCtx.save();
    programCtx.translate(px, py);
    programCtx.rotate((m.rotation * Math.PI) / 180);
    const s = m.scale / 100;
    programCtx.scale(s, s);
    programCtx.translate(-ax, -ay);
    programCtx.drawImage(video, 0, 0, vw, vh);
    programCtx.restore();
    programCtx.globalAlpha = 1;
    programCtx.globalCompositeOperation = 'source-over';
  }

  function drawPreviewFromVideo() {
    if (!video.videoWidth || !video.videoHeight) return;
    drawSourceFromVideo();
    drawProgramFromVideo();
    sourceViewport.classList.add('has-content');
    programViewport.classList.add('has-content');
  }

  function resizeWaveform() {
    const lane = $('#track-a1', root);
    if (!lane || !waveformCanvas) return;
    const r = lane.getBoundingClientRect();
    const w = Math.max(40, Math.floor(r.width));
    const h = Math.max(24, Math.floor(r.height - 20));
    if (waveformCanvas.width !== w || waveformCanvas.height !== h) {
      waveformCanvas.width = w;
      waveformCanvas.height = h;
    }
    drawWaveformPlaceholder();
  }

  function drawWaveformPlaceholder() {
    const ctx = waveformCanvas.getContext('2d');
    if (!ctx || !durationSec) return;
    ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
    ctx.fillStyle = 'rgba(64,156,255,0.25)';
    const t = video.currentTime / durationSec;
    const x = t * waveformCanvas.width;
    ctx.fillRect(0, 0, x, waveformCanvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    for (let i = 0; i < waveformCanvas.width; i += 8) {
      const h = 4 + (i % 17);
      ctx.moveTo(i, waveformCanvas.height / 2 - h);
      ctx.lineTo(i, waveformCanvas.height / 2 + h);
    }
    ctx.stroke();
  }

  function updatePlayheadUI() {
    if (!durationSec) {
      filmstripPlayhead.style.left = '0%';
      return;
    }
    const pct = (video.currentTime / durationSec) * 100;
    filmstripPlayhead.style.left = `${clamp(pct, 0, 100)}%`;
  }

  function updateFilmstripTrimOverlays() {
    if (!durationSec) {
      filmstripTrimIn.style.width = '0%';
      filmstripTrimOut.style.width = '0%';
      return;
    }
    const d = durationSec;
    const leftPct = (inSec / d) * 100;
    const rightPct = ((d - outSec) / d) * 100;
    filmstripTrimIn.style.width = `${leftPct}%`;
    filmstripTrimOut.style.width = `${rightPct}%`;
  }

  function updateTrackClipBlock() {
    if (!durationSec) {
      trackClipBlock.style.display = 'none';
      return;
    }
    trackClipBlock.style.display = 'block';
    const left = (inSec / durationSec) * 100;
    const w = ((outSec - inSec) / durationSec) * 100;
    trackClipBlock.style.left = `${left}%`;
    trackClipBlock.style.width = `${Math.max(w, 0.5)}%`;
  }

  function setTimelineFromClientX(clientX, snap) {
    const rect = filmstripTrack.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    let t = ratio * durationSec;
    if (snap) t = snapTimeToFrame(t);
    video.currentTime = clamp(t, 0, durationSec);
    curEl.textContent = formatTime(video.currentTime);
    updateFrameLabel();
    drawPreviewFromVideo();
    updatePlayheadUI();
    updateTimecodeDisplays();
    drawWaveformPlaceholder();
  }

  function setStatus(text, showProgress = false) {
    const msg = document.createElement('div');
    msg.textContent = text;
    status.replaceChildren(msg, progWrap);
    progWrap.classList.toggle('visible', showProgress);
    if (!showProgress) prog.style.width = '0%';
  }

  setStatus('Ready. Import media or record, then load ffmpeg to export.');

  function getStepSec() {
    const fps = Number(fpsStepInput.value);
    if (!Number.isFinite(fps) || fps < 1) return 1 / 30;
    return 1 / fps;
  }

  function updateFrameLabel() {
    const fps = getEffectiveFps();
    const f = Math.round(video.currentTime * fps);
    timelineFrameEl.textContent = `Frame ${f} · ${formatTime(video.currentTime)}`;
  }

  function syncPlayheadFromVideo() {
    if (timelineScrubbing || !durationSec) return;
    updateFrameLabel();
    updatePlayheadUI();
    updateTimecodeDisplays();
  }

  async function buildFilmstrip() {
    const gen = ++filmstripGen;
    filmstripThumbs.replaceChildren();
    filmstripStatus.textContent = '';
    if (!durationSec || !sourceCtx) {
      filmstripWrap.hidden = true;
      return;
    }
    filmstripWrap.hidden = false;
    const thumbH = 56;
    const trackW = filmstripTrack.getBoundingClientRect().width || 800;
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const thumbW = Math.max(24, Math.round(thumbH * aspect));
    const count = Math.max(8, Math.min(120, Math.ceil(trackW / thumbW)));
    filmstripStatus.textContent = `Building ${count} thumbnails…`;

    const times = [];
    for (let i = 0; i < count; i++) {
      times.push((i / Math.max(1, count - 1)) * durationSec);
    }

    const wasMuted = video.muted;
    const wasPaused = video.paused;
    const prevT = video.currentTime;
    video.muted = true;

    for (let i = 0; i < times.length; i++) {
      if (gen !== filmstripGen) return;
      await seekVideoPromise(times[i]);
      if (gen !== filmstripGen) return;
      drawSourceFromVideo();
      const c = document.createElement('canvas');
      c.width = thumbW;
      c.height = thumbH;
      const ctx = c.getContext('2d');
      if (ctx && sourceCanvas.width && sourceCanvas.height) {
        ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, thumbW, thumbH);
      }
      c.className = 'filmstrip-thumb';
      c.dataset.time = String(times[i]);
      filmstripThumbs.appendChild(c);
    }

    if (gen !== filmstripGen) return;
    await seekVideoPromise(prevT);
    if (!wasPaused) {
      video.play().catch(() => {});
    } else {
      drawPreviewFromVideo();
    }
    video.muted = wasMuted;
    filmstripStatus.textContent = '';
    updatePlayheadUI();
    updateFilmstripTrimOverlays();
    drawWaveformPlaceholder();
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

  function updateEffectValueLabels() {
    valPosX.textContent = Number(motionPosX.value).toFixed(1);
    valPosY.textContent = Number(motionPosY.value).toFixed(1);
    valScale.textContent = motionScale.value;
    valRot.textContent = `${motionRot.value}°`;
    valAnchorX.textContent = anchorX.value;
    valAnchorY.textContent = anchorY.value;
    valOpacity.textContent = `${opacityRange.value}%`;
  }

  function updateClipsUI() {
    clipGrid.innerHTML = '';
    clips.forEach((c) => {
      const tile = document.createElement('div');
      tile.className = 'clip-tile' + (c.id === activeClipId ? ' active' : '');
      tile.title = c.name;
      if (c.thumbDataUrl) {
        const img = document.createElement('img');
        img.className = 'clip-tile-thumb';
        img.src = c.thumbDataUrl;
        img.alt = '';
        tile.appendChild(img);
      } else {
        const fb = document.createElement('div');
        fb.className = 'clip-tile-fallback';
        fb.textContent = c.name.slice(0, 2).toUpperCase();
        tile.appendChild(fb);
      }
      const meta = document.createElement('div');
      meta.className = 'clip-tile-meta';
      meta.textContent = c.name;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'clip-tile-remove';
      rm.setAttribute('aria-label', 'Remove clip');
      rm.textContent = '×';
      rm.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeClip(c.id);
      });
      tile.appendChild(meta);
      tile.appendChild(rm);
      tile.addEventListener('click', () => selectClip(c.id));
      clipGrid.appendChild(tile);
    });
    clipsEmptyEl.style.display = clips.length ? 'none' : 'block';
  }

  async function captureThumbDataUrl(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.crossOrigin = 'anonymous';
      v.src = url;
      const done = (dataUrl) => {
        v.removeAttribute('src');
        v.load();
        resolve(dataUrl);
      };
      v.addEventListener('error', () => done(''));
      v.addEventListener('loadeddata', () => {
        try {
          v.currentTime = Math.min(0.1, (v.duration || 1) * 0.02);
        } catch {
          done('');
        }
      });
      v.addEventListener('seeked', () => {
        try {
          const w = v.videoWidth;
          const h = v.videoHeight;
          if (!w || !h) {
            done('');
            return;
          }
          const c = document.createElement('canvas');
          const tw = 160;
          const th = Math.round(tw * (h / w));
          c.width = tw;
          c.height = th;
          const ctx = c.getContext('2d');
          if (ctx) {
            ctx.drawImage(v, 0, 0, w, h, 0, 0, tw, th);
            done(c.toDataURL('image/jpeg', 0.72));
          } else done('');
        } catch {
          done('');
        }
      });
    });
  }

  function selectClip(id) {
    const c = clips.find((x) => x.id === id);
    if (!c) return;
    activeClipId = id;
    filmstripGen++;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = c.url;
    currentFile = c.file;
    video.src = objectUrl;
    sourceViewport.classList.remove('has-content');
    programViewport.classList.remove('has-content');
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
      filmstripGen++;
      video.removeAttribute('src');
      video.load();
      sourceViewport.classList.remove('has-content');
      programViewport.classList.remove('has-content');
      durationSec = 0;
      inSec = 0;
      outSec = 0;
      durEl.textContent = formatTime(0);
      curEl.textContent = formatTime(0);
      tcSource.textContent = '00:00:00:00';
      tcProgram.textContent = '00:00:00:00';
      filmstripWrap.hidden = true;
      filmstripThumbs.replaceChildren();
      filmstripStatus.textContent = '';
      btnFramePrev.disabled = true;
      btnFrameNext.disabled = true;
      updateFrameLabel();
      trackClipBlock.style.display = 'none';
    }
    if (clips.length && activeClipId === '') {
      selectClip(clips[0].id);
    }
    updateClipsUI();
    updateExportEnabled();
  }

  async function addClipFromFile(file) {
    const url = URL.createObjectURL(file);
    const id = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const clip = { id, file, url, name: file.name };
    clips.push(clip);
    selectClip(id);
    captureThumbDataUrl(url).then((thumb) => {
      const cl = clips.find((x) => x.id === id);
      if (cl && thumb) cl.thumbDataUrl = thumb;
      updateClipsUI();
    });
    setStatus(`Added "${file.name}".`);
  }

  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files?.length) return;
    for (let i = 0; i < files.length; i++) addClipFromFile(files[i]);
    fileInput.value = '';
  });

  fileDup.addEventListener('change', () => {
    const files = fileDup.files;
    if (!files?.length) return;
    for (let i = 0; i < files.length; i++) addClipFromFile(files[i]);
    fileDup.value = '';
  });

  tabMedia.addEventListener('click', () => {
    tabMedia.classList.add('active');
    tabEffectsLib.classList.remove('active');
    tabMedia.setAttribute('aria-selected', 'true');
    tabEffectsLib.setAttribute('aria-selected', 'false');
    panelMediaBody.classList.remove('hidden');
    panelEffectsLibBody.classList.add('hidden');
  });

  tabEffectsLib.addEventListener('click', () => {
    tabEffectsLib.classList.add('active');
    tabMedia.classList.remove('active');
    tabEffectsLib.setAttribute('aria-selected', 'true');
    tabMedia.setAttribute('aria-selected', 'false');
    panelEffectsLibBody.classList.remove('hidden');
    panelMediaBody.classList.add('hidden');
  });

  $$('.tool-btn', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tool-btn', root).forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
    });
  });

  let previewRaf = 0;
  function tickPreview() {
    previewRaf = 0;
    if (video.paused) return;
    drawPreviewFromVideo();
    curEl.textContent = formatTime(video.currentTime);
    syncPlayheadFromVideo();
    updateMeters();
    drawWaveformPlaceholder();
    previewRaf = requestAnimationFrame(tickPreview);
  }

  function startPreviewLoop() {
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    if (!previewRaf) previewRaf = requestAnimationFrame(tickPreview);
  }

  function stopPreviewLoop() {
    if (previewRaf) {
      cancelAnimationFrame(previewRaf);
      previewRaf = 0;
    }
    updateMeters();
  }

  video.addEventListener('loadeddata', () => {
    drawPreviewFromVideo();
  });

  video.addEventListener('loadedmetadata', () => {
    durationSec = video.duration || 0;
    inSec = 0;
    outSec = durationSec;
    durEl.textContent = formatTime(durationSec);
    syncSlidersFromState();
    btnFramePrev.disabled = false;
    btnFrameNext.disabled = false;
    updateExportEnabled();
    updateFrameLabel();
    updateFilmstripTrimOverlays();
    updateTrackClipBlock();
    resizeWaveform();
    ensureAudioGraph();
    requestAnimationFrame(() => {
      buildFilmstrip();
    });
  });

  video.addEventListener('play', () => {
    ensureAudioGraph();
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
    startPreviewLoop();
  });

  video.addEventListener('pause', () => {
    stopPreviewLoop();
    drawPreviewFromVideo();
    updateFrameLabel();
    syncPlayheadFromVideo();
    updateMeters();
  });

  video.addEventListener('timeupdate', () => {
    curEl.textContent = formatTime(video.currentTime);
    readSliders();
    if (!timelineScrubbing) syncPlayheadFromVideo();
    updateTimecodeDisplays();
    if (video.currentTime > outSec - 0.04) {
      video.pause();
      video.currentTime = outSec;
    }
  });

  video.addEventListener('seeked', () => {
    updateFrameLabel();
    drawPreviewFromVideo();
    updateTimecodeDisplays();
    if (!timelineScrubbing) syncPlayheadFromVideo();
    drawWaveformPlaceholder();
  });

  function bindFilmstripPointer(el) {
    el.addEventListener('pointerdown', (ev) => {
      if (!durationSec) return;
      ev.preventDefault();
      timelineScrubbing = true;
      video.pause();
      el.setPointerCapture(ev.pointerId);
      setTimelineFromClientX(ev.clientX, true);
    });
    el.addEventListener('pointermove', (ev) => {
      if (!timelineScrubbing || !el.hasPointerCapture(ev.pointerId)) return;
      setTimelineFromClientX(ev.clientX, true);
    });
    const end = (ev) => {
      if (el.hasPointerCapture(ev.pointerId)) {
        el.releasePointerCapture(ev.pointerId);
      }
      timelineScrubbing = false;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  bindFilmstripPointer(filmstripTrack);

  filmstripTrack.addEventListener('keydown', (ev) => {
    if (!durationSec) return;
    const step = getStepSec();
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      video.pause();
      video.currentTime = snapTimeToFrame(video.currentTime - step);
      curEl.textContent = formatTime(video.currentTime);
      updateFrameLabel();
      drawPreviewFromVideo();
      updatePlayheadUI();
      updateTimecodeDisplays();
    } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      video.pause();
      video.currentTime = snapTimeToFrame(video.currentTime + step);
      curEl.textContent = formatTime(video.currentTime);
      updateFrameLabel();
      drawPreviewFromVideo();
      updatePlayheadUI();
      updateTimecodeDisplays();
    }
  });

  let filmstripResizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!durationSec) return;
    clearTimeout(filmstripResizeTimer);
    filmstripResizeTimer = window.setTimeout(() => {
      buildFilmstrip();
      resizeWaveform();
    }, 200);
  });

  fpsStepInput.addEventListener('change', () => {
    updateFrameLabel();
    updateTimecodeDisplays();
    if (durationSec) buildFilmstrip();
  });

  function onEffectInput() {
    updateEffectValueLabels();
    drawProgramFromVideo();
  }

  [
    motionPosX,
    motionPosY,
    motionScale,
    motionRot,
    anchorX,
    anchorY,
    opacityRange,
    blendMode,
  ].forEach((el) => el.addEventListener('input', onEffectInput));

  updateEffectValueLabels();

  function stepFrame(dir) {
    if (!durationSec) return;
    video.pause();
    const step = getStepSec();
    const t = clamp(snapTimeToFrame(video.currentTime + dir * step), 0, durationSec);
    video.currentTime = t;
  }

  btnFramePrev.addEventListener('click', () => stepFrame(-1));
  btnFrameNext.addEventListener('click', () => stepFrame(1));

  ['input', 'change'].forEach((ev) => {
    inSlider.addEventListener(ev, () => {
      readSliders();
      updateFilmstripTrimOverlays();
      updateTrackClipBlock();
      if (inSec > video.currentTime) video.currentTime = inSec;
      updateExportEnabled();
    });
    outSlider.addEventListener(ev, () => {
      readSliders();
      updateFilmstripTrimOverlays();
      updateTrackClipBlock();
      updateExportEnabled();
    });
  });

  btnPlay.addEventListener('click', () => {
    ensureAudioGraph();
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
    updateFilmstripTrimOverlays();
    updateTrackClipBlock();
    updateExportEnabled();
  });

  btnOut.addEventListener('click', () => {
    readSliders();
    const t = clamp(video.currentTime, 0, durationSec);
    outSec = t;
    if (outSec <= inSec) inSec = Math.max(0, outSec - 0.1);
    syncSlidersFromState();
    updateFilmstripTrimOverlays();
    updateTrackClipBlock();
    updateExportEnabled();
  });

  btnMarkIn.addEventListener('click', () => btnIn.click());
  btnMarkOut.addEventListener('click', () => btnOut.click());

  btnResetTrim.addEventListener('click', () => {
    inSec = 0;
    outSec = durationSec;
    syncSlidersFromState();
    updateFilmstripTrimOverlays();
    updateTrackClipBlock();
    updateExportEnabled();
  });

  async function openCameraPanel() {
    cameraPanel.classList.remove('hidden');
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      cameraPreview.srcObject = cameraStream;
      await cameraPreview.play();
      btnRecStart.disabled = false;
      setStatus('Camera ready.');
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
  resizeWaveform();
}

const app = $('#app');
if (app) buildUI(app);
