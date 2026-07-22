const PEDK_DNA_MATRIX_VERSION = 'pedk_dna_v2';

const PEDK_DNA_PILLARS = [
  {
    order: 1,
    code: 'presenca_autoridade',
    name: 'Presença e autoridade',
    fullName: 'Presença docente e autoridade pelo exemplo',
    weight: 8,
    question: 'O professor conduz pelo exemplo?',
    definition: 'Professor ocupa sala com exemplo e comando.',
    grade1: 'Professor ausente ou dependente de bronca.',
    grade3: 'Conduz com clareza básica.',
    grade5: 'Referência visível de foco e energia.'
  },
  {
    order: 2,
    code: 'demonstracao_qualificada',
    name: 'Demonstração qualificada',
    fullName: 'Clareza corporal e demonstração qualificada',
    weight: 8,
    question: 'O corpo do professor ensina forma, ritmo e intenção?',
    definition: 'Mostra corpo, ritmo, direção, intenção e acabamento.',
    grade1: 'Demonstra pouco ou de forma confusa.',
    grade3: 'Demonstra caminho adequado.',
    grade5: 'Demonstra como régua artística.'
  },
  {
    order: 3,
    code: 'organizacao_espacial',
    name: 'Organização espacial',
    fullName: 'Organização espacial e desenho de sala',
    weight: 8,
    question: 'A sala está organizada e produtiva?',
    definition: 'Desenha sala, grupos, linhas, entradas e esperas.',
    grade1: 'Turma perdida.',
    grade3: 'Espaço funcional.',
    grade5: 'Sala opera como ensaio.'
  },
  {
    order: 4,
    code: 'progressao_fluxo',
    name: 'Progressão e fluxo',
    fullName: 'Progressão pedagógica e ritmo de aula',
    weight: 8,
    question: 'A aula progride sem pausas vazias?',
    definition: 'Aula em blocos com transições claras.',
    grade1: 'Aula travada ou caótica.',
    grade3: 'Fluxo básico.',
    grade5: 'Alto tempo útil e progressão visível.'
  },
  {
    order: 5,
    code: 'correcao_impacto',
    name: 'Correção com impacto',
    fullName: 'Correção com impacto',
    weight: 8,
    question: 'As correções geram melhora visível?',
    definition: 'Intervenção gera melhora na tentativa seguinte.',
    grade1: 'Não corrige ou corrige de modo vago.',
    grade3: 'Corrige pontos principais.',
    grade5: 'Correções precisas e transformadoras.'
  },
  {
    order: 6,
    code: 'repeticao_produtiva',
    name: 'Repetição produtiva',
    fullName: 'Repetição produtiva e refinamento',
    weight: 8,
    question: 'Cada repetição tem objetivo claro?',
    definition: 'Repetir para limpar, musicalizar e refinar.',
    grade1: 'Repetição automática.',
    grade3: 'Repetições ajudam memorização.',
    grade5: 'Cada rodada tem ganho claro.'
  },
  {
    order: 7,
    code: 'musicalidade',
    name: 'Musicalidade',
    fullName: 'Musicalidade e intenção artística',
    weight: 8,
    question: 'A música vira corpo, não só contagem?',
    definition: 'Música como corpo, acento, pausa e intenção.',
    grade1: 'Só contagem ou fundo.',
    grade3: 'Tempo e intenção básicos.',
    grade5: 'Aluno dança musicalmente.'
  },
  {
    order: 8,
    code: 'performance_palco',
    name: 'Performance e palco',
    fullName: 'Cultura de performance e palco',
    weight: 8,
    question: 'A aula treina presença e palco?',
    definition: 'Aula regular treina comportamento cênico.',
    grade1: 'Só passos.',
    grade3: 'Momentos de apresentação.',
    grade5: 'Cultura de palco integrada.'
  },
  {
    order: 9,
    code: 'seguranca_emocional',
    name: 'Segurança emocional',
    fullName: 'Autoridade positiva, vínculo e segurança emocional',
    weight: 8,
    question: 'A cobrança acontece com respeito?',
    definition: 'Cobrança com respeito, vínculo e firmeza.',
    grade1: 'Tensão ou permissividade.',
    grade3: 'Ambiente seguro básico.',
    grade5: 'Alta exigência com confiança.'
  },
  {
    order: 10,
    code: 'adaptacao_contexto',
    name: 'Adaptação ao contexto',
    fullName: 'Adaptação por idade, nível e objetivo da turma',
    weight: 8,
    question: 'A estratégia combina com idade e nível?',
    definition: 'Ajusta linguagem por idade, nível e objetivo.',
    grade1: 'Modelo único para todos.',
    grade3: 'Adapta o suficiente.',
    grade5: 'DNA mantido com método ajustado.'
  },
  {
    order: 11,
    code: 'observacao_elenco',
    name: 'Observação e elenco',
    fullName: 'Observação ativa, autonomia e cultura de elenco',
    weight: 8,
    question: 'Quem observa aprende e fica pronto para entrar?',
    definition: 'Observadores aprendem; turma assume autonomia.',
    grade1: 'Espera passiva.',
    grade3: 'Alternância funcional.',
    grade5: 'Cultura de elenco ativa.'
  },
  {
    order: 12,
    code: 'diagnostico_individualizacao',
    name: 'Diagnóstico e individualização',
    fullName: 'Diagnóstico pedagógico e individualização',
    weight: 8,
    question: 'Há leitura coletiva e individual da turma?',
    definition: 'Lê coletivo e indivíduo com evidências.',
    grade1: 'Sem leitura visível.',
    grade3: 'Identifica padrões principais.',
    grade5: 'Diagnóstico fino e específico.'
  },
  {
    order: 13,
    code: 'engajamento_divertido',
    name: 'Engajamento e diversão',
    fullName: 'Energia, leveza e engajamento divertido',
    weight: 8,
    question: 'A aula tem leveza e os alunos demonstram prazer em dançar?',
    definition: 'Conduz com energia e leveza; alunos sorriem, riem e demonstram felicidade genuína ao longo da aula.',
    grade1: 'Clima pesado ou apático; alunos sem prazer aparente.',
    grade3: 'Ambiente agradável, com momentos de leveza.',
    grade5: 'Alegria contagiante: alunos sorrindo e gargalhando enquanto dançam com entrega.'
  }
];


