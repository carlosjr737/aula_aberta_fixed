require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { google } = require('googleapis');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

const DEBUG_ENV_KEYS = [
  'PORT',
  'RAILWAY_API_URL',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GCS_BUCKET_NAME',
  'RTSP_SUBWAY',
  'RTSP_BOLSO',
  'RTSP_MIRANTE'
];

function toBool(value) { return Boolean(String(value || '').trim()); }
function getEnvSummary() { return DEBUG_ENV_KEYS.reduce((acc, key) => (acc[key] = toBool(process.env[key]), acc), {}); }

function parseServiceAccountJson(raw) {
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nÃ£o configurado.');
  try {
    const parsed = JSON.parse(String(raw).trim());
    if (!parsed.private_key) throw new Error('private_key ausente no GOOGLE_SERVICE_ACCOUNT_JSON.');
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON invÃ¡lido: ${error.message}`);
  }
}

const app = express();
const RAILWAY_API_URL = String(process.env.RAILWAY_API_URL || '').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 4000);
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const SCHEDULE_PATH = path.join(__dirname, '..', 'config', 'class-schedule.json');
const MIN_LONG_RTSP_FILE_SIZE_BYTES = 1024 * 1024;
const FFPROBE_FALLBACK_MIN_BYTES = 100 * 1024;
const CLEANUP_LOCAL_FILES = false;
const TARGET_VIDEO_FPS = 3;
const configuredMaxRecordingDelayMinutes = Number(process.env.MAX_RECORDING_DELAY_MINUTES || 10);
const MAX_RECORDING_DELAY_MINUTES = Number.isFinite(configuredMaxRecordingDelayMinutes) && configuredMaxRecordingDelayMinutes >= 0
  ? configuredMaxRecordingDelayMinutes
  : 10;
const MAX_TIMEOUT_MS = 2147483647;
const LATE_TOLERANCE_MS = 5 * 60 * 1000;
const RECORDING_GRACE_SECONDS = Number(process.env.RECORDING_GRACE_SECONDS || 30);
const FORCE_KILL_GRACE_SECONDS = Number(process.env.FORCE_KILL_GRACE_SECONDS || 15);
const FILE_PROGRESS_INTERVAL_MS = Number(process.env.FILE_PROGRESS_INTERVAL_MS || 60000);
const NO_OUTPUT_TIMEOUT_MS = Number(process.env.NO_OUTPUT_TIMEOUT_MS || 35000);

const MAX_FFMPEG_LOG_CHARS = 20000;
const MAX_FFMPEG_STDERR_LINES = 80;

console.log('BINARIES', { FFMPEG_PATH, FFPROBE_PATH });

function appendBoundedLog(currentLog, chunk, maxChars = MAX_FFMPEG_LOG_CHARS) {
  const nextLog = `${currentLog || ''}${String(chunk || '')}`;
  return nextLog.length > maxChars ? nextLog.slice(-maxChars) : nextLog;
}

function getLogTail(log, maxChars = MAX_FFMPEG_LOG_CHARS) {
  const safeLog = String(log || '');
  return safeLog.length > maxChars ? safeLog.slice(-maxChars) : safeLog;
}

function forceKillProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);

    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (error) => {
        if (error) {
          console.error(`[ffmpeg] taskkill falhou pid=${pid}: ${error.message}`);
          return resolve(false);
        }
        return resolve(true);
      });
      return;
    }

    try {
      process.kill(pid, 'SIGKILL');
      return resolve(true);
    } catch (error) {
      console.error(`[ffmpeg] SIGKILL falhou pid=${pid}: ${error.message}`);
      return resolve(false);
    }
  });
}

function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/rtsp:\/\/[^@\s]+@/gi, 'rtsp://[REDACTED]@')
    .replace(/(password|pass|token|key)=([^&\s]+)/gi, '$1=[REDACTED]');
}
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const CAMERAS = { bolso: process.env.RTSP_BOLSO, mirante: process.env.RTSP_MIRANTE, subway: process.env.RTSP_SUBWAY };
const recordings = new Map();
const recordingQueues = new Map();
const activeRecordings = new Map();
const processingQueue = [];
const processingStatuses = new Map();
let processingQueueRunning = false;
const ACTIVE_RECORDING_STATUSES = new Set(['recording', 'stopping']);
const dailyScheduleState = {
  started: false,
  sourcePath: SCHEDULE_PATH,
  scheduleDate: null,
  timezone: null,
  classes: new Map(),
  timers: new Map()
};

app.use(cors({ origin: 'https://aula-aberta-fixed.vercel.app', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

function getActiveRecording(cameraId = null) {
  if (cameraId) {
    const recordingId = activeRecordings.get(String(cameraId).toLowerCase());
    return recordingId ? recordings.get(recordingId) || null : null;
  }
  return Array.from(activeRecordings.values())
    .map((recordingId) => recordings.get(recordingId))
    .find((rec) => rec && ACTIVE_RECORDING_STATUSES.has(rec.status)) || null;
}

function getFileSizeSafe(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : null;
  } catch (_error) {
    return null;
  }
}

function buildErrorDetails(error, rec, stage) {
  return {
    stage,
    stack: error?.stack || null,
    message: error?.message || String(error || ''),
    cause: error?.cause ? (error.cause?.stack || error.cause?.message || String(error.cause)) : null,
    endpoint: error?.endpoint || null,
    httpStatus: error?.status || error?.statusCode || error?.response?.status || null,
    responseText: error?.responseText || error?.response?.data || null,
    command: rec?.ffmpegCommand || null,
    outputPath: rec?.outputPath || null,
    fileSize: getFileSizeSafe(rec?.outputPath)
  };
}

function setRecordingError(rec, stage, error) {
  const details = buildErrorDetails(error, rec, stage);
  rec.status = 'failed';
  rec.failedStage = stage;
  rec.error = details.message;
  rec.errorDetails = details;
  rec.fileSize = details.fileSize;
  return details;
}

function getErrorMessage(error) {
  return error?.message || String(error || '');
}

function logProcessingError(recordingId, stage, error) {
  console.error(`[processing:${recordingId}] Erro na etapa ${stage}`);
  console.error(`[processing:${recordingId}] error.message: ${getErrorMessage(error)}`);
  console.error(`[processing:${recordingId}] error.stack: ${error?.stack || null}`);
  console.error(`[processing:${recordingId}] error.cause: ${error?.cause ? (error.cause?.stack || error.cause?.message || String(error.cause)) : null}`);
  console.error(`[processing:${recordingId}] endpoint: ${error?.endpoint || null}`);
  console.error(`[processing:${recordingId}] status HTTP: ${error?.status || error?.statusCode || error?.response?.status || null}`);
  console.error(`[processing:${recordingId}] response text: ${error?.responseText || error?.response?.data || null}`);
}

function setProcessingStatus(recordingId, patch) {
  const current = processingStatuses.get(recordingId) || {
    recordingId,
    status: 'processing',
    failedStage: null,
    errorMessage: null,
    errorStack: null,
    updatedAt: null
  };
  const next = { ...current, ...patch, recordingId, updatedAt: new Date().toISOString() };
  processingStatuses.set(recordingId, next);
  const rec = recordings.get(recordingId);
  if (rec) rec.processingStatus = next;
  return next;
}

function failProcessingStatus(recordingId, failedStage, error) {
  return setProcessingStatus(recordingId, {
    status: 'failed',
    failedStage,
    errorMessage: getErrorMessage(error),
    errorStack: error?.stack || null
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} excedeu timeout de ${Math.round(timeoutMs / 60000)} minutos.`);
      error.code = 'TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function sanitizeCommandArgs(args) {
  const sanitized = [];
  for (let i = 0; i < args.length; i += 1) {
    sanitized.push(args[i] === '-i' && i + 1 < args.length ? '-i' : args[i]);
    if (args[i] === '-i' && i + 1 < args.length) {
      sanitized.push('[RTSP_URL]');
      i += 1;
    }
  }
  return sanitized;
}

