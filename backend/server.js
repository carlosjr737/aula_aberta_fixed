const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { google } = require('googleapis');
const { uploadToGemini, waitForGeminiActive, analyzeVideo, analyzeText, countVideoTokens, GEMINI_MODEL } = require('./services/geminiAnalyzer');
const { DNA_PROFESSOR_DK_FULL_OPERATIONAL } = require('./prompts/dnaProfessorDKFullOperational');
const { generateLessonPdf } = require('./services/pdfGenerator');
const { uploadPdf } = require('./services/googleDriveUpload');
let ffprobeStaticPath = 'ffprobe';
try { ffprobeStaticPath = require('ffprobe-static').path || 'ffprobe'; } catch (_error) { ffprobeStaticPath = 'ffprobe'; }

const app = express();
const PORT = process.env.PORT || 3000;
const execFileAsync = promisify(execFile);
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || ffprobeStaticPath || 'ffprobe';
const TOKEN_SINGLE_ANALYSIS_LIMIT = 900000;
const MIN_VALIDATION_FILE_SIZE_BYTES = 50 * 1024;
const FFPROBE_FALLBACK_FILE_SIZE_BYTES = 100 * 1024;
const DEFAULT_PROMPT = 'Observar principalmente autonomia, refinamento e responsabilidade de elenco.';
const ANALYSIS_ROUTES = ['/analyze-drive', '/analyze-gcs'];
const jobs = new Map();

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
app.use(express.json({ limit: '50mb' }));

process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

function parseServiceAccountJson() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nÃ£o configurado.');
  const credentials = JSON.parse(String(raw).trim());
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  return credentials;
}

function logStage(jobId, stage, data = {}) {
  console.log(`[analysis:${jobId}] ${stage} ${JSON.stringify(data)}`);
}

function logStageError(jobId, stage, error, data = {}) {
  console.error(`[analysis:${jobId}] ${stage} ${JSON.stringify({
    stage,
    message: error?.message || String(error || ''),
    stack: error?.stack || null,
    endpoint: data.endpoint || null,
    httpStatus: error?.status || error?.statusCode || data.httpStatus || null,
    responseBody: error?.responseText || data.responseBody || null,
    localPath: data.localPath || null,
    gcsBucket: data.gcsBucket || null,
    gcsFileName: data.gcsFileName || null
  })}`);
}

function serializeJob(job) {
  if (!job) return null;
  return {
    ok: true,
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result || null,
    error: job.error || null
  };
}

function createJob(payload) {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    jobId,
    payload,
    status: 'queued',
    stage: 'queued',
    createdAt: now,
    updatedAt: now,
    result: null,
    error: null
  };
  jobs.set(jobId, job);
  console.log(`[job:${jobId}] queued`);
  return job;
}

function updateJob(jobId, patch) {
  const current = jobs.get(jobId);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  return next;
}

function buildFailureResponse(error, failedStage, details = {}) {
  return {
    ok: false,
    failedStage,
    message: error?.message || String(error || ''),
    reportPath: error?.reportPath || details.reportPath || null,
    details: {
      ...details,
      ...(error?.details || {}),
      stack: error?.stack || null,
      httpStatus: error?.status || error?.statusCode || null,
      responseText: error?.responseText || null,
      reportPath: error?.reportPath || details.reportPath || null,
      reportDir: error?.reportDir || details.reportDir || null
    }
  };
}

