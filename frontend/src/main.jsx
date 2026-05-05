import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

function App() {
  const [tab, setTab] = useState('drive');
  const [driveUrl, setDriveUrl] = useState('');
  const [professor, setProfessor] = useState('');
  const [turma, setTurma] = useState('');
  const [sala, setSala] = useState('');
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!API_URL) {
      setStatus('Configure VITE_API_URL na Vercel apontando para o backend Railway.');
      return;
    }
    fetch(`${API_URL}/default-prompt`)
      .then((r) => r.json())
      .then((data) => setPrompt(data.defaultPrompt || ''))
      .catch(() => setStatus('Não consegui carregar o prompt padrão do backend.'));
  }, []);

  async function analyzeDrive() {
    if (!API_URL) return setStatus('VITE_API_URL não configurada.');
    if (!driveUrl.trim()) return setStatus('Cole o link do Google Drive.');

    setLoading(true);
    setReport(null);
    setStatus('Enviando pedido para o backend. Isso pode demorar em vídeo grande...');

    try {
      const response = await fetch(`${API_URL}/analyze-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveUrl, professor, turma, sala, prompt })
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error || 'Falha ao analisar vídeo.');
        setReport(data);
        return;
      }
      setStatus(`Análise concluída. Arquivo: ${data.fileSizeMB} MB. Modelo: ${data.model}`);
      setReport(data);
    } catch (error) {
      setStatus(`Erro de conexão com backend: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>DK Aula IA — MVP</h1>
      <p className="hint">Frontend na Vercel + Backend no Railway + Vídeo no Drive + Gemini Files API.</p>

      <div className="tabs">
        <button className={tab === 'drive' ? 'active' : ''} onClick={() => setTab('drive')}>Analisar por Drive</button>
        <button className={tab === 'record' ? 'active' : ''} onClick={() => setTab('record')}>Gravar aula</button>
      </div>

      {tab === 'record' && (
        <section className="card">
          <p><strong>Próxima fase:</strong> gravação RTSP automática a partir de um PC no DK. Neste MVP, use o Drive para validar a análise.</p>
        </section>
      )}

      {tab === 'drive' && (
        <section className="card">
          <label>Link do Google Drive
            <input value={driveUrl} onChange={(e) => setDriveUrl(e.target.value)} placeholder="https://drive.google.com/file/d/.../view" />
          </label>
          <label>Professor
            <input value={professor} onChange={(e) => setProfessor(e.target.value)} />
          </label>
          <label>Turma
            <input value={turma} onChange={(e) => setTurma(e.target.value)} />
          </label>
          <label>Sala
            <input value={sala} onChange={(e) => setSala(e.target.value)} />
          </label>
          <label>Prompt de análise
            <textarea rows="14" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <button onClick={analyzeDrive} disabled={loading}>{loading ? 'Analisando...' : 'Analisar vídeo do Drive'}</button>
          <p className="status">{status}</p>
        </section>
      )}

      <section className="card">
        <h2>Relatório</h2>
        {report ? (
          <pre>{JSON.stringify(report, null, 2)}</pre>
        ) : (
          <pre>Nenhuma análise executada.</pre>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
