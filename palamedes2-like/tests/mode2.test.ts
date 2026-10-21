import { describe, expect, it } from 'vitest';
import type { Command } from '../src/core/game';
import { Match, SingleSession } from '../src/core/match';
import { columnCandidates, Mode2Game, type Mode2Event } from '../src/core/mode2';
import { isLaunchSuccess } from '../src/core/pieces';
import type { PlayerId } from '../src/core/types';
import { CpuController } from '../src/input/cpu';
import { kind, testConfig } from './helpers';

const cmd = (player: PlayerId, type: Command['type']): Command => ({ player, type }) as Command;
const evs = <T extends Mode2Event['type']>(g: Mode2Game, type: T) => g.events.filter((e): e is Extract<Mode2Event, { type: T }> => e.type === type);

interface M2Setup {
  base?: string;
  boards?: Partial<Record<PlayerId, Record<number, string[]>>>;
}

function mode2(players: 1 | 2, setup: M2Setup = {}): Mode2Game {
  return new Mode2Game({
    seed: 11,
    players,
    config: testConfig(),
    setup: (g) => {
      if (setup.base) g.base = g.factory.make(kind(setup.base).n, kind(setup.base).suit);
      for (const [pid, cols] of Object.entries(setup.boards ?? {})) {
        const b = g.players[Number(pid)].board;
        for (let c = 0; c < 6; c++) b.cols[c] = [];
        for (const [c, codes] of Object.entries(cols as Record<number, string[]>))
          b.cols[Number(c)] = codes.map((code) => ({ kind: 'piece' as const, piece: g.factory.make(kind(code).n, kind(code).suit) }));
      }
    },
  });
}

const toPlay = (g: Mode2Game) => {
  while (!g.playing) g.step();
};
const stepN = (g: Mode2Game, n: number, cmds: () => Command[] = () => []) => {
  for (let i = 0; i < n; i++) g.step(cmds());
};