function extractDriveFileId(input) { if (!input) return null; if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input; const m = String(input).match(/\/d\/([a-zA-Z0-9_-]+)/); return m?.[1] || null; }
function getDriveClientRO() { const credentials = parseServiceAccountJson(); const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] }); return google.drive({ version: 'v3', auth }); }
function getGcsClientRO() { const credentials = parseServiceAccountJson(); const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/devstorage.read_only'] }); return google.storage({ version: 'v1', auth }); }
async function downloadFromDrive(fileId, destPath) { const drive = getDriveClientRO(); const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }); await pipeline(res.data, fs.createWriteStream(destPath)); }
async function downloadFromGCS(bucketName, fileName, destPath) { const storage = getGcsClientRO(); const res = await storage.objects.get({ bucket: bucketName, object: fileName, alt: 'media' }, { responseType: 'stream' }); await pipeline(res.data, fs.createWriteStream(destPath)); }
async function downloadFromUrl(url, destPath) { const response = await fetch(url); if (!response.ok) throw new Error(`Falha ao baixar vídeo URL: ${response.status}`); await pipeline(response.body, fs.createWriteStream(destPath)); }
async function validateVideoFileLegacy(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { valid: false, fileSize: 0, error: 'Arquivo não encontrado.' };
  const fileSize = fs.statSync(filePath).size;
  if (fileSize < MIN_VALIDATION_FILE_SIZE_BYTES) return { valid: false, fileSize, error: `Arquivo inválido (${fileSize} bytes).` };

  try {
    const { stdout, stderr } = await execFileAsync(FFPROBE_PATH, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath]);
    if (stderr && /moov atom not found/i.test(stderr)) return { valid: false, fileSize, error: 'Arquivo invalido: moov atom not found.', ffprobeStderr: stderr };
    const probe = JSON.parse(stdout || '{}');
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');
    if (!videoStream) return { valid: false, fileSize, error: 'Arquivo inválido: stream de vídeo não encontrada.' };
    const audioStream = streams.find((stream) => stream.codec_type === 'audio');
    const durationRaw = probe?.format?.duration || videoStream.duration || 0;
    const duration = Number(durationRaw) || 0;
    if (!duration || duration <= 0) return { valid: false, fileSize, error: 'Arquivo invalido: duracao ausente ou zero.', ffprobeData: probe };
    return { valid: true, fileSize, duration, formatDuration: Number(probe?.format?.duration || 0) || null, codec: videoStream.codec_name || null, width: Number(videoStream.width) || null, height: Number(videoStream.height) || null, hasAudio: Boolean(audioStream) };
  } catch (error) {
    if (false && fileSize >= FFPROBE_FALLBACK_FILE_SIZE_BYTES) {
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
async function validateVideoFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { valid: false, fileSize: 0, error: 'Arquivo nao encontrado.' };
  const fileSize = fs.statSync(filePath).size;
  if (fileSize < MIN_VALIDATION_FILE_SIZE_BYTES) return { valid: false, fileSize, error: `Arquivo invalido (${fileSize} bytes).` };

  try {
    const { stdout, stderr } = await execFileAsync(FFPROBE_PATH, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath]);
    if (stderr && /moov atom not found/i.test(stderr)) return { valid: false, fileSize, error: 'Arquivo invalido: moov atom not found.', ffprobeStderr: stderr };
    const probe = JSON.parse(stdout || '{}');
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');
    if (!videoStream) return { valid: false, fileSize, error: 'Arquivo invalido: stream de video nao encontrada.', ffprobeData: probe };
    const audioStream = streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number(probe?.format?.duration || videoStream?.duration || 0) || 0;
    if (!duration || duration <= 0) return { valid: false, fileSize, error: 'Arquivo invalido: duracao ausente ou zero.', ffprobeData: probe };
    return {
      valid: true,
      fileSize,
      duration,
      formatDuration: Number(probe?.format?.duration || 0) || null,
      videoDuration: Number(videoStream?.duration || 0) || null,
      codec: videoStream.codec_name || null,
      width: Number(videoStream.width) || null,
      height: Number(videoStream.height) || null,
      hasAudio: Boolean(audioStream)
    };
  } catch (error) {
    const details = error?.stderr || error?.stdout || error?.message || '';
    const message = /moov atom not found/i.test(details)
      ? 'Arquivo invalido: moov atom not found.'
      : `Falha ao validar video com ffprobe: ${details}`;
    return { valid: false, fileSize, error: message, ffprobeError: error?.message || null, ffprobeStderr: error?.stderr || null, ffprobeStdout: error?.stdout || null };
  }
}

function normalizeField(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function parseGcsUri(gcsUri) {
  const text = normalizeField(gcsUri);
  const match = text.match(/^gs:\/\/([^/]+)\/(.+)$/i);
  if (!match) return {};
  return { bucketName: match[1], fileName: match[2] };
}

function withFailedStage(error, failedStage) {
  if (error && !error.failedStage) error.failedStage = failedStage;
  return error;
}

function checkBinary(command, args = ['-version']) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    let settled = false;

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        command,
        message: error.message
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: code === 0,
        command,
        code,
        version: (output || errorOutput).split('\n')[0]
      });
    });
  });
}

