# DK Aula IA — Arquitetura corrigida (Railway + Agent Local)

## Visão geral

A arquitetura foi separada em três partes:

- **Railway (backend em nuvem):** apenas análise Gemini + integração Drive + geração/salvamento de PDF.
- **agent-local (computador da escola):** gravação RTSP local com FFmpeg + upload do MP4 para Drive + chamada do Railway `/analyze-drive`.
- **frontend (Vercel):**
  - aba **Analisar por Drive** chama Railway (`VITE_API_URL`)
  - aba **Gravar Aula** chama agent-local (`VITE_LOCAL_AGENT_URL`)

> **Importante:** o Railway **não grava RTSP** e **não acessa IP local** da rede DK Studio.

---

## 1) Rodar backend Railway

Pasta: `backend/`

```bash
cd backend
npm install
npm start
```

Variáveis do backend (`backend/.env`):

```bash
PORT=3001
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

Endpoint principal:

- `POST /analyze-drive`
  - aceita `driveUrl` **ou** `driveFileId` (ou `fileId`)
  - gera relatório IA
  - gera PDF
  - salva PDF no Drive

---

## 2) Rodar agent-local no computador da escola

Pasta: `agent-local/`

```bash
cd agent-local
npm install
npm start
```

### Configuração `.env`

Copie `agent-local/.env.example` para `agent-local/.env` e ajuste:

```bash
PORT=4000
RAILWAY_API_URL=https://aulaabertafixed-production.up.railway.app
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
DRIVE_FOLDER_ID=
RTSP_BOLSO=rtsp://usuario:senha@192.168.1.5/stream
RTSP_MIRANTE=rtsp://usuario:senha@192.168.1.6/stream
RTSP_SUBWAY=rtsp://usuario:senha@192.168.1.7/stream
```

Mapeamento de câmera no agent-local:

- `bolso -> RTSP_BOLSO`
- `mirante -> RTSP_MIRANTE`
- `subway -> RTSP_SUBWAY`

### Endpoints do agent-local

- `POST /start-recording`
- `POST /stop-recording/:recordingId`
- `GET /recording-status/:recordingId`
- `GET /health`

### Fluxo da gravação local

1. recebe metadados (`professor`, `turma`, `nivel`, `sala`, `horario`, `prompt`, `cameraId`, `durationMinutes`)
2. grava RTSP via FFmpeg
3. envia MP4 para Drive (`DRIVE_FOLDER_ID`)
4. chama `POST {RAILWAY_API_URL}/analyze-drive` com `driveFileId` + metadados

---

## 3) Instalar FFmpeg (agent-local)

O `agent-local` depende do binário `ffmpeg` disponível no sistema.

### Ubuntu/Debian
```bash
sudo apt update && sudo apt install -y ffmpeg
```

### Windows (Chocolatey)
```bash
choco install ffmpeg
```

### macOS (Homebrew)
```bash
brew install ffmpeg
```

Teste:
```bash
ffmpeg -version
```

---

## 4) Frontend e Vercel

Pasta: `frontend/`

Variáveis:

```bash
VITE_API_URL=https://aulaabertafixed-production.up.railway.app
VITE_LOCAL_AGENT_URL=https://SEU_SUBDOMINIO.ngrok-free.app
```

### Configurar no Vercel

No projeto da Vercel:
1. **Settings → Environment Variables**
2. criar/editar `VITE_LOCAL_AGENT_URL`
3. apontar para a URL **HTTPS** do ngrok que expõe o `agent-local`
4. usar o valor **sem barra no final** (ex.: `https://abc123.ngrok-free.app`)

Se `VITE_LOCAL_AGENT_URL` não existir, a interface de gravação exibirá:

`Configure VITE_LOCAL_AGENT_URL para gravar localmente.`

---

## Segurança

- credenciais RTSP ficam **somente** no `.env` do `agent-local`
- frontend **não recebe** URLs RTSP
- não existe endpoint que exponha RTSP completo
- Railway não tenta acessar câmera local
