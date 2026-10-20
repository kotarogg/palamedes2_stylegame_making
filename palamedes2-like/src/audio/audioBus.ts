// 音声の再生バス（Web Audio）。カテゴリ（BGM／SE／ボイス）ごとの再生ゲインとミュート、マスター、ボイス中のBGM減衰、
// 同一イベントの重複抑制、声の優先度を管理する。素材の再ノーマライズ・ピーク最大化・リミッターは行わない。
// ブラウザが再生を拒否しても例外を出さず無音で続行する（ゲーム進行は音に依存しない）。
// AudioContext はユーザー操作（最初のキー・クリック・ボタン）で作成する。
import { BGM_FILES, sfxFile, SFX_MIN_INTERVAL_MS, voiceFile, type BgmId, type Character, type SfxId, type VoiceLine } from './audioMap';

export interface AudioVolumes {
  /** 0〜100（100＝素材そのまま＝カテゴリゲイン0dB。再ノーマライズの意味ではない） */
  bgm: number;
  sfx: number;
  voice: number;
  bgmMute: boolean;
  sfxMute: boolean;
  voiceMute: boolean;
}

export const DEFAULT_VOLUMES: AudioVolumes = { bgm: 100, sfx: 100, voice: 100, bgmMute: false, sfxMute: false, voiceMute: false };

/** ミックスの初期値（audio_loudness_spec.md 第5章：マスター−6dB、ボイス中BGM−4dB、BGM切替約300ms） */
export interface MixConfig {
  masterDb: number;
  duckDb: number;
  duckAttackMs: number;
  duckReleaseMs: number;
  bgmFadeMs: number;
  /** 同時発音するSEの上限（超えた分は鳴らさない） */
  maxSfx: number;
  /** 同じSEの同一フレーム重複とみなす間隔 */
  sameFrameMs: number;
}

export const DEFAULT_MIX: MixConfig = { masterDb: -6, duckDb: -4, duckAttackMs: 60, duckReleaseMs: 250, bgmFadeMs: 300, maxSfx: 12, sameFrameMs: 20 };

export type VoiceChannel = 'main' | 'announce' | 'result';

export interface AudioLogEntry {
  t: number;
  kind: 'bgm' | 'sfx' | 'voice';
  id: string;
  channel?: VoiceChannel;
  /** 再生しなかった理由（重複・優先度・未取得など） */
  skipped?: string;
}

/** 0〜100 → 線形ゲイン（0＝無音、100＝1.0）。聴感に合わせて二乗カーブ */
export const volumeToGain = (v: number): number => Math.pow(Math.max(0, Math.min(100, v)) / 100, 2);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** WAVヘッダから長さ（ms）を求める（デコード前でも使える） */
export function wavDurationMs(buf: ArrayBuffer): number | null {
  const v = new DataView(buf);
  if (buf.byteLength < 12 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return null;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.byteLength) {
    const id = v.getUint32(off, false);
    const size = v.getUint32(off + 4, true);
    if (id === 0x666d7420) byteRate = v.getUint32(off + 16, true); // 'fmt '
    if (id === 0x64617461 && byteRate > 0) return (size / byteRate) * 1000; // 'data'
    off += 8 + size + (size % 2);
  }
  return null;
}

interface Playing {
  id: string;
  prio: number;
  endT: number;
  src: AudioBufferSourceNode | null;
  gain: GainNode | null;
}

export class AudioBus {
  ctx: AudioContext | null = null;
  readonly log: AudioLogEntry[] = [];
  readonly missing = new Set<string>();
  private readonly raw = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private master: GainNode | null = null;
  private bus: Record<'bgm' | 'sfx' | 'voice', GainNode> | null = null;
  private duck: GainNode | null = null;
  private volumes: AudioVolumes = { ...DEFAULT_VOLUMES };
  private bgmId: BgmId | null = null;
  private bgmSrc: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private readonly lastSfx = new Map<SfxId, number>();
  private sfxPlaying: Playing[] = [];
  private readonly voices: Record<VoiceChannel, Playing[]> = { main: [], announce: [], result: [] };
  private unlocking: Promise<void> | null = null;

  constructor(
    private readonly baseUrl: string,
    readonly mix: MixConfig = DEFAULT_MIX,
    /** 時刻（ms）。テストで差し替え */
    private readonly now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  ) {}

  /** 記録（自動検証用。最新2000件まで） */
  private record(e: AudioLogEntry): void {
    this.log.push(e);
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get currentBgm(): BgmId | null {
    return this.bgmId;
  }

