# DK Aula IA — arquitetura final

## Estrutura
- `frontend/`: Vite React para Vercel
- `backend/`: Express para Railway

## Backend Railway
Root directory: `backend`

Variáveis:
```
GEMINI_API_KEY=...
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GEMINI_MODEL=gemini-2.5-flash
PORT=3001
FRONTEND_URL=https://sua-url-vercel.vercel.app
```

### Configuração Google Drive API (Service Account)
1. No Google Cloud Console, crie uma **Service Account** no projeto.
2. Ative a **Google Drive API** para esse projeto.
3. Gere a chave JSON da Service Account.
4. Compartilhe no Google Drive (arquivo ou pasta dos vídeos) com o e-mail da Service Account (ex: `nome@projeto.iam.gserviceaccount.com`) com permissão de leitura.
5. No Railway, configure `GOOGLE_SERVICE_ACCOUNT_JSON` com o JSON completo em uma única variável de ambiente.
6. No Railway, configure `GEMINI_API_KEY`.

Teste:
```
https://SEU_BACKEND/health
```

## Frontend Vercel
Root directory: `frontend`

Variáveis:
```
VITE_API_URL=https://SEU_BACKEND.up.railway.app
```

## Fluxo
1. Frontend envia `driveUrl` para o backend.
2. Backend extrai o `fileId` e baixa o vídeo via Google Drive API autenticada (`files.get` com `alt=media`).
3. Backend valida arquivo, envia para Gemini Files API, aguarda `ACTIVE` e gera relatório.