async function assertFfmpegAvailable() {
  const ffmpeg = await checkBinary(FFMPEG_PATH);
  if (ffmpeg.ok) return ffmpeg;

  const error = new Error('FFmpeg nao encontrado no backend Railway');
  error.failedStage = 'binary_check';
  error.details = {
    ffmpeg,
    FFMPEG_PATH,
    suggestion: 'Instale ffmpeg via backend/nixpacks.toml ou configure FFMPEG_PATH'
  };
  throw error;
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

async function segmentVideo(videoPath, segmentSeconds = 600) {
  const segmentPrefix = path.join(os.tmpdir(), `dk_segment_${Date.now()}_${path.basename(videoPath, path.extname(videoPath))}`);
  await assertFfmpegAvailable();
  await execFileAsync(FFMPEG_PATH, ['-hide_banner', '-y', '-i', videoPath, '-c', 'copy', '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1', `${segmentPrefix}_%03d.mp4`])
    .catch((error) => {
      if (error?.code === 'ENOENT' || /spawn .*ffmpeg.*ENOENT/i.test(error?.message || '')) {
        const binaryError = new Error('FFmpeg nao encontrado no backend Railway');
        binaryError.failedStage = 'binary_check';
        binaryError.details = {
          FFMPEG_PATH,
          suggestion: 'Instale ffmpeg via backend/nixpacks.toml ou configure FFMPEG_PATH'
        };
        throw binaryError;
      }
      throw withFailedStage(error, 'ffmpeg_preprocess');
    });
  const files = fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(path.basename(segmentPrefix)) && name.endsWith('.mp4'))
    .map((name) => path.join(os.tmpdir(), name))
    .sort();
  if (!files.length) throw new Error('Falha ao segmentar vídeo em blocos temporais.');
  return files;
}

app.get('/health', async (_req, res) => {
  const [ffmpeg, ffprobe] = await Promise.all([
    checkBinary(FFMPEG_PATH),
    checkBinary(FFPROBE_PATH)
  ]);

  res.json({
    ok: true,
    service: 'aula-aberta-backend',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    routes: ['/health', '/jobs/:jobId', '/analyze-gcs', '/analyze-drive'],
    binaries: {
      ffmpeg,
      ffprobe
    },
    env: {
      GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
      GOOGLE_APPLICATION_CREDENTIALS: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
      GCS_BUCKET: Boolean(process.env.GCS_BUCKET),
      FFMPEG_PATH: process.env.FFMPEG_PATH || null,
      FFPROBE_PATH: process.env.FFPROBE_PATH || null
    }
  });
});
app.get('/routes', (_req, res) => res.json({ ok: true, routes: ['/health', '/routes', '/default-prompt', '/debug-env', ...ANALYSIS_ROUTES] }));
app.get('/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, message: 'Job nao encontrado', jobId: req.params.jobId });
  return res.json(serializeJob(job));
});
app.get('/default-prompt', (_req, res) => res.json({ defaultPrompt: DEFAULT_PROMPT }));
app.get('/debug-env', (_req, res) => res.json({ GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY), GEMINI_MODEL: Boolean(process.env.GEMINI_MODEL), GOOGLE_SERVICE_ACCOUNT_JSON: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), PDF_UPLOAD_PROVIDER: Boolean(process.env.PDF_UPLOAD_PROVIDER) }));

