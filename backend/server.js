const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { google } = require('googleapis');
const { uploadToGemini, waitForGeminiActive, analyzeVideo, GEMINI_MODEL } = require('./services/geminiAnalyzer');
const { DNA_PROFESSOR_DK_FULL_OPERATIONAL } = require('./prompts/dnaProfessorDKFullOperational');
const { generateLessonPdf } = require('./services/pdfGenerator');
const { uploadPdf } = require('./services/googleDriveUpload');
const { uploadFileToGCS, generateSignedReadUrl } = require('./services/gcsStorage');
let ffprobePath = 'ffprobe';
try { ffprobePath = require('ffprobe-static').path || 'ffprobe'; } catch (_error) { ffprobePath = 'ffprobe'; }

const app = express();
const PORT = process.env.PORT || 3000;
const execFileAsync = promisify(execFile);
const MIN_VALIDATION_FILE_SIZE_BYTES = 50 * 1024;
const FFPROBE_FALLBACK_FILE_SIZE_BYTES = 100 * 1024;
const DEFAULT_PROMPT = 'Observar principalmente autonomia, refinamento e responsabilidade de elenco.';

const REQUIRED_PILLARS = [
  'Clareza de Objetivo e Direção Pedagógica',
  'Estrutura e Progressão Didática',
  'Gestão de Tempo e Ritmo',
  'Comunicação e Comandos',
  'Demonstração Técnica e Referência Corporal',
  'Correção Técnica e Refinamento',
  'Leitura de Turma e Adaptação',
  'Autonomia dos Alunos',
  'Gestão de Energia e Presença de Liderança',
  'Responsabilidade de Elenco e Ambiente de Aprendizagem',
  'Musicalidade, Precisão e Coerência Artística',
  'Evolução Observável ao Longo da Aula'
];

app.use(cors({ origin: true }));
app.use(express.json());

function extractDriveFileId(input) { if (!input) return null; if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input; const m = String(input).match(/\/d\/([a-zA-Z0-9_-]+)/); return m?.[1] || null; }
function getDriveClientRO() { const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] }); return google.drive({ version: 'v3', auth }); }
async function downloadFromDrive(fileId, destPath) { const drive = getDriveClientRO(); const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }); await pipeline(res.data, fs.createWriteStream(destPath)); }
async function downloadFromUrl(url, destPath) { const response = await fetch(url); if (!response.ok) throw new Error(`Falha ao baixar vídeo URL: ${response.status}`); await pipeline(response.body, fs.createWriteStream(destPath)); }
async function validateVideoFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { valid: false, fileSize: 0, error: 'Arquivo não encontrado.' };
  const fileSize = fs.statSync(filePath).size;
  if (fileSize < MIN_VALIDATION_FILE_SIZE_BYTES) return { valid: false, fileSize, error: `Arquivo inválido (${fileSize} bytes).` };

  try {
    const { stdout } = await execFileAsync(ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath]);
    const probe = JSON.parse(stdout || '{}');
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');
    if (!videoStream) return { valid: false, fileSize, error: 'Arquivo inválido: stream de vídeo não encontrada.' };
    const audioStream = streams.find((stream) => stream.codec_type === 'audio');
    const durationRaw = videoStream.duration || probe?.format?.duration || 0;
    const duration = Number(durationRaw) || 0;
    return { valid: true, fileSize, duration, codec: videoStream.codec_name || null, width: Number(videoStream.width) || null, height: Number(videoStream.height) || null, hasAudio: Boolean(audioStream) };
  } catch (_error) {
    if (fileSize >= FFPROBE_FALLBACK_FILE_SIZE_BYTES) {
      return {
        valid: true,
        fileSize,
        duration: null,
        codec: null,
        width: null,
        height: null,
        hasAudio: null,
        warning: 'ffprobe falhou no backend, mas arquivo tem tamanho suficiente para continuar.'
      };
    }
    return { valid: false, fileSize, error: 'Falha ao validar vídeo com ffprobe.' };
  }
}


