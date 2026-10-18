import { describe, expect, it } from 'vitest';
import type { Command, GameEvent } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import { allPieceIds, label, makeGame, stepN, stepUntil, testConfig, toPlay, top } from './helpers';

const cmd = (player: PlayerId, type: Exclude<Command['type'], 'debugAttack'>): Command => ({ player, type });
const evs = <T extends GameEvent['type']>(events: GameEvent[], type: T) =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

describe('共通基準への到達順序', () => {
  it('同一フレーム到達は1P優先で、2Pは更新後の基準で判定する（1♠ ← 1P:2♥, 2P:4♥ → 両者成功）', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['2h', '5s'] }, 1: { 2: ['4h', '5s'] } } });
    toPlay(g);
    g.step([cmd(1, 'launch'), cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs));
    const arrivals = evs(g.events, 'arrive');
    expect(arrivals.map((a) => [a.player, label(a.piece), a.success, label(a.baseBefore)])).toEqual([
      [0, '2h', true, '1s'],
      [1, '4h', true, '2h'],
    ]);
    expect(arrivals[0].tick).toBe(arrivals[1].tick);
    expect(label(g.base)).toBe('4h');
    expect(g.players[0].roleStock.map(label)).toEqual(['2h']);
    expect(g.players[1].roleStock.map(label)).toEqual(['4h']);
  });

  it('発射時に成功見込みでも、到達前に相手が基準を変えれば失敗する', () => {
    // 基準1♠。2Pの2♠が先に到達して基準2♠へ。後から到達する1Pの6♦は 1♠なら成功だが 2♠ には失敗
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['6d', '5s'] }, 1: { 2: ['2s', '5h'] } } });
    toPlay(g);
    g.step([cmd(1, 'launch')]);
    stepN(g, 3);
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) + 2);
    const arr = evs(g.events, 'arrive');
    expect(arr.map((a) => [a.player, label(a.piece), a.success])).toEqual([
      [1, '2s', true],
      [0, '6d', false],
    ]);
  });

  it('発射時に不一致でも、到達時の基準に一致すれば成功する', () => {
    // 基準1♠。1Pが3♥を発射（1♠には不一致）。直後に2Pの2♥が到達して基準2♥へ → 3♥は到達時成功
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['3h', '5s'] }, 1: { 2: ['2h', '5c'] } } });
    toPlay(g);
    g.step([cmd(1, 'launch')]);
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) + 2);
    expect(evs(g.events, 'arrive').map((a) => [label(a.piece), a.success])).toEqual([
      ['2h', true],
      ['3h', true],
    ]);
  });

  it('発射時には列を詰めず予約空白にし、成功到達で予約解除・上詰めする', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 0: ['2s', '6h', '4d'] } } });
    toPlay(g);
    stepN(g, 2, () => [cmd(0, 'left')]);
    stepUntil(g, g.tick + g.ticks(g.config.timing.charMoveMs) + 1);
    stepN(g, 2, () => [cmd(0, 'left')]);
    stepUntil(g, g.tick + g.ticks(g.config.timing.charMoveMs) + 1);
    expect(g.players[0].selectedCol).toBe(0);
    g.step([cmd(0, 'launch')]);
    const col = g.players[0].board.cols[0];
    expect(col.map((s) => s.kind)).toEqual(['reserved', 'piece', 'piece']);
    stepN(g, g.ticks(g.config.timing.launchMs));
    expect(g.players[0].board.cols[0].map((s) => (s.kind === 'piece' ? label(s.piece) : 'R'))).toEqual(['6h', '4d']);
    expect(g.players[0].roleStock.map(label)).toEqual(['2s']);
  });
});

