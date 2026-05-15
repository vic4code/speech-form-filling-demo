let mediaRecorder = null;
let recordedChunks = [];
let stream = null;

// Realtime PCM streaming
let pcmStream = null;
let audioContext = null;
let pcmProcessor = null;
let pcmSource = null;
let pcmFallbackBuffer = [];

// Only handle messages targeted at offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  const { action } = message;

  if (action === 'start_recording') {
    startRecording()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message, errorName: e.name }));
    return true;
  }

  if (action === 'stop_recording') {
    stopRecording()
      .then(audioData => sendResponse({ success: true, audioData }))
      .catch(e => sendResponse({ success: false, error: e.message, errorName: e.name, stack: e.stack }));
    return true;
  }

  if (action === 'start_pcm_stream') {
    startPcmStream()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message, errorName: e.name, stack: e.stack }));
    return true;
  }

  if (action === 'stop_pcm_stream') {
    stopPcmStream();
    sendResponse({ success: true });
    return true;
  }

  return false;
});

// ── WebM Recording (for Whisper mode) ──

function cleanupRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) {}
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
}

async function startRecording() {
  cleanupRecording();

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  recordedChunks = [];

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.start(500);
}

async function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      cleanupRecording();
      reject(new Error('No active recording'));
      return;
    }

    const currentRecorder = mediaRecorder;
    const currentStream = stream;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
      }
      if (stream === currentStream) stream = null;
      if (mediaRecorder === currentRecorder) mediaRecorder = null;
      recordedChunks = [];
      fn(value);
    };

    currentRecorder.onstop = () => {
      if (recordedChunks.length === 0) {
        finish(reject, new Error('No audio data captured'));
        return;
      }

      const audioBlob = new Blob(recordedChunks, { type: currentRecorder.mimeType || 'audio/webm' });

      if (audioBlob.size < 100) {
        finish(reject, new Error('Audio too short or empty'));
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const base64 = result.split(',')[1];
        if (!base64) {
          finish(reject, new Error('Failed to encode audio: empty result'));
          return;
        }
        finish(resolve, base64);
      };
      reader.onerror = () => finish(reject, new Error(`Failed to encode audio: ${reader.error?.message || 'unknown'}`));
      reader.readAsDataURL(audioBlob);
    };
    currentRecorder.onerror = (event) => {
      finish(reject, new Error(`Recorder error: ${event.error?.message || event.error?.name || 'unknown'}`));
    };

    setTimeout(() => {
      finish(reject, new Error('Timed out while stopping recording'));
    }, 5000);

    if (currentRecorder.state === 'recording') {
      try { currentRecorder.requestData(); } catch (e) {}
    }
    try {
      currentRecorder.stop();
    } catch (e) {
      finish(reject, e);
    }
  });
}

// ── PCM16 Streaming (for Realtime API mode) ──

async function startPcmStream() {
  stopPcmStream();

  pcmStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 24000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  audioContext = new AudioContext({ sampleRate: 24000 });
  pcmSource = audioContext.createMediaStreamSource(pcmStream);

  if (audioContext.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      await audioContext.audioWorklet.addModule('pcm-processor.js');
      pcmProcessor = new AudioWorkletNode(audioContext, 'pcm-processor');

      pcmProcessor.port.onmessage = (event) => {
        sendPcm16(event.data);
      };

      pcmSource.connect(pcmProcessor);
      pcmProcessor.connect(audioContext.destination);
      return;
    } catch (error) {
      console.warn('AudioWorklet PCM capture failed, falling back to ScriptProcessor:', error);
    }
  }

  startPcmFallbackProcessor();
}

function startPcmFallbackProcessor() {
  pcmFallbackBuffer = [];
  pcmProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  pcmProcessor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const mono24k = resampleTo24k(input, audioContext.sampleRate);
    for (let i = 0; i < mono24k.length; i++) {
      pcmFallbackBuffer.push(mono24k[i]);
    }

    const chunkSize = 2400;
    while (pcmFallbackBuffer.length >= chunkSize) {
      const chunk = pcmFallbackBuffer.splice(0, chunkSize);
      sendFloatPcmAsInt16(chunk);
    }
  };

  pcmSource.connect(pcmProcessor);
  pcmProcessor.connect(audioContext.destination);
}

function resampleTo24k(input, sourceRate) {
  if (sourceRate === 24000) return input;
  const ratio = sourceRate / 24000;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    output[i] = input[Math.floor(i * ratio)] || 0;
  }
  return output;
}

function sendFloatPcmAsInt16(floatSamples) {
  const pcm16 = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  sendPcm16(pcm16);
}

function sendPcm16(pcm16Array) {
  const bytes = new Uint8Array(pcm16Array.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  chrome.runtime.sendMessage({
    target: 'sidepanel',
    action: 'pcm_audio_data',
    audioData: base64
  }).catch(() => {});
}

function stopPcmStream() {
  if (pcmProcessor) {
    if (pcmProcessor.port) {
      pcmProcessor.port.onmessage = null;
    }
    if (pcmProcessor.onaudioprocess) {
      pcmProcessor.onaudioprocess = null;
    }
    try { pcmProcessor.disconnect(); } catch (e) {}
    pcmProcessor = null;
  }
  if (pcmSource) {
    try { pcmSource.disconnect(); } catch (e) {}
    pcmSource = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (pcmStream) {
    pcmStream.getTracks().forEach(track => track.stop());
    pcmStream = null;
  }
  pcmFallbackBuffer = [];
}
