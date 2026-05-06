import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const LOCAL_AGENT_URL = (import.meta.env.VITE_LOCAL_AGENT_URL || '').replace(/\/$/, '');

function App() {
  const [tab, setTab] = useState('drive');
  const [driveUrl, setDriveUrl] = useState('');
  const [professor, setProfessor] = useState('');
  const [turma, setTurma] = useState('');
  const [nivel, setNivel] = useState('');
  const [sala, setSala] = useState('');
  const [horario, setHorario] = useState('');
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [camera, setCamera] = useState('subway');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [recordingId, setRecordingId] = useState('');
  const [recordingStatus, setRecordingStatus] = useState('idle');

  useEffect(() => {
    fetch(`${API_URL}/default-prompt`).then((r) => r.json()).then((d) => setPrompt(d.defaultPrompt || '')).catch(() => {});
  }, []);

  useEffect(() => {
    if (!recordingId || !LOCAL_AGENT_URL) return;
    const timer = setInterval(async () => {
      const rec = await fetch(`${LOCAL_AGENT_URL}/recording-status/${recordingId}`).then((r) => r.json());
      setRecordingStatus(rec.status || 'unknown');
      setStatus(`Gravação local: ${rec.status || '-'}`);
      if (rec.status === 'completed' || rec.status === 'failed') clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [recordingId]);

  async function analyzeDrive() {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/analyze-drive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driveUrl, professor, turma, nivel, sala, horario, prompt }) });
      const data = await response.json();
      if (!response.ok) return setStatus(data.error || 'Falha ao analisar');
      setReport(data);
      setStatus('Análise concluída com sucesso.');
    } catch (e) { setStatus(`Erro: ${e.message}`); } finally { setLoading(false); }
  }

  async function startRecording() {
    if (!LOCAL_AGENT_URL) return setStatus('Configure VITE_LOCAL_AGENT_URL para gravar localmente.');
    const response = await fetch(`${LOCAL_AGENT_URL}/start-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ professor, turma, nivel, sala, horario, durationMinutes, prompt, camera }) });
    const data = await response.json();
    if (!response.ok) return setStatus(data.error || 'Erro ao iniciar');
    setRecordingId(data.recordingId);
    setRecordingStatus('recording');
    setStatus(`Gravação local iniciada com ID ${data.recordingId}`);
  }

  async function stopRecording() {
    if (!recordingId || !LOCAL_AGENT_URL) return;
    const response = await fetch(`${LOCAL_AGENT_URL}/stop-recording/${recordingId}`, { method: 'POST' });
    const data = await response.json();
    setStatus(data.error || `Status: ${data.status}`);
  }

  return <main className="container"><h1>DK Aula IA</h1><div className="tabs"><button className={tab==='drive'?'active':''} onClick={()=>setTab('drive')}>Analisar por Drive</button><button className={tab==='record'?'active':''} onClick={()=>setTab('record')}>Gravar Aula</button></div>
  {tab==='drive' && <section className="card"><label>Link<input value={driveUrl} onChange={(e)=>setDriveUrl(e.target.value)} /></label><button onClick={analyzeDrive} disabled={loading}>Analisar vídeo do Drive</button></section>}
  {tab==='record' && <section className="card"><label>Professor<input value={professor} onChange={(e)=>setProfessor(e.target.value)} /></label><label>Turma<input value={turma} onChange={(e)=>setTurma(e.target.value)} /></label><label>Nível<input value={nivel} onChange={(e)=>setNivel(e.target.value)} /></label><label>Sala<input value={sala} onChange={(e)=>setSala(e.target.value)} /></label><label>Horário<input value={horario} onChange={(e)=>setHorario(e.target.value)} /></label><label>Câmera<select value={camera} onChange={(e)=>setCamera(e.target.value)}><option value="subway">Subway</option><option value="bolso">Bolso</option><option value="mirante">Mirante</option></select></label><label>Duração (min)<input type="number" value={durationMinutes} onChange={(e)=>setDurationMinutes(Number(e.target.value))} /></label><label>Prompt<textarea rows="8" value={prompt} onChange={(e)=>setPrompt(e.target.value)} /></label><button onClick={startRecording}>Iniciar</button><button onClick={stopRecording}>Parar</button><p>Status: {recordingStatus}</p></section>}
  <section className="card"><p className="status">{status}</p><pre>{report ? JSON.stringify(report, null, 2) : 'Nenhuma análise executada.'}</pre></section></main>;
}

createRoot(document.getElementById('root')).render(<App />);
