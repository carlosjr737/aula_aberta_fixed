const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const RAILWAY_API_URL = String(process.env.RAILWAY_API_URL || '').replace(/\/$/, '');
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

const RECORDINGS_DIR = path.join(os.tmpdir(), 'dk-local-recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const CAMERAS = {
  bolso: process.env.RTSP_BOLSO,
  mirante: process.env.RTSP_MIRANTE,
  subway: process.env.RTSP_SUBWAY
};

const recordings = new Map();

app.use(cors({ origin: true }));
app.use(express.json());

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}

async function uploadVideo(filePath) {
  const drive = getDriveClient();
  const media = { mimeType: 'video/mp4', body: fs.createReadStream(filePath) };
  const requestBody = {
    name: path.basename(filePath),
    parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined
  };
  const res = await drive.files.create({ requestBody, media, fields: 'id,webViewLink', supportsAllDrives: true });
  return res.data;
}

async function finalizeRecording(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return;

  rec.recordingEndedAt = new Date().toISOString();
  try {
    rec.status = 'uploading_drive';
    const driveFile = await uploadVideo(rec.outputPath);
    rec.driveFileId = driveFile.id;

    rec.status = 'analyzing';
    const response = await fetch(`${RAILWAY_API_URL}/analyze-drive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driveFileId: driveFile.id,
        professor: rec.professor,
        turma: rec.turma,
        nivel: rec.nivel,
        sala: rec.sala,
        horario: rec.horario,
        prompt: rec.prompt,
        cameraId: rec.cameraId,
        recordingStartedAt: rec.recordingStartedAt,
        recordingEndedAt: rec.recordingEndedAt
      })
    });

    const payload = await response.json();
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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'agent-local' });
});

app.post('/start-recording', (req, res) => {
  try {
    const cameraId = String(req.body.camera || req.body.cameraId || '').toLowerCase();
    const rtspUrl = CAMERAS[cameraId];
    if (!rtspUrl) return res.status(400).json({ error: 'cameraId inválido.' });
    if (!RAILWAY_API_URL) return res.status(500).json({ error: 'RAILWAY_API_URL não configurada.' });

    const durationMinutes = Math.max(1, Number(req.body.durationMinutes || 60));
    const durationSeconds = Math.floor(durationMinutes * 60);
    const recordingId = crypto.randomUUID();
    const outputPath = path.join(RECORDINGS_DIR, `${recordingId}.mp4`);
    const args = ['-rtsp_transport', 'tcp', '-i', rtspUrl, '-t', String(durationSeconds), '-c', 'copy', outputPath];
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const rec = {
      recordingId,
      status: 'recording',
      outputPath,
      processRef: ffmpeg,
      professor: req.body.professor || '',
      turma: req.body.turma || '',
      nivel: req.body.nivel || '',
      sala: req.body.sala || '',
      horario: req.body.horario || '',
      prompt: req.body.prompt || '',
      cameraId,
      recordingStartedAt: new Date().toISOString()
    };

    recordings.set(recordingId, rec);

    ffmpeg.on('error', (error) => {
      rec.status = 'failed';
      rec.error = error.message;
    });
    ffmpeg.on('exit', () => {
      if (rec.status === 'failed') return;
      finalizeRecording(recordingId);
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
  return res.json({
    recordingId: rec.recordingId,
    status: rec.status,
    error: rec.error || null,
    driveFileId: rec.driveFileId || null,
    report: rec.report || null,
    recordingStartedAt: rec.recordingStartedAt,
    recordingEndedAt: rec.recordingEndedAt || null
  });
});

app.listen(PORT, () => {
  console.log(`Agent local rodando na porta ${PORT}`);
});
