require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const DEBUG_ENV_KEYS = [
  'PORT',
  'RAILWAY_API_URL',
  'RTSP_SUBWAY',
  'RTSP_BOLSO',
  'RTSP_MIRANTE',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE_URL',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'DRIVE_FOLDER_ID'
];

function toBool(value) {
  return Boolean(String(value || '').trim());
}

function sanitizeJsonEnv(raw) {
  if (!raw) return '';
  let normalized = String(raw).trim();
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/\r/g, '').replace(/\n/g, '\\n');
  return normalized;
}

function parseServiceAccountJson(raw) {
  const parsed = JSON.parse(sanitizeJsonEnv(raw));
  parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  return parsed;
}

function getEnvSummary() {
  return DEBUG_ENV_KEYS.reduce((acc, key) => {
    acc[key] = toBool(process.env[key]);
    return acc;
  }, {});
}

function getR2Client() {
  const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`R2 não configurado. Variáveis ausentes: ${missing.join(', ')}`);
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

async function uploadVideoToR2(filePath, metadata = {}) {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET;
  const key = `recordings/${new Date().toISOString().slice(0, 10)}/${path.basename(filePath)}`;

  const uploadCommand = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: 'video/mp4',
    Metadata: Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v || '')]))
  });

  await client.send(uploadCommand);

  const getCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
  const videoUrl = await getSignedUrl(client, getCommand, { expiresIn: 2 * 60 * 60 });
  return { key, bucket, videoUrl };
}

const app = express();
const RAILWAY_API_URL = String(process.env.RAILWAY_API_URL || '').replace(/\/$/, '');
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const PORT = Number(process.env.PORT || 4000);

const RECORDINGS_DIR = path.join(os.tmpdir(), 'dk-local-recordings');
const MIN_FILE_SIZE_BYTES = 64 * 1024;
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const CAMERAS = {
  bolso: process.env.RTSP_BOLSO,
  mirante: process.env.RTSP_MIRANTE,
  subway: process.env.RTSP_SUBWAY
};

const recordings = new Map();

const corsOptions = {
  origin: 'https://aula-aberta-fixed.vercel.app',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning']
};

app.use(cors(corsOptions));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

function getDriveClient() {
  const credentials = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}

async function uploadVideoToDrive(filePath) {
  const drive = getDriveClient();
  const media = { mimeType: 'video/mp4', body: fs.createReadStream(filePath) };
  const requestBody = { name: path.basename(filePath), parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined };
  const res = await drive.files.create({ requestBody, media, fields: 'id,webViewLink', supportsAllDrives: true });
  return res.data;
}

async function finalizeRecording(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return;

  rec.finishedAt = new Date().toISOString();
  try {
    rec.status = 'uploading_r2';
    const r2Upload = await uploadVideoToR2(rec.outputPath, {
      professor: rec.professor,
      turma: rec.turma,
      cameraid: rec.cameraId,
      recordingid: rec.recordingId
    });

    rec.r2Key = r2Upload.key;
    rec.r2Bucket = r2Upload.bucket;
    rec.videoUrl = r2Upload.videoUrl;
    rec.uploadedAt = new Date().toISOString();

    rec.status = 'analyzing';
    const response = await fetch(`${RAILWAY_API_URL}/analyze-video-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoUrl: rec.videoUrl,
        r2Key: rec.r2Key,
        professor: rec.professor,
        turma: rec.turma,
        nivel: rec.nivel,
        sala: rec.sala,
        horario: rec.horario,
        prompt: rec.prompt,
        cameraId: rec.cameraId,
        recordingStartedAt: rec.startedAt,
        recordingEndedAt: rec.finishedAt
      })
    });

    const payload = await response.json();
    rec.railwayResponse = payload;
    if (!response.ok) throw new Error(payload.error || 'Falha ao analisar no Railway');
    rec.report = payload;
    rec.status = 'completed';
  } catch (error) {
    rec.status = 'failed';
    rec.error = error.message;
  } finally {
    if (fs.existsSync(rec.outputPath)) fs.unlinkSync(rec.outputPath);
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/debug-env', (_req, res) => res.json(getEnvSummary()));

// legacy fallback helper kept optional
app.post('/legacy-upload-drive/:recordingId', async (req, res) => {
  const rec = recordings.get(req.params.recordingId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return res.status(400).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON não configurado.' });
  const file = await uploadVideoToDrive(rec.outputPath);
  return res.json(file);
});

app.post('/start-recording', (req, res) => {
  try {
    const cameraId = String(req.body.camera || req.body.cameraId || '').toLowerCase();
    const rtspUrl = CAMERAS[cameraId];
    if (!rtspUrl) return res.status(400).json({ error: 'RTSP não configurado para esta câmera', cameraId, availableCameras: Object.keys(CAMERAS) });
    if (!RAILWAY_API_URL) return res.status(500).json({ error: 'RAILWAY_API_URL não configurada.' });

    const durationSeconds = Math.floor(Math.max(1, Number(req.body.durationMinutes || 60)) * 60);
    const recordingId = crypto.randomUUID();
    const outputPath = path.join(RECORDINGS_DIR, `${recordingId}.mp4`);
    const ffmpeg = spawn('ffmpeg', ['-rtsp_transport', 'tcp', '-i', rtspUrl, '-t', String(durationSeconds), '-c', 'copy', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] });

    const rec = { id: recordingId, recordingId, status: 'recording', outputPath, fileSize: null, processRef: ffmpeg, ffmpegStderr: '', professor: req.body.professor || '', turma: req.body.turma || '', nivel: req.body.nivel || '', sala: req.body.sala || '', horario: req.body.horario || '', prompt: req.body.prompt || '', cameraId, startedAt: new Date().toISOString(), finishedAt: null, r2Key: null, r2Bucket: null, videoUrl: null, uploadedAt: null, railwayResponse: null, error: null };
    recordings.set(recordingId, rec);

    ffmpeg.on('close', async (code) => {
      rec.finishedAt = new Date().toISOString();
      if (code !== 0) return void (rec.status = 'failed', rec.error = `FFmpeg encerrou com código ${code}`);
      if (!fs.existsSync(rec.outputPath)) return void (rec.status = 'failed', rec.error = 'Arquivo de saída não foi criado.');
      rec.fileSize = fs.statSync(rec.outputPath).size;
      if (rec.fileSize < MIN_FILE_SIZE_BYTES) return void (rec.status = 'failed', rec.error = `Arquivo muito pequeno (${rec.fileSize} bytes).`);
      await finalizeRecording(recordingId);
    });

    ffmpeg.on('error', (error) => {
      rec.status = 'failed';
      rec.error = `Falha ao iniciar FFmpeg: ${error.message}`;
    });

    return res.json({ recordingId, status: rec.status });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
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
  return res.json({ status: rec.status, error: rec.error, fileSize: rec.fileSize, r2Key: rec.r2Key, videoUrl: rec.videoUrl, railwayResponse: rec.railwayResponse });
});

app.listen(PORT, () => console.log(`Agent local rodando na porta ${PORT}`));