async function analyzeFromLocalVideo({ videoPath, recordingId, classContextInput, prompt, cameraId, recordingStartedAt, recordingEndedAt, sourceFileName, sourceUrl, sourceUrlExpiresAt, videoValidation, jobId = null }) {
  logStage(recordingId, 'analysis_started', { localPath: videoPath, sourceFileName });
  const classContext = buildClassContext({ ...classContextInput, cameraId }, classContextInput);
  const finalPrompt = buildAnalysisPrompt({ classContext, userNotes: prompt });
  validatePromptHasFullDNA(finalPrompt);
  const metadata = { ...classContext, cameraId, recordingId };
  const videoFileSize = videoPath && fs.existsSync(videoPath) ? fs.statSync(videoPath).size : null;
  const videoDurationSeconds = Number(videoValidation?.duration || videoValidation?.formatDuration || 0) || null;
  console.log(`[analysis:${recordingId}] video_duration_seconds=${videoDurationSeconds || null}`);
  console.log(`[analysis:${recordingId}] video_file_size=${videoFileSize || null}`);
  logStage(recordingId, 'gemini_upload_started', { localPath: videoPath });
  const file = await uploadToGemini(videoPath, 'video/mp4').catch((error) => { throw withFailedStage(error, 'gemini_upload'); });
  const active = await waitForGeminiActive(file.name).catch((error) => { throw withFailedStage(error, 'gemini_upload'); });
  logStage(recordingId, 'gemini_upload_success', { geminiFile: file.name });
  const tokenCount = await countVideoTokens(active.uri, finalPrompt, metadata).catch((error) => { throw withFailedStage(error, 'gemini_analysis'); });
  console.log(`[analysis:${recordingId}] tokenCount estimado=${tokenCount}`);
  let rawResponse = '';
  let strategy = 'single';
  let segmentCount = 0;

  if (tokenCount <= TOKEN_SINGLE_ANALYSIS_LIMIT) {
    console.log(`[analysis:${recordingId}] estratégia=inteiro`);
    console.log(`[analysis:${recordingId}] analysis_strategy=direct_gemini ffmpeg_required=false`);
    rawResponse = await analyzeVideo(active.uri, finalPrompt, metadata).catch((error) => { throw withFailedStage(error, 'gemini_analysis'); });
  } else {
    strategy = 'segmented';
    console.log(`[analysis:${recordingId}] estratégia=segmentado`);
    console.log(`[analysis:${recordingId}] analysis_strategy=compressed_video ffmpeg_required=true`);
    const segments = await segmentVideo(videoPath, 600);
    segmentCount = segments.length;
    console.log(`[analysis:${recordingId}] segmentos=${segmentCount}`);
    const partialAnalyses = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segmentPath = segments[index];
      console.log(`[analysis:${recordingId}] início análise parcial segmento ${index + 1}/${segmentCount}`);
      const segmentUpload = await uploadToGemini(segmentPath, 'video/mp4').catch((error) => { throw withFailedStage(error, 'gemini_upload'); });
      const segmentActive = await waitForGeminiActive(segmentUpload.name).catch((error) => { throw withFailedStage(error, 'gemini_upload'); });
      const partialPrompt = `${finalPrompt}

ANÁLISE PARCIAL DE BLOCO TEMPORAL:
- Este é o bloco ${index + 1} de ${segmentCount}.
- Responda apenas com análise parcial deste bloco.
- Inclua horários aproximados dentro deste bloco (ex.: minuto 02:30), evidências observáveis e notas parciais por pilares quando aplicável.
- Não conclua o relatório final ainda.`;
      const partialText = await analyzeVideo(segmentActive.uri, partialPrompt, { ...metadata, segmentIndex: index + 1, segmentCount }).catch((error) => { throw withFailedStage(error, 'gemini_analysis'); });
      partialAnalyses.push(`BLOCO ${index + 1}/${segmentCount}:\n${partialText}`);
      console.log(`[analysis:${recordingId}] fim análise parcial segmento ${index + 1}/${segmentCount}`);
      if (fs.existsSync(segmentPath)) fs.unlinkSync(segmentPath);
    }
    console.log(`[analysis:${recordingId}] início consolidação final`);
    const consolidationPrompt = `${finalPrompt}

CONSOLIDE AS ANÁLISES PARCIAIS ABAIXO EM UM RELATÓRIO FINAL COMPLETO COM OS 12 PILARES DO DNA PROFESSOR DK.
Mantenha evidências observáveis, progressão temporal, síntese executiva e plano de evolução.

${partialAnalyses.join('\n\n')}`;
    rawResponse = await analyzeText(consolidationPrompt).catch((error) => { throw withFailedStage(error, 'gemini_analysis'); });
    console.log(`[analysis:${recordingId}] fim consolidação final`);
  }
  const noClassDetected = detectNoClass(rawResponse);
  const status = noClassDetected ? 'completed_no_class_detected' : 'completed';

  const reportPayload = { recordingId, professor: classContext.professor, turma: classContext.turma, nivel: classContext.nivel, sala: classContext.sala, startedAt: recordingStartedAt || 'Não informado', endedAt: recordingEndedAt || 'Não informado', durationMinutes: recordingStartedAt && recordingEndedAt ? Math.max(1, Math.round((new Date(recordingEndedAt) - new Date(recordingStartedAt)) / 60000)) : 'Não informado', prompt, analysis: rawResponse };

  reportPayload.sourceFileName = sourceFileName;

  const pdfUploadProvider = String(process.env.PDF_UPLOAD_PROVIDER || 'local').toLowerCase();
  let pdfUrl = null;
  let pdfPath = null;
  if (jobId) updateJob(jobId, { status: 'processing', stage: 'report_generation' });
  if (jobId) console.log(`[job:${jobId}] report_generation_started`);
  logStage(recordingId, 'report_generation_started', { provider: pdfUploadProvider });
  pdfPath = await generateLessonPdf(reportPayload).catch((error) => { throw withFailedStage(error, 'report_generation'); });
  logStage(recordingId, 'report_generated', { pdfPath });
  if (pdfUploadProvider === 'drive') {
    const driveData = await uploadPdf(pdfPath, { professor: classContext.professor }).catch((error) => { throw withFailedStage(error, 'drive_upload'); });
    pdfUrl = driveData?.webViewLink || null;
    logStage(recordingId, 'report_upload_success', { provider: 'drive', reportUrl: pdfUrl });
  }
  if (pdfUploadProvider === 'drive' && pdfPath && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

  const responsePayload = {
    ok: true,
    status,
    recordingId,
    classContext,
    videoFileName: sourceFileName || recordingId,
    reportText: rawResponse,
    localJsonPath: null,
    localPdfPath: pdfUploadProvider === 'drive' ? null : pdfPath,
    reportUrl: pdfUrl || (pdfUploadProvider === 'drive' ? null : pdfPath),
    drivePdfUrl: null,
    driveJsonUrl: null,
    metadata: { recordingId, analyzedAt: new Date().toISOString(), classContext },
    video: { fileName: sourceFileName || recordingId, sourceUrl: sourceUrl || null, sourceUrlExpiresAt: sourceUrlExpiresAt || null, validation: videoValidation || null },
    prompt: { dnaVersion: '1.0', promptTemplateVersion: '2.0', userNotes: normalizeField(prompt), finalPromptUsed: finalPrompt, finalPromptLength: finalPrompt.length },
    analysis: { provider: 'gemini', model: GEMINI_MODEL, rawResponse, status, tokenCount, strategy, segmentCount }
  };
  if (pdfUrl) responsePayload.drivePdfUrl = pdfUrl;
  logStage(recordingId, 'analysis_completed', { status, reportUrl: responsePayload.reportUrl || responsePayload.drivePdfUrl || null });
  return responsePayload;
}

