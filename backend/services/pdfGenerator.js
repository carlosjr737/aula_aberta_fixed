const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');

function safePathPart(value, fallback = 'relatorio') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function buildReportPath(payload) {
  const sourceFile = String(payload.sourceFileName || payload.recordingId || 'relatorio').replace(/\\/g, '/');
  const objectDir = path.dirname(sourceFile).replace(/^recordings[\\/]/, '');
  const safeDir = objectDir && objectDir !== '.'
    ? objectDir.split(/[\\/]+/).filter(Boolean).map((part) => safePathPart(part, 'item')).join(path.sep)
    : safePathPart(payload.recordingId, 'local');
  const baseName = safePathPart(path.basename(sourceFile, path.extname(sourceFile)), 'relatorio');
  return path.join(os.tmpdir(), 'relatorio_recordings', safeDir, `${baseName}.pdf`);
}

function normalizeText(value, fallback = 'Não informado') {
  const text = String(value || '').trim();
  return text || fallback;
}

function addSectionTitle(doc, title) {
  doc.moveDown(0.8);
  doc.fontSize(13).fillColor('#111111').text(title, { underline: true });
  doc.moveDown(0.4);
  doc.fontSize(10.5).fillColor('#111111');
}

function addLabelValue(doc, label, value) {
  doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
  doc.font('Helvetica').text(normalizeText(value));
}

function addBullet(doc, text) {
  doc.text(`- ${normalizeText(text, '')}`);
}

function addWrappedList(doc, items, fallback = 'Nenhum item informado.') {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    doc.text(fallback);
    return;
  }
  list.forEach((item) => {
    if (typeof item === 'string') {
      addBullet(doc, item);
      return;
    }
    if (item && typeof item === 'object') {
      const description = item.description || item.text || item.title || JSON.stringify(item);
      const prefix = item.start || item.end ? `[${normalizeText(item.start, '')}${item.end ? ` - ${normalizeText(item.end, '')}` : ''}] ` : '';
      doc.text(`- ${prefix}${normalizeText(description, '')}`);
      return;
    }
    addBullet(doc, String(item));
  });
}

function addKeyValueBlock(doc, pairs) {
  pairs.forEach(([label, value]) => addLabelValue(doc, label, value));
}

