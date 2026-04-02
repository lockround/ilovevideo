import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

/** @ffmpeg/core ESM build (required for Vite). Version aligned with npm @ffmpeg/ffmpeg peer. */
const CORE_VERSION = '0.12.10';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

let ffmpegInstance = null;
let loadPromise = null;

/**
 * @returns {Promise<import('@ffmpeg/ffmpeg').FFmpeg>}
 */
export async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => {
      console.debug('[ffmpeg]', message);
    });
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return loadPromise;
}

/**
 * @param {File} file
 * @param {number} startSec
 * @param {number} endSec
 * @param {(p: number) => void} [onProgress]
 */
export async function trimToMp4(file, startSec, endSec, onProgress) {
  const ffmpeg = await getFFmpeg();
  const ext = extFromName(file.name);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inName = `in_${stamp}${ext}`;
  const outName = `out_${stamp}.mp4`;

  /** @type {((e: { progress: number }) => void) | undefined} */
  let onProg;
  if (onProgress) {
    onProg = ({ progress }) => {
      if (typeof progress === 'number') onProgress(progress);
    };
    ffmpeg.on('progress', onProg);
  }

  const cleanup = async () => {
    if (onProg) ffmpeg.off('progress', onProg);
    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
  };

  try {
    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
    await ffmpeg.writeFile(inName, await fetchFile(file));

    const safeStart = Math.max(0, startSec);
    const safeEnd = Math.max(safeStart + 0.1, endSec);
    const duration = safeEnd - safeStart;

    const tryCopy = [
      '-ss',
      String(safeStart),
      '-i',
      inName,
      '-t',
      String(duration),
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      outName,
    ];

    const reencode = [
      '-ss',
      String(safeStart),
      '-i',
      inName,
      '-t',
      String(duration),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outName,
    ];

    try {
      await ffmpeg.exec(tryCopy);
    } catch {
      await ffmpeg.deleteFile(outName).catch(() => {});
      await ffmpeg.exec(reencode);
    }

    const data = await ffmpeg.readFile(outName);
    // Use the Uint8Array directly; `.buffer` can be oversized and corrupts the MP4 in some runtimes.
    return new Blob([data], { type: 'video/mp4' });
  } finally {
    await cleanup();
  }
}

function extFromName(name) {
  const i = name.lastIndexOf('.');
  if (i === -1) return '.mp4';
  return name.slice(i).toLowerCase();
}
