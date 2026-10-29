// v3.1.0 採用ボイス（差替え11本・ピンチ3本）の組み込み：素材の照合、登録、ピンチボイスの抽選・上限・競合、
// 代替攻撃ボイスと役名ボイスの排他、長いボイスが固定長で切られないこと。
// 実再生ノードは最小の模擬 AudioContext で検査する（素材の長さは実WAVのヘッダから求める。聴感の確認ではない）
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioBus, dbToGain, DEFAULT_MIX, wavDurationMs } from '../src/audio/audioBus';
import { allAudioFiles, CHARACTERS, PINCH_VOICE, PINCH_VOICE_REGISTERED, ROLE_ALT_ATTACK_VOICE_PCT, VOICE_PRIORITY, voiceFile, type Character, type VoiceLine } from '../src/audio/audioMap';
import { SoundDirector } from '../src/audio/director';
import type { Command, Game, GameEvent } from '../src/core/game';
import type { Rng } from '../src/core/rng';
import type { PlayerId } from '../src/core/types';
import { planResult, RoleNameDirector } from '../src/view/presentation';
import { EMPTY, makeGame, rows, ROOT, stepN, testConfig, toPlay } from './helpers';

/** 納品 voice_manifest.csv（candidates/A）の SHA-256 と実尺 */
const ADOPTED: Record<string, { sha256: string; sec: number; added?: true }> = {
  voice_akane_role_09: { sha256: 'c37a46fb61e539dd273d2d71b262a772a5d955ac2ab6d616df0e2817bf354203', sec: 0.814312 },
  voice_akane_attack: { sha256: '5f76b2603d4ab4d67902addcc940056e27315e10109d36e28b9b186b7ab4d0dc', sec: 1.152729 },
  voice_akane_lose: { sha256: 'b6128366614b794600b768590456e431211b1658e441c8f560bdc48ed534831e', sec: 1.451521 },
  voice_akane_role_fail: { sha256: 'e8cf3d85becd5e9d78da64f100b23579234d1b1af8339f044e42bd96834da2a3', sec: 1.191208 },
  voice_akane_select: { sha256: 'ba97a2d2988e8ef83f8d9a3c0427a988ea246078a6d95a50c4d4f5d067265579', sec: 1.428833 },
  voice_akane_win: { sha256: '402533b06a7bbb44f693d35c0ce68a35d2c4e08069c7c0636038f5a141e6b0b1', sec: 1.226312 },
  voice_zunko_attack: { sha256: '45d66021ecdbcc0447eb07edf1465c0fcf9871e206da2e5c9619d102dbad7436', sec: 1.089396 },
  voice_zunko_lose: { sha256: '8dc27ce8eb9a5fefc27927c01f9589c492ec0a283c6bc4c29f4df042e0e2998b', sec: 1.513688 },
  voice_zunko_role_fail: { sha256: '81b8dbc782d0fbd13ff5232c8363c82ad97dfb0f36d76801521534ad892a03fd', sec: 0.711958 },
  voice_zunko_select: { sha256: '443f2be070e229eaa31e86dff61b646ed36a204805ffe43f002466d0578836ed', sec: 1.343729 },
  voice_zunko_win: { sha256: '4a34d63ca3423c9405950f0963799878655cdf4f9782d45b0f853d7e3e771cec', sec: 1.372542 },
  voice_akane_pinch: { sha256: 'd258dab3426975471a20712e46c568fdb2f566ffe2a085bc7ea9619a7cbc1b07', sec: 1.306896, added: true },
  voice_zunko_pinch: { sha256: 'cc9d2f3aab1869331df7b9ce4d44db1fa7cdec8986ec56e7d75ae48c5ee1a6e2', sec: 1.170208, added: true },
  voice_kotaro_pinch: { sha256: '111c3fe158980475fd6e0bba4e7f89c91f4273eb913d65d592f57b5004539e40', sec: 1.53, added: true },
};