function normalizeField(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function buildClassContext(input = {}, scheduleFallback = {}) {
  const source = { ...scheduleFallback, ...input };
  return {
    professor: normalizeField(source.professor),
    modalidade: normalizeField(source.modalidade),
    turma: normalizeField(source.turma),
    faixaEtaria: normalizeField(source.faixaEtaria),
    nivel: normalizeField(source.nivel),
    tipoAula: normalizeField(source.tipoAula),
    sala: normalizeField(source.sala),
    cameraId: normalizeField(source.cameraId),
    data: normalizeField(source.data, source.date),
    horarioAgendado: normalizeField(source.horarioAgendado, source.horario, source.start),
    durationMinutes: normalizeField(source.durationMinutes, source.duracao),
    observacoes: normalizeField(source.observacoes)
  };
}

function validatePromptHasFullDNA(finalPrompt = '') {
  const missing = REQUIRED_PILLARS.filter((pillar) => !finalPrompt.includes(pillar));
  if (missing.length) {
    const error = new Error('Prompt inválido: DNA Professor DK incompleto.');
    error.statusCode = 400;
    error.missingPillars = missing;
    throw error;
  }
}

function buildAnalysisPrompt({ classContext, userNotes = '' }) {
  const notes = normalizeField(userNotes, DEFAULT_PROMPT);
  return [
    DNA_PROFESSOR_DK_FULL_OPERATIONAL.trim(),
    '',
    'CONTEXTO DA AULA:',
    `- Professor: ${classContext.professor || 'Não informado'}`,
    `- Modalidade: ${classContext.modalidade || 'Não informado'}`,
    `- Turma: ${classContext.turma || 'Não informado'}`,
    `- Faixa etária: ${classContext.faixaEtaria || 'Não informado'}`,
    `- Nível: ${classContext.nivel || 'Não informado'}`,
    `- Tipo de aula: ${classContext.tipoAula || 'Não informado'}`,
    `- Sala: ${classContext.sala || 'Não informado'}`,
    `- Câmera: ${classContext.cameraId || 'Não informado'}`,
    `- Data: ${classContext.data || 'Não informado'}`,
    `- Horário agendado: ${classContext.horarioAgendado || 'Não informado'}`,
    `- Duração (min): ${classContext.durationMinutes || 'Não informado'}`,
    '',
    'OBSERVAÇÕES ESPECÍFICAS:',
    notes,
    '',
    'ORDEM FINAL: responder obrigatoriamente no modelo completo de relatório com os 12 pilares e a estrutura obrigatória definida no DNA.'
  ].join('\n');
}

function detectNoClass(rawResponse = '') {
  const text = String(rawResponse || '').toLowerCase();
  const signs = ['sala vazia', 'não há professor', 'nao ha professor', 'não há alunos', 'nao ha alunos', 'não foi possível avaliar', 'nao foi possivel avaliar'];
  return signs.some((sign) => text.includes(sign));
}

app.get('/health', (_req, res) => res.json({ ok: true, model: GEMINI_MODEL }));
app.get('/default-prompt', (_req, res) => res.json({ defaultPrompt: DEFAULT_PROMPT }));
app.get('/debug-env', (_req, res) => res.json({ GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY), GEMINI_MODEL: Boolean(process.env.GEMINI_MODEL), GOOGLE_SERVICE_ACCOUNT_JSON: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), GCS_BUCKET_NAME: Boolean(process.env.GCS_BUCKET_NAME), PDF_UPLOAD_PROVIDER: Boolean(process.env.PDF_UPLOAD_PROVIDER) }));

async function analyzeFromLocalVideo({ videoPath, recordingId, classContextInput, prompt, cameraId, recordingStartedAt, recordingEndedAt, gcsFileName, signedUrl, signedUrlExpiresAt, videoValidation }) {
  const file = await uploadToGemini(videoPath, 'video/mp4');
  const active = await waitForGeminiActive(file.name);
  const classContext = buildClassContext({ ...classContextInput, cameraId }, classContextInput);
  const finalPrompt = buildAnalysisPrompt({ classContext, userNotes: prompt });
  validatePromptHasFullDNA(finalPrompt);
  const rawResponse = await analyzeVideo(active.uri, finalPrompt, { ...classContext, cameraId, recordingId });
  const noClassDetected = detectNoClass(rawResponse);
  const status = noClassDetected ? 'completed_no_class_detected' : 'completed';

  const reportPayload = { recordingId, professor: classContext.professor, turma: classContext.turma, nivel: classContext.nivel, sala: classContext.sala, startedAt: recordingStartedAt || 'Não informado', endedAt: recordingEndedAt || 'Não informado', durationMinutes: recordingStartedAt && recordingEndedAt ? Math.max(1, Math.round((new Date(recordingEndedAt) - new Date(recordingStartedAt)) / 60000)) : 'Não informado', prompt, analysis: rawResponse };

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

  const responsePayload = {
    status,
    recordingId,
    classContext,
    videoGcsFileName: gcsFileName || recordingId,
    reportText: rawResponse,
    localJsonPath: null,
    localPdfPath: null,
    drivePdfUrl: null,
    driveJsonUrl: null,
    metadata: { recordingId, analyzedAt: new Date().toISOString(), classContext },
    video: { gcsFileName: gcsFileName || recordingId, signedUrl: signedUrl || null, signedUrlExpiresAt: signedUrlExpiresAt || null, validation: videoValidation || null },
    prompt: { dnaVersion: '1.0', promptTemplateVersion: '2.0', userNotes: normalizeField(prompt), finalPromptUsed: finalPrompt, finalPromptLength: finalPrompt.length },
    analysis: { provider: 'gemini', model: GEMINI_MODEL, rawResponse, status }
  };
  if (pdfUrl) responsePayload.drivePdfUrl = pdfUrl;
  return responsePayload;
}

