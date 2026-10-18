// 効果音（仮）。音素材が未納品のため WebAudio の短い電子音で代用する。ゲームロジックには影響しない。
export type SoundCode = 'declareOk' | 'lineClear' | 'declareFail' | 'launch' | 'hit' | 'bounce' | 'danger' | 'win';

const TONES: Record<SoundCode, Array<[freq: number, ms: number]>> = {
  declareOk: [
    [660, 70],
    [880, 70],
    [1320, 120],
  ],
  lineClear: [[520, 60]],
  declareFail: [
    [220, 90],
    [165, 140],
  ],
  launch: [[440, 25]],
  hit: [[990, 35]],
  bounce: [[180, 50]],
  danger: [
    [300, 80],
    [300, 80],
  ],
  win: [
    [523, 100],
    [659, 100],
    [784, 200],
  ],
};

export class SoundBus {
  muted = false;
  volume = 0.05;
  private ctx: AudioContext | null = null;
  /** ブラウザの自動再生制限のため、最初のキー入力（unlock）までは鳴らさない */
  private unlocked = false;
  /** 自動検証用：鳴らした音の記録 */
  readonly log: Array<{ code: SoundCode; delayMs: number }> = [];

  /** ユーザー操作（keydown 等）の中から呼ぶ */
  unlock(): void {
    this.unlocked = true;
  }

  private audio(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (!this.unlocked) return null;
    const AC = typeof window !== 'undefined' ? (window.AudioContext ?? null) : null;
    if (!AC) return null;
    try {
      this.ctx = new AC();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** delayMs 後に鳴らす（役処理の各フェーズ時刻に合わせる） */
  play(code: SoundCode, delayMs = 0): void {
    this.log.push({ code, delayMs });
    if (this.log.length > 200) this.log.shift();
    if (this.muted) return;
    const ac = this.audio();
    if (!ac || ac.state === 'closed') return;
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
    let at = ac.currentTime + Math.max(0, delayMs) / 1000;
    for (const [freq, ms] of TONES[code]) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(this.volume, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
      osc.connect(gain).connect(ac.destination);
      osc.start(at);
      osc.stop(at + ms / 1000);
      at += ms / 1000;
    }
  }
}