app.post('/disabled-url-analysis', async (req, res) => {
  let videoPath = null;
  try {
    const { videoUrl, fileName = '', professor = '', modalidade = '', turma = '', faixaEtaria = '', nivel = '', sala = '', horario = '', duracao = '', observacoes = '', prompt = DEFAULT_PROMPT, cameraId = '', recordingStartedAt = '', recordingEndedAt = '' } = req.body || {};
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl é obrigatório.' });
    videoPath = path.join(os.tmpdir(), `url_video_${Date.now()}.mp4`);
    await downloadFromUrl(videoUrl, videoPath);
    const videoValidation = await validateVideoFile(videoPath);
    if (!videoValidation.valid) {
      return res.status(400).json({ error: videoValidation.error || 'Arquivo inválido', failedStage: 'validating_video_backend', fileSize: videoValidation.fileSize || 0, videoValidation });
    }
    const analysis = await analyzeFromLocalVideo({ videoPath, recordingId: fileName || `url_${Date.now()}`, classContextInput: { professor, modalidade, turma, faixaEtaria, nivel, sala, horarioAgendado: horario, durationMinutes: duracao, observacoes }, prompt, cameraId, recordingStartedAt, recordingEndedAt, sourceFileName: fileName, sourceUrl: videoUrl, videoValidation });
    return res.json(analysis);
  } catch (error) { return res.status(error.statusCode || 500).json({ error: error.message, failedStage: 'validating_video_backend', missingPillars: error.missingPillars || [], fileSize: videoPath && fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0, videoValidation: null }); }
  finally { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); }
});

