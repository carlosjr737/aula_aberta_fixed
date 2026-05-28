# Debug do Pipeline de Relatorio

Use estes comandos sem expor segredos do `.env`.

## Health

Agent-local:

```bash
curl http://localhost:4000/health
```

Backend local:

```bash
curl http://localhost:3000/health
```

Backend Railway:

```bash
curl https://aulaabertafixed-production.up.railway.app/health
```

A resposta do backend deve conter `routes` com `/analyze-gcs`.

## Teste de rota GCS sem payload valido

Este teste confirma que a rota existe e responde JSON controlado:

```bash
curl -X POST https://aulaabertafixed-production.up.railway.app/analyze-gcs \
  -H "Content-Type: application/json" \
  -d '{"test":true}'
```

Resposta esperada: HTTP 400 com JSON parecido com:

```json
{
  "ok": false,
  "failedStage": "request_validation",
  "message": "bucketName/fileName sao obrigatorios"
}
```

## Teste com arquivo real no GCS

```bash
curl -X POST https://aulaabertafixed-production.up.railway.app/analyze-gcs \
  -H "Content-Type: application/json" \
  -d '{
    "gcsBucket": "SEU_BUCKET",
    "gcsFileName": "videos/camera/data/arquivo.mp4",
    "professor": "Teste",
    "turma": "Teste",
    "modalidade": "Ballet",
    "nivel": "Iniciante",
    "sala": "Sala 1",
    "horario": "10:00",
    "durationMinutes": 60,
    "observacoes": "Teste de pipeline"
  }'
```

## Logs esperados no Railway

- `GET /health registered`
- `POST /analyze-gcs registered`
- `POST /analyze-drive registered`

Se `/analyze-gcs` estiver correto, o erro `Cannot POST /analyze-gcs` nao deve aparecer mais.
