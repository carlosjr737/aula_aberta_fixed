# DK Aula IA — Fluxo padrão com Google Cloud Storage

## Fluxo padrão novo
1. `agent-local` grava RTSP com FFmpeg.
2. `agent-local` faz upload do MP4 para Google Cloud Storage.
3. `agent-local` gera signed URL temporária (>=2h).
4. `agent-local` chama `POST {RAILWAY_API_URL}/analyze-video-url` com `videoUrl` + metadados.
5. Backend Railway baixa o vídeo via URL, envia para Gemini e retorna análise.
6. Frontend exibe o relatório.

## Como criar bucket no Google Cloud Storage
1. Criar bucket no mesmo projeto da Service Account.
2. Dar permissão `Storage Object Admin` para a Service Account no bucket.
3. Copiar o nome do bucket para `GCS_BUCKET_NAME`.

## Variáveis no `agent-local`
Use `agent-local/.env.example` como base:
- `PORT`
- `RAILWAY_API_URL`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GCS_BUCKET_NAME`
- `RTSP_SUBWAY`
- `RTSP_BOLSO`
- `RTSP_MIRANTE`

## Variáveis no `backend` (Railway)
Use `backend/.env.example` como base:
- `PORT`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GCS_BUCKET_NAME`
- `PDF_UPLOAD_PROVIDER` (`none` ou `gcs`)

## Rodar local
```bash
cd agent-local
npm install
npm start
```

## Testar
```bash
curl http://localhost:4000/debug-env

curl -X POST http://localhost:4000/start-recording \
  -H "Content-Type: application/json" \
  -d '{"cameraId":"mirante","durationMinutes":1,"prompt":"Analise a aula inteira com foco em didática, energia e clareza."}'
```

## Endpoints
- Novo padrão: `POST /analyze-video-url`
- Legado mantido: `POST /analyze-drive`
