require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const REQUIRED_ENV_KEYS = [
  'PORT',
  'RAILWAY_API_URL',
  'DRIVE_FOLDER_ID',
  'RTSP_SUBWAY',
  'RTSP_BOLSO',
  'RTSP_MIRANTE',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_TOKEN_JSON'
];

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

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

function parseJsonEnv(raw, envVarName) {
  try {
    const parsed = JSON.parse(sanitizeJsonEnv(raw));
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`${envVarName} não é um objeto JSON válido.`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Falha ao processar ${envVarName}: ${error.message}`);
  }
}

function parseServiceAccountJson(raw) {
  const parsed = parseJsonEnv(raw, 'GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!parsed.private_key || typeof parsed.private_key !== 'string') {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON sem private_key válida.');
  }
  parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  return parsed;
}

function parseOAuthTokenJson(raw) {
  const parsed = parseJsonEnv(raw, 'GOOGLE_OAUTH_TOKEN_JSON');
  if (!parsed.refresh_token && !parsed.access_token) {
    throw new Error('GOOGLE_OAUTH_TOKEN_JSON sem access_token/refresh_token.');
  }
  return parsed;
}

function getEnvSummary() {
  return REQUIRED_ENV_KEYS.reduce((acc, key) => {
    acc[key] = toBool(process.env[key]);
    return acc;
  }, {});
}

const envSummary = getEnvSummary();
console.log('[agent-local] Variáveis de ambiente detectadas (true/false):');
Object.entries(envSummary).forEach(([key, value]) => console.log(`- ${key}: ${value}`));

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

function getOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:4000/oauth2callback';
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getDriveClient() {
  const hasOAuth = toBool(process.env.GOOGLE_OAUTH_CLIENT_ID)
    && toBool(process.env.GOOGLE_OAUTH_CLIENT_SECRET)
    && toBool(process.env.GOOGLE_OAUTH_TOKEN_JSON);

  if (hasOAuth) {
    try {
      const oauth2Client = getOAuthClient();
      const tokens = parseOAuthTokenJson(process.env.GOOGLE_OAUTH_TOKEN_JSON);
      oauth2Client.setCredentials(tokens);
      return {
        drive: google.drive({ version: 'v3', auth: oauth2Client }),
        authMode: 'oauth_user'
      };
    } catch (error) {
      throw new Error(`Credenciais OAuth inválidas: ${error.message}`);
    }
  }

  if (toBool(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)) {
    try {
      const credentials = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
      return {
        drive: google.drive({ version: 'v3', auth }),
        authMode: 'service_account'
      };
    } catch (error) {
      throw new Error(`Credenciais Service Account inválidas: ${error.message}`);
    }
  }

  throw new Error('Nenhuma credencial Google Drive válida encontrada. Configure OAuth (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_TOKEN_JSON) ou GOOGLE_SERVICE_ACCOUNT_JSON.');
}

async function uploadVideo(filePath) {
  const { drive, authMode } = getDriveClient();
  const media = { mimeType: 'video/mp4', body: fs.createReadStream(filePath) };
  const requestBody = {
    name: path.basename(filePath),
    parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined
  };

  try {
    const res = await drive.files.create({ requestBody, media, fields: 'id,webViewLink', supportsAllDrives: true });
    return {
      driveFileId: res.data.id,
      driveFileUrl: res.data.webViewLink || null,
      authMode
    };
  } catch (error) {
    const details = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
    throw new Error(`Falha no upload para Google Drive (${authMode}): ${details}`);
  }
}

async function finalizeRecording(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return;

  rec.finishedAt = new Date().toISOString();
  try {
    rec.status = 'uploading_drive';
    const driveFile = await uploadVideo(rec.outputPath);
    rec.driveFileId = driveFile.driveFileId;
    rec.driveFileUrl = driveFile.driveFileUrl;
    rec.driveAuthMode = driveFile.authMode;

    rec.status = 'analyzing';
    const response = await fetch(`${RAILWAY_API_URL}/analyze-drive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driveFileId: driveFile.driveFileId,
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
    rec.errorDetails = {
      stack: error.stack,
      at: new Date().toISOString()
    };
    console.error(`[recording:${recordingId}] erro:`, error);
  } finally {
    if (fs.existsSync(rec.outputPath)) fs.unlinkSync(rec.outputPath);
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/debug-env', (_req, res) => {
  res.json(getEnvSummary());
});

