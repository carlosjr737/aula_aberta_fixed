# DK Aula IA — Fluxo com Cloudflare R2

## Novo fluxo padrão
1. `agent-local` grava RTSP com FFmpeg.
2. `agent-local` envia MP4 para Cloudflare R2.
3. `agent-local` gera signed URL temporária (>=2h).
4. `agent-local` chama `POST {RAILWAY_API_URL}/analyze-video-url` com `videoUrl` + metadados.
5. Backend Railway baixa o vídeo via URL, envia para Gemini e retorna análise.
6. Upload de PDF é opcional via `PDF_UPLOAD_PROVIDER` (`none`, `r2`, `drive`).

## Configuração Cloudflare R2
1. Criar bucket no Cloudflare R2.
2. Criar Access Key com permissão de escrita/leitura no bucket.
3. Copiar Account ID, Access Key ID e Secret Access Key.

## Variáveis no agent-local (`agent-local/.env`)
```bash
PORT=4000
RAILWAY_API_URL=https://seu-backend.railway.app
RTSP_BOLSO=rtsp://...
RTSP_MIRANTE=rtsp://...
RTSP_SUBWAY=rtsp://...
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_BASE_URL=
# opcionais (legado)
GOOGLE_SERVICE_ACCOUNT_JSON=
DRIVE_FOLDER_ID=
```

## Variáveis no Railway (backend)
```bash
PORT=3001
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
PDF_UPLOAD_PROVIDER=none
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_BASE_URL=
# somente se manter endpoint legado /analyze-drive
GOOGLE_SERVICE_ACCOUNT_JSON=
```

## Rodar local
```bash
cd agent-local
npm install
npm start
```

## Testes rápidos
```bash
curl http://localhost:4000/debug-env
curl -X POST http://localhost:4000/start-recording -H "Content-Type: application/json" -d '{"cameraId":"mirante","durationMinutes":1}'
```

## Endpoints
- Novo padrão: `POST /analyze-video-url`
- Legado mantido: `POST /analyze-drive`
