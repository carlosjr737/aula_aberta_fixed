const originalFetch = globalThis.fetch;

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function isAnalyzeGcsRequest(input) {
  const url = typeof input === 'string' ? input : input?.url;
  return typeof url === 'string' && url.includes('/analyze-gcs');
}

function parseJsonBody(body) {
  if (!body || typeof body !== 'string') return null;
  try {
    return JSON.parse(body);
  } catch (_error) {
    return null;
  }
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function patchedFetch(input, init = {}) {
    if (!isAnalyzeGcsRequest(input)) return originalFetch(input, init);

    const payload = parseJsonBody(init?.body);
    if (!payload || typeof payload !== 'object') return originalFetch(input, init);

    const bucketName = pickFirstNonEmpty(
      payload.bucketName,
      payload.bucket,
      payload.gcsBucket
    );
    const fileName = pickFirstNonEmpty(
      payload.fileName,
      payload.gcsPath,
      payload.gcsFileName,
      payload.objectName,
      payload.destination,
      payload.storagePath
    );

    const normalizedPayload = {
      ...payload,
      bucketName,
      fileName,
      bucket: pickFirstNonEmpty(payload.bucket, bucketName),
      gcsBucket: pickFirstNonEmpty(payload.gcsBucket, bucketName),
      gcsPath: pickFirstNonEmpty(payload.gcsPath, fileName),
      gcsFileName: pickFirstNonEmpty(payload.gcsFileName, fileName)
    };

    const recordingId = payload.recordingId || payload.id || 'unknown';
    console.log(`[processing:${recordingId}] analyze-gcs payload`, {
      bucketName: normalizedPayload.bucketName,
      fileName: normalizedPayload.fileName,
      professor: normalizedPayload.professor,
      turma: normalizedPayload.turma,
      sala: normalizedPayload.sala,
      durationMinutes: normalizedPayload.durationMinutes
    });

    if (!normalizedPayload.bucketName || !normalizedPayload.fileName) {
      throw new Error(`Payload invalido para /analyze-gcs: bucketName/fileName ausentes. uploadResult=${JSON.stringify(payload)}`);
    }

    return originalFetch(input, {
      ...init,
      body: JSON.stringify(normalizedPayload)
    });
  };
}
