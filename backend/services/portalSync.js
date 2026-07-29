const fs = require('fs');
const path = require('path');

// Integração com o Portal DK (Supabase): envia o PDF do relatório para o
// Storage (bucket privado dna-reports) e grava uma linha em
// teacher_dna_assessments. Usa a service role / secret key, que ignora RLS.
// Tudo é "gated": sem SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY o módulo não faz
// nada e devolve { skipped: true }, para não quebrar ambientes não configurados.

function getPortalConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const bucket = String(process.env.SUPABASE_REPORTS_BUCKET || 'dna-reports').trim();
  return { url, key, bucket, enabled: Boolean(url && key) };
}

function authHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function toTextArray(items, pick) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return pick(item);
      return null;
    })
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

// Deriva os campos da tabela a partir do JSON estruturado do PEDK.
function buildAssessmentRow({ structuredAnalysis, teacherId, classId, lessonDate, source, reportPath }) {
  const sa = structuredAnalysis || {};
  const strengths = toTextArray(sa.strengths, (s) => s.title || s.description);
  const improvements = [
    ...toTextArray(sa.attentionPoints, (p) => p.title || p.description),
    ...toTextArray(sa.evolutionPlan, (p) => p.action || p.expectedBehavior)
  ];
  const summary = String(sa.objectiveSummary || sa.finalOpinion || '').trim() || null;
  const overall = Number(sa.finalScore);

  const row = {
    teacher_id: teacherId,
    source: source || 'aula_ia',
    overall_score: Number.isFinite(overall) ? overall : 0,
    pillar_scores: Array.isArray(sa.pillarScores) ? sa.pillarScores : [],
    strengths,
    improvements,
    summary,
    raw_payload: sa,
    report_path: reportPath || null
  };
  if (classId) row.class_id = classId;
  if (lessonDate) row.lesson_date = lessonDate;
  return row;
}

async function uploadReportToStorage({ url, key, bucket }, pdfPath, objectPath) {
  const fileBuffer = fs.readFileSync(pdfPath);
  const endpoint = `${url}/storage/v1/object/${bucket}/${objectPath}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(key, { 'Content-Type': 'application/pdf', 'x-upsert': 'true', 'Cache-Control': '3600' }),
    body: fileBuffer
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Falha upload Storage (${response.status}): ${text.slice(0, 300)}`);
  }
  return objectPath;
}

async function insertAssessment({ url, key }, row) {
  const endpoint = `${url}/rest/v1/teacher_dna_assessments`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(key, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(row)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Falha insert teacher_dna_assessments (${response.status}): ${text.slice(0, 400)}`);
  }
  let inserted = null;
  try { inserted = JSON.parse(text)?.[0] || null; } catch (_) { inserted = null; }
  return inserted;
}

function sanitizeSegment(value, fallback) {
  const text = String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return text || fallback;
}

// Orquestra o envio completo ao Portal. Retorna { skipped } quando não há
// configuração ou teacherId; caso contrário { ok, assessmentId, reportPath }.
async function syncReportToPortal({ structuredAnalysis, pdfPath, teacherId, classId, lessonDate, source, recordingId }) {
  const config = getPortalConfig();
  if (!config.enabled) return { skipped: true, reason: 'supabase_not_configured' };
  if (!teacherId) return { skipped: true, reason: 'missing_teacher_id' };

  let reportPath = null;
  if (pdfPath && fs.existsSync(pdfPath)) {
    const folder = sanitizeSegment(teacherId, 'teacher');
    const baseName = path.basename(String(recordingId || 'relatorio')).replace(/\.[^.]+$/, '');
    const file = `${sanitizeSegment(baseName, 'relatorio')}_${Date.now()}.pdf`;
    const objectPath = path.posix.join(folder, file);
    reportPath = await uploadReportToStorage(config, pdfPath, objectPath);
  }

  const row = buildAssessmentRow({ structuredAnalysis, teacherId, classId, lessonDate, source, reportPath });
  const inserted = await insertAssessment(config, row);
  return { ok: true, assessmentId: inserted?.id || null, reportPath, source: row.source };
}

module.exports = { getPortalConfig, buildAssessmentRow, syncReportToPortal };