function renderStructuredAnalysis(doc, payload, structured) {
  const classInfo = structured.class || {};
  const teacherInfo = structured.teacher || {};

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#111111').text('PEDK  Projeto de Excelência DK', { align: 'center' });
  doc.fontSize(15).text('Relatório de Análise de Aula', { align: 'center' });
  doc.fontSize(11).font('Helvetica').text('DNA Professor DK  Versão 1.0', { align: 'center' });
  doc.moveDown(1);

  addSectionTitle(doc, '1. Identificação da aula');
  addKeyValueBlock(doc, [
    ['Professor', teacherInfo.name || payload.professor],
    ['Modalidade', classInfo.modality || payload.classContext?.modalidade || payload.classContext?.tipoAula],
    ['Turma', classInfo.name || payload.turma],
    ['Faixa etária', payload.classContext?.faixaEtaria || payload.classContext?.faixaEtaria || payload.faixaEtaria],
    ['Nível', classInfo.level || payload.nivel],
    ['Tipo de aula', payload.classContext?.tipoAula || payload.classContext?.modality || payload.classContext?.modalidade],
    ['Sala', classInfo.room || payload.sala],
    ['Câmera', classInfo.cameraId || payload.classContext?.cameraId || payload.cameraId],
    ['Data', classInfo.date || payload.startedAt],
    ['Horário agendado', classInfo.scheduledTime || payload.classContext?.horarioAgendado || payload.startedAt],
    ['Duração', `${normalizeText(classInfo.durationMinutes || payload.durationMinutes, '')} min`],
    ['Observações/contexto', payload.prompt || payload.classContext?.observacoes || 'Não informado']
  ]);

  addSectionTitle(doc, '2. Limitações da análise');
  addWrappedList(doc, structured.limitations, 'Nenhuma limitação registrada.');

  addSectionTitle(doc, '3. Síntese objetiva');
  doc.text(normalizeText(structured.objectiveSummary, 'Sem síntese objetiva disponível.'));

  addSectionTitle(doc, '4. Evidências observáveis por momento da aula');
  addWrappedList(doc, structured.timelineEvidence, 'Sem evidências temporais registradas.');

  addSectionTitle(doc, `5. Avaliação pelos ${structured.pillarScores.length} pilares oficiais do PEDK`);
  structured.pillarScores.forEach((pillar) => {
    doc.font('Helvetica-Bold').text(`${pillar.order}. ${pillar.code} - ${pillar.name} (peso ${pillar.weight})`);
    doc.font('Helvetica').text(`Nota: ${pillar.score} | Ponderado: ${pillar.weightedScore}`);
    doc.text(`Justificativa: ${normalizeText(pillar.justification, 'Sem justificativa.')}`);
    doc.text(`Evidências: ${Array.isArray(pillar.evidence) && pillar.evidence.length ? pillar.evidence.join(' | ') : 'Sem evidências listadas.'}`);
    doc.text(`Impacto na turma: ${normalizeText(pillar.impact, 'Não informado.')}`);
    doc.text(`Ação de melhoria: ${normalizeText(pillar.improvementAction, 'Não informada.')}`);
    doc.moveDown(0.4);
  });

  addSectionTitle(doc, '6. Tabela ponderada');
  doc.text('Ordem | Pilar | Peso | Nota | Pontuação ponderada');
  structured.pillarScores.forEach((pillar) => {
    doc.text(`${pillar.order} | ${pillar.name} | ${pillar.weight} | ${pillar.score} | ${pillar.weightedScore}`);
  });
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').text(`Nota final: ${structured.finalScore}`);
  doc.font('Helvetica-Bold').text(`Classificação final: ${structured.classification}`);

  addSectionTitle(doc, '7. Classificação final');
  doc.text(`Resultado consolidado: ${structured.classification}`);

  addSectionTitle(doc, '8. Forças principais');
  addWrappedList(doc, structured.strengths, 'Sem forças destacadas.');

  addSectionTitle(doc, '9. Pontos de atenção');
  addWrappedList(doc, structured.attentionPoints, 'Sem pontos de atenção destacados.');

  addSectionTitle(doc, '10. Plano de evolução');
  addWrappedList(doc, structured.evolutionPlan, 'Sem plano de evolução informado.');

  addSectionTitle(doc, '11. Parecer final');
  doc.text(normalizeText(structured.finalOpinion, 'Sem parecer final disponível.'));
}

function renderFallbackReport(doc, payload) {
  doc.fontSize(20).text('DK IA - Relatorio de Aula', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12);
  doc.text(`Professor: ${payload.professor}`);
  doc.text(`Turma: ${payload.turma}`);
  doc.text(`Nivel: ${payload.nivel}`);
  doc.text(`Sala: ${payload.sala}`);
  doc.text(`Inicio: ${payload.startedAt}`);
  doc.text(`Fim: ${payload.endedAt}`);
  doc.text(`Duracao: ${payload.durationMinutes} min`);
  doc.moveDown();
  doc.text(`Prompt usado: ${payload.prompt}`);
  doc.moveDown();
  doc.fontSize(14).text('Relatorio IA', { underline: true });
  doc.fontSize(11).text(payload.analysis || 'Sem analise.');
}

async function generateLessonPdf(payload) {
  const outPath = buildReportPath(payload);
  const reportDir = path.dirname(outPath);
  const logId = payload.sourceFileName || payload.recordingId || 'unknown';

  try {
    await fs.promises.mkdir(reportDir, { recursive: true });
    console.log(`[analysis:${logId}] report_path=${outPath}`);
    console.log(`[analysis:${logId}] report_dir_created=${reportDir}`);

    const doc = new PDFDocument({ margin: 50 });
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(outPath);

      stream.on('finish', resolve);
      stream.on('error', reject);
      doc.on('error', reject);
      doc.pipe(stream);

      if (payload.structuredAnalysis) {
        renderStructuredAnalysis(doc, payload, payload.structuredAnalysis);
      } else {
        renderFallbackReport(doc, payload);
      }

      doc.end();
    });

    console.log(`[analysis:${logId}] report_generation_success`);
    return outPath;
  } catch (error) {
    error.reportPath = outPath;
    error.reportDir = reportDir;
    throw error;
  }
}

module.exports = { generateLessonPdf };
