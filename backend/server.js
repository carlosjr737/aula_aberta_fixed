const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { google } = require('googleapis');
const { uploadToGemini, waitForGeminiActive, analyzeVideo, GEMINI_MODEL } = require('./services/geminiAnalyzer');

const app = express();
const PORT = process.env.PORT || 3001;
const MIN_FILE_SIZE_BYTES = 1 * 1024 * 1024;

app.use(cors({ origin: true }));
app.use(express.json());

const DEFAULT_PROMPT = 'Analise a aula inteira com foco em didática, energia, correções, clareza e evolução dos alunos.';

function extractDriveFileId(input) {
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  const m = input.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m?.[1] || null;
}

function getDriveClientRO() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  return google.drive({ version: 'v3', auth });
}

async function downloadFromDrive(fileId, destPath) {
  const drive = getDriveClientRO();
  const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
  await pipeline(res.data, fs.createWriteStream(destPath));
}

app.get('/health', (_req, res) => res.json({ ok: true, model: GEMINI_MODEL }));
app.get('/default-prompt', (_req, res) => res.json({ defaultPrompt: DEFAULT_PROMPT }));

app.post('/analyze-drive', async (req, res) => {
  let filePath = null;
  try {
    const {
      driveUrl,
      fileId: bodyFileId,
      professor = '',
      turma = '',
      nivel = '',
      sala = '',
      horario = '',
      prompt = DEFAULT_PROMPT
    } = req.body || {};

    const fileId = extractDriveFileId(bodyFileId || driveUrl || '');
    if (!fileId) return res.status(400).json({ error: 'É necessário enviar driveUrl ou fileId válidos.' });

    filePath = path.join(os.tmpdir(), `drive_video_${Date.now()}_${fileId}.mp4`);
    await downloadFromDrive(fileId, filePath);
    const size = fs.statSync(filePath).size;
    if (size < MIN_FILE_SIZE_BYTES) return res.status(400).json({ error: 'Arquivo inválido' });

    const file = await uploadToGemini(filePath, 'video/mp4');
    const active = await waitForGeminiActive(file.name);
    const rawResponse = await analyzeVideo(active.uri, prompt, { professor, turma, nivel, sala, horario, driveFileId: fileId });

    res.json({
      usedRealAI: true,
      provider: 'gemini',
      model: GEMINI_MODEL,
      report: {
        rawResponse,
        promptUsado: prompt,
        metadata: { professor, turma, nivel, sala, horario, driveFileId: fileId },
        analyzedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