app.post('/analyze-video-url', async (req, res) => {
  let videoPath = null;
  try {
    const { videoUrl, gcsBucket = '', gcsFileName = '', professor = '', modalidade = '', turma = '', faixaEtaria = '', nivel = '', sala = '', horario = '', duracao = '', observacoes = '', prompt = DEFAULT_PROMPT, cameraId = '', recordingStartedAt = '', recordingEndedAt = '' } = req.body || {};
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl é obrigatório.' });
    videoPath = path.join(os.tmpdir(), `gcs_video_${Date.now()}.mp4`);
    await downloadFromUrl(videoUrl, videoPath);
    const videoValidation = await validateVideoFile(videoPath);
    if (!videoValidation.valid) {
      return res.status(400).json({ error: videoValidation.error || 'Arquivo inválido', failedStage: 'validating_video_backend', fileSize: videoValidation.fileSize || 0, videoValidation });
    }
    const analysis = await analyzeFromLocalVideo({ videoPath, recordingId: gcsFileName || `url_${Date.now()}`, classContextInput: { professor, modalidade, turma, faixaEtaria, nivel, sala, horarioAgendado: horario, durationMinutes: duracao, observacoes }, prompt, cameraId, recordingStartedAt, recordingEndedAt, gcsFileName, signedUrl: videoUrl, videoValidation });
    return res.json(analysis);
  } catch (error) { return res.status(error.statusCode || 500).json({ error: error.message, failedStage: 'validating_video_backend', missingPillars: error.missingPillars || [], fileSize: videoPath && fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0, videoValidation: null }); }
  finally { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); }
});

app.post('/analyze-drive', async (req, res) => {
  let videoPath = null;
  try {
    const { driveUrl, driveFileId, fileId, professor = '', modalidade = '', turma = '', faixaEtaria = '', nivel = '', sala = '', horario = '', duracao = '', observacoes = '', prompt = DEFAULT_PROMPT, cameraId = '', recordingStartedAt = '', recordingEndedAt = '' } = req.body || {};
    const finalFileId = extractDriveFileId(driveFileId || fileId || driveUrl || '');
    if (!finalFileId) return res.status(400).json({ error: 'É necessário enviar driveFileId, fileId ou driveUrl válidos.' });
    videoPath = path.join(os.tmpdir(), `drive_video_${Date.now()}_${finalFileId}.mp4`);
    await downloadFromDrive(finalFileId, videoPath);
    const videoValidation = await validateVideoFile(videoPath);
    if (!videoValidation.valid) return res.status(400).json({ error: videoValidation.error || 'Arquivo inválido', failedStage: 'validating_video_backend', fileSize: videoValidation.fileSize || 0, videoValidation });
    const analysis = await analyzeFromLocalVideo({ videoPath, recordingId: finalFileId, classContextInput: { professor, modalidade, turma, faixaEtaria, nivel, sala, horarioAgendado: horario, durationMinutes: duracao, observacoes }, prompt, cameraId, recordingStartedAt, recordingEndedAt, gcsFileName: finalFileId, videoValidation });
    return res.json(analysis);
  } catch (error) { return res.status(error.statusCode || 500).json({ error: error.message, missingPillars: error.missingPillars || [] }); }
  finally { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); }
});

app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
