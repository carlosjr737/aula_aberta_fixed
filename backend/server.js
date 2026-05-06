const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { google } = require('googleapis');
const { uploadToGemini, waitForGeminiActive, analyzeVideo, GEMINI_MODEL } = require('./services/geminiAnalyzer');
const { generateLessonPdf } = require('./services/pdfGenerator');
const { uploadPdf } = require('./services/googleDriveUpload');

const app = express();
const PORT = process.env.PORT || 3001;
const MIN_FILE_SIZE_BYTES = 1 * 1024 * 1024;
const DEFAULT_PROMPT = 'Analise a aula inteira com foco em didática, energia, correções, clareza e evolução dos alunos.';

app.use(cors({ origin: true }));
app.use(express.json());

function extractDriveFileId(input) {
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  const m = String(input).match(/\/d\/([a-zA-Z0-9_-]+)/);
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
  let videoPath = null;
  let pdfPath = null;
  try {
    const {
      driveUrl,
      driveFileId,
      fileId,
      professor = '',
      turma = '',
      nivel = '',
      sala = '',
      horario = '',
      prompt = DEFAULT_PROMPT,
      cameraId = '',
      recordingStartedAt = '',
      recordingEndedAt = ''
    } = req.body || {};

    const finalFileId = extractDriveFileId(driveFileId || fileId || driveUrl || '');
    if (!finalFileId) return res.status(400).json({ error: 'É necessário enviar driveFileId, fileId ou driveUrl válidos.' });

    videoPath = path.join(os.tmpdir(), `drive_video_${Date.now()}_${finalFileId}.mp4`);
    await downloadFromDrive(finalFileId, videoPath);

    const size = fs.statSync(videoPath).size;
    if (size < MIN_FILE_SIZE_BYTES) return res.status(400).json({ error: 'Arquivo inválido' });

    const file = await uploadToGemini(videoPath, 'video/mp4');
    const active = await waitForGeminiActive(file.name);
    const rawResponse = await analyzeVideo(active.uri, prompt, { professor, turma, nivel, sala, horario, cameraId, driveFileId: finalFileId });

    const reportPayload = {
      recordingId: finalFileId,
      professor,
      turma,
      nivel,
      sala,
      startedAt: recordingStartedAt || 'Não informado',
      endedAt: recordingEndedAt || 'Não informado',
      durationMinutes: recordingStartedAt && recordingEndedAt ? Math.max(1, Math.round((new Date(recordingEndedAt) - new Date(recordingStartedAt)) / 60000)) : 'Não informado',
      prompt,
      analysis: rawResponse
    };

    pdfPath = await generateLessonPdf(reportPayload);
    const pdfDriveFile = await uploadPdf(pdfPath, { professor });

    return res.json({
      usedRealAI: true,
      provider: 'gemini',
      model: GEMINI_MODEL,
      report: {
        rawResponse,
        promptUsado: prompt,
        metadata: { professor, turma, nivel, sala, horario, cameraId, driveFileId: finalFileId },
        pdf: pdfDriveFile,
        analyzedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  } finally {
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (pdfPath && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  }
});

app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
