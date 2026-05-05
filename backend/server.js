const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MIN_FILE_SIZE_BYTES = 1 * 1024 * 1024;

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000'
].filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin) || /vercel\.app$/.test(new URL(origin).hostname)) {
      return cb(null, true);
    }
    return cb(null, true); // MVP: liberado para facilitar teste. Trave isso depois.
  }
}));
app.use(express.json({ limit: '2mb' }));

const DEFAULT_PROMPT = `Você é um especialista em pedagogia da dança, gestão de professores e análise de comportamento em sala de aula. Analise a aula inteira considerando o Perfil Professor DK.

Perfil Professor DK:
- conduz a aula com energia e presença
- explica com clareza e objetividade
- coloca os alunos em prática rapidamente
- corrige individualmente e coletivamente
- mantém a turma engajada
- usa bem o espaço da sala
- demonstra domínio técnico
- cria ambiente seguro, motivador e exigente
- equilibra técnica, disciplina, diversão e evolução

IMPORTANTE:
- Analise o vídeo completo ao longo do tempo, não apenas um frame.
- Use evidências observáveis do vídeo e do áudio.
- Quando não for possível avaliar algo, diga claramente que não foi possível.
- Evite inventar comportamentos não observados.

Formato do relatório:
- Resumo geral
- Pontos fortes
- Pontos de melhoria
- Energia e presença
- Clareza da condução
- Interação com alunos
- Explicação vs prática
- Correções realizadas
- Alinhamento com o Perfil Professor DK
- Nota geral de 0 a 10, apenas se houver evidência suficiente
- Recomendações práticas para próxima aula`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractDriveFileId(input) {
  if (!input || typeof input !== 'string') return null;
  try {
    const url = new URL(input);
    const id = url.searchParams.get('id');
    if (id) return id;
  } catch (_) {}

  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/uc\?[^\s]*id=([a-zA-Z0-9_-]+)/,
    /drive\.usercontent\.google\.com\/download\?[^\s]*id=([a-zA-Z0-9_-]+)/,
    /\bid=([a-zA-Z0-9_-]+)/
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function parseSetCookie(headers) {
  const raw = headers.get('set-cookie') || '';
  return raw
    .split(/,(?=\s*[^;]+=[^;]+)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function extractConfirmTokenFromHtml(html) {
  const patterns = [
    /confirm=([0-9A-Za-z_\-]+)/,
    /name="confirm"\s+value="([0-9A-Za-z_\-]+)"/,
    /confirm=([^&"']+)/
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

function contentLooksLikeVideo(contentType) {
  const value = (contentType || '').toLowerCase();
  return value.startsWith('video/') || value.includes('application/octet-stream');
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mpeg' || ext === '.mpg') return 'video/mpeg';
  return 'video/mp4';
}

async function downloadToFile(url, filePath, cookieHeader) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    }
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    throw Object.assign(new Error(`Falha ao baixar vídeo do Drive. HTTP ${response.status}`), { statusCode: 400 });
  }

  if (contentType.toLowerCase().includes('text/html')) {
    const html = await response.text();
    return { html, contentType, response };
  }

  if (!contentLooksLikeVideo(contentType)) {
    throw Object.assign(new Error(`Drive não retornou vídeo. Content-Type: ${contentType}`), { statusCode: 400 });
  }

  await pipeline(response.body, fs.createWriteStream(filePath));
  return { filePath, contentType, response };
}

async function downloadDriveFile(driveUrl) {
  const fileId = extractDriveFileId(driveUrl);
  if (!fileId) {
    throw Object.assign(new Error('Link do Google Drive inválido. Não foi possível extrair o fileId.'), { statusCode: 400 });
  }

  const filePath = path.join(os.tmpdir(), `drive_video_${Date.now()}_${fileId}.mp4`);
  const firstUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const first = await downloadToFile(firstUrl, filePath);

  if (first.filePath) return filePath;

  const confirmToken = extractConfirmTokenFromHtml(first.html || '');
  const cookieHeader = parseSetCookie(first.response.headers);
  if (!confirmToken) {
    // Tenta rota usercontent mesmo sem token.
    const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    const direct = await downloadToFile(directUrl, filePath, cookieHeader);
    if (direct.filePath) return filePath;
    throw Object.assign(new Error('Google Drive retornou HTML em vez do vídeo. Use link público ou backend autenticado com Google Drive API.'), { statusCode: 400 });
  }

  const confirmUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmToken}`;
  const second = await downloadToFile(confirmUrl, filePath, cookieHeader);
  if (second.filePath) return filePath;

  throw Object.assign(new Error('Google Drive retornou página de confirmação em vez do vídeo.'), { statusCode: 400 });
}

function inspectFile(filePath) {
  const exists = !!filePath && fs.existsSync(filePath);
  const bytes = exists ? fs.statSync(filePath).size : 0;
  return {
    fileExists: exists,
    fileSizeBytes: bytes,
    fileSizeMB: Number((bytes / 1024 / 1024).toFixed(2))
  };
}

async function uploadToGemini(filePath) {
  const mimeType = guessMimeType(filePath);
  const buffer = fs.readFileSync(filePath);
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`;

  console.log('Enviando vídeo para Gemini Files API...', { mimeType, sizeMB: (buffer.length / 1024 / 1024).toFixed(2) });
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': path.basename(filePath),
      'Content-Type': mimeType
    },
    body: buffer
  });

  const payload = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error?.message || 'Falha ao enviar vídeo para Gemini Files API.'), { statusCode: 500 });
  }
  if (!payload?.file?.name || !payload?.file?.uri) {
    throw Object.assign(new Error('Gemini Files API não retornou file.name/file.uri.'), { statusCode: 500 });
  }
  return { name: payload.file.name, uri: payload.file.uri, mimeType };
}

