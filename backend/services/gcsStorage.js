const fs = require('fs');
const { Storage } = require('@google-cloud/storage');

function parseServiceAccountJson(raw) {
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado.');
  try {
    const parsed = JSON.parse(String(raw).trim());
    if (!parsed.private_key) throw new Error('private_key ausente no GOOGLE_SERVICE_ACCOUNT_JSON.');
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON inválido: ${error.message}`);
  }
}

function getBucketName() {
  const bucketName = String(process.env.GCS_BUCKET_NAME || '').trim();
  if (!bucketName) throw new Error('GCS_BUCKET_NAME não configurado.');
  return bucketName;
}

function getGCSClient() {
  const credentials = parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new Storage({ projectId: credentials.project_id, credentials });
}

async function uploadFileToGCS(filePath, destination, contentType = 'application/octet-stream') {
  const bucketName = getBucketName();
  const storage = getGCSClient();
  await storage.bucket(bucketName).upload(filePath, { destination, contentType });
  return { bucket: bucketName, fileName: destination };
}

async function uploadBufferToGCS(buffer, destination, contentType = 'application/octet-stream') {
  const bucketName = getBucketName();
  const storage = getGCSClient();
  await storage.bucket(bucketName).file(destination).save(buffer, { contentType });
  return { bucket: bucketName, fileName: destination };
}

async function generateSignedReadUrl(fileName, expiresInMinutes = 120) {
  const bucketName = getBucketName();
  const storage = getGCSClient();
  const [url] = await storage.bucket(bucketName).file(fileName).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + (expiresInMinutes * 60 * 1000) });
  return url;
}

module.exports = { getGCSClient, uploadFileToGCS, uploadBufferToGCS, generateSignedReadUrl };
