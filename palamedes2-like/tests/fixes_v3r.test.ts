// 第3版 修正R1〜R4（2026-10-22 修正範囲の確定指示）の回帰。R1 は tests/v3view.test.ts の受攻撃ストック配置。
import { describe, expect, it } from 'vitest';
import { AudioBus, DEFAULT_MIX } from '../src/audio/audioBus';
import { VOICE_PRIORITY } from '../src/audio/audioMap';
import { SoundDirector } from '../src/audio/director';
import type { Command, Game } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import { fixedScaleChoices, MAX_FIXED_SCALE, resolveScale } from '../src/view/scale';
import { EMPTY, makeGame, rows, setStock, stepN, toPlay } from './helpers';

const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });

/** 効果音の要求を記録するだけの音声（AudioContext なし） */
function recordingBus() {
  const sfx: { id: string; delay: number }[] = [];
  const bus = { playSfx: (id: string, delay = 0) => (sfx.push({ id, delay }), true), playVoice: () => true, stopPlaySounds: () => undefined } as unknown as AudioBus;
  return { bus, sfx, count: (id: string) => sfx.filter((s) => s.id === id).length };
}

function runWithDirector(g: Game, steps: (g: Game) => void) {
  const r = recordingBus();
  const d = new SoundDirector(r.bus, g, ['kotaro', 'akane']);
  steps(g);
  d.sync();
  return r;
}

describe('修正R2：攻撃段の上昇音', () => {
  it('3段の実適用で上昇音3回・接着音3回。上昇音は適用tick（遅延なし）、接着音は飛来後（120ms）', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    toPlay(g);
    const r = runWithDirector(g, (g) => {
      g.step([atk(0, 3)]);
      stepN(g, 200);
    });
    expect(g.events.filter((e) => e.type === 'attackRow')).toHaveLength(3);
    expect(g.events.filter((e) => e.type === 'rise' && e.kind === 'attack')).toHaveLength(3);
    expect(r.count('field_rise')).toBe(3);
    expect(r.count('attack_row')).toBe(3);
    expect(r.sfx.filter((s) => s.id === 'field_rise').every((s) => s.delay === 0)).toBe(true);
    expect(r.sfx.filter((s) => s.id === 'attack_row').every((s) => s.delay === 120)).toBe(true);
  });

  it('7段到達で破棄・保留した段では鳴らさない（実適用2段＝上昇音2回）', () => {
    const g = makeGame({ boards: { 0: rows(5), 1: EMPTY } });
    toPlay(g);
    const r = runWithDirector(g, (g) => {
      g.step([atk(0, 5)]);
      stepN(g, 400);
    });
    expect(g.events.filter((e) => e.type === 'attackDiscard')).toHaveLength(1);
    const applied = g.events.filter((e) => e.type === 'attackRow').length;
    expect(applied).toBe(2);
    expect(r.count('field_rise')).toBe(applied);
    expect(r.count('attack_row')).toBe(applied);
  });

  it('役処理による保留後も、実適用1段につき1回（同じ上昇で二重に鳴らさない）', () => {
    const g = makeGame({ boards: { 0: rows(1), 1: EMPTY } });
    toPlay(g);
    const r = runWithDirector(g, (g) => {
      g.step([atk(0, 3)]);
      stepN(g, 120);
      setStock(g, 0, '1s', '2s', '3s', '4s');
      g.step([{ player: 0, type: 'declare' }]);
      stepN(g, 500);
    });
    // 1Pの3段（保留をはさむ）と、宣言の攻撃で2Pに入った段の合計
    const all = g.events.filter((e) => e.type === 'attackRow');
    const p1 = all.filter((e) => e.player === 0);
    expect(p1).toHaveLength(3);
    expect(new Set(p1.map((e) => e.tick)).size).toBe(3);
    expect(r.count('field_rise')).toBe(all.length);
    expect(r.count('attack_row')).toBe(all.length);
  });

  it('自然上昇・手動上昇は従来どおり rise から1回', () => {
    const g = makeGame({ boards: { 0: rows(2), 1: rows(2) } });
    toPlay(g);
    const r = runWithDirector(g, (g) => {
      g.step([{ player: 0, type: 'manualRise' }]);
      stepN(g, 60);
    });
    expect(g.events.filter((e) => e.type === 'rise' && e.kind === 'manual')).toHaveLength(1);
    expect(r.count('field_rise')).toBe(1);
    expect(r.count('attack_row')).toBe(0);
  });
});

describe('修正R3：キャラクター選択の確定ボイス（select チャンネル）', () => {
  const make = () => {
    let t = 0;
    const bus = new AudioBus('./', DEFAULT_MIX, () => t);
    return { bus, at: (ms: number) => (t = ms) };
  };

  it('1P・2Pの確定ボイスは重なってよく、互いに切らない。READY（announce）でも止まらない', () => {
    const { bus, at } = make();
    bus.playVoice('kotaro', 'select', VOICE_PRIORITY.start, 'select');
    at(30);
    bus.playVoice('akane', 'select', VOICE_PRIORITY.start, 'select');
    at(60);
    bus.playVoice('akane', 'ready', VOICE_PRIORITY.start, 'announce');
    expect(bus.voicesPlaying('select')).toEqual(['kotaro_select', 'akane_select']);
  });

  it('選択→試合の遷移（stopEffects に select を残す指定）では止めず、他の声は止める', () => {
    const { bus } = make();
    bus.playVoice('kotaro', 'select', VOICE_PRIORITY.start, 'select');
    bus.playVoice('zunko', 'attack', VOICE_PRIORITY.attack, 'main');
    bus.stopEffects(['select']);
    expect(bus.voicesPlaying()).toEqual(['kotaro_select']);
  });

  it('メニュー復帰・再戦など通常の一括停止では select も止める。取消はその人の声だけを止める', () => {
    const { bus } = make();
    bus.playVoice('kotaro', 'select', VOICE_PRIORITY.start, 'select');
    bus.playVoice('akane', 'select', VOICE_PRIORITY.start, 'select');
    bus.stopVoice('select', 'kotaro_select');
    expect(bus.voicesPlaying('select')).toEqual(['akane_select']);
    bus.stopEffects();
    expect(bus.voicesPlaying()).toEqual([]);
  });
});

describe('修正R4：固定倍率は1〜4倍', () => {
  it('選択肢は×1〜×4、「収まる最大」は独立。収まらない倍率は無効', () => {
    expect(MAX_FIXED_SCALE).toBe(4);
    expect(fixedScaleChoices(1920, 1080, 1).map((c) => [c.n, c.enabled])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
    ]);
    expect(fixedScaleChoices(3840, 2160, 1).map((c) => c.n)).toEqual([1, 2, 3, 4]);
    expect(resolveScale(0, 3840, 2160, 1)).toMatchObject({ mode: 'fit', n: 6 }); // 収まる最大は4倍に制限しない
  });
});