async function waitForGeminiActive(fileName) {
  // Vídeos grandes podem demorar. Railway aguenta melhor que Vercel, mas evite timeout gigante no MVP.
  for (let i = 0; i < 120; i += 1) {
    const url = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error?.message || 'Falha ao consultar status do arquivo Gemini.'), { statusCode: 500 });
    }
    console.log('Status Gemini file:', data.state);
    if (data.state === 'ACTIVE') return data;
    if (data.state === 'FAILED') {
      throw Object.assign(new Error('Falha ao processar vídeo na Gemini Files API.'), { statusCode: 500 });
    }
    await sleep(5000);
  }
  throw Object.assign(new Error('Timeout: vídeo ainda processando na Gemini Files API. Tente novamente.'), { statusCode: 408 });
}

async function analyzeWithGemini(file, metadata, prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        {
          file_data: {
            mime_type: file.mimeType,
            file_uri: file.uri
          }
        },
        {
          text: `${prompt || DEFAULT_PROMPT}\n\nMetadata da aula: ${JSON.stringify(metadata)}\n\nAnalise o vídeo inteiro usando vídeo e áudio. Cite sinais observáveis e evite inferir o que não aparece.`
        }
      ]
    }]
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error?.message || 'Falha na chamada generateContent do Gemini.'), { statusCode: 500 });
  }

  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n').trim();
  if (!text) {
    throw Object.assign(new Error('Gemini retornou resposta vazia.'), { statusCode: 500 });
  }
  return text;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'aula-aberta-backend', model: GEMINI_MODEL });
});

app.get('/default-prompt', (_req, res) => {
  res.json({ defaultPrompt: DEFAULT_PROMPT });
});

app.post('/analyze-drive', async (req, res) => {
  let filePath = null;
  let fileInfo = { fileExists: false, fileSizeBytes: 0, fileSizeMB: 0 };

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw Object.assign(new Error('GEMINI_API_KEY não configurada. Análise real não executada.'), { statusCode: 500 });
    }

    const { driveUrl, professor = '', turma = '', sala = '', prompt = DEFAULT_PROMPT } = req.body || {};
    if (!driveUrl) {
      throw Object.assign(new Error('driveUrl é obrigatório.'), { statusCode: 400 });
    }

    console.log('Baixando vídeo do Drive...');
    filePath = await downloadDriveFile(driveUrl);
    fileInfo = inspectFile(filePath);
    console.log('Vídeo baixado:', fileInfo);

    if (!fileInfo.fileExists || fileInfo.fileSizeBytes < MIN_FILE_SIZE_BYTES) {
      throw Object.assign(new Error('Arquivo de vídeo inválido ou menor que 1MB.'), { statusCode: 400 });
    }

    const uploaded = await uploadToGemini(filePath);
    const active = await waitForGeminiActive(uploaded.name);
    const metadata = { professor, turma, sala, driveUrl };
    const rawResponse = await analyzeWithGemini({ ...uploaded, uri: active.uri || uploaded.uri }, metadata, prompt);

    res.json({
      fileSizeMB: fileInfo.fileSizeMB,
      usedRealAI: true,
      provider: 'gemini',
      model: GEMINI_MODEL,
      report: {
        provider: 'gemini',
        rawResponse,
        promptUsado: prompt,
        metadata,
        analyzedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Erro /analyze-drive:', error);
    res.status(error.statusCode || 500).json({
      error: error.message || 'Erro ao analisar vídeo.',
      fileSizeMB: fileInfo.fileSizeMB,
      usedRealAI: false,
      provider: 'gemini'
    });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`Backend DK Aula IA rodando na porta ${PORT}`);
});