function buildFfmpegArgs(rtspUrl, durationSeconds, outputPath) {
  return [
    '-hide_banner',
    '-y',
    '-nostdin',
    '-rtsp_transport', 'tcp',
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',
    '-i', rtspUrl,
    '-t', String(durationSeconds),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', 'fps=3,scale=-2:720',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-ar', '16000',
    '-ac', '1',
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
    outputPath
  ];
}

function getGcsClient() {
  const credentials = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
  return google.storage({ version: 'v1', auth });
}

async function uploadVideoToGCS(filePath, rec) {
  const bucketName = String(process.env.GCS_BUCKET_NAME || '').trim();
  if (!bucketName) throw new Error('GCS_BUCKET_NAME nÃ£o configurado.');
  const storage = getGcsClient();
  const safeBaseName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '-');
  const gcsFileName = `recordings/${rec.recordingId}/${safeBaseName}`;
  await storage.objects.insert({
    bucket: bucketName,
    name: gcsFileName,
    uploadType: 'media',
    media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) }
  });
  const encodedName = gcsFileName.split('/').map(encodeURIComponent).join('/');
  return {
    gcsBucket: bucketName,
    gcsFileName,
    videoUrl: `gs://${bucketName}/${gcsFileName}`,
    publicUrl: `https://storage.googleapis.com/${bucketName}/${encodedName}`
  };
}

