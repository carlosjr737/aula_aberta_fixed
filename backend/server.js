const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3001;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MIN_FILE_SIZE_BYTES = 1 * 1024 * 1024;

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://aula-aberta-fixed.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
].filter(Boolean);

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
app.use(express.json());

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

function extractDriveFileId(driveUrl) {
  if (!driveUrl || typeof driveUrl !== 'string') return null;

  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/uc\?[\s\S]*?[?&]id=([a-zA-Z0-9_-]+)/,
    /drive\.usercontent\.google\.com\/download\?[\s\S]*?[?&]id=([a-zA-Z0-9_-]+)/
  ];

  for (const pattern of patterns) {
    const match = driveUrl.match(pattern);
    if (match?.[1]) return match[1];
  }

  try {
    const url = new URL(driveUrl);
    const id = url.searchParams.get('id');
    if (id) return id;
  } catch (_) {
    return null;
  }

  return null;
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mpeg' || ext === '.mpg') return 'video/mpeg';
  return 'video/mp4';
}

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });

  return google.drive({ version: 'v3', auth });
}

async function downloadFromDrive(fileId, destPath) {
  const drive = getDriveClient();
  const res = await drive.files.get(
    {
      fileId,
      alt: 'media',
      supportsAllDrives: true
    },
    { responseType: 'stream' }
  );

  await pipeline(res.data, fs.createWriteStream(destPath));
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

async function uploadToGemini(filePath, fallbackMimeType) {
  const mimeType = fallbackMimeType || guessMimeType(filePath);
  const buffer = fs.readFileSync(filePath);
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`;

  console.log('Enviando para Gemini Files API...');
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
  console.log('Aguardando arquivo ACTIVE...');
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
  console.log('BODY RECEBIDO:', req.body);
  let filePath = null;
  let fileInfo = { fileExists: false, fileSizeBytes: 0, fileSizeMB: 0 };

  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON não configurada.' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY não configurada.' });
    }

    const { driveUrl, professor = '', turma = '', sala = '', prompt = DEFAULT_PROMPT } = req.body || {};
    if (!driveUrl) {
      return res.status(400).json({ error: 'driveUrl é obrigatório' });
    }

    const fileId = extractDriveFileId(driveUrl);
    if (!fileId) {
      throw Object.assign(new Error('Link do Google Drive inválido. Não foi possível extrair o fileId.'), { statusCode: 400 });
    }

    console.log('Drive fileId:', fileId);

    const drive = getDriveClient();
    const metadataResponse = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size',
      supportsAllDrives: true
    });

    const driveFile = metadataResponse.data || {};
    const driveMimeType = driveFile.mimeType || 'video/mp4';
    const driveFileSizeBytes = Number(driveFile.size || 0);
    const driveFileSizeMB = Number((driveFileSizeBytes / 1024 / 1024).toFixed(2));

    filePath = path.join(os.tmpdir(), `drive_video_${Date.now()}_${fileId}`);

    console.log('Baixando via Google Drive API...');
    await downloadFromDrive(fileId, filePath);

    fileInfo = inspectFile(filePath);
    console.log('Arquivo baixado:', fileInfo.fileSizeMB);

    if (!fileInfo.fileExists || fileInfo.fileSizeBytes < MIN_FILE_SIZE_BYTES) {
      throw Object.assign(new Error('Arquivo de vídeo inválido ou menor que 1MB.'), { statusCode: 400 });
    }

    const uploaded = await uploadToGemini(filePath, driveMimeType);
    const active = await waitForGeminiActive(uploaded.name);
    console.log('Gerando relatório...');

    const metadata = { professor, turma, sala, driveUrl, driveFileId: fileId };
    const rawResponse = await analyzeWithGemini({ ...uploaded, uri: active.uri || uploaded.uri, mimeType: driveMimeType }, metadata, prompt);

    res.json({
      fileSizeMB: fileInfo.fileSizeMB,
      driveFileName: driveFile.name || null,
      driveMimeType,
      driveFileSizeMB,
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