describe('失敗帰還・予約・列ロック', () => {
  function failingSetup() {
    // 1P列2の 4♦ は基準1♠に不一致 → 帰還
    const g = makeGame({ base: '1s', boards: { 0: { 1: ['2s', '3d'], 2: ['4d', '6h'] }, 1: { 2: ['2d', '3s'] } } });
    toPlay(g);
    return g;
  }

  it('帰還中に自然/手動上昇・攻撃SNAPが起きても、帰還完了tickは固定で、元の予約位置へ戻り二重生成しない', () => {
    const g = failingSetup();
    const idsBefore = allPieceIds(g).length;
    g.step([cmd(0, 'launch')]);
    const launchTick = g.tick;
    const T = g.config.timing;
    const expectedEnd = launchTick + g.ticks(T.launchMs) + g.ticks(T.bounceMs) + g.ticks(T.arcMs) + g.ticks(T.descendMs);
    stepN(g, g.ticks(T.launchMs));
    const arrive = evs(g.events, 'arrive')[0];
    expect(arrive.success).toBe(false);
    expect(arrive.returnEndTick).toBe(expectedEnd);
    // 下降区間中に手動上昇と攻撃行追加を発生させる
    stepUntil(g, arrive.arcEndTick + 2);
    g.step([cmd(0, 'manualRise'), { player: 0, type: 'debugAttack', lines: 2 }]);
    stepUntil(g, expectedEnd - 1);
    expect(g.players[0].board.cols[2][0].kind).toBe('reserved');
    g.step();
    const ret = evs(g.events, 'returned');
    expect(ret).toHaveLength(1);
    expect(ret[0].tick).toBe(expectedEnd);
    expect(g.players[0].board.cols[2][0]).toMatchObject({ kind: 'piece', piece: { id: arrive.piece.id } });
    const ids = allPieceIds(g);
    expect(new Set(ids).size).toBe(ids.length);
    const rows = evs(g.events, 'rise').filter((e) => e.player === 0).reduce((a, e) => a + e.rows, 0);
    expect(ids.length).toBe(idsBefore + rows * 6);
    expect(g.flights).toHaveLength(0);
  });

  it('帰還待ちの列だけ発射・Bを禁止し、他列と相手の操作は継続できる', () => {
    const g = failingSetup();
    g.step([cmd(0, 'launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs)); // 到達・失敗
    const before = g.events.length;
    g.step([cmd(0, 'launch'), cmd(0, 'rotate')]);
    expect(g.events.length).toBe(before); // 列2は帰還待ち
    // 2Pは操作できる
    g.step([cmd(1, 'launch')]);
    expect(evs(g.events, 'launch').filter((e) => e.player === 1)).toHaveLength(1);
    // 1Pは他列（列1）へ移動して発射できる
    g.step([cmd(0, 'left')]);
    stepN(g, g.ticks(g.config.timing.charMoveMs));
    g.step([cmd(0, 'launch')]);
    expect(evs(g.events, 'launch').filter((e) => e.player === 0).map((e) => e.col)).toEqual([2, 1]);
  });

  it('未確定(G04)：自分の打ち上げ中ピースの到達前は次の発射を受け付けない', () => {
    const g = failingSetup();
    g.step([cmd(0, 'launch')]);
    g.step([cmd(0, 'left')]);
    stepN(g, g.ticks(g.config.timing.charMoveMs));
    g.step([cmd(0, 'launch')]);
    expect(evs(g.events, 'launch')).toHaveLength(1);
    expect(evs(g.events, 'notice').map((n) => n.code)).toContain('G04_MULTI_LAUNCH');
  });

  it('未確定(G04)：空列への発射・Bは受け付けない', () => {
    const g = makeGame({ boards: { 0: { 2: [] } } });
    toPlay(g);
    g.step([cmd(0, 'launch'), cmd(0, 'rotate')]);
    expect(evs(g.events, 'launch')).toHaveLength(0);
    expect(evs(g.events, 'rotate')).toHaveLength(0);
  });
});

describe('B列入れ替え', () => {
  it('最上段を最下段へ循環し、残りを上へ詰める', () => {
    const g = makeGame({ boards: { 0: { 2: ['1s', '2d', '3c', '4h'] } } });
    toPlay(g);
    g.step([cmd(0, 'rotate')]);
    expect(g.players[0].board.cols[2].map((s) => (s.kind === 'piece' ? label(s.piece) : 'R'))).toEqual(['2d', '3c', '4h', '1s']);
    const r = evs(g.events, 'rotate')[0];
    expect(r.otherIds).toHaveLength(3);
  });
});

describe('自然上昇・手動上昇', () => {
  it('手動上昇は7段を超えない', () => {
    const g = makeGame();
    toPlay(g);
    for (let i = 0; i < 10; i++) g.step([cmd(0, 'manualRise')]);
    expect(g.players[0].board.height()).toBe(7);
    expect(evs(g.events, 'rise').filter((e) => e.kind === 'manual')).toHaveLength(4);
  });

  it('自然上昇は間隔ごとに1段（TWEEN）、宣言側は演出中に停止し、相手は継続する', () => {
    const g = makeGame({ boards: { 0: { 0: ['1s'], 1: ['2s'], 2: ['3s'], 3: ['4s'], 4: ['5d'], 5: ['6d'] } } }, testConfig({ naturalRiseIntervalMs: 3000 }));
    g.players[0].roleStock = [g.factory.make(1, 'spade'), g.factory.make(2, 'spade'), g.factory.make(3, 'spade'), g.factory.make(4, 'spade')];
    toPlay(g);
    const interval = g.ticks(3000);
    stepN(g, interval - 10);
    g.step([cmd(0, 'declare')]);
    const decl = evs(g.events, 'declare')[0];
    expect(decl.result.han).toBe(4); // ストレート1＋フラッシュ3
    expect(decl.logos).toEqual([13]);
    expect(g.players[0].roleStock).toHaveLength(0);
    stepUntil(g, decl.endTick - 2);
    // 演出中：2Pは上昇済み、1Pは停止中
    const rises = () => evs(g.events, 'rise').filter((e) => e.kind === 'natural');
    expect(rises().filter((e) => e.player === 1)).toHaveLength(1);
    expect(rises().filter((e) => e.player === 0)).toHaveLength(0);
    // 宣言者は演出中操作不能、相手は可能
    const n = g.events.length;
    g.step([cmd(0, 'right'), cmd(1, 'right')]);
    expect(g.events.slice(n).filter((e) => e.type === 'move').map((e) => e.player)).toEqual([1]);
    // 演出後、残り時間（約10tick）で1Pも上昇
    stepN(g, 15);
    expect(rises().filter((e) => e.player === 0)).toHaveLength(1);
  });

  it('未確定(G03)：7段で自然上昇は保留し、敗北判定は行わない', () => {
    const g = makeGame({}, testConfig({ naturalRiseIntervalMs: 500 }));
    toPlay(g);
    stepN(g, g.ticks(500) * 8);
    expect(g.players[0].board.height()).toBe(7);
    expect(g.players[0].overflowPending).toBe(true);
    expect(evs(g.events, 'notice').filter((e) => e.code === 'G03_OVERFLOW_PENDING' && e.player === 0)).toHaveLength(1);
  });
});

describe('攻撃波（確定部分）', () => {
  it('最大3ラインずつ・間隔WAIT・攻撃による盤面は6段まで・入りきらない分は保持', () => {
    const g = makeGame();
    toPlay(g);
    g.step([{ player: 0, type: 'debugAttack', lines: 10 }]);
    expect(g.players[0].attackStock).toBe(10);
    stepN(g, g.ticks(g.config.firstWaveDelayMs) + g.ticks(g.config.waveIntervalMs) * 4);
    const waves = evs(g.events, 'rise').filter((e) => e.kind === 'attack');
    expect(waves.map((w) => w.rows)).toEqual([3]); // 3段+3=6段で打ち止め
    expect(g.players[0].board.height()).toBe(6);
    expect(g.players[0].attackStock).toBe(7); // 破棄せず保持
    expect(waves[0].endTick).toBe(waves[0].tick); // SNAP
  });

  it('波の間隔は waveIntervalMs、盤面に空きがあれば順次適用', () => {
    const g = makeGame({ boards: { 0: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] } } });
    toPlay(g);
    g.step([{ player: 0, type: 'debugAttack', lines: 5 }]);
    stepN(g, g.ticks(g.config.firstWaveDelayMs) + g.ticks(g.config.waveIntervalMs) + 2);
    const waves = evs(g.events, 'rise').filter((e) => e.kind === 'attack');
    expect(waves.map((w) => w.rows)).toEqual([3, 2]);
    expect(waves[1].tick - waves[0].tick).toBe(g.ticks(g.config.waveIntervalMs));
    expect(g.players[0].attackStock).toBe(0);
  });

  it('攻撃ストックは29で飽和', () => {
    const g = makeGame();
    toPlay(g);
    g.step([{ player: 1, type: 'debugAttack', lines: 25 }]);
    g.step([{ player: 1, type: 'debugAttack', lines: 10 }]);
    expect(g.players[1].attackStock).toBe(29);
  });

  it('被攻撃者が役宣言演出中なら波はWAITし、演出終了後に再評価して適用', () => {
    const g = makeGame({ boards: { 0: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] } } });
    g.players[0].roleStock = [g.factory.make(1, 'spade'), g.factory.make(2, 'spade'), g.factory.make(3, 'spade'), g.factory.make(4, 'spade')];
    toPlay(g);
    g.step([{ player: 0, type: 'debugAttack', lines: 3 }]);
    g.step([cmd(0, 'declare')]);
    const decl = evs(g.events, 'declare')[0];
    stepUntil(g, decl.endTick - 1);
    expect(evs(g.events, 'rise').filter((e) => e.kind === 'attack')).toHaveLength(0);
    stepN(g, 2);
    const waves = evs(g.events, 'rise').filter((e) => e.kind === 'attack');
    expect(waves).toHaveLength(1);
    expect(waves[0].tick).toBe(decl.endTick);
  });
});

