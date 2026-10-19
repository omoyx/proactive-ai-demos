import createVAD, { VADMode, VADEvent } from '/proactive-ai-demos/vendor/vad/lib/index.js';
import { SpeechGate } from './speech-gate.js';

export function wavBlob(samples) {
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => { const s = Math.max(-1, Math.min(1, value)); view.setInt16(44 + i * 2, s * (s < 0 ? 32768 : 32767), true); });
  return new Blob([bytes], { type: 'audio/wav' });
}
export const blobDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('音频读取失败。')); reader.readAsDataURL(blob);
});
async function resample(samples, rate) {
  if (rate === 16000) return samples;
  const context = new OfflineAudioContext(1, Math.ceil(samples.length / rate * 16000), 16000);
  const buffer = context.createBuffer(1, samples.length, rate); buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); source.start();
  return (await context.startRendering()).getChannelData(0);
}
export async function audioFile(blob) {
  if (blob.size > 20_000_000) throw new Error('音频文件最多 20 MB。');
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    if (audio.duration < .1 || audio.duration > 30) throw new Error('请选择 0.1 到 30 秒的音频。');
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) { const channel = audio.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.numberOfChannels; }
    return wavBlob(await resample(mono, audio.sampleRate));
  } finally { await context.close(); }
}

export class ConversationMic {
  constructor(callbacks) { this.callbacks = callbacks; this.generation = 0; this.active = false; this.starting = false; this.reset(); }
  reset() { this.pre = []; this.frames = []; this.voiced = 0; this.silence = 0; this.segmentContext = null; this.speaking = false; this.continuation = false; }
  async start() {
    if (this.active || this.starting) return;
    const generation = ++this.generation;
    this.starting = true; this.callbacks.onState('starting');
    let stream, context;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error('此浏览器不支持持续录音，可使用文字或音频文件。');
      context = this.context = new AudioContext({ sampleRate: 16000 });
      const resumed = context.resume();
      resumed.catch(() => {});
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      await resumed;
      if (generation !== this.generation) return;
      this.rate = context.sampleRate;
      this.gate = new SpeechGate();
      if (![8000, 16000, 32000, 48000].includes(this.rate)) throw new Error('当前音频采样率不支持停顿检测，请使用音频文件。');
      const VAD = await createVAD();
      if (generation !== this.generation) return;
      this.VAD = VAD; this.vad = new VAD(VADMode.AGGRESSIVE, this.rate);
      let worklet = false, timer;
      if (context.audioWorklet && window.AudioWorkletNode) {
        try {
          await Promise.race([context.audioWorklet.addModule('/proactive-ai-demos/memory/capture-worklet.js'),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Audio worklet unavailable')), 2500); })]);
          worklet = true;
        } catch {} finally { clearTimeout(timer); }
      }
      if (generation !== this.generation) return;
      if (worklet) {
        this.node = new AudioWorkletNode(context, 'memory-capture');
        this.node.port.onmessage = ({ data }) => this.frame(data);
      } else {
        // Some embedded browsers expose AudioWorklet but never load its module.
        this.node = context.createScriptProcessor(1024, 1, 1);
        let frame = new Float32Array(this.rate / 50), offset = 0;
        this.node.onaudioprocess = event => {
          for (const sample of event.inputBuffer.getChannelData(0)) {
            frame[offset++] = sample;
            if (offset === frame.length) { this.frame(frame); frame = new Float32Array(this.rate / 50); offset = 0; }
          }
        };
      }
      this.captureBackend = worklet ? 'worklet' : 'compatibility';
      this.source = context.createMediaStreamSource(stream);
      this.mute = context.createGain(); this.mute.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.mute); this.mute.connect(context.destination);
      stream.getAudioTracks()[0].onended = () => { if (this.active) { this.stop(); this.callbacks.onError(new Error('麦克风连接已中断。')); } };
      this.context.onstatechange = () => { if (this.active && this.context?.state === 'suspended') { this.stop(); this.callbacks.onError(new Error('音频已被浏览器暂停，请重新开始聆听。')); } };
      this.active = true; this.callbacks.onState('listening');
    } catch (error) {
      if (generation !== this.generation) return;
      await this.stop(false);
      this.callbacks.onError(error.name === 'NotAllowedError' ? new Error('麦克风未获允许。可以在浏览器设置中开启，或使用文字与音频文件。') : error);
    } finally {
      if (generation === this.generation) this.starting = false;
      if (generation !== this.generation) {
        stream?.getTracks().forEach(track => track.stop());
        if (context && context.state !== 'closed') await context.close();
      }
    }
  }
  frame(samples) {
    if (!this.active) return;
    try {
      const vadResult = this.vad.processFrame(this.VAD.floatTo16BitPCM(samples));
      if (vadResult === VADEvent.ERROR) throw new Error('停顿检测失败，聆听已暂停。');
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      const voice = this.gate.accept(rms, vadResult === VADEvent.VOICE) ? VADEvent.VOICE : VADEvent.SILENCE;
      this.callbacks.onLevel(rms, voice === VADEvent.VOICE);
      const speaking = voice === VADEvent.VOICE;
      if (speaking !== this.speaking) { this.speaking = speaking; this.callbacks.onActivity?.(speaking); }
      if (!this.frames.length) {
        this.pre.push(samples); this.pre = this.pre.slice(-10);
        if (voice !== VADEvent.VOICE) return;
        this.segmentContext = this.callbacks.getContext?.();
        this.frames = this.pre; this.pre = [];
      } else this.frames.push(samples);
      if (voice === VADEvent.VOICE) { this.voiced++; this.silence = 0; }
      else this.silence++;
      // Retain Chinese phrase context; the hard cap still bounds continuous utterances.
      if (this.silence >= 40 || this.frames.length >= 400) this.flush(this.frames.length >= 400);
    } catch (error) { this.stop(false); this.callbacks.onError(error); }
  }
  flush(forced = false) {
    if (this.voiced >= 12 && this.frames.length) {
      const frames = this.frames, rate = this.rate, generation = this.generation, context = { ...this.segmentContext, incomplete: forced || this.continuation };
      const samples = new Float32Array(frames.reduce((length, frame) => length + frame.length, 0));
      let offset = 0; for (const frame of frames) { samples.set(frame, offset); offset += frame.length; }
      resample(samples, rate).then(audio => { if (generation === this.generation) this.callbacks.onSegment(wavBlob(audio), context); }).catch(this.callbacks.onError);
    }
    this.reset();
    this.continuation = forced;
  }
  async stop(flush = true) {
    ++this.generation; this.active = false; this.starting = false;
    if (flush) this.flush(); else this.reset();
    if (this.node) { if (this.node.port) this.node.port.onmessage = null; else this.node.onaudioprocess = null; this.node.disconnect(); }
    this.source?.disconnect(); this.mute?.disconnect();
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    const context = this.context; this.context = null;
    this.vad?.destroy(); this.vad = null; this.node = null; this.source = null; this.mute = null; this.stream = null;
    this.callbacks.onState('paused'); this.callbacks.onLevel(0, false);
    if (context && context.state !== 'closed') await context.close();
  }
}