const readVoice = (f: string) => readFileSync(new URL(`public/assets/audio/${f}`, ROOT));

describe('v3.1.0 採用ボイス14本の照合と登録', () => {
  it('差替え11本・追加3本がリポジトリにあり、SHA-256・形式（48kHz/16bit/mono）・実尺が納品マニフェストと一致する', () => {
    for (const [name, m] of Object.entries(ADOPTED)) {
      const b = readVoice(`voice/${name}.wav`);
      expect(createHash('sha256').update(b).digest('hex'), name).toBe(m.sha256);
      expect([b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)], name).toEqual([1, 48000, 16]);
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      expect(wavDurationMs(ab)! / 1000, name).toBeCloseTo(m.sec, 5);
    }
    expect(Object.values(ADOPTED).filter((m) => !m.added)).toHaveLength(11);
  });

  it('ピンチボイス3本は3キャラとも登録・必須読込（117本）。既存の対応名（attack／lose／role_fail／select／win／role_09）は変えない', () => {
    for (const c of CHARACTERS) {
      expect(PINCH_VOICE_REGISTERED[c], c).toBe(true);
      expect(allAudioFiles()).toContain(voiceFile(c, 'pinch'));
    }
    expect(allAudioFiles()).toHaveLength(117);
    for (const name of Object.keys(ADOPTED)) {
      const [, c, ...line] = name.split('_');
      expect(allAudioFiles()).toContain(voiceFile(c as Character, line.join('_') as VoiceLine));
    }
    expect(PINCH_VOICE).toEqual({ pct: 30, maxPerPinch: 1 });
    expect(ROLE_ALT_ATTACK_VOICE_PCT).toBe(20);
    expect(VOICE_PRIORITY.pinch).toBeLessThan(Math.min(VOICE_PRIORITY.fail, VOICE_PRIORITY.role, VOICE_PRIORITY.start, VOICE_PRIORITY.result));
  });
});

// ---------------------------------------------------------------- 模擬 AudioContext（素材の長さは実WAVから）

class FakeParam {
  value = 1;
  target: number | null = null;
  ramps: number[] = [];
  setValueAtTime() {}
  linearRampToValueAtTime(v: number) {
    this.ramps.push(v);
  }
  setTargetAtTime(v: number) {
    this.target = v;
  }
  cancelScheduledValues() {}
}
class FakeNode {
  gain = new FakeParam();
  buffer: unknown = null;
  loop = false;
  to: unknown = null;
  started: number | null = null;
  stopped: number | null = null;
  connect(n: unknown) {
    this.to = n;
    return n;
  }
  start(t = 0) {
    this.started = t;
  }
  stop(t = 0) {
    this.stopped = t;
  }
}
class FakeContext {
  static last: FakeContext;
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: FakeNode[] = [];
  constructor() {
    FakeContext.last = this;
  }
  resume() {
    return Promise.resolve();
  }
  createGain() {
    return new FakeNode();
  }
  createBufferSource() {
    const n = new FakeNode();
    this.sources.push(n);
    return n;
  }
  decodeAudioData(data: ArrayBuffer) {
    return Promise.resolve({ duration: (wavDurationMs(data) ?? 0) / 1000 });
  }
}

const gw = globalThis as unknown as { window?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = gw.window;
  gw.window = { AudioContext: FakeContext };
});
afterEach(() => {
  gw.window = saved;
});

const ALL_VOICES = CHARACTERS.flatMap((c) => (['pinch', 'attack', 'role_09', 'role_03', 'role_fail', 'select', 'ready', 'go', 'win', 'lose'] as VoiceLine[]).map((l) => voiceFile(c, l)));

