const express = require('express');
const { getGCSClient } = require('./services/gcsStorage');

const originalExpress = express;

function boolEnv(...keys) {
  return keys.some((key) => Boolean(String(process.env[key] || '').trim()));
}

function normalizeField(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

async function createSignedUrl(bucketName, fileName) {
  const storage = getGCSClient();
  const [url] = await storage.bucket(bucketName).file(fileName).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + (2 * 60 * 60 * 1000)
  });
  return url;
}

async function readJsonResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      failedStage: 'analysis_request',
      message: `Backend interno retornou resposta nao JSON: status=${response.status} content-type=${contentType || 'desconhecido'}`,
      details: { body: text.slice(0, 1000) }
    };
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return {
      ok: false,
      failedStage: 'analysis_request',
      message: `Falha ao parsear JSON interno: ${error.message}`,
      details: { body: text.slice(0, 1000) }
    };
  }
}

function registerRoutes(app) {
  app.get('/health', (_req, res) => res.json({
    ok: true,
    service: 'aula-aberta-backend',
    routes: ['/health', '/analyze-gcs', '/analyze-drive'],
    env: {
      GOOGLE_APPLICATION_CREDENTIALS: boolEnv('GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_SERVICE_ACCOUNT_JSON'),
      GEMINI_API_KEY: boolEnv('GEMINI_API_KEY'),
      GCS_BUCKET: boolEnv('GCS_BUCKET', 'GCS_BUCKET_NAME')
    }
  }));

  app.post('/analyze-gcs', async (req, res) => {
    const body = req.body || {};
    const bucketName = normalizeField(body.bucketName, body.bucket, body.gcsBucket, process.env.GCS_BUCKET, process.env.GCS_BUCKET_NAME);
    const fileName = normalizeField(body.fileName, body.gcsPath, body.gcsFileName);

    if (!bucketName || !fileName) {
      return res.status(400).json({
        ok: false,
        failedStage: 'request_validation',
        message: 'bucketName/fileName sao obrigatorios'
      });
    }

    try {
      console.log(`[analysis-gcs] request bucket=${bucketName} file=${fileName}`);
      const signedUrl = await createSignedUrl(bucketName, fileName);
      const port = Number(process.env.PORT || 3000);
      const response = await fetch(`http://127.0.0.1:${port}/analyze-video-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          videoUrl: signedUrl,
          gcsBucket: bucketName,
          gcsFileName: fileName
        })
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) return res.status(response.status).json({ ok: false, ...payload });
      return res.json({
        ok: true,
        ...payload,
        videoFile: { bucket: bucketName, fileName }
      });
    } catch (error) {
      console.error(`[analysis-gcs] failed ${error.stack || error.message}`);
      return res.status(error.statusCode || 500).json({
        ok: false,
        failedStage: 'analysis_request',
        message: error.message,
        details: { stack: error.stack || null, bucketName, fileName }
      });
    }
  });

  console.log('GET /health registered');
  console.log('POST /analyze-gcs registered');
  console.log('POST /analyze-drive registered');
}

function patchedExpress(...args) {
  const app = originalExpress(...args);
  registerRoutes(app);
  return app;
}

Object.assign(patchedExpress, originalExpress);
require.cache[require.resolve('express')].exports = patchedExpress;
