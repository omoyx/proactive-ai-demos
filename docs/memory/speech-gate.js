export class SpeechGate {
  constructor() { this.calibration = []; this.noise = .001; this.frames = 0; }
  accept(rms, vadVoice) {
    this.frames++;
    // Calibrate ambient input before emitting any audio, including a VAD false positive.
    if (this.frames <= 25) {
      this.calibration.push(rms);
      const sorted = [...this.calibration].sort((a, b) => a - b);
      this.noise = Math.max(.0003, sorted[Math.floor(sorted.length * .3)]);
      return false;
    }
    const threshold = Math.max(.003, this.noise * 2.5);
    const accepted = vadVoice && rms >= threshold;
    if (!accepted && rms < threshold) this.noise = Math.max(.0003, this.noise * .98 + Math.min(rms, threshold / 2.5) * .02);
    return accepted;
  }
}