async function realBus() {
  let t = 0;
  const bus = new AudioBus('./', DEFAULT_MIX, () => t);
  await bus.preload(ALL_VOICES, async (u) => {
    const b = readVoice(u.replace('./assets/audio/', ''));
    return new Response(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  });
  await bus.unlock();
  const ctx = FakeContext.last;
  const at = (ms: number) => ((t = ms), (ctx.currentTime = ms / 1000));
  return { bus, ctx, at, nodes: (id: string) => bus.nodes.filter((n) => n.id === id) };
}

describe('v3.1.0 ピンチボイスの再生（AudioBus：低優先度・競合時は捨てる・重要ボイスで止める）', () => {
  it('他の声がなければ main で実ファイル尺どおり再生。ボイス音量・マスター・BGM減衰の経路を通る', async () => {
    const { bus, ctx, at, nodes } = await realBus();
    at(1000);
    expect(bus.playOptionalVoice('kotaro', 'pinch', VOICE_PRIORITY.pinch)).toBe(true);
    const [rec] = nodes('kotaro_pinch');
    expect(rec.duration).toBeCloseTo(1.53, 5);
    expect(bus.voicesPlaying('main')).toEqual(['kotaro_pinch']);
    // 経路：source → イベントゲイン → ボイスのカテゴリゲイン（→ マスター）
    const src = ctx.sources.at(-1)!;
    const voiceBus = (bus as unknown as { bus: { voice: FakeNode } }).bus.voice;
    const master = (bus as unknown as { master: FakeNode }).master;
    expect((src.to as FakeNode).to).toBe(voiceBus);
    expect(voiceBus.to).toBe(master);
    expect(master.gain.value).toBeCloseTo(dbToGain(DEFAULT_MIX.masterDb), 6);
    // ボイス中は BGM を −4dB
    const duck = (bus as unknown as { duck: FakeNode }).duck;
    expect(duck.gain.ramps).toContain(dbToGain(DEFAULT_MIX.duckDb));
    // 音量設定：ボイス0・ミュートでカテゴリゲイン0、50で (0.5)^2
    bus.setVolumes({ bgm: 100, sfx: 100, voice: 50, bgmMute: false, sfxMute: false, voiceMute: false });
    expect(voiceBus.gain.target).toBeCloseTo(0.25, 6);
    bus.setVolumes({ bgm: 100, sfx: 100, voice: 100, bgmMute: false, sfxMute: false, voiceMute: true });
    expect(voiceBus.gain.target).toBe(0);
    // 終端まで止めない（固定長で切らない）
    at(1000 + 1529);
    expect(bus.voicesPlaying('main')).toEqual(['kotaro_pinch']);
    at(1000 + 1531);
    expect(bus.voicesPlaying()).toEqual([]);
    expect(rec.stoppedAt).toBeNull();
  });

  it.each([
    ['READY（announce）', (b: AudioBus) => b.playVoice('akane', 'ready', VOICE_PRIORITY.start, 'announce')],
    ['キャラ選択（select）', (b: AudioBus) => b.playVoice('zunko', 'select', VOICE_PRIORITY.start, 'select')],
    ['結果（result）', (b: AudioBus) => b.playVoice('akane', 'lose', VOICE_PRIORITY.result, 'result')],
    ['役名（main）', (b: AudioBus) => b.playVoice('akane', 'role_09', VOICE_PRIORITY.role)],
    ['代替の攻撃ボイス（main）', (b: AudioBus) => b.playVoice('zunko', 'attack', VOICE_PRIORITY.role)],
    ['役不成立（main）', (b: AudioBus) => b.playVoice('akane', 'role_fail', VOICE_PRIORITY.fail)],
    ['遅延開始の予約（result 300ms 後）', (b: AudioBus) => b.playVoice('akane', 'win', VOICE_PRIORITY.result, 'result', 300)],
  ])('%s が鳴っている（予約中）ならピンチボイスは鳴らさず捨てる。後から再生もしない', async (_name, important) => {
    const { bus, at, nodes } = await realBus();
    at(1000);
    important(bus);
    const before = bus.nodes.length;
    expect(bus.playOptionalVoice('akane', 'pinch', VOICE_PRIORITY.pinch)).toBe(false);
    expect(bus.log.at(-1)).toMatchObject({ id: 'akane_pinch', skipped: 'busy' });
    for (const ms of [1100, 1500, 2000, 3000, 5000]) at(ms);
    expect(nodes('akane_pinch')).toEqual([]);
    expect(bus.nodes.length).toBe(before);
    // 先行する声は止めていない
    expect(bus.nodes.every((n) => n.stoppedAt === null)).toBe(true);
  });

  it.each([
    ['GO（announce）', (b: AudioBus) => b.playVoice('kotaro', 'go', VOICE_PRIORITY.start, 'announce'), 'kotaro_go'],
    ['キャラ選択（select）', (b: AudioBus) => b.playVoice('zunko', 'select', VOICE_PRIORITY.start, 'select'), 'zunko_select'],
    ['結果（result）', (b: AudioBus) => b.playVoice('zunko', 'win', VOICE_PRIORITY.result, 'result'), 'zunko_win'],
    ['役名（main）', (b: AudioBus) => b.playVoice('akane', 'role_03', VOICE_PRIORITY.role), 'akane_role_03'],
    ['代替の攻撃ボイス（main）', (b: AudioBus) => b.playVoice('akane', 'attack', VOICE_PRIORITY.role), 'akane_attack'],
    ['役不成立（main）', (b: AudioBus) => b.playVoice('kotaro', 'role_fail', VOICE_PRIORITY.fail), 'kotaro_role_fail'],
  ])('ピンチボイス再生中に %s が始まれば、ピンチボイスを止めて重要ボイスを鳴らす', async (_name, important, id) => {
    const { bus, at, nodes } = await realBus();
    at(1000);
    bus.playOptionalVoice('zunko', 'pinch', VOICE_PRIORITY.pinch);
    at(1400);
    expect(important(bus)).toBe(true);
    expect(nodes('zunko_pinch')[0].stoppedAt).toBeCloseTo(1.4, 6);
    expect(nodes(id)).toHaveLength(1);
    expect(nodes(id)[0].stoppedAt).toBeNull();
    expect(bus.voicesPlaying()).toEqual([id]);
  });

  it('ピンチボイス同士・ピンチ中の2人目：先行する声があれば鳴らさない（1P のピンチ中に 2P がピンチ到達）', async () => {
    const { bus, at, nodes } = await realBus();
    at(0);
    expect(bus.playOptionalVoice('kotaro', 'pinch', VOICE_PRIORITY.pinch)).toBe(true);
    at(500);
    expect(bus.playOptionalVoice('akane', 'pinch', VOICE_PRIORITY.pinch)).toBe(false);
    expect(nodes('kotaro_pinch')[0].stoppedAt).toBeNull();
    expect(nodes('akane_pinch')).toEqual([]);
  });

  it('次ラウンド・再戦・メニュー復帰（stopEffects）と結果移行（stopPlaySounds）でピンチボイスを止め、持ち越さない', async () => {
    for (const stop of [(b: AudioBus) => b.stopEffects(), (b: AudioBus) => b.stopPlaySounds()]) {
      const { bus, at, nodes } = await realBus();
      at(0);
      bus.playOptionalVoice('akane', 'pinch', VOICE_PRIORITY.pinch);
      at(300);
      stop(bus);
      expect(nodes('akane_pinch')[0].stoppedAt).toBeCloseTo(0.3, 6);
      expect(bus.voicesPlaying()).toEqual([]);
    }
  });
});

describe('v3.1.0 長いボイスを固定長で切らない（選択・結果・役名・役不成立）', () => {
  it('キャラ選択の決定ボイス（アカネ1.43秒・ずん子1.34秒）は試合への遷移（select を残す stopEffects）と READY で止めない', async () => {
    const { bus, at, nodes } = await realBus();
    at(0);
    bus.playVoice('akane', 'select', VOICE_PRIORITY.start, 'select');
    bus.playVoice('zunko', 'select', VOICE_PRIORITY.start, 'select');
    at(20);
    bus.stopEffects(['select']); // App.startGame（keepSelectVoices）
    at(1030); // 開始前待機 1000ms の後に READY
    bus.playVoice('kotaro', 'ready', VOICE_PRIORITY.start, 'announce');
    at(1428);
    expect(bus.voicesPlaying('select').sort()).toEqual(['akane_select']);
    at(1430);
    for (const id of ['akane_select', 'zunko_select']) {
      expect(nodes(id)[0].stoppedAt, id).toBeNull();
      expect(nodes(id)[0].duration, id).toBeCloseTo(ADOPTED[`voice_${id}`].sec, 5);
    }
  });

  it('結果：敗北ボイス（ずん子1.51秒）は勝者演出（結果開始から約1533ms）より前に終わり、勝利ボイスでも止めない。勝利ボイスは終端まで', async () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    (g as unknown as { result: unknown }).result = { outcome: 'win', winner: 1, tick: 0 };
    const plan = planResult(g)!;
    expect(plan.kind).toBe('versus');
    const winnerMs = ((plan.winnerTick ?? 0) - plan.startTick) * g.tickMs;
    expect(winnerMs).toBeCloseTo(1533.33, 1); // 640+700+200ms を tick へ丸めた実時刻（38+42+12=92tick）
    for (const c of ['akane', 'zunko'] as const) expect(ADOPTED[`voice_${c}_lose`].sec * 1000).toBeLessThan(winnerMs);
    const { bus, at, nodes } = await realBus();
    at(0);
    bus.playVoice('zunko', 'lose', VOICE_PRIORITY.result, 'result');
    at(winnerMs);
    bus.playVoice('akane', 'win', VOICE_PRIORITY.result, 'result');
    at(winnerMs + 1300);
    expect(nodes('zunko_lose')[0].stoppedAt).toBeNull();
    expect(nodes('akane_win')[0].stoppedAt).toBeNull();
    expect(bus.voicesPlaying('result')).toEqual([]);
  });

  it('役不成立（アカネ1.19秒）・代替攻撃（アカネ1.15秒）は実尺で鳴り、時間経過では止めない', async () => {
    const { bus, at, nodes } = await realBus();
    at(0);
    bus.playVoice('akane', 'role_fail', VOICE_PRIORITY.fail);
    at(1192);
    expect(nodes('akane_role_fail')[0].stoppedAt).toBeNull();
    bus.playVoice('akane', 'attack', VOICE_PRIORITY.role);
    at(2400);
    expect(nodes('akane_attack')[0].stoppedAt).toBeNull();
    expect(nodes('akane_attack')[0].duration).toBeCloseTo(1.152729, 5);
  });
});