  /** 素材の取得（ユーザー操作前でも可。デコードは unlock 後）。取得できない素材は missing に記録して続行 */
  async preload(files: readonly string[], fetcher: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<void> {
    await Promise.all(
      files.map(async (f) => {
        try {
          const res = await fetcher(`${this.baseUrl}assets/audio/${f}`);
          if (!res.ok) throw new Error(String(res.status));
          this.raw.set(f, await res.arrayBuffer());
        } catch {
          this.missing.add(f);
        }
      }),
    );
  }

  /** 取得済み素材の長さ（ms）。未取得なら null */
  durationMs(file: string): number | null {
    const b = this.buffers.get(file);
    if (b) return b.duration * 1000;
    const r = this.raw.get(file);
    return r ? wavDurationMs(r) : null;
  }

  voiceDurationMs(c: Character, line: VoiceLine): number | null {
    return this.durationMs(voiceFile(c, line));
  }

  /** ユーザー操作の中から呼ぶ。AudioContext を作成・再開し、取得済み素材をデコードする */
  unlock(): Promise<void> {
    if (this.unlocking) {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return this.unlocking;
    }
    const AC = typeof window !== 'undefined' ? (window.AudioContext ?? null) : null;
    if (!AC) return (this.unlocking = Promise.resolve());
    try {
      this.ctx = new AC();
    } catch {
      this.ctx = null;
      return (this.unlocking = Promise.resolve());
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = dbToGain(this.mix.masterDb);
    this.master.connect(ctx.destination);
    this.duck = ctx.createGain();
    this.duck.connect(this.master);
    this.bus = { bgm: ctx.createGain(), sfx: ctx.createGain(), voice: ctx.createGain() };
    this.bus.bgm.connect(this.duck);
    this.bus.sfx.connect(this.master);
    this.bus.voice.connect(this.master);
    this.applyVolumes();
    void ctx.resume().catch(() => undefined);
    this.unlocking = Promise.all(
      [...this.raw.entries()].map(async ([f, data]) => {
        try {
          this.buffers.set(f, await ctx.decodeAudioData(data.slice(0)));
        } catch {
          this.missing.add(f);
        }
        this.raw.delete(f);
      }),
    ).then(() => {
      // 解除前に要求されたBGMを開始
      const want = this.bgmId;
      if (want && !this.bgmSrc) {
        this.bgmId = null;
        this.playBgm(want);
      }
    });
    return this.unlocking;
  }

  setVolumes(v: AudioVolumes): void {
    this.volumes = { ...v };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.bus || !this.ctx) return;
    const t = this.ctx.currentTime;
    const g = (vol: number, mute: boolean) => (mute ? 0 : volumeToGain(vol));
    this.bus.bgm.gain.setTargetAtTime(g(this.volumes.bgm, this.volumes.bgmMute), t, 0.02);
    this.bus.sfx.gain.setTargetAtTime(g(this.volumes.sfx, this.volumes.sfxMute), t, 0.02);
    this.bus.voice.gain.setTargetAtTime(g(this.volumes.voice, this.volumes.voiceMute), t, 0.02);
  }

  // ---- BGM ----

  /** BGM：ファイル全体を先頭からループ。同じ曲なら再始動しない。切替は約300msのフェード */
  playBgm(id: BgmId): void {
    if (this.bgmId === id && (this.bgmSrc || !this.ctx)) return;
    this.bgmId = id;
    this.record({ t: this.now(), kind: 'bgm', id });
    this.fadeOutBgm();
    const ctx = this.ctx;
    const buf = this.buffers.get(BGM_FILES[id]);
    if (!ctx || !this.bus) return;
    if (!buf) {
      this.record({ t: this.now(), kind: 'bgm', id, skipped: 'missing' });
      return;
    }
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(1, t + this.mix.bgmFadeMs / 1000);
      src.connect(gain).connect(this.bus.bgm);
      src.start();
      this.bgmSrc = { src, gain };
    } catch {
      this.bgmSrc = null;
    }
  }

  stopBgm(): void {
    this.bgmId = null;
    this.fadeOutBgm();
  }

  private fadeOutBgm(): void {
    const old = this.bgmSrc;
    this.bgmSrc = null;
    if (!old || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0, t + this.mix.bgmFadeMs / 1000);
      old.src.stop(t + this.mix.bgmFadeMs / 1000 + 0.05);
    } catch {
      /* 既に停止 */
    }
  }

  // ---- SE ----

  /** 効果音：同じIDの同一フレーム重複・最短間隔内は1回にまとめる。同時発音上限を超えたら鳴らさない */
  playSfx(id: SfxId, delayMs = 0): boolean {
    const t = this.now() + delayMs;
    const last = this.lastSfx.get(id);
    const minGap = Math.max(this.mix.sameFrameMs, SFX_MIN_INTERVAL_MS[id] ?? 0);
    if (last !== undefined && t - last < minGap) {
      this.record({ t, kind: 'sfx', id, skipped: 'duplicate' });
      return false;
    }
    this.sfxPlaying = this.sfxPlaying.filter((p) => p.endT > t);
    if (this.sfxPlaying.length >= this.mix.maxSfx) {
      this.record({ t, kind: 'sfx', id, skipped: 'polyphony' });
      return false;
    }
    this.lastSfx.set(id, t);
    const file = sfxFile(id);
    const p = this.start(file, 'sfx', delayMs);
    this.sfxPlaying.push({ id, prio: 0, endT: t + (this.durationMs(file) ?? 200), src: p?.src ?? null, gain: p?.gain ?? null });
    this.record({ t, kind: 'sfx', id, skipped: p || !this.ctx ? undefined : this.skipReason(file) });
    return true;
  }

