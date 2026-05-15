let mediaRecorder = null;
let recordedChunks = [];
let stream = null;

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
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  return false;
});

async function startRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    throw new Error('Recording already in progress');
  }

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  recordedChunks = [];

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: 'audio/webm;codecs=opus'
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.start();
}

async function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      reject(new Error('No active recording'));
      return;
    }

    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });

      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];

        if (stream) {
          stream.getTracks().forEach(track => track.stop());
          stream = null;
        }

        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(audioBlob);
    };

    mediaRecorder.stop();
  });
}
