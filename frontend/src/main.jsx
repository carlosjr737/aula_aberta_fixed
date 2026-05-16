import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const LOCAL_AGENT_URL = (import.meta.env.VITE_LOCAL_AGENT_URL || '').replace(/\/$/, '');
const NGROK_HEADERS = { 'ngrok-skip-browser-warning': 'true' };
const SCHEDULE_STATUSES = ['agendada', 'aguardando', 'gravando', 'validando_video', 'uploading_gcs', 'calling_railway', 'analyzing', 'completed', 'completed_no_class_detected', 'failed'];

function App() {
  const [tab, setTab] = useState('manual');
  const [manual, setManual] = useState({ professor: '', modalidade: '', turma: '', faixaEtaria: '', nivel: '', sala: '', cameraId: 'subway', horario: '', durationMinutes: 60, observacoes: '', tipoAula: '' });
  const fieldLabels = { observacoes: 'Observações específicas' };
  const [status, setStatus] = useState('');
  const [errorDetail, setErrorDetail] = useState('');
  const [recordingId, setRecordingId] = useState('');
  const [recordingStatus, setRecordingStatus] = useState('idle');
  const [report, setReport] = useState(null);
  const [schedule, setSchedule] = useState([]);

  const debugUrl = useMemo(() => `${LOCAL_AGENT_URL}/start-recording`, []);

  async function safeJson(response) {
    try { return await response.json(); } catch { return { error: `Resposta inválida (${response.status})` }; }
  }

  async function loadSchedule() {
    if (!LOCAL_AGENT_URL) return;
    const startRes = await fetch(`${LOCAL_AGENT_URL}/start-daily-schedule`, { method: 'POST', headers: NGROK_HEADERS });
    const startPayload = await safeJson(startRes);
    if (!startRes.ok) {
      setStatus(startPayload.error || 'Falha ao iniciar cronograma');
      setErrorDetail(JSON.stringify(startPayload, null, 2));
      return;
    }
    const res = await fetch(`${LOCAL_AGENT_URL}/daily-schedule-status`, { headers: NGROK_HEADERS });
    const payload = await safeJson(res);
    if (!res.ok) return;
    setSchedule(payload.classes || []);
  }

  useEffect(() => { loadSchedule().catch((e) => setStatus(`Erro cronograma: ${e.message}`)); }, []);

  useEffect(() => {
    if (!recordingId || !LOCAL_AGENT_URL) return;
    const timer = setInterval(async () => {
      const response = await fetch(`${LOCAL_AGENT_URL}/recording-status/${recordingId}`, { headers: NGROK_HEADERS });
      const rec = await safeJson(response);
      if (!response.ok) {
        setStatus(rec.error || 'Falha ao consultar status');
        setErrorDetail(JSON.stringify(rec, null, 2));
        return;
      }
      setRecordingStatus(rec.status || 'unknown');
      setStatus(`Status atual: ${rec.status || '-'} | Etapa: ${rec.failedStage || rec.status || '-'}${rec.error ? ` | Erro: ${rec.error}` : ''}`);
      if (rec.status === 'completed' || rec.status === 'failed') {
        setReport(rec);
        if (rec.status === 'failed') setErrorDetail(JSON.stringify(rec, null, 2));
        clearInterval(timer);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [recordingId]);

  async function gravarAgora(payload, source = 'manual') {
    if (!LOCAL_AGENT_URL) return setStatus('Configure VITE_LOCAL_AGENT_URL');
    setErrorDetail('');
    const response = await fetch(`${LOCAL_AGENT_URL}/start-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...NGROK_HEADERS }, body: JSON.stringify(payload) });
    const data = await safeJson(response);
    if (!response.ok) {
      setStatus(data.error || 'Erro ao iniciar');
      setErrorDetail(JSON.stringify(data, null, 2));
      return;
    }
    setRecordingId(data.recordingId);
    setRecordingStatus('recording');
    setStatus(source === 'manual' ? 'Gravação iniciada manualmente.' : 'Gravação iniciada fora do horário agendado (ignora JSON).');
  }

  return <main className="container">
    <h1>DK Aula IA</h1>
    <p className="hint">Debug: URL agent-local usada: <code>{debugUrl}</code></p>
    <div className="tabs"><button className={tab==='manual'?'active':''} onClick={()=>setTab('manual')}>Gravação manual</button><button className={tab==='schedule'?'active':''} onClick={()=>setTab('schedule')}>Cronograma</button><button className={tab==='reports'?'active':''} onClick={()=>setTab('reports')}>Relatórios</button></div>

    {tab==='manual' && <section className="card">
      {Object.entries(manual).map(([k,v]) => <label key={k}>{fieldLabels[k] || k}<input value={v} onChange={(e)=>setManual((m)=>({...m,[k]:k==='durationMinutes'?Number(e.target.value):e.target.value}))} /></label>)}
      <button onClick={()=>gravarAgora({ ...manual, prompt: manual.observacoes })}>Gravar agora</button>
    </section>}

    {tab==='schedule' && <section className="card">
      <button onClick={loadSchedule}>Atualizar cronograma</button>
      {schedule.map((aula) => <div key={aula.id} className="card mini"><p><strong>{aula.start}</strong> - {aula.professor} / {aula.turma} / {aula.sala || aula.cameraId}</p><p>Status: {aula.uiStatus || aula.recordingStatus || 'agendada'} ({SCHEDULE_STATUSES.join(', ')})</p><button onClick={()=>{ if (confirm('Isso vai ignorar o horário do JSON. Deseja continuar?')) gravarAgora({ ...aula, horario: aula.start, prompt: aula.observacoes || '' }, 'schedule'); }}>Gravar agora esta aula</button></div>)}
    </section>}

    {tab==='reports' && <section className="card"><p>Status gravação: {recordingStatus}</p>{report?.status === 'completed_no_class_detected' && <p>Gravação concluída, mas nenhuma aula foi detectada no vídeo.</p>}{report ? <><p>PDF: {report?.drivePdfUrl ? <a href={report.drivePdfUrl} target="_blank">Abrir PDF</a> : '-'}</p><p>JSON: {report?.driveJsonUrl ? <a href={report.driveJsonUrl} target="_blank">Abrir JSON</a> : '-'}</p><pre>{JSON.stringify(report, null, 2)}</pre></> : <p>Nenhum relatório ainda.</p>}</section>}

    <section className="card"><p className="status">{status}</p>{errorDetail && <pre>{errorDetail}</pre>}</section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
