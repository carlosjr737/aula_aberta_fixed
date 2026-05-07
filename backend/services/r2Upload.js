const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getR2Client() {
  const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`R2 não configurado: ${missing.join(', ')}`);

  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
  });
}

async function uploadFileToR2(filePath, { keyPrefix = 'reports', contentType = 'application/pdf' } = {}) {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET;
  const key = `${keyPrefix}/${Date.now()}_${path.basename(filePath)}`;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.createReadStream(filePath), ContentType: contentType }));
  const publicBase = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const url = publicBase ? `${publicBase}/${key}` : await generateSignedGetUrl(key);
  return { bucket, key, url };
}

async function generateSignedGetUrl(key, expiresIn = 2 * 60 * 60) {
  const client = getR2Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }), { expiresIn });
}

module.exports = { uploadFileToR2, generateSignedGetUrl };
