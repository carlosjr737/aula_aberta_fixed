# SouAle — Agendador local de gravações de aula

**Data:** 2026-08-10
**Componente:** `agent-local` (Node/Express, roda na LAN da escola)
**Status:** design aprovado

## Objetivo

Substituir o disparo de gravações via `curl` por uma **interface local** que permite
**agendar gravações pontuais** (uma vez, em data/hora escolhida) e "gravar agora",
escolhendo sala/câmera e professor por dropdown — sem colar UUID.

Decisões de produto (tomadas na fase de design):
- **Agendamento pontual** (sem recorrência semanal por ora).
- **UI local** servida pelo próprio agent-local (`http://localhost:4000/`), sem nuvem — funciona offline.
- **Listas locais sincronizadas** (professores/câmeras em arquivos locais).
- Marca **SouAle** (a assistente da escola).

## Arquitetura

O `agent-local` (Express) passa a:
1. Servir uma **UI estática** (HTML+JS puro, sem build) em `GET /`.
2. Expor endpoints REST novos:
   - `GET /refs` → `{ cameras: [{id, sala}], professores: [{name, teacherId}] }` (lidos de arquivos locais).
   - `POST /schedule` → cria agendamento pontual. Body: `{ cameraId, sala, professor, teacherId, turma?, date (YYYY-MM-DD), time (HH:mm), durationMinutes, observacoes }`.
   - `GET /schedule` → lista agendamentos com status.
   - `DELETE /schedule/:id` → cancela um agendamento **pendente**.
   - **"Gravar agora"** não usa o scheduler: o form chama direto o `POST /start-recording` já existente (gravação imediata).
3. Rodar um **scheduler interno**: a cada ~30s varre `scheduled-jobs.json`; para cada job cuja
   `date+time` chegou (dentro da tolerância), dispara a gravação **reusando o fluxo `start-recording` existente**.

Reuso: a captura (FFmpeg RTSP → MP4 → GCS), a chamada ao Railway `/analyze-gcs` (com `teacherId`),
análise Gemini v2, PDF e escrita no Portal **já existem e não mudam**. Este trabalho só adiciona a
camada de UI + agendamento na frente do `start-recording`.

## Dados & arquivos locais

- `config/cameras.json` — `[{ id, sala }]`. Ex.: `aquario/Aquário` (ch9), `mirante/Mirante` (ch4),
  `subway/Subway` (ch7), `bolso/<sala a definir>` (ch11), `pequena/<câmera a definir>`.
  **Aberto:** qual sala a câmera `bolso` cobre e se a sala **Pequena** tem câmera — preenchido pelo usuário.
- `config/professores.json` — `[{ name, teacherId }]` com os 14 professores ativos (gerado uma vez a partir do Supabase; atualizado manualmente quando mudar o quadro).
- `scheduled-jobs.json` — fila persistente de agendamentos (sobrevive a reinício do agent-local).
- Turma: **texto livre** (o `classId` é opcional; evoluível para dropdown depois).

## Tela (UI)

Identidade **SouAle**: fundo `#F7F7FB`, acentos Cobalto `#5B5CE2` / Índigo `#25265B`, fonte Inter,
logo `souale-logo-principal.svg` no topo, favicon do pacote.

- **Form "Agendar gravação":** Sala/Câmera (dropdown; label = sala, valor = cameraId), Professor
  (dropdown nome→teacherId), Turma (texto, opcional), Data, Hora, Duração (min), Observações (textarea).
  Botões **"Agendar"** e **"Gravar agora"**.
- **Lista "Agendamentos":** por item — sala, professor, data/hora, duração e **status colorido**
  (Agendada → Gravando → Enviando → Analisando → Concluída/Falhou). Botão **Cancelar** (só pendente)
  e **link do PDF** ao concluir. Atualização por polling (~5s) usando os endpoints de status já existentes.

## Fluxo de dados

`Form → POST /schedule → scheduled-jobs.json → scheduler (no horário) → start-recording (RTSP→GCS)
→ Railway /analyze-gcs (teacherId) → Gemini v2 → PDF → Portal (DNA do Professor)`.
A UI acompanha o `recording-status` até "Concluída" e exibe o link do relatório.

## Erros & casos de borda

- Câmera offline / RTSP falha → status "Falhou" com motivo (tratamento já existente).
- Data/hora inválida ou no passado além da tolerância → recusa no `POST /schedule` (validação rígida
  `YYYY-MM-DD` / `HH:mm`, como o hotfix 2026-06-01).
- Duas gravações na mesma câmera ao mesmo tempo → **fila por câmera** (mecanismo já existe).
- Reinício do agent-local → recarrega `scheduled-jobs.json` e mantém pendentes; jobs muito antigos são
  marcados "perdida" em vez de dispararem atrasados.
- Sem internet no horário → a gravação local ocorre; o upload/análise tenta e, se falhar, marca para reprocessar.

## Fora do escopo (YAGNI)

Sem recorrência semanal · sem login/auth na UI (é localhost na máquina da escola) · sem edição de
professores/turmas pela UI · sem multiusuário · sem dropdown de turmas (texto livre por ora).

## Itens abertos (não bloqueiam a implementação)

1. Mapa `bolso → sala` e se **Pequena** tem câmera (preencher `config/cameras.json`).
2. Evolução futura: turma como dropdown (com `classId`) e modo recorrente semanal (usando `class_schedules` do Portal).