async function saveReportArtifacts(rec) {
  const now = new Date();
  const recordingDir = path.join(RECORDINGS_DIR, rec.recordingId);
  fs.mkdirSync(recordingDir, { recursive: true });
  const reportText = rec?.railwayResponse?.reportText || rec?.railwayResponse?.analysis?.rawResponse || '';
  const reportObj = {
    metadata: { recordingId: rec.recordingId, classContext: rec?.railwayResponse?.classContext || {}, recordingStartedAt: rec.startedAt, recordingEndedAt: rec.finishedAt, createdAt: now.toISOString() },
    video: { gcsBucket: rec.gcsBucket || null, gcsFileName: rec.gcsFileName || null, videoUrl: rec.videoUrl || null, uploadedAt: rec.uploadedAt || null, validation: rec.videoValidation || null },
    prompt: rec?.railwayResponse?.prompt || {},
    analysis: rec?.railwayResponse?.analysis || { rawResponse: reportText, status: rec?.railwayResponse?.status || rec.status }
  };
  const textPath = path.join(recordingDir, 'analysis.txt');
  const jsonPath = path.join(recordingDir, 'analysis.json');
  fs.writeFileSync(textPath, reportText);
  fs.writeFileSync(jsonPath, JSON.stringify(reportObj, null, 2));
  rec.jsonLocalPath = jsonPath;
  rec.analysisTextPath = textPath;
  rec.jsonUrl = null;
}
async function finalizeRecording(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return;
  const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const RAILWAY_TIMEOUT_MS = 60 * 60 * 1000;
  let currentStage = 'validation';
  try {
    setProcessingStatus(recordingId, { status: 'processing', failedStage: null, errorMessage: null, errorStack: null });

    currentStage = 'validation';
    rec.status = 'validating_video';
    notifyRecordingStatus(rec, rec.status);
    try {
      console.log(`[processing:${recordingId}] video_validation_started`);
      console.log(`[processing:${recordingId}] Iniciando validaÃ§Ã£o`);
      const validation = await validateVideoFile(rec.outputPath, rec.durationSeconds);
      console.log(`[processing:${recordingId}] Resultado da validaÃ§Ã£o ffprobe: ${JSON.stringify(validation)}`);
      rec.videoValidation = validation;
      rec.fileSize = validation.fileSize || getFileSizeSafe(rec.outputPath);
      if (!validation.valid) {
        throw new Error(validation.reason || validation.error || 'Falha na validaÃ§Ã£o do vÃ­deo.');
      }
      console.log(`[processing:${recordingId}] video_validation_success`);
      console.log(`[processing:${recordingId}] ValidaÃ§Ã£o concluÃ­da`);
    } catch (error) {
      console.log(`[processing:${recordingId}] video_validation_failed`);
      logProcessingError(recordingId, currentStage, error);
      throw error;
    }

    currentStage = 'upload';
    rec.status = 'uploading_gcs';
    notifyRecordingStatus(rec, rec.status);
    try {
      console.log(`[processing:${recordingId}] upload_started`);
      console.log(`[processing:${recordingId}] Iniciando upload GCS`);
      const gcsUpload = await withTimeout(uploadVideoToGCS(rec.outputPath, rec), UPLOAD_TIMEOUT_MS, 'Upload GCS');
      rec.gcsBucket = pickFirstNonEmpty(gcsUpload.bucketName, gcsUpload.bucket, gcsUpload.gcsBucket);
      rec.gcsFileName = pickFirstNonEmpty(gcsUpload.fileName, gcsUpload.gcsPath, gcsUpload.gcsFileName, gcsUpload.objectName, gcsUpload.destination, gcsUpload.storagePath);
      rec.videoUrl = gcsUpload.videoUrl;
      rec.gcsPublicUrl = gcsUpload.publicUrl;
      rec.uploadedAt = new Date().toISOString();
      setProcessingStatus(recordingId, { status: 'uploaded', failedStage: null, errorMessage: null, errorStack: null });
      console.log(`[processing:${recordingId}] upload_success`);
      console.log(`[processing:${recordingId}] Upload GCS concluÃ­do`);
    } catch (error) {
      logProcessingError(recordingId, currentStage, error);
      throw error;
    }

    currentStage = 'railway';
    rec.status = 'calling_railway';
    notifyRecordingStatus(rec, rec.status);
    let payload;
    try {
      setProcessingStatus(recordingId, { status: 'analyzing', failedStage: null, errorMessage: null, errorStack: null });
      if (!RAILWAY_API_URL) throw new Error('RAILWAY_API_URL nÃ£o configurada.');
      console.log(`[processing:${recordingId}] ${payload.accepted ? 'Analise aceita em background' : 'Analise concluida'}`);
      console.log(`[processing:${recordingId}] Chamando Railway`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('Railway excedeu timeout de 60 minutos.')), RAILWAY_TIMEOUT_MS);
      let response;
      let responseText = '';
      let contentType = '';
      const analysisEndpoint = `${RAILWAY_API_URL}/analyze-gcs`;
      const analysisPayload = {
        bucketName: rec.gcsBucket,
        fileName: rec.gcsFileName,
        bucket: rec.gcsBucket,
        gcsBucket: rec.gcsBucket,
        gcsPath: rec.gcsFileName,
        gcsFileName: rec.gcsFileName,
        videoUrl: rec.videoUrl,
        gcsUri: rec.videoUrl,
        professor: rec.professor,
        turma: rec.turma,
        nivel: rec.nivel,
        sala: rec.sala,
        horario: rec.horario,
        prompt: rec.prompt,
        cameraId: rec.cameraId,
        durationMinutes: rec.durationSeconds ? Math.max(1, Math.round(rec.durationSeconds / 60)) : null,
        recordingStartedAt: rec.startedAt,
        recordingEndedAt: rec.finishedAt
      };
      console.log(`[processing:${recordingId}] analyze-gcs payload`, {
        bucketName: analysisPayload.bucketName,
        fileName: analysisPayload.fileName,
        professor: analysisPayload.professor,
        turma: analysisPayload.turma,
        sala: analysisPayload.sala,
        durationMinutes: analysisPayload.durationMinutes
      });
      if (!analysisPayload.bucketName || !analysisPayload.fileName) {
        throw new Error(`Payload inválido para /analyze-gcs: bucketName/fileName ausentes. recGcsBucket=${rec.gcsBucket || null} recGcsFileName=${rec.gcsFileName || null}`);
      }
      try {
        const bodyJson = JSON.stringify(analysisPayload);
        console.log(`[processing:${recordingId}] analyze-gcs bodyJson`, bodyJson);
        response = await fetch(analysisEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: bodyJson });
        contentType = response.headers.get('content-type') || '';
        responseText = await response.text();
      } finally {
        clearTimeout(timeoutId);
      }
      console.log(`[processing:${recordingId}] Railway respondeu status=${response?.status || null} contentType=${contentType || null}`);
      if (!contentType.toLowerCase().includes('application/json')) {
        const nonJsonError = new Error(`Railway retornou resposta nao JSON em ${analysisEndpoint}: status=${response?.status || null} content-type=${contentType || 'desconhecido'}`);
        nonJsonError.status = response?.status || null;
        nonJsonError.responseText = String(responseText || '').slice(0, 1000);
        nonJsonError.endpoint = analysisEndpoint;
        throw nonJsonError;
      }
      try {
        payload = responseText ? JSON.parse(responseText) : {};
      } catch (parseError) {
        parseError.responseText = responseText;
        parseError.status = response?.status || null;
        parseError.endpoint = analysisEndpoint;
        throw parseError;
      }
      rec.railwayResponse = payload;
      if (!response.ok) {
        const railwayError = new Error(payload.error || payload.message || 'Falha ao analisar no Railway');
        railwayError.status = response.status;
        railwayError.responseText = responseText;
        railwayError.endpoint = analysisEndpoint;
        throw railwayError;
      }
      if (payload && payload.ok === false) {
        const railwayError = new Error(payload.message || payload.error || 'Railway retornou ok=false.');
        railwayError.status = response.status;
        railwayError.responseText = responseText;
        railwayError.endpoint = analysisEndpoint;
        throw railwayError;
      }
      if (payload && payload.accepted === true && payload.jobId) {
        console.log(`[processing:${recordingId}] analysis_request_accepted jobId=${payload.jobId}`);
        console.log(`[processing:${recordingId}] Acompanhe em ${payload.statusUrl || `/jobs/${payload.jobId}`}`);
      }
      rec.report = payload;
      rec.localJsonPath = payload.localJsonPath || null;
      rec.localPdfPath = payload.localPdfPath || null;
      rec.reportUrl = payload.reportUrl || payload.pdfUrl || payload?.analysis?.pdfUrl || null;
      rec.analysisJobId = payload.jobId || null;
      rec.analysisStatusUrl = payload.statusUrl || null;
      rec.remoteJsonUrl = payload.jsonUrl || null;
      console.log(`[processing:${recordingId}] ${payload.accepted ? 'Analise aceita em background' : 'Analise concluida'}`);
    } catch (error) {
      console.log(`[processing:${recordingId}] ${payload.accepted ? 'Analise aceita em background' : 'Analise concluida'}`);
      logProcessingError(recordingId, currentStage, error);
      throw error;
    }

    currentStage = 'pdf';
    if (payload?.accepted) {
      rec.status = 'analysis_accepted';
      setProcessingStatus(recordingId, { status: 'analyzing', failedStage: null, errorMessage: null, errorStack: null });
      console.log(`[processing:${recordingId}] analysis_job_status jobId=${payload.jobId} status=queued stage=queued`);
      return;
    }
    try {
      console.log(`[processing:${recordingId}] Salvando PDF`);
      await saveReportArtifacts(rec);
      console.log(`[processing:${recordingId}] PDF salvo`);
    } catch (error) {
      logProcessingError(recordingId, currentStage, error);
      throw error;
    }

    rec.status = payload.status || 'completed';
    setProcessingStatus(recordingId, { status: 'completed', failedStage: null, errorMessage: null, errorStack: null });
    console.log(`[processing:${recordingId}] report_generated`);
  } catch (error) {
    setRecordingError(rec, currentStage, error);
    failProcessingStatus(recordingId, currentStage, error);
  } finally {
    if (CLEANUP_LOCAL_FILES && fs.existsSync(rec.outputPath)) fs.unlinkSync(rec.outputPath);
    notifyRecordingStatus(rec, rec.status, rec.errorDetails || null);
  }
}

function notifyRecordingStatus(rec, phase, details = null) {
  if (typeof rec?.onStatus === 'function') rec.onStatus(rec, phase, details);
}

function enqueueProcessingJob(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return;
  processingQueue.push({ recordingId, enqueuedAt: new Date().toISOString() });
  rec.processingQueuedAt = new Date().toISOString();
  setProcessingStatus(recordingId, { status: 'processing', failedStage: null, errorMessage: null, errorStack: null });
  notifyRecordingStatus(rec, 'queued_processing');
  runProcessingQueue();
}

function getRecordingQueue(cameraId) {
  const key = String(cameraId || '').toLowerCase();
  if (!recordingQueues.has(key)) recordingQueues.set(key, []);
  return recordingQueues.get(key);
}

function getRecordingDelayMinutes(job) {
  const scheduledStartAt = job?.scheduledStartAt instanceof Date
    ? job.scheduledStartAt
    : new Date(job?.scheduledStartAt || Date.now());
  return (Date.now() - scheduledStartAt.getTime()) / 60000;
}

