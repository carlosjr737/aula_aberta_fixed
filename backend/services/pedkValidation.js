function validateStructuredPedkAnalysis(structuredAnalysis, pillars) {
  if (!structuredAnalysis || typeof structuredAnalysis !== 'object') {
    throw new Error('structuredAnalysis inválido ou vazio');
  }

  if (structuredAnalysis.schemaVersion !== 'pedk_dna_v1') {
    throw new Error(`schemaVersion inválido: ${structuredAnalysis.schemaVersion}`);
  }

  if (!Array.isArray(pillars) || pillars.length !== 12) {
    throw new Error(`pillars precisa ter 12 itens, recebeu ${Array.isArray(pillars) ? pillars.length : 'inválido'}`);
  }

  if (!Array.isArray(structuredAnalysis.pillarScores)) {
    throw new Error('pillarScores precisa ser um array');
  }

  if (structuredAnalysis.pillarScores.length !== pillars.length) {
    throw new Error(`pillarScores precisa ter ${pillars.length} pilares, recebeu ${structuredAnalysis.pillarScores.length}`);
  }

  const expectedByCode = new Map(pillars.map((pillar) => [pillar.code, pillar]));
  const receivedCodes = new Set();

  for (const item of structuredAnalysis.pillarScores) {
    const expected = expectedByCode.get(item.code);

    if (!expected) {
      throw new Error(`Pilar inesperado no JSON estruturado: ${item.code}`);
    }

    if (receivedCodes.has(item.code)) {
      throw new Error(`Pilar duplicado no JSON estruturado: ${item.code}`);
    }

    receivedCodes.add(item.code);

    if (Number(item.order) !== expected.order) {
      throw new Error(`Ordem inválida para ${item.code}: esperado ${expected.order}, recebido ${item.order}`);
    }

    if (Number(item.weight) !== expected.weight) {
      throw new Error(`Peso inválido para ${item.code}: esperado ${expected.weight}, recebido ${item.weight}`);
    }

    const score = Number(item.score);

    if (!Number.isFinite(score) || score < 1 || score > 5) {
      throw new Error(`Nota inválida para ${item.code}: ${item.score}`);
    }

    const expectedWeighted = Number((score * expected.weight).toFixed(2));
    const receivedWeighted = Number(item.weightedScore);

    if (!Number.isFinite(receivedWeighted) || Math.abs(receivedWeighted - expectedWeighted) > 0.05) {
      throw new Error(`weightedScore inválido para ${item.code}: esperado ${expectedWeighted}, recebido ${item.weightedScore}`);
    }

    item.weightedScore = expectedWeighted;
  }

  for (const expected of pillars) {
    if (!receivedCodes.has(expected.code)) {
      throw new Error(`Pilar obrigatório ausente: ${expected.code}`);
    }
  }

  const totalWeight = pillars.reduce((sum, pillar) => sum + Number(pillar.weight || 0), 0);

  if (totalWeight !== 100) {
    throw new Error(`Soma dos pesos inválida: ${totalWeight}`);
  }

  const weightedSum = structuredAnalysis.pillarScores.reduce((sum, item) => sum + Number(item.weightedScore || 0), 0);
  const expectedFinalScore = Number((weightedSum / 100).toFixed(2));
  const receivedFinalScore = Number(structuredAnalysis.finalScore);

  if (!Number.isFinite(receivedFinalScore) || Math.abs(receivedFinalScore - expectedFinalScore) > 0.05) {
    throw new Error(`finalScore inválido: esperado ${expectedFinalScore}, recebido ${structuredAnalysis.finalScore}`);
  }

  if (!structuredAnalysis.classification) {
    throw new Error('classification é obrigatório');
  }

  if (!Array.isArray(structuredAnalysis.strengths)) {
    structuredAnalysis.strengths = [];
  }

  if (!Array.isArray(structuredAnalysis.attentionPoints)) {
    structuredAnalysis.attentionPoints = [];
  }

  if (!Array.isArray(structuredAnalysis.evolutionPlan)) {
    structuredAnalysis.evolutionPlan = [];
  }

  return {
    ok: true,
    weightedSum: Number(weightedSum.toFixed(2)),
    finalScore: expectedFinalScore
  };
}

module.exports = {
  validateStructuredPedkAnalysis
};