function normalizeAnalyzeGcsPayload(body = {}) {
  const parsedGcsUri = parseGcsUri(body.gcsUri || body.gcsURI || body.gsUri);
  const recordingId = normalizeField(body.recordingId, body.gcsFileName, body.fileName, `gcs_${Date.now()}`);
  const bucketName = normalizeField(body.bucketName, body.bucket, body.gcsBucket, parsedGcsUri.bucketName);
  const fileName = normalizeField(body.fileName, body.gcsPath, body.objectName, body.destination, body.gcsFileName, body.storagePath, parsedGcsUri.fileName);
  return { body, recordingId, bucketName, fileName, gcsBucket: bucketName, gcsFileName: fileName };
}

async function runAnalyzeGcs(payload, jobId = null) {
  let videoPath = null;
  const endpoint = '/analyze-gcs';
  const { body, recordingId, gcsBucket, gcsFileName } = normalizeAnalyzeGcsPayload(payload);
  try {
    console.log('[analyze-gcs] analysis_started');
    logStage(recordingId, 'analysis_request_started', { endpoint, gcsBucket, gcsFileName });
    if (!gcsBucket || !gcsFileName) {
      const error = new Error('bucketName/fileName sao obrigatorios.');
      logStageError(recordingId, 'analysis_request_failed', error, { endpoint, gcsBucket, gcsFileName });
      error.failedStage = 'request_validation';
      throw error;
    }

    if (jobId) updateJob(jobId, { status: 'processing', stage: 'download_gcs' });
    if (jobId) console.log(`[job:${jobId}] download_gcs_started`);
    videoPath = path.join(os.tmpdir(), `gcs_video_${Date.now()}_${path.basename(gcsFileName) || 'video.mp4'}`);
    logStage(recordingId, 'gcs_download_started', { endpoint, gcsBucket, gcsFileName, localPath: videoPath });
    try {
      await downloadFromGCS(gcsBucket, gcsFileName, videoPath);
    } catch (error) {
      const errorMessage = String(error?.message || '');
      const missingObject = /No such object/i.test(errorMessage) || /not found/i.test(errorMessage) || error?.status === 404 || error?.code === 404;
      if (missingObject) {
        const notFoundError = new Error('Arquivo não encontrado no GCS');
        notFoundError.failedStage = 'gcs_download';
        notFoundError.status = 404;
        notFoundError.details = {
          endpoint,
          bucketName: gcsBucket,
          fileName: gcsFileName,
          localPath: videoPath,
          suggestion: 'Verifique o fileName exato gerado no upload_success',
          originalMessage: errorMessage,
          originalStack: error?.stack || null
        };
        logStageError(recordingId, 'gcs_download_failed', notFoundError, {
          endpoint,
          localPath: videoPath,
          gcsBucket,
          gcsFileName
        });
        throw notFoundError;
      }
      throw withFailedStage(error, 'gcs_download');
    }
    logStage(recordingId, 'gcs_download_success', { localPath: videoPath, fileSize: fs.statSync(videoPath).size });
    if (jobId) console.log(`[job:${jobId}] download_gcs_success`);

    if (jobId) updateJob(jobId, { status: 'processing', stage: 'video_validation' });
    logStage(recordingId, 'video_validation_started', { localPath: videoPath, gcsBucket, gcsFileName });
    const videoValidation = await validateVideoFile(videoPath);
    if (!videoValidation.valid) {
      const error = new Error(videoValidation.error || 'Video invalido.');
      logStageError(recordingId, 'video_validation_failed', error, { endpoint, localPath: videoPath, gcsBucket, gcsFileName });
      error.failedStage = 'video_validation';
      error.details = { endpoint, localPath: videoPath, gcsBucket, gcsFileName, videoValidation };
      throw error;
    }
    logStage(recordingId, 'video_validation_success', { localPath: videoPath, videoValidation });

    if (jobId) updateJob(jobId, { status: 'processing', stage: 'ai_analysis' });
    if (jobId) console.log(`[job:${jobId}] analysis_started`);
    const analysis = await analyzeFromLocalVideo({
      videoPath,
      recordingId,
      classContextInput: {
        professor: body.professor,
        modalidade: body.modalidade,
        turma: body.turma,
        faixaEtaria: body.faixaEtaria,
        nivel: body.nivel,
        sala: body.sala,
        data: body.data,
        horarioAgendado: body.horario,
        durationMinutes: body.durationMinutes || body.duracao,
        observacoes: body.observacoes
      },
      prompt: body.prompt || body.observacoes || DEFAULT_PROMPT,
      cameraId: body.cameraId,
      recordingStartedAt: body.recordingStartedAt,
      recordingEndedAt: body.recordingEndedAt,
      sourceFileName: gcsFileName,
      sourceUrl: body.videoUrl || `gs://${gcsBucket}/${gcsFileName}`,
      videoValidation,
      jobId
    });

    console.log('[analyze-gcs] analysis_success');
    const result = {
      ...analysis,
      videoFile: { bucket: gcsBucket, fileName: gcsFileName, localPath: videoPath, validation: videoValidation },
      metadata: { ...(analysis.metadata || {}), gcsBucket, gcsFileName }
    };
    if (jobId) {
      console.log(`[job:${jobId}] report_generation_success`);
      console.log(`[job:${jobId}] success`);
    }
    return result;
  } catch (error) {
    const failedStage = error.failedStage || 'analysis';
    console.error(`[analyze-gcs] analysis_failed stage=${failedStage} message=${error.message}`);
    if (jobId) console.error(`[job:${jobId}] failed stage=${failedStage} message=${error.message}`);
    logStageError(recordingId, `${failedStage}_failed`, error, { endpoint, localPath: videoPath, gcsBucket, gcsFileName });
    throw error;
  } finally {
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  }
}