function markScheduleJobFailed(job, phase, error) {
  if (!job?.status) return;
  job.status.recordingStatus = phase;
  job.status.analysisStatus = 'failed';
  job.status.uiStatus = phase;
  job.status.error = error.message;
  job.status.errorDetails = error.details || null;
}

function markScheduleJobSkippedLate(job, delayMinutes) {
  if (!job?.status) return;
  job.status.recordingStatus = 'skipped_late';
  job.status.analysisStatus = 'skipped_late';
  job.status.uiStatus = 'skipped_late';
  job.status.error = `Aula atrasou ${delayMinutes.toFixed(1)} minutos para iniciar. Limite: ${MAX_RECORDING_DELAY_MINUTES} minutos.`;
}

function startQueuedRecordingJob(job, fromQueue = false) {
  const cameraId = String(job.cameraId || job.body?.cameraId || job.body?.camera || '').toLowerCase();
  if (fromQueue) console.log(`[schedule:${job.scheduleId}] Iniciando aula pendente da fila da cÃ¢mera ${cameraId}`);
  else console.log(`[schedule:${job.scheduleId}] InÃ­cio da gravaÃ§Ã£o`);
  try {
    return startRecordingJob({
      body: job.body,
      outputPath: job.outputPath,
      source: job.source || 'schedule',
      scheduleId: job.scheduleId,
      onStatus: job.onStatus
    });
  } catch (error) {
    markScheduleJobFailed(job, 'record_failed', error);
    startNextRecordingForCamera(cameraId);
    return null;
  }
}

function enqueueOrStartRecording(job) {
  const cameraId = String(job.cameraId || job.body?.cameraId || job.body?.camera || '').toLowerCase();
  if (activeRecordings.has(cameraId)) {
    getRecordingQueue(cameraId).push(job);
    if (job.status) {
      job.status.recordingStatus = 'queued';
      job.status.analysisStatus = 'aguardando';
      job.status.uiStatus = 'queued';
      job.status.error = null;
    }
    console.log(`[schedule:${job.scheduleId}] CÃ¢mera ocupada, aula enviada para fila da cÃ¢mera ${cameraId}`);
    return null;
  }
  return startQueuedRecordingJob(job, false);
}

function startNextRecordingForCamera(cameraId) {
  const key = String(cameraId || '').toLowerCase();
  if (activeRecordings.has(key)) return;
  const queue = getRecordingQueue(key);
  while (queue.length > 0) {
    const nextJob = queue.shift();
    const delayMinutes = getRecordingDelayMinutes(nextJob);
    if (delayMinutes > MAX_RECORDING_DELAY_MINUTES) {
      markScheduleJobSkippedLate(nextJob, delayMinutes);
      console.log(`[schedule:${nextJob.scheduleId}] skipped_late atraso=${delayMinutes.toFixed(1)}min limite=${MAX_RECORDING_DELAY_MINUTES}min`);
      continue;
    }
    startQueuedRecordingJob(nextJob, true);
    return;
  }
}

async function runProcessingQueue() {
  if (processingQueueRunning) return;
  processingQueueRunning = true;
  try {
    while (processingQueue.length > 0) {
      const job = processingQueue.shift();
      const rec = recordings.get(job.recordingId);
      if (!rec) continue;
      console.log(`[processing:${job.recordingId}] InÃ­cio`);
      await finalizeRecording(job.recordingId);
    }
  } finally {
    processingQueueRunning = false;
  }
}

function slugifyText(text) {
  return String(text || '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_]/g, '');
}

function parseTimeString(start) {
  const match = String(start || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Horário inválido no schedule: ${start}. Use HH:mm, exemplo 08:30.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23) throw new Error(`Hora inválida no schedule: ${start}. Use 00 a 23.`);
  if (minute < 0 || minute > 59) throw new Error(`Minuto inválido no schedule: ${start}. Use 00 a 59.`);
  return { hour, minute };
}

function parseScheduleDate(dateText) {
  const value = String(dateText || '').trim();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Data inválida no schedule: ${dateText}. Use o formato YYYY-MM-DD, exemplo 2026-06-01.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) throw new Error(`Mês inválido no schedule: ${dateText}.`);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) throw new Error(`Dia inválido no schedule: ${dateText}.`);

  return { year, month, day, value };
}

