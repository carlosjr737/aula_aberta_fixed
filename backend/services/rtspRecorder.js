const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const RECORDINGS_DIR = path.join(os.tmpdir(), 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

function createRecordingId() {
  return crypto.randomUUID();
}

function startRtspRecording({ rtspUrl, durationMinutes, recordingId }) {
  const outputPath = path.join(RECORDINGS_DIR, `${recordingId}.mp4`);
  const durationSeconds = Math.max(1, Number(durationMinutes) * 60);
  const args = ['-rtsp_transport', 'tcp', '-i', rtspUrl, '-t', String(durationSeconds), '-c', 'copy', outputPath];
  const processRef = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  processRef.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return { outputPath, processRef, stderrRef: () => stderr };
}

function stopRtspRecording(processRef) {
  if (processRef && !processRef.killed) processRef.kill('SIGINT');
}

module.exports = { createRecordingId, startRtspRecording, stopRtspRecording, RECORDINGS_DIR };
