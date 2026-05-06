# DK Aula IA — nova arquitetura (Railway + Agent Local)

## Estrutura
- `frontend/`: Vite React
- `backend/`: Express no Railway (somente análise por Drive + Gemini)
- `agent-local/`: Express local (rede DK) para RTSP/FFmpeg + upload Drive + disparo de análise no Railway

## Backend Railway (sem RTSP)
Responsabilidades:
- analisar vídeo do Google Drive
- chamar Gemini
- gerar relatório
- retornar/salvar resultado

Variáveis:
```bash
GEMINI_API_KEY=...
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GEMINI_MODEL=gemini-2.5-flash
PORT=3001
```

Endpoint principal:
- `POST /analyze-drive` com `driveUrl` **ou** `fileId`, além de `professor`, `turma`, `nivel`, `sala`, `horario`, `prompt`

## Agent Local (rede DK)
Responsabilidades:
- acessar RTSP local (`192.168.x.x`) via FFmpeg
- gravar MP4 local
- enviar para Google Drive via Service Account
- chamar Railway `/analyze-drive`

Variáveis:
```bash
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
DRIVE_FOLDER_ID=...
RAILWAY_API_URL=https://backend-railway.up.railway.app
RTSP_BOLSO=rtsp://...
RTSP_SUBWAY=rtsp://...
RTSP_MIRANTE=rtsp://...
PORT=4000
```

Endpoints:
- `POST /start-recording`
- `POST /stop-recording/:id`
- `GET /recording-status/:id`

## Frontend
Variáveis:
```bash
VITE_API_URL=https://backend-railway.up.railway.app
VITE_LOCAL_AGENT_URL=http://IP_DO_COMPUTADOR_DK:4000
```

Fluxo:
1. Aba **Analisar por Drive** chama Railway (`VITE_API_URL`).
2. Aba **Gravar Aula** chama Agent Local (`VITE_LOCAL_AGENT_URL`) para iniciar/parar/status.
3. Agent Local faz upload para Drive e aciona Railway com `fileId` + metadados.