function parseScheduleDateTime(dateStr, timeStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
    throw new Error(`Data invÃ¡lida no schedule: ${dateStr}. Use o formato YYYY-MM-DD, exemplo 2026-06-01.`);
  }

  if (!/^\d{2}:\d{2}$/.test(String(timeStr || ''))) {
    throw new Error(`HorÃ¡rio invÃ¡lido no schedule: ${timeStr}. Use HH:mm.`);
  }

  const [year, month, day] = String(dateStr).split('-').map(Number);
  const [hour, minute] = String(timeStr).split(':').map(Number);

  if (month < 1 || month > 12) throw new Error(`MÃªs invÃ¡lido no schedule: ${dateStr}`);
  if (day < 1 || day > 31) throw new Error(`Dia invÃ¡lido no schedule: ${dateStr}`);
  if (hour < 0 || hour > 23) throw new Error(`Hora invÃ¡lida no schedule: ${timeStr}`);
  if (minute < 0 || minute > 59) throw new Error(`Minuto invÃ¡lido no schedule: ${timeStr}`);

  const daysInMonth = new Date(year, month, 0).getDate();

  if (day > daysInMonth) {
    throw new Error(`Dia invÃ¡lido para o mÃªs no schedule: ${dateStr}`);
  }

  const iso = `${dateStr}T${timeStr}:00-03:00`;
  const dt = new Date(iso);

  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Data/hora invÃ¡lida no schedule: ${dateStr} ${timeStr}`);
  }

  return dt;
}

function getTimeZoneOffsetMillis(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = dtf.formatToParts(date).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUTC - date.getTime();
}

function zonedDateTimeToUtc(dateText, start, timeZone) {
  const saoPauloDate = parseScheduleDateTime(dateText, start);
  if (!timeZone || timeZone === 'America/Sao_Paulo') return saoPauloDate;

  const { year, month, day } = parseScheduleDate(dateText);
  const { hour, minute } = parseTimeString(start);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimeZoneOffsetMillis(guess, timeZone || 'America/Sao_Paulo');
  const result = new Date(guess.getTime() - offset);
  if (Number.isNaN(result.getTime())) throw new Error(`Data/hora inválida no schedule: ${dateText} ${start}.`);
  return result;
}


function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath];
    execFile(FFPROBE_PATH, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr || stdout || error.message;
        return reject(new Error(`ffprobe error: ${details}`));
      }
      resolve(stdout);
    });
  });
}

function parseFps(value) {
  const text = String(value || '');
  if (!text || text === '0/0') return null;
  const [num, den] = text.split('/').map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
  const direct = Number(text);
  return Number.isFinite(direct) && direct > 0 ? direct : null;
}

async function validateVideoFile(filePath, expectedDurationSeconds) {
  if (!fs.existsSync(filePath)) return { valid: false, error: 'Arquivo de saÃ­da nÃ£o foi criado.' };
  const fileSize = fs.statSync(filePath).size;
  if (fileSize <= MIN_LONG_RTSP_FILE_SIZE_BYTES) return { valid: false, fileSize, error: `Arquivo invÃ¡lido (${fileSize} bytes).` };

  try {
    const ffprobeRaw = await runFfprobe(filePath);
    const ffprobeData = JSON.parse(ffprobeRaw);
    const streams = Array.isArray(ffprobeData.streams) ? ffprobeData.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');
    const audioStream = streams.find((stream) => stream.codec_type === 'audio');
    const parseDuration = (stream) => Number(stream?.duration || 0) || null;
    const formatDuration = Number(ffprobeData?.format?.duration || 0) || null;
    const videoDuration = parseDuration(videoStream);
    const audioDuration = parseDuration(audioStream);
    const videoFrames = Number(videoStream?.nb_frames || 0) || null;

    if (!videoStream) {
      console.log(`[validation] formatDuration=${formatDuration || 0} videoDuration=0 audioDuration=${audioDuration || 0} fileSize=${fileSize} validationReference=format.duration`);
      return { valid: false, reason: 'ffprobe nÃ£o encontrou stream de vÃ­deo.', fileSize, duration: formatDuration, formatDuration, videoDuration: null, audioDuration, videoFrames, fps: null, validationReference: 'format.duration', expectedDurationSeconds, ffprobeData };
    }
    const fps = parseFps(videoStream?.avg_frame_rate || videoStream?.r_frame_rate)
      || (videoFrames && videoDuration ? videoFrames / videoDuration : null);
    const warning = (!videoDuration || (formatDuration && videoDuration < formatDuration * 0.95))
      ? 'videoStream.duration menor que format.duration; usando format.duration como refer\u00eancia'
      : null;
    console.log(`[validation] formatDuration=${formatDuration || 0} videoDuration=${videoDuration || 0} audioDuration=${audioDuration || 0} fileSize=${fileSize} validationReference=format.duration${warning ? ` warning="${warning}"` : ''}`);

    if (!formatDuration || formatDuration < expectedDurationSeconds * 0.9) {
      return { valid: false, reason: `Format duration too short: format has ${formatDuration || 0}s but expected at least ${expectedDurationSeconds * 0.9}s`, fileSize, duration: formatDuration, formatDuration, videoDuration, audioDuration, videoFrames, fps, validationReference: 'format.duration', expectedDurationSeconds, ffprobeData };
    }
    return {
      valid: true,
      fileSize,
      duration: formatDuration,
      formatDuration,
      videoDuration,
      audioDuration,
      videoFrames,
      fps,
      validationReference: 'format.duration',
      warning,
      expectedDurationSeconds,
      codec: videoStream.codec_name || null,
      width: Number(videoStream.width || 0) || null,
      height: Number(videoStream.height || 0) || null,
      hasAudio: streams.some((stream) => stream.codec_type === 'audio')
    };
  } catch (error) {
    const warning = 'ffprobe falhou; arquivo invalido para analise.';
    if (false && fileSize >= FFPROBE_FALLBACK_MIN_BYTES) {
      console.log(`[validation] formatDuration=0 videoDuration=0 audioDuration=0 fileSize=${fileSize} validationReference=format.duration`);
      return { valid: true, fileSize, duration: null, formatDuration: null, videoDuration: null, audioDuration: null, videoFrames: null, fps: null, validationReference: 'format.duration', expectedDurationSeconds, codec: null, width: null, height: null, hasAudio: null, warning, ffprobeError: error.message };
    }
    const details = error?.message || String(error || '');
    const reason = /moov atom not found/i.test(details) ? 'ffprobe falhou: moov atom not found.' : `ffprobe falhou: ${details}`;
    return { valid: false, fileSize, reason, ffprobeError: details, expectedDurationSeconds };
  }
}

function startRecordingJob(options) {
  const {
    body = {},
    outputPath: providedOutputPath,
    source = 'manual',
    scheduleId = null,
    onStatus
  } = options || {};

  const cameraId = String(body.camera || body.cameraId || '').toLowerCase();
  const rtspUrl = CAMERAS[cameraId];
  if (!rtspUrl) {
    const error = new Error('RTSP nÃ£o configurado para esta cÃ¢mera');
    error.statusCode = 400;
    error.details = { cameraId, availableCameras: Object.keys(CAMERAS) };
    throw error;
  }
  const activeRecording = getActiveRecording(cameraId);
  if (activeRecording) {
    const error = new Error(`JÃ¡ existe gravaÃ§Ã£o em andamento para a cÃ¢mera ${cameraId}`);
    error.statusCode = 409;
    error.details = { cameraId, activeRecordingId: activeRecording.recordingId };
    throw error;
  }
  const durationMinutes = Number(body.durationMinutes || 60);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    const error = new Error('durationMinutes invÃ¡lido.');
    error.statusCode = 400;
    throw error;
  }

  const durationSeconds = Math.floor(Math.max(1, durationMinutes) * 60);
  const recordingId = crypto.randomUUID();
  const outputPath = providedOutputPath || path.join(RECORDINGS_DIR, `${recordingId}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const ffmpegArgs = buildFfmpegArgs(rtspUrl, durationSeconds, outputPath);
  const ffmpegCommand = `${FFMPEG_PATH} ${sanitizeCommandArgs(ffmpegArgs).join(' ')}`;

  console.log(`[recording:${recordingId}] Iniciando gravaÃ§Ã£o RTSP camera=${cameraId} duration=${durationSeconds}s source=${source}`);
  console.log(`[recording:${recordingId}] recording_started camera=${cameraId} duration=${durationSeconds}s source=${source}`);
  console.log(`[recording:${recordingId}] outputPath=${outputPath}`);
  console.log(`[recording:${recordingId}] FFmpeg command: ${ffmpegCommand}`);
  const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let closeHandled = false;
  let recordingFailed = false;
  let watchdogTimer = null;
  let forceKillTimer = null;
  let fileProgressTimer = null;
  let noOutputTimer = null;
  let lastFileSize = 0;
  let noOutputTicks = 0;
  const ffmpegStderrLines = [];

  const rec = {
    id: recordingId,
    recordingId,
    status: 'recording',
    failedStage: null,
    outputPath,
    fileSize: null,
    videoValidation: null,
    processRef: ffmpeg,
    ffmpegStderr: '',
    ffmpegLastLog: '',
    ffmpegCommand,
    source,
    scheduleId,
    durationSeconds,
    onStatus,
    professor: body.professor || '',
    turma: body.turma || '',
    nivel: body.nivel || '',
    sala: body.sala || '',
    horario: body.horario || body.start || '',
    prompt: body.observacoes || body.prompt || '',
    cameraId,
    observacoes: body.observacoes || body.prompt || '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    gcsBucket: null,
    gcsFileName: null,
    videoUrl: null,
    gcsPublicUrl: null,
    uploadedAt: null,
    railwayResponse: null,
    reportUrl: null,
    remoteJsonUrl: null,
    error: null,
    errorDetails: null,
    processingStatus: null
  };
  recordings.set(recordingId, rec);
  activeRecordings.set(cameraId, recordingId);
  if (onStatus) onStatus(rec, 'recording');

  function getOutputFileState() {
    const exists = fs.existsSync(outputPath);
    const size = exists ? fs.statSync(outputPath).size : 0;
    return { exists, size };
  }

  function logFfmpegTail() {
    console.error(`[recording:${recordingId}] ffmpeg_tail:\n${ffmpegStderrLines.join('\n')}`);
  }

  function pushFfmpegStderr(chunk) {
    const text = chunk.toString();
    rec.ffmpegStderr = appendBoundedLog(rec.ffmpegStderr, text, MAX_FFMPEG_LOG_CHARS);
    for (const line of text.split(/\r?\n/)) {
      const clean = redactSecrets(line.trim());
      if (!clean) continue;
      ffmpegStderrLines.push(clean);
      if (ffmpegStderrLines.length > MAX_FFMPEG_STDERR_LINES) {
        ffmpegStderrLines.shift();
      }
    }
  }

  function markRecordingFailed(stage, error) {
    if (recordingFailed) return;
    recordingFailed = true;
    const message = error?.message || String(error || '');
    console.error(`[recording:${recordingId}] recording_failed stage=${stage} message=${message}`);
    rec.status = 'failed';
    rec.failedStage = stage;
    rec.error = {
      stage,
      message,
      ffmpegTail: ffmpegStderrLines.slice(-40),
      outputPath
    };
    rec.errorDetails = {
      ...buildErrorDetails(error, rec, stage),
      ffmpegTail: ffmpegStderrLines.slice(-40),
      outputPath
    };
    rec.fileSize = getFileSizeSafe(outputPath);
  }

  ffmpeg.stderr?.on('data', (chunk) => {
    pushFfmpegStderr(chunk);
  });

  function handleFfmpegClosed(code, reason = 'close') {
    if (closeHandled) return;
    closeHandled = true;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (fileProgressTimer) clearInterval(fileProgressTimer);
    if (noOutputTimer) clearTimeout(noOutputTimer);

    rec.finishedAt = new Date().toISOString();
    rec.ffmpegLastLog = getLogTail(rec.ffmpegStderr);
    console.log(`[recording:${recordingId}] ffmpeg_closed reason=${reason} code=${code}`);
    console.log(`[recording:${recordingId}] FFmpeg finalizou com cÃ³digo ${code}`);
    if (rec.scheduleId) console.log(`[schedule:${rec.scheduleId}] Fim da gravaÃ§Ã£o cÃ³digo=${code}`);
    if (activeRecordings.get(cameraId) === recordingId) activeRecordings.delete(cameraId);
    logFfmpegTail();

    const outputState = getOutputFileState();
    if (!outputState.exists || outputState.size === 0) {
      markRecordingFailed('recording_no_file', new Error(`Arquivo de gravaÃƒÂ§ÃƒÂ£o nÃƒÂ£o foi criado ou estÃƒÂ¡ vazio: ${outputPath}`));
    }

    if (recordingFailed) {
      if (onStatus) onStatus(rec, 'failed', rec.errorDetails);
      startNextRecordingForCamera(cameraId);
      return;
    }

    if (reason === 'forced_timeout') {
      const details = setRecordingError(rec, 'recording_timeout', new Error('FFmpeg nÃ£o emitiu close apÃ³s force kill.'));
      if (onStatus) onStatus(rec, 'failed', details);
      startNextRecordingForCamera(cameraId);
      return;
    }
    if (code !== 0 && rec.status !== 'stopping') {
      const details = setRecordingError(rec, 'recording', new Error(`FFmpeg encerrou com cÃ³digo ${code}`));
      if (onStatus) onStatus(rec, 'failed', details);
      startNextRecordingForCamera(cameraId);
      return;
    }

    if (!fs.existsSync(rec.outputPath)) {
      const details = setRecordingError(rec, 'recording', new Error('Arquivo de saÃ­da nÃ£o foi criado.'));
      if (onStatus) onStatus(rec, 'failed', details);
      startNextRecordingForCamera(cameraId);
      return;
    }

    console.log(`[recording:${recordingId}] recording_finished code=${code}`);
    rec.fileSize = outputState.size;
    rec.status = 'recorded';
    if (onStatus) onStatus(rec, 'recorded');
    enqueueProcessingJob(recordingId);
    if (rec.scheduleId) console.log(`[schedule:${rec.scheduleId}] Enviado para fila de processamento`);
    startNextRecordingForCamera(cameraId);
  }

  ffmpeg.on('close', (code) => {
    handleFfmpegClosed(code, 'close');
  });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`[recording:${recordingId}] FFmpeg exit code=${code} signal=${signal}`);
  });

  ffmpeg.on('error', (error) => {
    if (closeHandled) return;
    closeHandled = true;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (fileProgressTimer) clearInterval(fileProgressTimer);
    if (noOutputTimer) clearTimeout(noOutputTimer);
    rec.ffmpegLastLog = getLogTail(rec.ffmpegStderr);
    logFfmpegTail();
    if (activeRecordings.get(cameraId) === recordingId) activeRecordings.delete(cameraId);
    const details = setRecordingError(rec, 'starting_ffmpeg', error);
    if (onStatus) onStatus(rec, 'failed', details);
    startNextRecordingForCamera(cameraId);
  });

  fileProgressTimer = setInterval(() => {
    const { exists, size } = getOutputFileState();
    const grew = size > lastFileSize;
    console.log(`[recording:${recordingId}] file_progress exists=${exists} size=${size} grew=${grew}`);

    if (!exists || size === 0) {
      noOutputTicks += 1;
    }

    lastFileSize = size;
  }, FILE_PROGRESS_INTERVAL_MS);

  noOutputTimer = setTimeout(() => {
    if (closeHandled || recordingFailed) return;
    const { exists, size } = getOutputFileState();

    if (!exists || size === 0) {
      console.error(`[recording:${recordingId}] no_output_timeout outputPath=${outputPath} exists=${exists} size=${size}`);
      logFfmpegTail();
      markRecordingFailed('recording_no_file', new Error(`FFmpeg nÃ£o criou arquivo de saÃ­da apÃ³s ${NO_OUTPUT_TIMEOUT_MS}ms`));

      try {
        ffmpeg.kill('SIGINT');
        console.error(`[recording:${recordingId}] sigint_sent pid=${ffmpeg.pid} reason=no_output_timeout`);
      } catch (error) {
        console.error(`[recording:${recordingId}] Erro ao enviar SIGINT apÃ³s no_output_timeout: ${error.message}`);
      }
      const noOutputForceKillMs = (Number.isFinite(FORCE_KILL_GRACE_SECONDS) && FORCE_KILL_GRACE_SECONDS >= 0 ? FORCE_KILL_GRACE_SECONDS : 15) * 1000;
      forceKillTimer = setTimeout(async () => {
        if (closeHandled) return;

        console.error(`[recording:${recordingId}] force_kill_timeout. Matando FFmpeg pid=${ffmpeg.pid} reason=no_output_timeout`);
        await forceKillProcessTree(ffmpeg.pid);

        setTimeout(() => {
          if (closeHandled) return;
          handleFfmpegClosed(1, 'forced_timeout');
        }, 3000);
      }, noOutputForceKillMs);
    }
  }, NO_OUTPUT_TIMEOUT_MS);

  const safeRecordingGraceSeconds = Number.isFinite(RECORDING_GRACE_SECONDS) && RECORDING_GRACE_SECONDS >= 0 ? RECORDING_GRACE_SECONDS : 30;
  const safeForceKillGraceSeconds = Number.isFinite(FORCE_KILL_GRACE_SECONDS) && FORCE_KILL_GRACE_SECONDS >= 0 ? FORCE_KILL_GRACE_SECONDS : 15;
  const recordingWatchdogMs = (durationSeconds + safeRecordingGraceSeconds) * 1000;
  watchdogTimer = setTimeout(() => {
    if (closeHandled) return;

    console.error(`[recording:${recordingId}] watchdog_timeout duration=${durationSeconds}s grace=${safeRecordingGraceSeconds}s. Enviando SIGINT para FFmpeg.`);
    rec.status = 'stopping';

    try {
      if (rec.processRef && !rec.processRef.killed) {
        rec.processRef.kill('SIGINT');
        console.error(`[recording:${recordingId}] sigint_sent pid=${ffmpeg.pid}`);
      }
    } catch (error) {
      console.error(`[recording:${recordingId}] Erro ao enviar SIGINT: ${error.message}`);
    }

    forceKillTimer = setTimeout(async () => {
      if (closeHandled) return;

      console.error(`[recording:${recordingId}] force_kill_timeout. Matando FFmpeg pid=${ffmpeg.pid}`);
      await forceKillProcessTree(ffmpeg.pid);

      setTimeout(() => {
        if (closeHandled) return;
        handleFfmpegClosed(1, 'forced_timeout');
      }, 3000);
    }, safeForceKillGraceSeconds * 1000);
  }, recordingWatchdogMs);
  console.log(`[recording:${recordingId}] recording_watchdog_started timeoutMs=${recordingWatchdogMs}`);

  return rec;
}

