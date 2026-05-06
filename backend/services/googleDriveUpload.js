const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  return google.drive({ version: 'v3', auth });
}

async function createFolderIfNotExists(drive, name, parentId = null) {
  const q = [`name='${name.replace(/'/g, "\\'")}'`, "mimeType='application/vnd.google-apps.folder'", 'trashed=false'];
  if (parentId) q.push(`'${parentId}' in parents`);
  const response = await drive.files.list({ q: q.join(' and '), fields: 'files(id,name)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (response.data.files?.[0]?.id) return response.data.files[0].id;

  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined },
    fields: 'id',
    supportsAllDrives: true
  });
  return created.data.id;
}

async function uploadFile(drive, filePath, mimeType, parentId) {
  const fileMetadata = { name: path.basename(filePath), parents: [parentId] };
  const media = { mimeType, body: fs.createReadStream(filePath) };
  const res = await drive.files.create({ requestBody: fileMetadata, media, fields: 'id,name,webViewLink', supportsAllDrives: true });
  return res.data;
}

async function uploadVideo(filePath, metadata) {
  const drive = getDriveClient();
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const root = await createFolderIfNotExists(drive, 'DK IA');
  const aulas = await createFolderIfNotExists(drive, 'Aulas', root);
  const yearFolder = await createFolderIfNotExists(drive, year, aulas);
  const monthFolder = await createFolderIfNotExists(drive, month, yearFolder);
  const teacherFolder = await createFolderIfNotExists(drive, metadata.professor || 'Sem Professor', monthFolder);
  return uploadFile(drive, filePath, 'video/mp4', teacherFolder);
}

async function uploadPdf(filePath, metadata) {
  const drive = getDriveClient();
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const root = await createFolderIfNotExists(drive, 'DK IA');
  const rel = await createFolderIfNotExists(drive, 'Relatorios', root);
  const yearFolder = await createFolderIfNotExists(drive, year, rel);
  const monthFolder = await createFolderIfNotExists(drive, month, yearFolder);
  const teacherFolder = await createFolderIfNotExists(drive, metadata.professor || 'Sem Professor', monthFolder);
  return uploadFile(drive, filePath, 'application/pdf', teacherFolder);
}

module.exports = { getDriveClient, createFolderIfNotExists, uploadVideo, uploadPdf };
