// 入力機器・割当・CPU
import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../src/core/rng';
import { Match } from '../src/core/match';
import type { Command } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import {
  assignKey,
  cloneKeyBindings,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_PAD_BINDINGS,
  GamepadController,
  KeyboardController,
  type PadState,
} from '../src/input/controller';
import { CpuController } from '../src/input/cpu';
import { defaultSettings, parseSettings } from '../src/input/settings';
import { makeGame, testConfig, toPlay } from './helpers';

describe('初期割当（確定）', () => {
  it('1P A/D F G H W、2P ←/→ , . / ↑', () => {
    expect(DEFAULT_KEY_BINDINGS[0]).toEqual({ left: ['KeyA'], right: ['KeyD'], launch: ['KeyF'], rotate: ['KeyG'], declare: ['KeyH'], manualRise: ['KeyW'] });
    expect(DEFAULT_KEY_BINDINGS[1]).toEqual({
      left: ['ArrowLeft'],
      right: ['ArrowRight'],
      launch: ['Comma'],
      rotate: ['Period'],
      declare: ['Slash'],
      manualRise: ['ArrowUp'],
    });
  });

  it('ゲームパッド：十字キー・左スティックで左右、A発射、B入れ替え、X役宣言、RB手動上昇', () => {
    expect(DEFAULT_PAD_BINDINGS.left).toEqual([
      { kind: 'button', index: 14 },
      { kind: 'axis', index: 0, dir: -1 },
    ]);
    expect([DEFAULT_PAD_BINDINGS.launch, DEFAULT_PAD_BINDINGS.rotate, DEFAULT_PAD_BINDINGS.declare, DEFAULT_PAD_BINDINGS.manualRise]).toEqual([
      [{ kind: 'button', index: 0 }],
      [{ kind: 'button', index: 1 }],
      [{ kind: 'button', index: 2 }],
      [{ kind: 'button', index: 5 }],
    ]);
  });
});

describe('割当変更', () => {
  it('同じキーは両プレイヤーを通じて重複させない。予約キー（Esc・F1〜F12・Enter・Tab）は割当不可', () => {
    const all = [cloneKeyBindings(DEFAULT_KEY_BINDINGS[0]), cloneKeyBindings(DEFAULT_KEY_BINDINGS[1])];
    expect(assignKey(all, 0, 'launch', 'Comma')).toBe(true);
    expect(all[0].launch).toEqual(['Comma']);
    expect(all[1].launch).toEqual([]);
    expect(assignKey(all, 1, 'declare', 'Escape')).toBe(false);
    expect(assignKey(all, 1, 'declare', 'F5')).toBe(false);
    expect(all[1].declare).toEqual(['Slash']);
  });

  it('キーボード：割当どおりにコマンド化。キーリピートは左右移動のみ', () => {
    const k = new KeyboardController(0);
    expect(k.handleKey('KeyF', false)).toBe(true);
    expect(k.handleKey('KeyF', true)).toBe(true); // リピートは捨てる
    expect(k.handleKey('KeyA', true)).toBe(true);
    expect(k.handleKey('Comma', false)).toBe(false); // 2Pのキー
    expect(k.poll().map((c) => c.type)).toEqual(['launch', 'left']);
  });

  it('ゲームパッド：押した瞬間に1回、左右は押し続けでリピート、START・Aを検出', () => {
    let state: PadState = { buttons: Array.from({ length: 16 }, () => ({ pressed: false })), axes: [0, 0] };
    let now = 0;
    const pad = new GamepadController(1, 0, DEFAULT_PAD_BINDINGS, () => state, () => now);
    const press = (i: number, v: boolean) => {
      state = { ...state, buttons: state.buttons.map((b, j) => (j === i ? { pressed: v } : b)) };
    };
    press(0, true);
    expect(pad.poll().map((c) => c.type)).toEqual(['launch']);
    expect(pad.poll()).toEqual([]);
    expect(pad.confirmPressed).toBe(true);
    press(0, false);
    state = { ...state, axes: [-0.9, 0] };
    const lefts: Command[] = [];
    for (now = 0; now <= 500; now += 50) lefts.push(...pad.poll());
    // 0ms で1回、250ms から100msごと（250,350,450）
    expect(lefts.map((c) => c.type)).toEqual(['left', 'left', 'left', 'left']);
    press(9, true);
    pad.poll();
    expect(pad.startPressed).toBe(true);
    expect(lefts.every((c) => c.player === 1)).toBe(true);
  });

  it('設定の保存値が壊れていても初期値で動く', () => {
    expect(parseSettings('{broken')).toEqual(defaultSettings());
    expect(parseSettings(JSON.stringify({ firstTo: 9, difficulty: 'hard' }))).toMatchObject({ firstTo: 2, difficulty: 'hard' });
    expect(defaultSettings()).toMatchObject({ firstTo: 2, devices: [{ kind: 'keyboard' }, { kind: 'keyboard' }] });
  });
});