app.get('/auth/google', (_req, res) => {
  try {
    if (!toBool(process.env.GOOGLE_OAUTH_CLIENT_ID) || !toBool(process.env.GOOGLE_OAUTH_CLIENT_SECRET)) {
      return res.status(400).json({
        error: 'Configure GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET antes de iniciar o fluxo OAuth.'
      });
    }

    const oauth2Client = getOAuthClient();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [DRIVE_SCOPE]
    });

    return res.redirect(authUrl);
  } catch (error) {
    return res.status(500).json({ error: `Falha ao gerar URL OAuth: ${error.message}` });
  }
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Parâmetro "code" não recebido do Google OAuth.');

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));

    return res.status(200).send(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>OAuth concluído</title></head>
<body style="font-family: Arial, sans-serif; margin: 24px;">
  <h2>OAuth do Google Drive concluído ✅</h2>
  <p>Copie o valor abaixo e cole no seu <code>.env</code> como <code>GOOGLE_OAUTH_TOKEN_JSON</code>.</p>
  <textarea style="width:100%;height:220px;">${JSON.stringify(tokens)}</textarea>
  <pre style="white-space: pre-wrap; background:#f5f5f5; padding: 12px;">GOOGLE_OAUTH_TOKEN_JSON=${JSON.stringify(tokens)}</pre>
  <p>Depois reinicie o agent-local.</p>
</body>
</html>`);
  } catch (error) {
    const details = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
    return res.status(500).send(`Falha ao trocar code por token: ${details}`);
  }
});

app.post('/start-recording', (req, res) => {
  try {
    const cameraId = String(req.body.camera || req.body.cameraId || '').toLowerCase();
    const rtspUrl = CAMERAS[cameraId];
    if (!rtspUrl) {
      return res.status(400).json({
        error: 'RTSP não configurado para esta câmera',
        cameraId,
        availableCameras: Object.keys(CAMERAS),
        hasRtsp: {
          bolso: Boolean(process.env.RTSP_BOLSO),
          mirante: Boolean(process.env.RTSP_MIRANTE),
          subway: Boolean(process.env.RTSP_SUBWAY)
        }
      });
    }
    if (!RAILWAY_API_URL) return res.status(500).json({ error: 'RAILWAY_API_URL não configurada.' });

    const durationMinutes = Math.max(1, Number(req.body.durationMinutes || 60));
    const durationSeconds = Math.floor(durationMinutes * 60);
    const recordingId = crypto.randomUUID();
    const outputPath = path.join(RECORDINGS_DIR, `${recordingId}.mp4`);
    const args = ['-rtsp_transport', 'tcp', '-i', rtspUrl, '-t', String(durationSeconds), '-c', 'copy', outputPath];
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const rec = {
      id: recordingId,
      recordingId,
      status: 'recording',
      outputPath,
      fileSize: null,
      processRef: ffmpeg,
      ffmpegStderr: '',
      professor: req.body.professor || '',
      turma: req.body.turma || '',
      nivel: req.body.nivel || '',
      sala: req.body.sala || '',
      horario: req.body.horario || '',
      prompt: req.body.prompt || '',
      cameraId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      driveFileId: null,
      driveFileUrl: null,
      driveAuthMode: null,
      railwayResponse: null,
      error: null,
      errorDetails: null
    };

    recordings.set(recordingId, rec);
    console.log(`[ffmpeg] Início gravação ${recordingId} câmera=${cameraId} duração=${durationSeconds}s`);

    const timeoutMs = (durationSeconds + 45) * 1000;
    rec.timeoutRef = setTimeout(() => {
      if (rec.status === 'recording' && rec.processRef && !rec.processRef.killed) {
        rec.status = 'failed';
        rec.error = `FFmpeg timeout após ${timeoutMs}ms`;
        rec.processRef.kill('SIGKILL');
      }
    }, timeoutMs);

    ffmpeg.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      rec.ffmpegStderr += text;
      if (rec.ffmpegStderr.length > 12000) rec.ffmpegStderr = rec.ffmpegStderr.slice(-12000);
      process.stdout.write(`[ffmpeg:${recordingId}] ${text}`);
    });

    ffmpeg.on('error', (error) => {
      clearTimeout(rec.timeoutRef);
      rec.status = 'failed';
      rec.finishedAt = new Date().toISOString();
      rec.error = `Falha ao iniciar FFmpeg: ${error.message}`;
      rec.errorDetails = { stack: error.stack, at: new Date().toISOString() };
    });

    ffmpeg.on('close', async (code) => {
      clearTimeout(rec.timeoutRef);
      rec.finishedAt = new Date().toISOString();
      console.log(`[ffmpeg] Fim gravação ${recordingId} code=${code}`);

      if (rec.status === 'failed') return;

      if (code !== 0) {
        rec.status = 'failed';
        rec.error = `FFmpeg encerrou com código ${code}. STDERR: ${rec.ffmpegStderr.slice(-2000)}`;
        return;
      }

      if (!fs.existsSync(rec.outputPath)) {
        rec.status = 'failed';
        rec.error = 'FFmpeg finalizou, mas o arquivo de saída não foi criado.';
        return;
      }

      const stat = fs.statSync(rec.outputPath);
      rec.fileSize = stat.size;
      if (stat.size < MIN_FILE_SIZE_BYTES) {
        rec.status = 'failed';
        rec.error = `Arquivo de saída muito pequeno (${stat.size} bytes).`;
        return;
      }

      await finalizeRecording(recordingId);
    });

    return res.json({ recordingId, status: rec.status });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

function stopRecordingById(recordingId, res) {
  const rec = recordings.get(recordingId);
  if (!rec) return res.status(404).json({ error: 'recordingId não encontrado' });
  rec.status = 'stopping';
  if (rec.processRef && !rec.processRef.killed) rec.processRef.kill('SIGINT');
  return res.json({ ok: true, recordingId: rec.recordingId, status: rec.status });
}

app.post('/stop-recording', (req, res) => stopRecordingById(req.body.recordingId, res));
app.post('/stop-recording/:recordingId', (req, res) => stopRecordingById(req.params.recordingId, res));

app.get('/recording-status/:recordingId', (req, res) => {
  const rec = recordings.get(req.params.recordingId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  return res.json({
    id: rec.id,
    status: rec.status,
    error: rec.error,
    errorDetails: rec.errorDetails,
    outputPath: rec.outputPath,
    fileSize: rec.fileSize,
    cameraId: rec.cameraId,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    driveFileId: rec.driveFileId,
    driveFileUrl: rec.driveFileUrl,
    driveAuthMode: rec.driveAuthMode,
    railwayResponse: rec.railwayResponse
  });
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, _req, res, _next) => {
  const statusCode = err?.status || 500;
  return res.status(statusCode).json({ error: err?.message || 'internal_server_error' });
});

app.listen(PORT, () => {
  console.log(`Agent local rodando na porta ${PORT}`);
});