const PEDK_DNA_WEIGHT_SUM = PEDK_DNA_PILLARS.reduce((sum, pillar) => sum + pillar.weight, 0);

function buildPedkMatrixPromptBlock() {
  return PEDK_DNA_PILLARS.map((pillar) => [
    `${pillar.order}. ${pillar.code}`,
    `Nome: ${pillar.name}`,
    `Peso: ${pillar.weight}`,
    `Pergunta resumida: ${pillar.question}`,
    `Definição: ${pillar.definition}`,
    `Nível 1: ${pillar.grade1}`,
    `Nível 3: ${pillar.grade3}`,
    `Nível 5: ${pillar.grade5}`
  ].join('\n')).join('\n\n');
}

const PEDK_DNA_PROMPT = [
  'PEDK - Projeto de Excelência DK',
  `DNA Professor DK - Versão 1.0 (${PEDK_DNA_MATRIX_VERSION})`,
  '',
  'Use somente os 13 pilares oficiais abaixo, nesta ordem, com estes pesos. Não crie, renomeie ou substitua pilares.',
  '',
  buildPedkMatrixPromptBlock(),
  '',
  'Regras de avaliação:',
  '- A nota de cada pilar deve ser de 1 a 5.',
  '- Nota 3 significa adequado e funcional.',
  '- Nota 5 é rara e reservada para comportamento que poderia servir como referência de formação interna.',
  '- Toda nota precisa ter evidência observável.',
  '- Separe comportamento observável de interpretação pedagógica.',
  '- Quando câmera ou áudio limitarem a análise, registre a limitação antes de concluir.',
  '- Não transforme limitação técnica em falha do professor sem evidência.',
  '- Não copiar estilo de Ruan, Gladson ou Marcella. A matriz padroniza qualidade, não personalidade.',
  '',
  'Estrutura obrigatória do relatório:',
  '1. Identificação da aula',
  '2. Limitações da análise',
  '3. Síntese objetiva',
  '4. Evidências observáveis por momento da aula',
  '5. Avaliação pelos 13 pilares oficiais do PEDK',
  '6. Tabela ponderada',
  '7. Classificação final',
  '8. Forças principais',
  '9. Pontos de atenção',
  '10. Plano de evolução',
  '11. Parecer final',
  '',
  'A pontuação ponderada deve seguir: weightedScore = score * weight.',
  'A nota final deve seguir: finalScore = soma(weightedScore) / soma(weights). Nesta versao a soma dos pesos e 104.',
  'Use apenas os 13 pilares oficiais do PEDK como matriz principal da avaliação.'
].join('\n');

function buildAnalysisPrompt({ classContext, userNotes = '' } = {}) {
  const notes = String(userNotes || '').trim() || 'Observar principalmente autonomia, refinamento e responsabilidade de elenco.';
  return [
    PEDK_DNA_PROMPT.trim(),
    '',
    'CONTEXTO DA AULA:',
    `- Professor: ${classContext?.professor || 'Não informado'}`,
    `- Modalidade: ${classContext?.modalidade || 'Não informado'}`,
    `- Turma: ${classContext?.turma || 'Não informado'}`,
    `- Faixa etária: ${classContext?.faixaEtaria || 'Não informado'}`,
    `- Nível: ${classContext?.nivel || 'Não informado'}`,
    `- Tipo de aula: ${classContext?.tipoAula || 'Não informado'}`,
    `- Sala: ${classContext?.sala || 'Não informado'}`,
    `- Câmera: ${classContext?.cameraId || 'Não informado'}`,
    `- Data: ${classContext?.data || 'Não informado'}`,
    `- Horário agendado: ${classContext?.horarioAgendado || 'Não informado'}`,
    `- Duração (min): ${classContext?.durationMinutes || 'Não informado'}`,
    '',
    'OBSERVAÇÕES ESPECÍFICAS:',
    notes,
    '',
    'ORDEM FINAL: responder obrigatoriamente no modelo completo de relatório com os 13 pilares oficiais do PEDK e a estrutura obrigatória definida no DNA.'
  ].join('\n');
}

