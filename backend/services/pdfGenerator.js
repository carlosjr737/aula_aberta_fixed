const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');

async function generateLessonPdf(payload) {
  const outPath = path.join(os.tmpdir(), `relatorio_${payload.recordingId}.pdf`);
  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  doc.fontSize(20).text('DK IA - Relatório de Aula', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12);
  doc.text(`Professor: ${payload.professor}`);
  doc.text(`Turma: ${payload.turma}`);
  doc.text(`Nível: ${payload.nivel}`);
  doc.text(`Sala: ${payload.sala}`);
  doc.text(`Início: ${payload.startedAt}`);
  doc.text(`Fim: ${payload.endedAt}`);
  doc.text(`Duração: ${payload.durationMinutes} min`);
  doc.moveDown();
  doc.text(`Prompt usado: ${payload.prompt}`);
  doc.moveDown();
  doc.fontSize(14).text('Relatório IA', { underline: true });
  doc.fontSize(11).text(payload.analysis || 'Sem análise.');

  doc.end();
  await new Promise((resolve) => stream.on('finish', resolve));
  return outPath;
}

module.exports = { generateLessonPdf };