app.get('/health', (_req, res) => res.json({
  ok: true,
  environment: process.env.NODE_ENV || 'development',
  requiredEnv: getEnvSummary(),
  analysisRoutes: ['/processing-status/:recordingId'],
  backendEndpoint: RAILWAY_API_URL ? `${RAILWAY_API_URL}/analyze-gcs` : null,
  version: require('./package.json').version
}));
app.get('/debug-env', (_req, res) => res.json(getEnvSummary()));

app.post('/start-recording', (req, res) => {
  try {
    const rec = startRecordingJob({ body: req.body, source: 'manual' });
    return res.json({ recordingId: rec.recordingId, status: rec.status });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message, ...(error.details || {}) });
  }
});

app.post('/start-daily-schedule', async (_req, res) => {
  try {
    if (dailyScheduleState.started) {
      return res.json({ started: true, message: 'Scheduler jÃ¡ iniciado.', classes: Array.from(dailyScheduleState.classes.values()) });
    }
    if (!fs.existsSync(SCHEDULE_PATH)) return res.status(404).json({ error: `Agenda nÃ£o encontrada em ${SCHEDULE_PATH}` });
    const raw = fs.readFileSync(SCHEDULE_PATH, 'utf-8');
    const schedule = JSON.parse(raw);
    const classes = Array.isArray(schedule.classes) ? schedule.classes : [];
    const timezone = schedule.timezone || 'America/Sao_Paulo';
    console.log(`[schedule] Agenda carregada: date=${schedule.date} timezone=${timezone} aulas=${classes.length}`);

    const byCamera = new Map();
    for (const item of classes) {
      const durationMinutes = Number(item.durationMinutes || 60);
      const startAt = zonedDateTimeToUtc(schedule.date, item.start, timezone);
      const endAt = new Date(startAt.getTime() + durationMinutes * 60000);
      const key = String(item.cameraId || '').toLowerCase();
      if (!byCamera.has(key)) byCamera.set(key, []);
      byCamera.get(key).push({ ...item, durationMinutes, startAt, endAt });
    }
    for (const [cameraId, items] of byCamera.entries()) {
      items.sort((a, b) => a.startAt - b.startAt);
      for (let i = 1; i < items.length; i += 1) {
        if (items[i].startAt < items[i - 1].endAt) {
          console.log(`[schedule] Conflito na cÃ¢mera ${cameraId}: ${items[i - 1].id} sobrepÃµe ${items[i].id}; a fila da cÃ¢mera vai serializar as gravaÃ§Ãµes`);
        }
      }
    }

    dailyScheduleState.started = true;
    dailyScheduleState.scheduleDate = schedule.date;
    dailyScheduleState.timezone = timezone;

    const scheduled = [];
    for (const classItem of classes) {
      const durationMinutes = Number(classItem.durationMinutes || 60);
      const classStartUtc = zonedDateTimeToUtc(schedule.date, classItem.start, timezone);
      const timestamp = classItem.start.replace(':', '');
      const professorSlug = slugifyText(classItem.professor || 'professor');
      const outputName = `${schedule.date}_${classItem.cameraId}_${timestamp}_${professorSlug}.mp4`;
      const classStatus = { ...classItem, date: schedule.date, durationMinutes, recordingStatus: 'agendada', analysisStatus: 'aguardando', uiStatus: 'agendada', videoPath: path.join(RECORDINGS_DIR, outputName), videoUrl: null, reportUrl: null, error: null };
      dailyScheduleState.classes.set(classItem.id, classStatus);
      scheduled.push(classStatus);

      let delayMs = classStartUtc.getTime() - Date.now();
      classStatus.scheduledAt = classStartUtc.toISOString();
      classStatus.delayMinutes = Math.round(delayMs / 60000);

      if (delayMs < -LATE_TOLERANCE_MS) {
        classStatus.recordingStatus = 'skipped_late';
        classStatus.analysisStatus = 'skipped_late';
        classStatus.uiStatus = 'skipped_late';
        classStatus.error = `Aula já passou fora da tolerância de ${Math.round(LATE_TOLERANCE_MS / 60000)} minutos.`;
        console.warn(`[schedule:${classItem.id}] Aula já passou. Não será iniciada automaticamente. Data=${classStartUtc.toISOString()} delayMs=${delayMs}`);
        continue;
      }

      if (delayMs < 0) {
        console.warn(`[schedule:${classItem.id}] Aula atrasada dentro da tolerância. Iniciando agora. atrasoMs=${Math.abs(delayMs)}`);
        delayMs = 0;
      }

      if (delayMs > MAX_TIMEOUT_MS) {
        classStatus.recordingStatus = 'pending_future';
        classStatus.analysisStatus = 'pending_future';
        classStatus.uiStatus = 'pending_future';
        classStatus.error = `Aula muito distante para setTimeout direto. Reinicie o agente no dia da aula.`;
        console.warn(`[schedule:${classItem.id}] Aula muito distante para setTimeout direto. Data=${classStartUtc.toISOString()} delayMs=${delayMs}. Não será agendada agora.`);
        continue;
      }

      const timer = setTimeout(() => {
        (async () => {
          const status = dailyScheduleState.classes.get(classItem.id);
          if (!status || status.recordingStatus === 'gravando') return;
          const scheduleCameraId = String(classItem.cameraId || '').toLowerCase();
          if (!CAMERAS[scheduleCameraId]) {
            status.recordingStatus = 'record_failed';
            status.analysisStatus = 'failed'; status.uiStatus = 'failed';
            status.error = `RTSP nÃ£o configurado para ${classItem.cameraId}`;
            return;
          }
          if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
            status.recordingStatus = 'record_failed';
            status.analysisStatus = 'failed'; status.uiStatus = 'failed';
            status.error = `durationMinutes invÃ¡lido: ${classItem.durationMinutes}`;
            return;
          }
          enqueueOrStartRecording({
            cameraId: scheduleCameraId,
            body: { ...classItem, cameraId: scheduleCameraId, camera: scheduleCameraId, horario: classItem.start, durationMinutes },
            outputPath: status.videoPath,
            source: 'schedule',
            scheduleId: classItem.id,
            scheduledStartAt: classStartUtc,
            status,
            onStatus: (rec, phase, details) => {
              status.recordingId = rec.recordingId;
              status.videoPath = rec.outputPath;
              status.videoUrl = rec.videoUrl || status.videoUrl;
              status.errorDetails = details || rec.errorDetails || null;
              status.error = rec.error || status.error;

              if (phase === 'recording') {
                status.recordingStatus = 'gravando';
                status.analysisStatus = 'aguardando';
                status.uiStatus = 'gravando';
              } else if (phase === 'recorded') {
                status.recordingStatus = 'completed';
                status.analysisStatus = 'queued_processing';
                status.uiStatus = 'queued_processing';
              } else if (phase === 'queued_processing') {
                status.recordingStatus = 'completed';
                status.analysisStatus = 'queued_processing';
                status.uiStatus = 'queued_processing';
              } else if (phase === 'validating_video') {
                status.recordingStatus = 'completed';
                status.analysisStatus = 'validating_video';
                status.uiStatus = 'validating_video';
              } else if (phase === 'uploading_gcs' || phase === 'calling_railway') {
                status.recordingStatus = 'completed';
                status.analysisStatus = phase;
                status.uiStatus = phase;
              } else if (phase === 'failed' || rec.status === 'failed') {
                status.recordingStatus = rec.failedStage === 'recording' || rec.failedStage === 'starting_ffmpeg' ? 'record_failed' : 'completed';
                status.analysisStatus = 'failed';
                status.uiStatus = 'failed';
              } else if (rec.status === 'completed' || rec.status === 'success') {
                status.recordingStatus = 'completed';
                status.analysisStatus = 'completed';
                status.uiStatus = 'completed';
                status.reportUrl = rec.reportUrl || rec?.railwayResponse?.analysis?.pdfUrl || rec?.railwayResponse?.pdfUrl || status.reportUrl;
              } else {
                status.analysisStatus = rec.status;
                status.uiStatus = rec.status;
              }
            }
          });
          return;
        })().catch((error) => {
          const status = dailyScheduleState.classes.get(classItem.id);
          if (status) {
            status.analysisStatus = 'failed';
            status.uiStatus = 'failed';
            status.error = getErrorMessage(error);
            status.errorDetails = { message: getErrorMessage(error), stack: error?.stack || null, cause: error?.cause || null };
          }
          console.error(`[schedule:${classItem.id}] Erro assÃ­ncrono no agendamento: ${getErrorMessage(error)}`);
          console.error(error?.stack || error);
        });
      }, delayMs);

      dailyScheduleState.timers.set(classItem.id, timer);
      console.log(`[schedule:${classItem.id}] Aula agendada para ${classItem.start} (${classStartUtc.toISOString()})`);
    }
    return res.json({ started: true, classes: scheduled });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/daily-schedule-status', (_req, res) => {
  return res.json({ started: dailyScheduleState.started, date: dailyScheduleState.scheduleDate, timezone: dailyScheduleState.timezone, classes: Array.from(dailyScheduleState.classes.values()) });
});