describe('CPU（確定：初級・中級・上級、見える情報だけで判断）', () => {
  const runCpu = (factorySeed: number, level: 'easy' | 'normal' | 'hard', ticks: number) => {
    const g = makeGame({}, testConfig(), 77);
    // 未来の生成ピース（盤面の乱数源）だけを差し替える：見える盤面・基準は同じ
    (g.players[0] as { rng: unknown }).rng = createSeededRng(factorySeed);
    (g.players[1] as { rng: unknown }).rng = createSeededRng(factorySeed + 1);
    const cpu = new CpuController(0, level, 3);
    const log: string[] = [];
    toPlay(g);
    for (let i = 0; i < ticks; i++) {
      const cmds = cpu.poll(g);
      for (const c of cmds) log.push(`${g.tick}:${c.type}`);
      g.step(cmds);
    }
    return { log, g };
  };

  it('未来の生成ピースを参照しない：乱数源を変えても、新しいピースが出るまでの判断は同一', () => {
    const a = runCpu(1, 'hard', 600);
    const b = runCpu(999, 'hard', 600);
    expect(a.log.length).toBeGreaterThan(5);
    expect(a.log).toEqual(b.log);
  });

  it('上級は初級より反応が速い（同じ盤面で成功取得10個に要する時間が短い）。CPUは不成立宣言をしない', () => {
    const run = (level: 'easy' | 'hard') => {
      const m = new Match({ firstTo: 3, difficulty: 'easy', seed: 42 });
      const cpu = new CpuController(0, level, 5);
      let tenth = -1;
      for (let i = 0; i < 6000 && m.state === 'round' && tenth < 0; i++) {
        m.step(cpu.poll(m.game));
        const ok = m.game.events.filter((e) => e.type === 'arrive' && e.player === 0 && e.success).length;
        if (ok >= 10) tenth = m.game.tick;
      }
      const fails = m.game.events.filter((e) => e.type === 'declareFail').length;
      return { tenth, fails };
    };
    const easy = run('easy');
    const hard = run('hard');
    expect(hard.tenth).toBeGreaterThan(0);
    expect(easy.tenth < 0 || hard.tenth < easy.tenth).toBe(true);
    expect(easy.fails + hard.fails).toBe(0);
  });

  it('CPU同士の対戦で宣言・消去・攻撃・相殺が発生し、CPU対操作なしの試合は試合結果まで進行する', () => {
    const m = new Match({ firstTo: 1, difficulty: 'hard', seed: 8 });
    const cpus = [new CpuController(0, 'hard', 1), new CpuController(1, 'normal', 2)];
    for (let i = 0; i < 6000 && m.state === 'round'; i++) m.step(cpus.flatMap((c) => c.poll(m.game)));
    const seen = new Set<string>(m.game.events.map((e) => e.type));
    for (const t of ['declare', 'lineClear', 'attack', 'attackStock']) expect(seen.has(t), t).toBe(true);
    const solo = new Match({ firstTo: 2, difficulty: 'hard', seed: 9 });
    const cpu = new CpuController(1, 'hard', 3);
    for (let i = 0; i < 40000 && solo.state !== 'matchResult'; i++) solo.step(solo.state === 'round' ? cpu.poll(solo.game) : [], solo.canConfirm);
    expect(solo.state).toBe('matchResult');
    expect(solo.matchWinner).toBe(1 as PlayerId);
  });
});
