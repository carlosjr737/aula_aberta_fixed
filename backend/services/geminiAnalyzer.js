const fs = require('fs');
const path = require('path');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function uploadToGemini(filePath, mimeType = 'video/mp4') {
  const fileSizeBytes = fs.statSync(filePath).size;
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': path.basename(filePath),
      'Content-Type': mimeType,
      'Content-Length': String(fileSizeBytes)
    },
    body: fs.createReadStream(filePath),
    duplex: 'half'
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || 'Falha upload Gemini');
  return payload.file;
}

async function waitForGeminiActive(fileName) {
  for (let i = 0; i < 120; i += 1) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${process.env.GEMINI_API_KEY}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'Falha status Gemini');
    if (data.state === 'ACTIVE') return data;
    if (data.state === 'FAILED') throw new Error('Gemini processou com falha');
    await sleep(5000);
  }
  throw new Error('Timeout aguardando ACTIVE');
}

async function analyzeVideo(fileUri, prompt, metadata) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ file_data: { mime_type: 'video/mp4', file_uri: fileUri } }, { text: `${prompt}\n\nMetadata:${JSON.stringify(metadata)}` }] }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Falha análise Gemini');
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || 'Sem resposta textual';
}

module.exports = { uploadToGemini, waitForGeminiActive, analyzeVideo, GEMINI_MODEL };
