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
const { uploadFileToGCS, generateSignedReadUrl } = require('./services/gcsStorage');

const app = express();
const PORT = process.env.PORT || 3000;
const MIN_FILE_SIZE_BYTES = 1 * 1024 * 1024;
const DEFAULT_PROMPT = 'Analise a aula inteira com foco em didática, energia, correções, clareza e evolução dos alunos.';

app.use(cors({ origin: true }));
app.use(express.json());

function extractDriveFileId(input) { if (!input) return null; if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input; const m = String(input).match(/\/d\/([a-zA-Z0-9_-]+)/); return m?.[1] || null; }
function getDriveClientRO() { const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] }); return google.drive({ version: 'v3', auth }); }
async function downloadFromDrive(fileId, destPath) { const drive = getDriveClientRO(); const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }); await pipeline(res.data, fs.createWriteStream(destPath)); }
async function downloadFromUrl(url, destPath) { const response = await fetch(url); if (!response.ok) throw new Error(`Falha ao baixar vídeo URL: ${response.status}`); await pipeline(response.body, fs.createWriteStream(destPath)); }

app.get('/health', (_req, res) => res.json({ ok: true, model: GEMINI_MODEL }));
app.get('/default-prompt', (_req, res) => res.json({ defaultPrompt: DEFAULT_PROMPT }));
app.get('/debug-env', (_req, res) => res.json({ GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY), GEMINI_MODEL: Boolean(process.env.GEMINI_MODEL), GOOGLE_SERVICE_ACCOUNT_JSON: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), GCS_BUCKET_NAME: Boolean(process.env.GCS_BUCKET_NAME), PDF_UPLOAD_PROVIDER: Boolean(process.env.PDF_UPLOAD_PROVIDER) }));

async function analyzeFromLocalVideo({ videoPath, recordingId, professor, turma, nivel, sala, horario, prompt, cameraId, recordingStartedAt, recordingEndedAt }) {
  const file = await uploadToGemini(videoPath, 'video/mp4');
  const active = await waitForGeminiActive(file.name);
  const rawResponse = await analyzeVideo(active.uri, prompt, { professor, turma, nivel, sala, horario, cameraId, recordingId });

  const reportPayload = { recordingId, professor, turma, nivel, sala, startedAt: recordingStartedAt || 'Não informado', endedAt: recordingEndedAt || 'Não informado', durationMinutes: recordingStartedAt && recordingEndedAt ? Math.max(1, Math.round((new Date(recordingEndedAt) - new Date(recordingStartedAt)) / 60000)) : 'Não informado', prompt, analysis: rawResponse };

  const pdfUploadProvider = String(process.env.PDF_UPLOAD_PROVIDER || 'none').toLowerCase();
  let pdfUrl = null;
  let pdfPath = null;
  if (pdfUploadProvider === 'gcs') {
    pdfPath = await generateLessonPdf(reportPayload);
    const analysisId = recordingId || `analysis_${Date.now()}`;
    const date = new Date().toISOString().slice(0, 10);
    const fileName = `reports/${date}/${analysisId}.pdf`;
    await uploadFileToGCS(pdfPath, fileName, 'application/pdf');
    pdfUrl = await generateSignedReadUrl(fileName, 120);
  } else if (pdfUploadProvider === 'drive') {
    pdfPath = await generateLessonPdf(reportPayload);
    const driveData = await uploadPdf(pdfPath, { professor });
    pdfUrl = driveData?.webViewLink || null;
  }
  if (pdfPath && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

  return { usedRealAI: true, provider: 'gemini', model: GEMINI_MODEL, report: { rawResponse, promptUsado: prompt, metadata: { professor, turma, nivel, sala, horario, cameraId, recordingId }, analyzedAt: new Date().toISOString() }, pdfUrl };
}

app.post('/analyze-video-url', async (req, res) => {
  let videoPath = null;
  try {
    const { videoUrl, gcsBucket = '', gcsFileName = '', professor = '', turma = '', nivel = '', sala = '', horario = '', prompt = DEFAULT_PROMPT, cameraId = '', recordingStartedAt = '', recordingEndedAt = '' } = req.body || {};
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl é obrigatório.' });
    videoPath = path.join(os.tmpdir(), `gcs_video_${Date.now()}.mp4`);
    await downloadFromUrl(videoUrl, videoPath);
    if (!fs.existsSync(videoPath)) return res.status(400).json({ error: 'Arquivo de vídeo não foi baixado corretamente.' });
    const size = fs.statSync(videoPath).size;
    if (size < MIN_FILE_SIZE_BYTES) return res.status(400).json({ error: `Arquivo inválido (${size} bytes).` });
    return res.json(await analyzeFromLocalVideo({ videoPath, recordingId: gcsFileName || `url_${Date.now()}`, professor, turma, nivel, sala, horario, prompt, cameraId, recordingStartedAt, recordingEndedAt, gcsBucket, gcsFileName }));
  } catch (error) { return res.status(500).json({ error: error.message }); }
  finally { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); }
});

app.post('/analyze-drive', async (req, res) => {
  let videoPath = null;
  try {
    const { driveUrl, driveFileId, fileId, professor = '', turma = '', nivel = '', sala = '', horario = '', prompt = DEFAULT_PROMPT, cameraId = '', recordingStartedAt = '', recordingEndedAt = '' } = req.body || {};
    const finalFileId = extractDriveFileId(driveFileId || fileId || driveUrl || '');
    if (!finalFileId) return res.status(400).json({ error: 'É necessário enviar driveFileId, fileId ou driveUrl válidos.' });
    videoPath = path.join(os.tmpdir(), `drive_video_${Date.now()}_${finalFileId}.mp4`);
    await downloadFromDrive(finalFileId, videoPath);
    const size = fs.statSync(videoPath).size;
    if (size < MIN_FILE_SIZE_BYTES) return res.status(400).json({ error: 'Arquivo inválido' });
    return res.json(await analyzeFromLocalVideo({ videoPath, recordingId: finalFileId, professor, turma, nivel, sala, horario, prompt, cameraId, recordingStartedAt, recordingEndedAt }));
  } catch (error) { return res.status(500).json({ error: error.message }); }
  finally { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); }
});

app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