describe('役宣言（確定部分のみ）', () => {
  it('宣言でストック全体を消費。攻撃量・消去は発生させない（G01/G02未確定）', () => {
    const g = makeGame();
    g.players[1].roleStock = ['2s', '3s', '4s', '5s', '1d'].map((c) => g.factory.make(Number(c[0]), c[1] === 's' ? 'spade' : 'diamond'));
    toPlay(g);
    const h0 = g.players[1].board.height();
    g.step([cmd(1, 'declare')]);
    const d = evs(g.events, 'declare')[0];
    expect(d.result.han).toBe(5);
    expect(d.consumed).toHaveLength(5);
    expect(g.players[1].roleStock).toHaveLength(0);
    expect(g.players[0].attackStock).toBe(0);
    expect(g.players[1].board.height()).toBe(h0);
  });

  it('未確定(G04)：無役・同点役は宣言を実行せずストックを保持', () => {
    const g = makeGame();
    g.players[0].roleStock = ['1s', '1d', '2s', '4d'].map((c) => g.factory.make(Number(c[0]), c[1] === 's' ? 'spade' : 'diamond'));
    toPlay(g);
    g.step([cmd(0, 'declare')]);
    expect(evs(g.events, 'declare')).toHaveLength(0);
    expect(evs(g.events, 'notice').map((e) => e.code)).toEqual(['G04_NO_ROLE']);
    expect(g.players[0].roleStock).toHaveLength(4);
    expect(g.isLocked(g.players[0])).toBe(false);
  });
});

describe('初期配置', () => {
  it('MATCH：各プレイヤー6列×下側3段＝18個、READY中は入力を受け付けない', () => {
    const g = makeGame({}, testConfig(), 99);
    for (const p of g.players) {
      expect(p.board.cols.every((c) => c.length === 3)).toBe(true);
      expect(p.board.allIds()).toHaveLength(18);
    }
    g.step([cmd(0, 'launch')]);
    expect(evs(g.events, 'launch')).toHaveLength(0);
    expect(top(g, 0, 2)).not.toBeNull();
  });
});