// ---------------------------------------------------------------- 抽選（注入した乱数で再現）

/** 指定の値を順に返す乱数（尽きたら失敗させる＝余計な抽選がないことの確認） */
function scripted(values: number[]): Rng & { used: number } {
  const r = {
    used: 0,
    next() {
      if (r.used >= values.length) throw new Error('予定外の抽選');
      return values[r.used++];
    },
  };
  return r;
}

/** ピンチボイスの呼び出しを記録する音声（AudioContext なし） */
function spyBus(busy = false) {
  const optional: string[] = [];
  const bus = {
    playSfx: () => true,
    playVoice: () => true,
    playOptionalVoice: (c: string, line: string) => (busy ? false : (optional.push(`${c}_${line}`), true)),
    voiceDurationMs: () => 800,
    stopPlaySounds: () => undefined,
  } as unknown as AudioBus;
  return { bus, optional };
}

const warn = (g: Game, player: PlayerId, state: 'start' | 'count' | 'end', tick = g.tick) =>
  (g.events as GameEvent[]).push({ type: 'pinchWarn', tick, player, state, value: null, remainingMs: null });

describe('v3.1.0 ピンチボイスの抽選（到達ごと30%・同じピンチ中1回・解除後は新しい機会）', () => {
  it('到達で1回だけ抽選。当たり（<0.30）で再生、外れでは再生せず同じピンチ中は再抽選しない。解除後の到達で再抽選', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const s = spyBus();
    const rng = scripted([0.31, 0.29]);
    const d = new SoundDirector(s.bus, g, ['zunko', 'akane'], { attachDelayMs: 120, rng });
    warn(g, 0, 'start');
    for (let i = 0; i < 3; i++) warn(g, 0, 'count');
    d.sync();
    expect(rng.used).toBe(1);
    expect(s.optional).toEqual([]); // 外れ（0.31 ≥ 0.30）
    warn(g, 0, 'start'); // 同じピンチ中の重複 start（仮に出ても再抽選しない）
    d.sync();
    expect(rng.used).toBe(1);
    warn(g, 0, 'end');
    warn(g, 0, 'start'); // 解除後の新しいピンチ到達
    d.sync();
    expect(rng.used).toBe(2);
    expect(s.optional).toEqual(['zunko_pinch']);
    expect(d.pinchLog.map((x) => x.result)).toEqual(['miss', 'played']);
  });

  it('鳴らせなかった（他の声と競合）場合も同じピンチ中は再抽選・後から再生しない。代表ボイスの予定があれば鳴らさない', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const busy = spyBus(true);
    const rng = scripted([0.0, 0.0]);
    const d = new SoundDirector(busy.bus, g, ['kotaro', 'akane'], { attachDelayMs: 120, rng });
    warn(g, 0, 'start');
    warn(g, 0, 'count');
    d.sync();
    expect(d.pinchLog.map((x) => x.result)).toEqual(['busy']);
    for (let i = 0; i < 5; i++) warn(g, 0, 'count');
    d.sync();
    expect(rng.used).toBe(1);
    // 代表ボイスの予定（表示待ち・未取り込みの宣言）がある場合
    const g2 = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const free = spyBus();
    const d2 = new SoundDirector(free.bus, g2, ['kotaro', 'akane'], { attachDelayMs: 120, rng: scripted([0.0]), roleVoiceImminent: () => true });
    warn(g2, 1, 'start');
    d2.sync();
    expect(free.optional).toEqual([]);
    expect(d2.pinchLog.map((x) => x.result)).toEqual(['busy']);
  });

  it('プレイヤー別に独立。新ラウンド（reset）で抽選状態を持ち越さず、ラウンド終了後は抽選しない', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const s = spyBus();
    const rng = scripted([0.9, 0.1, 0.1]);
    const d = new SoundDirector(s.bus, g, ['kotaro', 'zunko'], { attachDelayMs: 120, rng });
    warn(g, 0, 'start');
    warn(g, 1, 'start');
    d.sync();
    expect(s.optional).toEqual(['zunko_pinch']);
    // 1P はピンチのまま新ラウンドへ（end なし）→ 新ラウンドでは新しい機会
    const g2 = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    d.reset(g2);
    warn(g2, 0, 'start');
    (g2.events as GameEvent[]).push({ type: 'roundEnd', tick: g2.tick, winner: 1, outcome: 'versus' } as unknown as GameEvent);
    warn(g2, 1, 'start');
    d.sync();
    expect(s.optional).toEqual(['zunko_pinch', 'kotaro_pinch']);
    expect(rng.used).toBe(3);
  });

  it('実ゲーム：自然上昇の危険猶予から攻撃ピンチへ原因が移っても、同じ連続ピンチでは抽選1回（上限は戻らない）', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } }, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    const s = spyBus();
    const rng = scripted([0.0]);
    const d = new SoundDirector(s.bus, g, ['akane', 'zunko'], { attachDelayMs: 120, rng });
    while (!g.events.some((e) => e.type === 'danger')) g.step();
    g.step([{ player: 0, type: 'debugAttack', lines: 3 } as Command]);
    stepN(g, 150);
    d.sync();
    expect(g.events.filter((e) => e.type === 'pinchWarn' && e.player === 0 && e.state === 'start')).toHaveLength(1);
    expect(rng.used).toBe(1);
    expect(s.optional).toEqual(['akane_pinch']);
  });

  it('確率の再現検査：seed 固定の既定乱数で 20000 回の到達を抽選すると当たりは 30%±1%（手動の繰り返しではない）', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const s = spyBus();
    const d = new SoundDirector(s.bus, g, ['kotaro', 'akane'], { attachDelayMs: 120, seed: 12345 });
    for (let i = 0; i < 20000; i++) {
      warn(g, 0, 'start', i);
      warn(g, 0, 'end', i);
    }
    d.sync();
    const rate = s.optional.length / 20000;
    expect(rate).toBeGreaterThan(0.29);
    expect(rate).toBeLessThan(0.31);
  });
});