describe('MODE2：独立したルール', () => {
  it('初期盤面は6列×7段＝42個。役・B入れ替え・手動上昇・自然上昇・攻撃は働かない', () => {
    const g = new Mode2Game({ seed: 3, players: 2, config: { ...testConfig(), naturalRiseIntervalMs: 1000 } });
    for (const p of g.players) expect(p.board.allIds()).toHaveLength(42);
    toPlay(g);
    stepN(g, 400, () => [cmd(0, 'rotate'), cmd(0, 'declare'), cmd(0, 'manualRise'), cmd(1, 'debugAttack')]);
    const types = new Set(g.events.map((e) => e.type));
    for (const t of ['rotate', 'declare', 'declareFail', 'rise', 'attack', 'attackReceive', 'attackRow', 'blockStart', 'attackCancel', 'attackPinch', 'lineClear']) expect(types.has(t as never)).toBe(false);
    for (const p of g.players) expect(p.board.allIds()).toHaveLength(42);
  });

  it('成功条件はMODE1と同じ（数字一致・隣接（1↔6含む）・属性一致）。6列の候補から出す', () => {
    const g = mode2(1, { base: '1s', boards: { 0: { 0: ['6d', '2c'], 2: ['3h', '1h'], 4: ['4s'] } } });
    toPlay(g);
    expect(columnCandidates(g.players[0].board, g.flights, 0).map((p) => `${p.n}${p.suit[0]}`)).toEqual(['6d', '3h', '4s']);
    g.players[0].selectedCol = 0;
    g.step([cmd(0, 'launch')]);
    stepN(g, 30);
    expect(evs(g, 'arrive')[0]).toMatchObject({ success: true });
    expect(`${g.base.n}${g.base.suit[0]}`).toBe('6d');
  });

  it('片側だけが詰まっても場の更新をしない（対戦は両者とも出せない時だけ）', () => {
    const g = mode2(2, { base: '1s', boards: { 0: { 0: ['4h'] }, 1: { 0: ['2d'] } } });
    toPlay(g);
    stepN(g, 120);
    expect(evs(g, 'stuck')).toHaveLength(0);
    expect(g.phase).toBe('play');
  });

  it('行き飛行中は判定しない。帰還中なら操作を止めて帰還完了を待ち、3・2・1（各1秒）→ 出せるカードへ更新して再開', () => {
    const g = mode2(1, { base: '1s', boards: { 0: { 0: ['4h', '3d'], 1: ['2c', '6d'] } } });
    toPlay(g);
    const launchMs = g.ticks(g.config.timing.launchMs);
    g.players[0].selectedCol = 0;
    g.step([cmd(0, 'launch')]); // 4h は 1s に不一致 → 帰還
    stepN(g, launchMs + 1);
    expect(evs(g, 'arrive')[0]).toMatchObject({ success: false });
    g.players[0].selectedCol = 1;
    g.step([cmd(0, 'launch')]); // 2c は成功 → 基準 2c。残り候補（帰還先の4h・6d）はどれも出せない
    // 行き飛行中は判定しない
    stepN(g, launchMs - 1);
    expect(evs(g, 'stuck')).toHaveLength(0);
    stepN(g, 1);
    expect(evs(g, 'arrive')[1]).toMatchObject({ success: true });
    expect(evs(g, 'stuck')).toHaveLength(1);
    expect(g.phase).toBe('waitReturn');
    const ret = evs(g, 'arrive')[0].returnEndTick;
    expect(ret).toBeGreaterThan(g.tick);
    // 帰還中は操作停止：移動入力を受け付けない
    g.step([cmd(0, 'right')]);
    expect(evs(g, 'move')).toHaveLength(0);
    while (g.tick < ret) g.step();
    expect(evs(g, 'returned')).toHaveLength(1);
    const cds = evs(g, 'countdown');
    expect(cds.map((c) => [c.value, c.tick])).toEqual([[3, ret]]);
    stepN(g, g.ticks(3000) + 1);
    const all = evs(g, 'countdown');
    expect(all.map((c) => [c.value, c.tick - ret])).toEqual([
      [3, 0],
      [2, g.ticks(1000)],
      [1, g.ticks(2000)],
    ]);
    const ref = evs(g, 'cardRefresh');
    expect(ref).toHaveLength(1);
    expect(ref[0].tick - ret).toBe(g.ticks(3000));
    expect(g.phase).toBe('play');
    expect(g.canPlay(g.players[0])).toBe(true);
    expect(columnCandidates(g.players[0].board, g.flights, 0).some((c) => isLaunchSuccess(c, g.base))).toBe(true);
  });

  it('自分の盤面を空にした側が勝ち。同一tickに両者が空になれば引分け。シングルはクリアと経過時間', () => {
    const g = mode2(2, { base: '1s', boards: { 0: { 2: ['2s'] }, 1: { 2: ['1d', '5c'] } } });
    toPlay(g);
    g.step([cmd(0, 'launch'), cmd(1, 'launch')]);
    stepN(g, 40);
    expect(g.result).toMatchObject({ winner: 0, outcome: 'win' });
    const d = mode2(2, { base: '1s', boards: { 0: { 2: ['2s'] }, 1: { 2: ['1d'] } } });
    toPlay(d);
    d.step([cmd(0, 'launch'), cmd(1, 'launch')]);
    stepN(d, 40);
    expect(d.result).toMatchObject({ winner: null, outcome: 'draw' });
    const s = mode2(1, { base: '1s', boards: { 0: { 2: ['2s'] } } });
    toPlay(s);
    stepN(s, 30);
    s.step([cmd(0, 'launch')]);
    stepN(s, 40);
    expect(s.result).toMatchObject({ winner: 0, outcome: 'clear' });
    expect(s.elapsedMs()).toBeCloseTo((31 + s.ticks(s.config.timing.launchMs)) * s.tickMs, 5);
  });

  it('NPC（上級）同士でMODE2対戦が決着まで進む。シングルもNPC操作で全消費して終了する', () => {
    const m = new Match({ firstTo: 1, difficulty: 'normal', seed: 21, mode: 'mode2' });
    const cpus = [new CpuController(0, 'hard', 1), new CpuController(1, 'easy', 2)];
    for (let i = 0; i < 60000 && m.state === 'round'; i++) m.step(cpus.flatMap((c) => c.poll(m.game)));
    expect(m.state).toBe('matchResult');
    const g = m.game as Mode2Game;
    expect(evs(g, 'arrive').filter((a) => a.success).length).toBeGreaterThan(30);
    const s = new SingleSession({ mode: 'mode2', seed: 5 });
    const cpu = new CpuController(0, 'hard', 1);
    for (let i = 0; i < 60000 && s.state === 'play'; i++) s.step(cpu.poll(s.game));
    expect(s.game.result).toMatchObject({ outcome: 'clear' });
    expect((s.game as Mode2Game).players[0].board.isEmpty()).toBe(true);
  });
});
