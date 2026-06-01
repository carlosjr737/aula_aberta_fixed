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