async function processAnalyzeGcsJob(jobId, payload) {
  try {
    const result = await runAnalyzeGcs(payload, jobId);
    updateJob(jobId, {
      status: 'success',
      stage: 'done',
      result: {
        reportUrl: result.reportUrl || result.drivePdfUrl || null,
        reportPath: result.localPdfPath || result.reportUrl || null,
        videoFile: result.videoFile || null,
        metadata: result.metadata || null
      },
      error: null
    });
  } catch (error) {
    const failedStage = error.failedStage || 'analysis';
    updateJob(jobId, {
      status: 'failed',
      stage: failedStage,
      error: {
        message: error.message,
        stack: error.stack || null,
        details: error.details || null
      }
    });
  }
}

app.post('/analyze-gcs', async (req, res) => {
  const body = req.body || {};
  const { bucketName, fileName } = normalizeAnalyzeGcsPayload(body);

  console.log('[analyze-gcs] received');
  console.log('[analyze-gcs] content-type:', req.headers['content-type']);
  console.log('[analyze-gcs] body keys:', Object.keys(body || {}));
  console.log(`[analyze-gcs] bucketName=${bucketName || null}`);
  console.log(`[analyze-gcs] fileName=${fileName || null}`);

  if (body && body.test) {
    return res.json({
      ok: true,
      route: '/analyze-gcs',
      bodyKeys: Object.keys(body || {}),
      receivedBucketName: bucketName || null,
      receivedFileName: fileName || null,
      message: 'Rota analyze-gcs registrada e recebendo JSON.'
    });
  }

  if (!bucketName || !fileName) {
    return res.status(400).json({
      ok: false,
      failedStage: 'request_validation',
      message: 'bucketName/fileName sao obrigatorios',
      bodyKeys: Object.keys(body || {}),
      receivedContentType: req.headers['content-type']
    });
  }

  const job = createJob(body);
  processAnalyzeGcsJob(job.jobId, body).catch((error) => {
    updateJob(job.jobId, {
      status: 'failed',
      stage: 'unhandled_background_error',
      error: {
        message: error.message,
        stack: error.stack || null
      }
    });
  });

  return res.status(202).json({
    ok: true,
    accepted: true,
    jobId: job.jobId,
    statusUrl: `/jobs/${job.jobId}`,
    message: 'Analise recebida e iniciada em background'
  });
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
    const analysis = await analyzeFromLocalVideo({ videoPath, recordingId: finalFileId, classContextInput: { professor, modalidade, turma, faixaEtaria, nivel, sala, horarioAgendado: horario, durationMinutes: duracao, observacoes }, prompt, cameraId, recordingStartedAt, recordingEndedAt, sourceFileName: finalFileId, videoValidation });
    return res.json(analysis);
  } catch (error) { return res.status(error.statusCode || 500).json({ error: error.message, missingPillars: error.missingPillars || [] }); }
  finally { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); }
});

app.listen(PORT, () => {
  console.log('Backend iniciado');
  console.log(`Backend rodando na porta ${PORT}`);
  console.log('GET /health registered');
  console.log('POST /analyze-gcs registered');
  console.log('POST /analyze-drive registered');
});
