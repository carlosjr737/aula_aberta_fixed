require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');

const DEBUG_ENV_KEYS = [
  'PORT',
  'RAILWAY_API_URL',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GCS_BUCKET_NAME',
  'RTSP_SUBWAY',
  'RTSP_BOLSO',
  'RTSP_MIRANTE'
];

function toBool(value) { return Boolean(String(value || '').trim()); }
function getEnvSummary() { return DEBUG_ENV_KEYS.reduce((acc, key) => (acc[key] = toBool(process.env[key]), acc), {}); }

function parseServiceAccountJson(raw) {
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado.');
  try {
    const parsed = JSON.parse(String(raw).trim());
    if (!parsed.private_key) throw new Error('private_key ausente no GOOGLE_SERVICE_ACCOUNT_JSON.');
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON inválido: ${error.message}`);
  }
}

function getGCSBucket() {
  const bucketName = String(process.env.GCS_BUCKET_NAME || '').trim();
  if (!bucketName) throw new Error('GCS_BUCKET_NAME não configurado.');
  return bucketName;
}

function getGCSClient() {
  const credentials = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new Storage({ projectId: credentials.project_id, credentials });
}

async function uploadVideoToGCS(filePath, metadata = {}) {
  const bucketName = getGCSBucket();
  const storage = getGCSClient();
  const bucket = storage.bucket(bucketName);
  const recordingId = metadata.recordingId || crypto.randomUUID();
  const cameraId = metadata.cameraId || 'unknown-camera';
  const date = new Date().toISOString().slice(0, 10);
  const gcsFileName = `videos/${cameraId}/${date}/${recordingId}.mp4`;

  await bucket.upload(filePath, {
    destination: gcsFileName,
    contentType: 'video/mp4',
    metadata: {
      metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v || '')]))
    }
  });

  const [videoUrl] = await bucket.file(gcsFileName).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + (2 * 60 * 60 * 1000)
  });

  return { gcsBucket: bucketName, gcsFileName, videoUrl, uploadedAt: new Date().toISOString() };
}

const app = express();
const RAILWAY_API_URL = String(process.env.RAILWAY_API_URL || '').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 4000);
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const MIN_FILE_SIZE_BYTES = 50 * 1024;
const FFPROBE_FALLBACK_MIN_BYTES = 100 * 1024;
const CLEANUP_LOCAL_FILES = false;
const TARGET_VIDEO_FPS = 10;

const MAX_FFMPEG_LOG_CHARS = 20000;

function appendBoundedLog(currentLog, chunk, maxChars = MAX_FFMPEG_LOG_CHARS) {
  const nextLog = `${currentLog || ''}${String(chunk || '')}`;
  return nextLog.length > maxChars ? nextLog.slice(-maxChars) : nextLog;
}

function getLogTail(log, maxChars = MAX_FFMPEG_LOG_CHARS) {
  const safeLog = String(log || '');
  return safeLog.length > maxChars ? safeLog.slice(-maxChars) : safeLog;
}
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const CAMERAS = { bolso: process.env.RTSP_BOLSO, mirante: process.env.RTSP_MIRANTE, subway: process.env.RTSP_SUBWAY };
const recordings = new Map();

app.use(cors({ origin: 'https://aula-aberta-fixed.vercel.app', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

function getDriveClient() {
  const credentials = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}
async function uploadVideoToDrive(filePath) {
  const drive = getDriveClient();
  const res = await drive.files.create({ requestBody: { name: path.basename(filePath) }, media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) }, fields: 'id,webViewLink', supportsAllDrives: true });
  return res.data;
}

async function finalizeRecording(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return;
  rec.finishedAt = new Date().toISOString();
  let currentStage = 'uploading_gcs';
  try {
    rec.status = currentStage;
    const gcsUpload = await uploadVideoToGCS(rec.outputPath, { professor: rec.professor, turma: rec.turma, cameraId: rec.cameraId, recordingId: rec.recordingId });
    Object.assign(rec, gcsUpload);

    currentStage = 'generating_signed_url';
    rec.status = currentStage;
    currentStage = 'calling_railway';
    rec.status = currentStage;
    const response = await fetch(`${RAILWAY_API_URL}/analyze-video-url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      videoUrl: rec.videoUrl, gcsBucket: rec.gcsBucket, gcsFileName: rec.gcsFileName, professor: rec.professor, turma: rec.turma, nivel: rec.nivel, sala: rec.sala, horario: rec.horario, prompt: rec.prompt, cameraId: rec.cameraId, recordingStartedAt: rec.startedAt, recordingEndedAt: rec.finishedAt
    }) });
    const payload = await response.json();
    rec.railwayResponse = payload;
    if (!response.ok) throw new Error(payload.error || 'Falha ao analisar no Railway');
    rec.report = payload;
    rec.status = 'completed';
  } catch (error) {
    rec.status = 'failed';
    rec.failedStage = currentStage;
    rec.error = error.message;
  } finally {
    if (CLEANUP_LOCAL_FILES && fs.existsSync(rec.outputPath)) fs.unlinkSync(rec.outputPath);
  }
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath];
    execFile('ffprobe', args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr || stdout || error.message;
        return reject(new Error(`ffprobe error: ${details}`));
      }
      resolve(stdout);
    });
  });
}