describe('v3.1.0 代替攻撃ボイスと役名ボイス：同時に鳴らさない（実再生ノード）', () => {
  it('宣言ごとに一方だけ。代表ボイスの再生中に次の宣言の代表ボイスが始まっても、同時に鳴るのは常に1本', async () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const { bus, at } = await realBus();
    const dir = new RoleNameDirector(g, bus, ['akane', 'zunko'], undefined, 99, 50);
    const declares = [5, 40, 80, 81, 200, 260];
    for (let t = 0; t <= 400; t++) {
      (g as { tick: number }).tick = t;
      at(t * g.tickMs);
      for (const [i, d] of declares.entries()) if (d === t) (g.events as GameEvent[]).push({ type: 'declare', tick: t, player: (i % 2) as PlayerId, logos: [8, 2], chainCount: 1 } as unknown as GameEvent);
      dir.update();
      const playing = bus.voicesPlaying('main');
      expect(playing.length, `tick ${t}`).toBeLessThanOrEqual(2); // 1P・2P が各1本まで（同じ人の役名と攻撃が同時になることはない）
      for (const c of ['akane', 'zunko']) expect(playing.filter((id) => id.startsWith(c)).length, `tick ${t} ${c}`).toBeLessThanOrEqual(1);
    }
    expect(dir.voiceLog).toHaveLength(declares.length);
    // 宣言1件につき代表ボイスの再生要求は1本（役名か攻撃のどちらか）
    const voiced = bus.log.filter((e) => e.kind === 'voice' && !e.skipped);
    expect(voiced.length).toBeLessThanOrEqual(declares.length);
    expect(voiced.every((e) => /_(attack|role_09)$/.test(e.id))).toBe(true);
  });

  it('表示待ちの宣言・未取り込みの宣言があれば roleVoiceImminent が真（ピンチボイスを鳴らさない判定）', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const dir = new RoleNameDirector(g, null, ['akane', 'zunko'], undefined, 1, 0);
    expect(dir.roleVoiceImminent()).toBe(false);
    (g.events as GameEvent[]).push({ type: 'declare', tick: 0, player: 0, logos: [8], chainCount: 1 } as unknown as GameEvent);
    expect(dir.roleVoiceImminent()).toBe(true); // 同じフレームで後から代表ボイスが始まる
    dir.update();
    expect(dir.roleVoiceImminent()).toBe(false); // 再生開始済み（鳴っている声は AudioBus 側で判定）
    (g as { tick: number }).tick = 5;
    (g.events as GameEvent[]).push({ type: 'declare', tick: 5, player: 0, logos: [3], chainCount: 2 } as unknown as GameEvent);
    // V320-FIX-05 で更新：先頭ロゴ表示中の新宣言も即開始（表示待ちを作らない）→ 取り込み後は予定なし
    expect(dir.roleVoiceImminent()).toBe(true); // 未取り込みの宣言
    dir.update();
    expect(dir.roleVoiceImminent()).toBe(false);
  });
});
