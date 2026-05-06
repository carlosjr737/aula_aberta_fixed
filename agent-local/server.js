const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 4000;
const RAILWAY_API_URL = (process.env.RAILWAY_API_URL || '').replace(/\/$/, '');
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

const RECORDINGS_DIR = path.join(os.tmpdir(), 'dk-local-recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const CAMERAS = {
  bolso: process.env.RTSP_BOLSO,
  subway: process.env.RTSP_SUBWAY,
  mirante: process.env.RTSP_MIRANTE
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
  const requestBody = { name: path.basename(filePath), parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined };
  const res = await drive.files.create({ requestBody, media, fields: 'id,webViewLink', supportsAllDrives: true });
  return res.data;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/start-recording', async (req, res) => {
  try {
    const { professor = '', turma = '', nivel = '', sala = '', horario = '', prompt = '', camera = 'subway', durationMinutes = 60 } = req.body || {};
    const rtspUrl = CAMERAS[camera];
    if (!rtspUrl) return res.status(400).json({ error: 'Câmera inválida ou RTSP não configurado.' });
    if (!RAILWAY_API_URL) return res.status(500).json({ error: 'RAILWAY_API_URL não configurada.' });

    const recordingId = crypto.randomUUID();
    const outputPath = path.join(RECORDINGS_DIR, `${recordingId}.mp4`);
    const args = ['-rtsp_transport', 'tcp', '-i', rtspUrl, '-t', String(Math.max(1, Number(durationMinutes) * 60)), '-c', 'copy', outputPath];
    const processRef = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    recordings.set(recordingId, { recordingId, status: 'recording', outputPath, processRef, professor, turma, nivel, sala, horario, prompt, camera });
    processRef.on('exit', () => finalizeRecording(recordingId));

    res.json({ recordingId, status: 'recording' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/stop-recording/:id', (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'recordingId não encontrado' });
  rec.status = 'stopping';
  if (rec.processRef && !rec.processRef.killed) rec.processRef.kill('SIGINT');
  res.json({ ok: true, status: rec.status });
});

app.get('/recording-status/:id', (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  res.json({ recordingId: rec.recordingId, status: rec.status, error: rec.error || null, driveFileId: rec.driveFileId || null });
});

async function finalizeRecording(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return;
  try {
    rec.status = 'uploading_drive';
    const driveFile = await uploadVideo(rec.outputPath);
    rec.driveFileId = driveFile.id;

    rec.status = 'analyzing';
    const response = await fetch(`${RAILWAY_API_URL}/analyze-drive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: driveFile.id,
        professor: rec.professor,
        turma: rec.turma,
        nivel: rec.nivel,
        sala: rec.sala,
        horario: rec.horario,
        prompt: rec.prompt
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

app.listen(PORT, () => console.log(`Agent local rodando na porta ${PORT}`));