  private skipReason(file: string): 'missing' | 'decoding' {
    return this.raw.has(file) ? 'decoding' : 'missing';
  }

  // ---- ボイス ----

  /**
   * ボイス：main は全体で1本。優先度の低い声は鳴っている高い声を切らず、長い待ち行列にも溜めない（捨てる）。
   * 同等以上の優先度なら現在の声を止めて再生。announce は開始アナウンス1本。
   * result は結果の敗者→勝者の2声で、短い重なりを許容する（互いに切らない）。結果は main を中断できる。
   */
  playVoice(c: Character, line: VoiceLine, prio: number, channel: VoiceChannel = 'main', delayMs = 0): boolean {
    const t = this.now() + delayMs;
    const id = `${c}_${line}`;
    for (const ch of Object.keys(this.voices) as VoiceChannel[]) this.voices[ch] = this.voices[ch].filter((p) => p.endT > t);
    const cur = this.voices[channel];
    if (channel === 'main' && cur.length > 0 && cur[0].prio > prio) {
      this.record({ t, kind: 'voice', id, channel, skipped: 'priority' });
      return false;
    }
    if (channel !== 'result') this.stopChannel(channel);
    if (channel === 'result') this.stopChannel('main');
    const file = voiceFile(c, line);
    const p = this.start(file, 'voice', delayMs);
    const dur = this.durationMs(file) ?? 600;
    this.voices[channel].push({ id, prio, endT: t + dur, src: p?.src ?? null, gain: p?.gain ?? null });
    this.record({ t, kind: 'voice', id, channel, skipped: p || !this.ctx ? undefined : this.skipReason(file) });
    this.updateDuck(t, dur);
    return true;
  }

  /** 次ラウンド・再戦・メニュー復帰時：前の演出の声とSEを持ち越さない */
  stopEffects(): void {
    for (const ch of Object.keys(this.voices) as VoiceChannel[]) this.stopChannel(ch);
    for (const p of this.sfxPlaying) this.stopNode(p);
    this.sfxPlaying = [];
    this.updateDuck(this.now(), 0);
  }

  /** 結果へ遷移する時：プレイ中の声（main）と鳴り残りのSEを止める */
  stopPlaySounds(): void {
    this.stopChannel('main');
    for (const p of this.sfxPlaying) this.stopNode(p);
    this.sfxPlaying = [];
  }

  voicesPlaying(channel?: VoiceChannel): string[] {
    const t = this.now();
    const chs = channel ? [channel] : (Object.keys(this.voices) as VoiceChannel[]);
    return chs.flatMap((ch) => this.voices[ch].filter((p) => p.endT > t).map((p) => p.id));
  }

  private stopChannel(ch: VoiceChannel): void {
    for (const p of this.voices[ch]) this.stopNode(p);
    this.voices[ch] = [];
  }

  private stopNode(p: Playing): void {
    if (!p.src || !this.ctx || !p.gain) return;
    try {
      const t = this.ctx.currentTime;
      p.gain.gain.setTargetAtTime(0, t, 0.01);
      p.src.stop(t + 0.05);
    } catch {
      /* 既に停止 */
    }
  }

  private duckUntil = 0;

  /** ボイス中はBGMを −4dB（復帰は自然に） */
  private updateDuck(t: number, durMs: number): void {
    this.duckUntil = Math.max(t + durMs, this.voicesPlaying().length ? this.duckUntil : 0);
    if (!this.duck || !this.ctx) return;
    const ct = this.ctx.currentTime;
    const active = this.voicesPlaying().length > 0;
    const g = this.duck.gain;
    g.cancelScheduledValues(ct);
    g.setValueAtTime(g.value, ct);
    if (active) {
      g.linearRampToValueAtTime(dbToGain(this.mix.duckDb), ct + this.mix.duckAttackMs / 1000);
      const end = ct + Math.max(0, this.duckUntil - t) / 1000;
      g.setValueAtTime(dbToGain(this.mix.duckDb), Math.max(ct + this.mix.duckAttackMs / 1000, end));
      g.linearRampToValueAtTime(1, Math.max(ct + this.mix.duckAttackMs / 1000, end) + this.mix.duckReleaseMs / 1000);
    } else {
      g.linearRampToValueAtTime(1, ct + this.mix.duckReleaseMs / 1000);
    }
  }

  private start(file: string, cat: 'sfx' | 'voice', delayMs: number): { src: AudioBufferSourceNode; gain: GainNode } | null {
    const ctx = this.ctx;
    const buf = this.buffers.get(file);
    if (!ctx || !this.bus || !buf) {
      // 取得済みでデコード待ちのものは missing にしない（unlock直後の決定音など）
      if (this.ctx && !buf && !this.raw.has(file)) this.missing.add(file);
      return null;
    }
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      src.connect(gain).connect(this.bus[cat]);
      src.start(ctx.currentTime + Math.max(0, delayMs) / 1000);
      return { src, gain };
    } catch {
      return null;
    }
  }
}
