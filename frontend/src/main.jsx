import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const LOCAL_AGENT_URL = (import.meta.env.VITE_LOCAL_AGENT_URL || '').replace(/\/$/, '');
const NGROK_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

function extractAnalysis(rec) {
  const candidates = [
    rec?.analysis,
    rec?.result,
    rec?.response,
    rec?.text,
    rec?.railwayResponse?.analysis?.report?.rawResponse,
    rec?.railwayResponse?.analysis?.rawResponse,
    rec?.railwayResponse?.analysis?.report,
    rec?.railwayResponse?.analysis,
    rec?.railwayResponse?.result,
    rec?.railwayResponse?.response,
    rec?.railwayResponse?.text,
    rec?.railwayResponse?.data?.analysis,
  ];

  const value = candidates.find((item) => item !== undefined && item !== null && item !== '');
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.rawResponse === 'string' && value.rawResponse.trim()) return value.rawResponse;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

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
      const response = await fetch(`${LOCAL_AGENT_URL}/recording-status/${recordingId}`, { headers: NGROK_HEADERS });
      const rec = await response.json();
      if (!response.ok) {
        console.error('Erro no polling recording-status', { status: response.status, payload: rec });
      }
      setRecordingStatus(rec.status || 'unknown');
      setStatus(`Gravação local: ${rec.status || '-'}${rec.error ? ` | Erro: ${rec.error}` : ''}`);
      if (rec.status === 'completed') {
        console.log('Resposta completa de /recording-status/:id', rec);
        const analysisText = extractAnalysis(rec);
        const provider = rec?.railwayResponse?.analysis?.provider;
        const model = rec?.railwayResponse?.analysis?.model;
        const analyzedAt = rec?.railwayResponse?.analysis?.report?.analyzedAt;
        const videoUrl = rec?.videoUrl || rec?.railwayResponse?.videoUrl || rec?.railwayResponse?.analysis?.videoUrl;
        const gcsFileName = rec?.gcsFileName || rec?.railwayResponse?.gcsFileName || rec?.railwayResponse?.analysis?.gcsFileName;
        setReport({
          status: rec.status,
          hasAnalysis: Boolean(analysisText),
          analysisText,
          provider,
          model,
          analyzedAt,
          videoUrl,
          gcsFileName,
          railwayResponse: rec?.railwayResponse || null,
        });
      }
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
    const startRecordingUrl = `${LOCAL_AGENT_URL}/start-recording`;
    console.log('URL usada para start-recording:', startRecordingUrl);

    try {
      const response = await fetch(startRecordingUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...NGROK_HEADERS }, body: JSON.stringify({ professor, turma, nivel, sala, horario, durationMinutes, prompt, cameraId: camera }) });
      const data = await response.json();
      if (!response.ok) {
        console.error('Erro ao iniciar gravação', { status: response.status, payload: data, url: startRecordingUrl });
        return setStatus(data.error || 'Erro ao iniciar gravação: não foi possível conectar ao agent-local/ngrok.');
      }
      setRecordingId(data.recordingId);
      setRecordingStatus('recording');
      setStatus(`Gravação local iniciada com ID ${data.recordingId}`);
    } catch (error) {
      console.error('Erro de conexão ao iniciar gravação', { error, url: startRecordingUrl });
      setStatus('Erro ao iniciar gravação: não foi possível conectar ao agent-local/ngrok.');
    }
  }

  async function stopRecording() {
    if (!recordingId || !LOCAL_AGENT_URL) return;
    const response = await fetch(`${LOCAL_AGENT_URL}/stop-recording/${recordingId}`, { method: 'POST', headers: NGROK_HEADERS });
    const data = await response.json();
    if (!response.ok) {
      console.error('Erro ao parar gravação', { status: response.status, payload: data });
    }
    setStatus(data.error || `Status: ${data.status}`);
  }

  return <main className="container"><h1>DK Aula IA</h1><div className="tabs"><button className={tab==='drive'?'active':''} onClick={()=>setTab('drive')}>Analisar por Drive</button><button className={tab==='record'?'active':''} onClick={()=>setTab('record')}>Gravar Aula</button></div>
  {tab==='drive' && <section className="card"><label>Link<input value={driveUrl} onChange={(e)=>setDriveUrl(e.target.value)} /></label><button onClick={analyzeDrive} disabled={loading}>Analisar vídeo do Drive</button></section>}
  {tab==='record' && <section className="card">{!LOCAL_AGENT_URL && <p className="status">Configure VITE_LOCAL_AGENT_URL para gravar localmente.</p>}<label>Professor<input value={professor} onChange={(e)=>setProfessor(e.target.value)} /></label><label>Turma<input value={turma} onChange={(e)=>setTurma(e.target.value)} /></label><label>Nível<input value={nivel} onChange={(e)=>setNivel(e.target.value)} /></label><label>Sala<input value={sala} onChange={(e)=>setSala(e.target.value)} /></label><label>Horário<input value={horario} onChange={(e)=>setHorario(e.target.value)} /></label><label>Câmera<select value={camera} onChange={(e)=>setCamera(e.target.value)}><option value="subway">Subway</option><option value="bolso">Bolso</option><option value="mirante">Mirante</option></select></label><label>Duração (min)<input type="number" value={durationMinutes} onChange={(e)=>setDurationMinutes(Number(e.target.value))} /></label><label>Prompt<textarea rows="8" value={prompt} onChange={(e)=>setPrompt(e.target.value)} /></label><button onClick={startRecording}>Iniciar</button><button onClick={stopRecording}>Parar</button><p>Status: {recordingStatus}</p></section>}
  <section className="card"><p className="status">{status}</p>
    {report ? (
      <>
        {report.status === 'completed' && report.hasAnalysis ? (
          <>
            <p><strong>Provider:</strong> {report.provider || '-'}</p>
            <p><strong>Modelo:</strong> {report.model || '-'}</p>
            <p><strong>Analisado em:</strong> {report.analyzedAt || '-'}</p>
            {report.videoUrl && <p><strong>Video URL:</strong> {report.videoUrl}</p>}
            {report.gcsFileName && <p><strong>GCS file name:</strong> {report.gcsFileName}</p>}
            <pre>{report.analysisText}</pre>
          </>
        ) : report.status === 'completed' ? (
          <>
            <p>Processo concluído, mas nenhuma análise foi encontrada no retorno.</p>
            <pre>{JSON.stringify(report.railwayResponse, null, 2)}</pre>
          </>
        ) : (
          <pre>{JSON.stringify(report, null, 2)}</pre>
        )}
      </>
    ) : <pre>Nenhuma análise executada.</pre>}
  </section></main>;
}

createRoot(document.getElementById('root')).render(<App />);
