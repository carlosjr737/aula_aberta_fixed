# Agent Local (DK Studio)

Serviço local responsável por gravar RTSP com FFmpeg, subir o MP4 para o Google Drive e disparar a análise no Railway.

## Executar

```bash
npm install
npm start
```

## Variáveis

Copie `.env.example` para `.env` e configure os valores.

## Endpoints

- `POST /start-recording`
- `POST /stop-recording/:recordingId`
- `GET /recording-status/:recordingId`
- `GET /health`