function buildStructuredAnalysisPrompt({
  rawAnalysisText = '',
  metadata = {},
  pillars = PEDK_DNA_PILLARS,
  classContext = {},
  userNotes = ''
} = {}) {
  const normalizedPillars = Array.isArray(pillars) && pillars.length ? pillars : PEDK_DNA_PILLARS;
  const normalizedMetadata = metadata || {};
  const normalizedClassContext = classContext || normalizedMetadata.classContext || {};
  const notes = String(userNotes || normalizedMetadata.userNotes || '').trim();

  return [
    'Você deve converter a análise abaixo em JSON estruturado e válido.',
    'Retorne APENAS JSON, sem markdown, sem explicações e sem blocos de código.',
    `schemaVersion: "${PEDK_DNA_MATRIX_VERSION}"`,
    'analysisType: "class_video"',
    '',
    'MATRIZ OFICIAL DO PEDK:',
    JSON.stringify(normalizedPillars.map((pillar) => ({
      order: pillar.order,
      code: pillar.code,
      name: pillar.name,
      weight: pillar.weight,
      question: pillar.question,
      definition: pillar.definition,
      grade1: pillar.grade1,
      grade3: pillar.grade3,
      grade5: pillar.grade5
    })), null, 2),
    '',
    'REGRAS OBRIGATÓRIAS:',
    '- Use exatamente 13 pillarScores.',
    '- Os códigos e pesos devem bater com a matriz oficial.',
    '- score deve ficar entre 1 e 5.',
    '- 3 = adequado/funcional.',
    '- 5 deve ser raro e reservado para referência interna.',
    '- weightedScore = score * weight.',
    '- finalScore = soma(weightedScore) / soma(weights) (nesta versao = 104).',
    '- Toda nota precisa ter evidência observável.',
    '- Separe comportamento observável de interpretação pedagógica.',
    '- Se houver limitação de câmera ou áudio, registre em limitations.',
    '- Não use a matriz antiga como pilares principais.',
    '- Não copie estilo de Ruan, Gladson ou Marcella.',
    '',
    'ESTRUTURA JSON ESPERADA:',
    JSON.stringify({
      schemaVersion: PEDK_DNA_MATRIX_VERSION,
      analysisType: 'class_video',
      teacher: { name: normalizedClassContext.professor || normalizedMetadata.professor || '' },
      class: {
        name: normalizedClassContext.turma || normalizedMetadata.turma || '',
        level: normalizedClassContext.nivel || normalizedMetadata.nivel || '',
        modality: normalizedClassContext.modalidade || normalizedMetadata.modalidade || '',
        room: normalizedClassContext.sala || normalizedMetadata.sala || '',
        cameraId: normalizedClassContext.cameraId || normalizedMetadata.cameraId || '',
        date: normalizedClassContext.data || normalizedMetadata.data || '',
        scheduledTime: normalizedClassContext.horarioAgendado || normalizedMetadata.horarioAgendado || '',
        durationMinutes: Number(normalizedClassContext.durationMinutes || normalizedMetadata.durationMinutes) || null
      },
      limitations: [{ type: 'audio', description: '...' }],
      objectiveSummary: '...',
      timelineEvidence: [{ start: '00:00', end: '00:30', description: '...', relatedPillars: ['presenca_autoridade'] }],
      pillarScores: [{
        order: 1,
        code: 'presenca_autoridade',
        name: 'Presença e autoridade',
        weight: 8,
        score: 3,
        weightedScore: 24,
        justification: '...',
        evidence: ['...'],
        impact: '...',
        improvementAction: '...'
      }],
      finalScore: 3.56,
      classification: 'Forte',
      strengths: [{ title: '...', description: '...', relatedPillars: ['demonstracao_qualificada'] }],
      attentionPoints: [{ title: '...', description: '...', observableBehavior: '...', impact: '...', relatedPillars: ['progressao_fluxo'] }],
      evolutionPlan: [{ priority: 'alta', action: '...', expectedBehavior: '...', improvementIndicator: '...', timeframe: '2 a 4 semanas', relatedPillars: ['correcao_impacto'] }],
      finalOpinion: '...'
    }, null, 2),
    '',
    'DADOS DE APOIO PARA INFERÊNCIA:',
    `METADATA: ${JSON.stringify(normalizedMetadata)}`,
    `CONTEXT: ${JSON.stringify(normalizedClassContext)}`,
    `OBSERVAÇÕES DO USUÁRIO: ${notes || 'Nenhuma'}`,
    `ANÁLISE TEXTUAL PRELIMINAR: ${rawAnalysisText}`,
    '',
    'Retorne somente o JSON final coerente com a matriz oficial.'
  ].join('\n');
}

module.exports = {
  PEDK_DNA_MATRIX_VERSION,
  PEDK_DNA_PILLARS,
  PEDK_DNA_WEIGHT_SUM,
  PEDK_DNA_PROMPT,
  buildPedkMatrixPromptBlock,
  buildAnalysisPrompt,
  buildStructuredAnalysisPrompt
};