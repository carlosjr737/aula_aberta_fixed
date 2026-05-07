# Agent Local (DK Studio)

Serviço local responsável por gravar RTSP com FFmpeg, subir o MP4 para o Google Drive e disparar a análise no Railway.

## Executar

```bash
npm install
npm start
```

## Variáveis

Copie `.env.example` para `.env` e configure os valores.

```bash
PORT=4000
RAILWAY_API_URL=
DRIVE_FOLDER_ID=
RTSP_BOLSO=
RTSP_MIRANTE=
RTSP_SUBWAY=

# OAuth (prioritário)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4000/oauth2callback
GOOGLE_OAUTH_TOKEN_JSON=

# Fallback legado (service account)
GOOGLE_SERVICE_ACCOUNT_JSON=
```

## Fluxo OAuth local

1. Suba o serviço: `npm start`
2. Abra no navegador: `http://localhost:4000/auth/google`
3. Autorize com a conta Google.
4. O endpoint `/oauth2callback` exibirá `GOOGLE_OAUTH_TOKEN_JSON` pronto para copiar.
5. Cole no `.env` e reinicie o serviço.

> O token **não é salvo automaticamente** em arquivo.

## Endpoints

- `GET /auth/google`
- `GET /oauth2callback`
- `POST /start-recording`
- `POST /stop-recording/:recordingId`
- `GET /recording-status/:recordingId`
- `GET /debug-env`
- `GET /health`
