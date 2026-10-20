// 実再生ノードの開始・途中停止を、最小の模擬 AudioContext で検査する（再生要求ログだけで合格にしない）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioBus } from '../src/audio/audioBus';
import { SoundDirector } from '../src/audio/director';
import { sfxFile, VOICE_PRIORITY, voiceFile } from '../src/audio/audioMap';
import type { AnyGame } from '../src/core/match';

class FakeParam {
  value = 1;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
class FakeNode {
  gain = new FakeParam();
  buffer: unknown = null;
  loop = false;
  started: number | null = null;
  stopped: number | null = null;
  connect(n: unknown) {
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
  decodeAudioData(_: ArrayBuffer) {
    return Promise.resolve({ duration: 1.5 });
  }
}

const g = globalThis as unknown as { window?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.window;
  g.window = { AudioContext: FakeContext };
});
afterEach(() => {
  g.window = saved;
});

async function readyBus(files: string[]) {
  let t = 0;
  const bus = new AudioBus('./', undefined, () => t);
  await bus.preload(files, async () => new Response(new ArrayBuffer(16)));
  await bus.unlock();
  return { bus, ctx: FakeContext.last, at: (ms: number) => ((t = ms), (FakeContext.last.currentTime = ms / 1000)) };
}

describe('結果・クリアの効果音は、結果遷移の停止処理で途中停止しない（R3）', () => {
  const files = ['stage_clear', 'all_stages_clear', 'all_clear', 'piece_success', 'win'].map((id) => sfxFile(id as never));

  it('stageClear → roundEnd が同じイベント列でも stage_clear は終端まで鳴る。通常SEは止める', async () => {
    const { bus, at } = await readyBus([...files, voiceFile('kotaro', 'attack')]);
    at(1000);
    const events = [
      { type: 'arrive', tick: 60, player: 0, success: true },
      { type: 'allClear', tick: 60, player: 0 },
      { type: 'stageClear', tick: 60, player: 0, stage: 1, final: false },
      { type: 'roundEnd', tick: 60 },
    ];
    const game = { events, mode: 'mode1', playing: false, players: [] } as unknown as AnyGame;
    bus.playVoice('kotaro', 'attack', VOICE_PRIORITY.attack);
    new SoundDirector(bus, game).sync();
    at(1010);
    const rec = (id: string) => bus.nodes.find((n) => n.id === id)!;
    expect(rec('stage_clear')).toMatchObject({ kind: 'sfx', stoppedAt: null });
    expect(rec('all_clear').stoppedAt).toBeNull();
    expect(rec('piece_success').stoppedAt).not.toBeNull(); // 鳴り残りの通常SEは止める
    expect(rec('kotaro_attack').stoppedAt).not.toBeNull(); // プレイ中の声も止める
  });

  it('最終面クリア（all_stages_clear）も途中停止しない。次ラウンド・メニュー復帰（stopEffects）では止める', async () => {
    const { bus, at } = await readyBus(files);
    at(500);
    const game = { events: [{ type: 'stageClear', tick: 1, player: 0, stage: 10, final: true }, { type: 'roundEnd', tick: 1 }], mode: 'mode1', players: [] } as unknown as AnyGame;
    new SoundDirector(bus, game).sync();
    expect(bus.nodes.find((n) => n.id === 'all_stages_clear')!.stoppedAt).toBeNull();
    at(700);
    bus.stopEffects();
    expect(bus.nodes.find((n) => n.id === 'all_stages_clear')!.stoppedAt).toBeCloseTo(0.7);
  });

  it('対戦結果への遷移では通常のSEとプレイ中の声を止める（回帰）、結果SE（win）は残す', async () => {
    const { bus, at } = await readyBus(files);
    at(100);
    bus.playSfx('piece_success');
    bus.playSfx('win');
    bus.stopPlaySounds();
    expect(bus.nodes.find((n) => n.id === 'piece_success')!.stoppedAt).not.toBeNull();
    expect(bus.nodes.find((n) => n.id === 'win')!.stoppedAt).toBeNull();
  });
});

describe('音声の有効化（R1 の基盤）', () => {
  it('unlock は1回だけ AudioContext を作り、試行済みを記録する。素材をデコードして再生ノードを作れる', async () => {
    const { bus, ctx } = await readyBus([sfxFile('go')]);
    expect(bus.unlockAttempted).toBe(true);
    expect(bus.unlocked).toBe(true);
    await bus.unlock();
    expect(FakeContext.last).toBe(ctx);
    bus.playSfx('go');
    expect(ctx.sources.at(-1)!.started).not.toBeNull();
  });
});