app.post('/stop-recording/:recordingId', (req, res) => {
  const rec = recordings.get(req.params.recordingId);
  if (!rec) return res.status(404).json({ error: 'recordingId nÃ£o encontrado' });
  rec.status = 'stopping';
  if (rec.processRef && !rec.processRef.killed) rec.processRef.kill('SIGINT');
  return res.json({ ok: true, recordingId: rec.recordingId, status: rec.status });
});

app.get('/recording-status/:recordingId', (req, res) => {
  const rec = recordings.get(req.params.recordingId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  return res.json({ id: rec.id, recordingId: rec.recordingId, status: rec.status, jsonUrl: rec.jsonUrl || rec.remoteJsonUrl || null, reportUrl: rec.reportUrl || null, failedStage: rec.failedStage, error: rec.error, errorDetails: rec.errorDetails || null, ffmpegLastLog: rec.ffmpegLastLog || getLogTail(rec.ffmpegStderr), outputPath: rec.outputPath, fileSize: rec.fileSize, videoValidation: rec.videoValidation, gcsBucket: rec.gcsBucket || null, gcsFileName: rec.gcsFileName || null, videoUrl: rec.videoUrl || null, gcsPublicUrl: rec.gcsPublicUrl || null, uploadedAt: rec.uploadedAt || null, railwayResponse: rec.railwayResponse });
});

app.get('/processing-status/:recordingId', (req, res) => {
  const rec = recordings.get(req.params.recordingId);
  const processingStatus = processingStatuses.get(req.params.recordingId) || rec?.processingStatus || null;
  if (!rec && !processingStatus) return res.status(404).json({ error: 'not_found' });
  return res.json({
    recordingId: req.params.recordingId,
    status: processingStatus?.status || null,
    failedStage: processingStatus?.failedStage || null,
    errorMessage: processingStatus?.errorMessage || null,
    errorStack: processingStatus?.errorStack || null,
    updatedAt: processingStatus?.updatedAt || null,
    recordingStatus: rec?.status || null,
    gcsBucket: rec?.gcsBucket || null,
    gcsFileName: rec?.gcsFileName || null,
    videoUrl: rec?.videoUrl || null,
    gcsPublicUrl: rec?.gcsPublicUrl || null,
    reportUrl: rec?.reportUrl || null,
    jsonUrl: rec?.jsonUrl || rec?.remoteJsonUrl || null
  });
});

app.listen(PORT, () => console.log(`Agent local rodando na porta ${PORT}`));
