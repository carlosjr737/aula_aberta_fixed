# DK Aula IA — arquitetura final

## Estrutura
- `frontend/`: Vite React para Vercel
- `backend/`: Express para Railway

## Backend Railway
Root directory: `backend`

Variáveis:
```
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
PORT=3001
FRONTEND_URL=https://sua-url-vercel.vercel.app
```

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
1. Vídeo fica no Google Drive com acesso público por link.
2. Frontend envia o link para o backend.
3. Backend baixa o vídeo, envia para Gemini Files API, aguarda ACTIVE e gera relatório.