async function validateVideoFile(filePath, expectedDurationSeconds) {
  if (!fs.existsSync(filePath)) return { valid: false, error: 'Arquivo de saída não foi criado.' };
  const fileSize = fs.statSync(filePath).size;
  if (fileSize < MIN_FILE_SIZE_BYTES) return { valid: false, fileSize, error: `Arquivo inválido (${fileSize} bytes).` };

  try {
    const ffprobeRaw = await runFfprobe(filePath);
    const ffprobeData = JSON.parse(ffprobeRaw);
    const streams = Array.isArray(ffprobeData.streams) ? ffprobeData.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');
    const audioStream = streams.find((stream) => stream.codec_type === 'audio');
    const parseDuration = (stream) => Number(stream?.duration || 0) || null;
    const duration = Number(ffprobeData?.format?.duration || 0) || null;
    const videoDuration = parseDuration(videoStream);
    const audioDuration = parseDuration(audioStream);
    const videoFrames = Number(videoStream?.nb_frames || 0) || null;

    if (!videoStream) return { valid: false, reason: 'ffprobe não encontrou stream de vídeo.', fileSize, duration, videoDuration: null, audioDuration, videoFrames, expectedDurationSeconds, ffprobeData };
    if (!videoDuration || videoDuration < expectedDurationSeconds * 0.8) {
      return { valid: false, reason: `Video stream too short: video has ${videoDuration || 0}s but expected around ${expectedDurationSeconds}s`, fileSize, duration, videoDuration, audioDuration, videoFrames, expectedDurationSeconds, ffprobeData };
    }
    if (audioDuration && Math.abs(audioDuration - videoDuration) > 5 && expectedDurationSeconds <= 300) {
      return { valid: false, reason: `Audio/video duration mismatch: video has ${videoDuration}s and audio has ${audioDuration}s`, fileSize, duration, videoDuration, audioDuration, videoFrames, expectedDurationSeconds, ffprobeData };
    }
    const minExpectedFrames = expectedDurationSeconds * TARGET_VIDEO_FPS * 0.5;
    if (videoFrames !== null && videoFrames < minExpectedFrames) {
      return { valid: false, reason: `Video frame count too low: ${videoFrames} frames for ${expectedDurationSeconds}s`, fileSize, duration, videoDuration, audioDuration, videoFrames, expectedDurationSeconds, ffprobeData };
    }
    return {
      valid: true,
      fileSize,
      duration,
      videoDuration,
      audioDuration,
      videoFrames,
      expectedDurationSeconds,
      codec: videoStream.codec_name || null,
      width: Number(videoStream.width || 0) || null,
      height: Number(videoStream.height || 0) || null,
      hasAudio: streams.some((stream) => stream.codec_type === 'audio')
    };
  } catch (error) {
    const warning = 'ffprobe falhou, mas arquivo tem tamanho suficiente para teste.';
    if (fileSize >= FFPROBE_FALLBACK_MIN_BYTES) {
      return { valid: true, fileSize, duration: null, videoDuration: null, audioDuration: null, videoFrames: null, expectedDurationSeconds, codec: null, width: null, height: null, hasAudio: null, warning, ffprobeError: error.message };
    }
    return { valid: false, fileSize, reason: `ffprobe falhou: ${error.message}`, ffprobeError: error.message, expectedDurationSeconds };
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/debug-env', (_req, res) => res.json(getEnvSummary()));
app.post('/legacy-upload-drive/:recordingId', async (req, res) => { const rec = recordings.get(req.params.recordingId); if (!rec) return res.status(404).json({ error: 'not_found' }); return res.json(await uploadVideoToDrive(rec.outputPath)); });

app.post('/start-recording', (req, res) => {
  try {
    const cameraId = String(req.body.camera || req.body.cameraId || '').toLowerCase();
    const rtspUrl = CAMERAS[cameraId];
    if (!rtspUrl) return res.status(400).json({ error: 'RTSP não configurado para esta câmera', cameraId, availableCameras: Object.keys(CAMERAS) });
    if (!RAILWAY_API_URL) return res.status(500).json({ error: 'RAILWAY_API_URL não configurada.' });

    const durationSeconds = Math.floor(Math.max(1, Number(req.body.durationMinutes || 60)) * 60);
    const recordingId = crypto.randomUUID();
    const outputPath = path.join(RECORDINGS_DIR, `${recordingId}.mp4`);
    const ffmpegArgs = [
      '-hide_banner',
      '-y',
      '-nostdin',
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts+discardcorrupt',
      '-use_wallclock_as_timestamps', '1',
      '-i', rtspUrl,
      '-t', String(durationSeconds),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', 'fps=10,scale=-2:720',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-ar', '16000',
      '-ac', '1',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outputPath
    ];
    console.log(`[recording:${recordingId}] Iniciando gravação RTSP camera=${cameraId} duration=${durationSeconds}s`);
    console.log(`[recording:${recordingId}] FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });

    const rec = { id: recordingId, recordingId, status: 'recording', failedStage: null, outputPath, fileSize: null, videoValidation: null, processRef: ffmpeg, ffmpegStderr: '', ffmpegLastLog: '', professor: req.body.professor || '', turma: req.body.turma || '', nivel: req.body.nivel || '', sala: req.body.sala || '', horario: req.body.horario || '', prompt: req.body.prompt || '', cameraId, startedAt: new Date().toISOString(), finishedAt: null, gcsBucket: null, gcsFileName: null, videoUrl: null, uploadedAt: null, railwayResponse: null, error: null };
    recordings.set(recordingId, rec);

    ffmpeg.stderr.on('data', (chunk) => {
      rec.ffmpegStderr = appendBoundedLog(rec.ffmpegStderr, chunk, MAX_FFMPEG_LOG_CHARS);
    });

    ffmpeg.on('close', async (code) => {
      rec.finishedAt = new Date().toISOString();
      rec.ffmpegLastLog = getLogTail(rec.ffmpegStderr);
      console.log(`[recording:${recordingId}] FFmpeg finalizou com código ${code}`);
      if (code !== 0) {
        rec.status = 'failed';
        rec.failedStage = 'recording';
        rec.error = `FFmpeg encerrou com código ${code}`;
        return;
      }
      console.log(`[recording:${recordingId}] Iniciando validação de vídeo em ${rec.outputPath}`);
      rec.status = 'validating_video';
      const validation = await validateVideoFile(rec.outputPath, durationSeconds);
      console.log(`[recording:${recordingId}] Resultado da validação ffprobe: ${JSON.stringify(validation)}`);
      rec.videoValidation = validation;
      rec.fileSize = validation.fileSize || null;
      if (!validation.valid) {
        rec.status = 'failed';
        rec.failedStage = 'validating_video';
        rec.error = validation.reason || validation.error || 'Falha na validação do vídeo.';
        return;
      }
      console.log(`[recording:${recordingId}] Vídeo válido. Prosseguindo para upload/análise.`);
      await finalizeRecording(recordingId);
    });
    ffmpeg.on('error', (error) => {
      rec.status = 'failed';
      rec.failedStage = 'starting_ffmpeg';
      rec.error = `Falha ao iniciar FFmpeg: ${error.message}`;
      rec.ffmpegLastLog = getLogTail(rec.ffmpegStderr);
    });
    return res.json({ recordingId, status: rec.status });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

app.post('/stop-recording/:recordingId', (req, res) => {
  const rec = recordings.get(req.params.recordingId);
  if (!rec) return res.status(404).json({ error: 'recordingId não encontrado' });
  rec.status = 'stopping';
  if (rec.processRef && !rec.processRef.killed) rec.processRef.kill('SIGINT');
  return res.json({ ok: true, recordingId: rec.recordingId, status: rec.status });
});

app.get('/recording-status/:recordingId', (req, res) => {
  const rec = recordings.get(req.params.recordingId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  return res.json({ id: rec.id, status: rec.status, failedStage: rec.failedStage, error: rec.error, ffmpegLastLog: rec.ffmpegLastLog || getLogTail(rec.ffmpegStderr), outputPath: rec.outputPath, fileSize: rec.fileSize, videoValidation: rec.videoValidation, gcsBucket: rec.gcsBucket, gcsFileName: rec.gcsFileName, videoUrl: rec.videoUrl, railwayResponse: rec.railwayResponse });
});

app.listen(PORT, () => console.log(`Agent local rodando na porta ${PORT}`));
