/**
 * AudioWorklet processor for real-time PCM16 audio capture.
 *
 * The browser's AudioContext may run at a different sample rate (e.g. 48kHz),
 * so this processor downsamples to 24kHz and converts Float32 to Int16 PCM.
 * Buffers are flushed every ~100ms (2400 samples at 24kHz).
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.ratio = sampleRate / 24000;
    this.sampleIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this.sampleIndex++;
      if (this.sampleIndex >= this.ratio) {
        this.sampleIndex -= this.ratio;
        // Clamp and convert Float32 [-1, 1] to Int16 [-32768, 32767]
        const s = Math.max(-1, Math.min(1, channelData[i]));
        this.buffer.push(s < 0 ? s * 0x8000 : s * 0x7FFF);
      }
    }

    // Flush every ~100ms (2400 samples at 24kHz)
    if (this.buffer.length >= 2400) {
      const pcm16 = new Int16Array(this.buffer.splice(0, this.buffer.length));
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
