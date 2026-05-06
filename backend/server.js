const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { google } = require('googleapis');
const { CAMERAS, DEFAULT_DURATION_MIN } = require('./utils/constants');
const { createRecordingId, startRtspRecording, stopRtspRecording } = require('./services/rtspRecorder');
const { uploadVideo, uploadPdf } = require('./services/googleDriveUpload');
const { uploadToGemini, waitForGeminiActive, analyzeVideo, GEMINI_MODEL } = require('./services/geminiAnalyzer');
const { generateLessonPdf } = require('./services/pdfGenerator');

const app = express();
const PORT = process.env.PORT || 3001;
const MIN_FILE_SIZE_BYTES = 1 * 1024 * 1024;
const recordings = new Map();

app.use(cors({ origin: true }));
app.use(express.json());

const DEFAULT_PROMPT = 'Analise a aula inteira com foco em didática, energia, correções, clareza e evolução dos alunos.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractDriveFileId(driveUrl) { const m = driveUrl?.match(/\/d\/([a-zA-Z0-9_-]+)/); return m?.[1] || null; }
function getDriveClientRO() { const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] }); return google.drive({ version: 'v3', auth }); }
async function downloadFromDrive(fileId, destPath) { const drive = getDriveClientRO(); const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }); await pipeline(res.data, fs.createWriteStream(destPath)); }

app.get('/health', (_req, res) => res.json({ ok: true, model: GEMINI_MODEL }));
app.get('/default-prompt', (_req, res) => res.json({ defaultPrompt: DEFAULT_PROMPT }));
app.get('/cameras', (_req, res) => res.json({ cameras: CAMERAS }));

app.post('/start-recording', async (req, res) => {
  try {
    const { professor = '', turma = '', nivel = '', sala = '', durationMinutes = DEFAULT_DURATION_MIN, prompt = DEFAULT_PROMPT, camera = 'subway' } = req.body || {};
    if (!CAMERAS[camera]?.rtsp) return res.status(400).json({ error: 'Câmera inválida ou sem RTSP configurado.' });

    const recordingId = createRecordingId();
    const startedAt = new Date().toISOString();
    const { outputPath, processRef, stderrRef } = startRtspRecording({ rtspUrl: CAMERAS[camera].rtsp, durationMinutes, recordingId });
    recordings.set(recordingId, { recordingId, status: 'recording', analysisStatus: 'pending', outputPath, processRef, startedAt, professor, turma, nivel, sala, prompt, durationMinutes, camera, stderrRef });

    processRef.on('exit', () => finalizeRecording(recordingId));
    res.json({ recordingId, status: 'recording' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/stop-recording/:id', (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'recordingId não encontrado' });
  rec.status = 'stopping';
  stopRtspRecording(rec.processRef);
  res.json({ ok: true, status: rec.status });
});

app.get('/recording-status/:id', (req, res) => res.json(recordings.get(req.params.id) || { error: 'not_found' }));
app.get('/analysis-status/:id', (req, res) => {
  const rec = recordings.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  res.json({ recordingId: rec.recordingId, analysisStatus: rec.analysisStatus, reportDriveFile: rec.reportDriveFile || null, error: rec.error || null });
});

async function finalizeRecording(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return;
  rec.status = 'finished';
  rec.endedAt = new Date().toISOString();
  rec.analysisStatus = 'uploading_video';
  try {
    const driveVideo = await uploadVideo(rec.outputPath, rec);
    rec.videoDriveFile = driveVideo;
    rec.analysisStatus = 'processing_gemini';
    const file = await uploadToGemini(rec.outputPath, 'video/mp4');
    const active = await waitForGeminiActive(file.name);
    const analysis = await analyzeVideo(active.uri, `${DEFAULT_PROMPT}\n\n${rec.prompt}`, rec);
    rec.analysis = analysis;
    rec.analysisStatus = 'generating_pdf';
    const pdfPath = await generateLessonPdf({ ...rec, analysis, durationMinutes: rec.durationMinutes });
    rec.analysisStatus = 'uploading_pdf';
    rec.reportDriveFile = await uploadPdf(pdfPath, rec);
    rec.analysisStatus = 'completed';
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    if (fs.existsSync(rec.outputPath)) fs.unlinkSync(rec.outputPath);
  } catch (error) {
    rec.analysisStatus = 'failed';
    rec.error = error.message;
  }
}

app.post('/analyze-drive', async (req, res) => {
  let filePath = null;
  try {
    const { driveUrl, professor = '', turma = '', sala = '', prompt = DEFAULT_PROMPT } = req.body || {};
    const fileId = extractDriveFileId(driveUrl || '');
    if (!fileId) return res.status(400).json({ error: 'Link inválido' });
    filePath = path.join(os.tmpdir(), `drive_video_${Date.now()}_${fileId}.mp4`);
    await downloadFromDrive(fileId, filePath);
    const size = fs.statSync(filePath).size;
    if (size < MIN_FILE_SIZE_BYTES) return res.status(400).json({ error: 'Arquivo inválido' });
    const file = await uploadToGemini(filePath, 'video/mp4');
    const active = await waitForGeminiActive(file.name);
    const rawResponse = await analyzeVideo(active.uri, prompt, { professor, turma, sala, driveFileId: fileId });
    res.json({ usedRealAI: true, provider: 'gemini', model: GEMINI_MODEL, report: { rawResponse, promptUsado: prompt, metadata: { professor, turma, sala }, analyzedAt: new Date().toISOString() } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
