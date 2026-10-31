// V320-MEASURE-01：計測の観測がゲームを変えないこと、入力の受理・予約・破棄・理由・ロックの記録、打上硬直の比較設定
import { describe, expect, it } from 'vitest';
import type { Command, Game, InputTraceEntry } from '../src/core/game';
import { Match } from '../src/core/match';
import { createSeededRng } from '../src/core/rng';
import type { PlayerId } from '../src/core/types';
import { CpuController } from '../src/input/cpu';
import { LAUNCH_PROFILES, profileConfig, profileReport } from '../src/measure/profile';
import { MeasureRecorder } from '../src/measure/recorder';
import { EMPTY, makeGame, rows, setStock, stepN, toPlay } from './helpers';

const ACTIONS = ['left', 'right', 'launch', 'rotate', 'declare', 'manualRise'] as const;

/** 人の操作の代わり：seed 付きの乱数で、押下・反復・離す（cancelRepeat）を混ぜた入力を作る */
function noisyHuman(seed: number) {
  const rng = createSeededRng(seed);
  return (tick: number): Command[] => {
    const out: Command[] = [];
    if (rng.next() < 0.35) {
      const a = ACTIONS[Math.floor(rng.next() * ACTIONS.length)];
      out.push({ player: 0, type: a, ...(rng.next() < 0.2 && (a === 'left' || a === 'right') ? { repeat: true } : {}) });
    }
    if (rng.next() < 0.05) out.push({ player: 0, type: rng.next() < 0.5 ? 'left' : 'right' });
    if (rng.next() < 0.05) out.push({ player: 0, type: 'cancelRepeat' });
    void tick;
    return out;
  };
}

function runMatch(withRecorder: boolean, seed: number, profile: 'A' | 'B' | null, ticks = 60 * 120) {
  const m = new Match({ firstTo: 2, difficulty: 'normal', seed, mode: 'mode1', ...(profile ? { config: profileConfig(profile) } : {}) });
  const human = noisyHuman(seed * 13);
  const cpu = new CpuController(1, 'hard', seed, 'akane');
  const rec = withRecorder ? new MeasureRecorder(undefined, () => 0) : null;
  rec?.matchStart({ mode: 'mode1', kind: 'cpu', characters: ['kotaro', 'akane'], devices: [], humans: [0], seed, profile: profile ?? 'none' });
  rec?.start();
  const snaps: string[] = [];
  for (let i = 0; i < ticks && m.state !== 'matchResult'; i++) {
    const g = m.game as Game;
    rec?.beforeTick(g);
    const cmds = [...human(g.tick + 1), ...cpu.poll(g)];
    if (rec) for (const c of cmds) rec.command(c, c.player === 0 ? 'keyboard' : 'cpu');
    m.step(cmds, m.state === 'roundResult');
    rec?.afterTick(m.game as Game);
    if (i % 600 === 0) snaps.push((m.game as Game).snapshot());
  }
  const g = m.game as Game;
  return { snaps, final: g.snapshot(), events: JSON.stringify(g.events), inputLog: JSON.stringify(g.inputLog), wins: [...m.wins], round: m.round, rec };
}

describe('計測ON/OFFでゲームが変わらない（同一 seed・同一入力）', () => {
  it.each([
    [3, 'B'],
    [11, 'A'],
    [29, null],
  ] as const)('seed %i・設定 %s：盤面・イベント・入力ログ・勝敗が一致（計測ありは記録が増えるだけ）', (seed, profile) => {
    const off = runMatch(false, seed, profile);
    const on = runMatch(true, seed, profile);
    expect(on.snaps).toEqual(off.snaps);
    expect(on.final).toBe(off.final);
    expect(on.events).toBe(off.events);
    expect(on.inputLog).toBe(off.inputLog);
    expect([on.wins, on.round]).toEqual([off.wins, off.round]);
    expect(on.rec!.count).toBeGreaterThan(1000);
  });

  it('観測側が例外を出してもゲームへ伝えない', () => {
    const g = makeGame({ boards: { 0: rows(3), 1: EMPTY } });
    toPlay(g);
    g.trace = () => {
      throw new Error('boom');
    };
    expect(() => stepN(g, 30, () => [{ player: 0, type: 'launch' }])).not.toThrow();
  });
});

function traced(setup: Parameters<typeof makeGame>[0] = { boards: { 0: rows(3), 1: EMPTY } }) {
  const g = makeGame(setup);
  const log: InputTraceEntry[] = [];
  g.trace = (e) => log.push(e);
  return { g, log, pick: (kind: string) => log.filter((e) => e.kind === kind && e.player === 0) };
}
const cmd = (type: Command['type'], extra: Partial<Command> = {}): Command => ({ player: 0, type, ...extra }) as Command;

describe('入力処理の追跡（理由付き）', () => {
  it('試合開始前の入力は drop（notStarted）、決着後は drop（roundEnded）', () => {
    const { g, pick } = traced();
    g.step([cmd('launch')]);
    expect(pick('drop')[0]).toMatchObject({ action: 'launch', reason: 'notStarted' });
    toPlay(g);
    g.result = { winner: 1, tick: g.tick, outcome: 'win' };
    g.step([cmd('left')]);
    expect(pick('drop').at(-1)).toMatchObject({ action: 'left', reason: 'roundEnded' });
  });

  it('打上硬直中・成功後の列詰め中・列入替中・役演出中の入力は reject（理由＝launch／pack／rotate／role）。ロック開始も理由と終了tick付き', () => {
    const { g, pick, log } = traced({ base: '1s', boards: { 0: { 2: ['2s', '3s', '4s'], 3: ['5c', '6c'] }, 1: EMPTY } });
    toPlay(g);
    g.step([cmd('launch')]);
    g.step([cmd('launch')]); // 飛行中
    expect(pick('reject').at(-1)).toMatchObject({ action: 'launch', reason: 'launch' });
    while (!g.events.some((e) => e.type === 'arrive')) g.step();
    g.step([cmd('rotate')]); // 列詰め中
    expect(pick('reject').at(-1)).toMatchObject({ action: 'rotate', reason: 'pack' });
    while (g.isLocked(g.players[0])) g.step();
    g.step([cmd('right')]);
    while (g.isMoving(g.players[0])) g.step();
    g.step([cmd('rotate')]);
    expect(pick('execute').at(-1)).toMatchObject({ action: 'rotate' });
    g.step([cmd('left')]);
    expect(pick('reject').at(-1)).toMatchObject({ action: 'left', reason: 'rotate' });
    expect(log.filter((e) => e.kind === 'lock').map((e) => e.action)).toEqual(['launch', 'pack', 'rotate']);
    expect(log.find((e) => e.kind === 'lock')!.detail).toMatchObject({ until: expect.any(Number) });
    // 役演出中
    while (g.isLocked(g.players[0])) g.step();
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd('declare')]);
    g.step([cmd('launch')]);
    expect(pick('reject').at(-1)).toMatchObject({ action: 'launch', reason: 'role' });
  });

  it('左右端・空の列・帰還中の列・1個だけの列の入替・手動上昇の上限は reject（edge／emptyColumn／returningColumn／singlePiece／riseLimit）', () => {
    const { g, pick } = traced({ base: '1s', boards: { 0: { 0: ['4d', '5c'], 1: ['6h'], 2: [], 3: [], 4: [], 5: [] }, 1: EMPTY } });
    toPlay(g);
    const p = g.players[0];
    p.selectedCol = 5;
    g.step([cmd('right')]);
    expect(pick('reject').at(-1)).toMatchObject({ action: 'right', reason: 'edge' });
    g.step([cmd('launch')]);
    expect(pick('reject').at(-1)).toMatchObject({ action: 'launch', reason: 'emptyColumn' });
    p.selectedCol = 1;
    g.step([cmd('rotate')]);
    expect(pick('reject').at(-1)).toMatchObject({ action: 'rotate', reason: 'singlePiece' });
    p.selectedCol = 0;
    g.step([cmd('launch')]); // 4♦ 失敗 → 帰還中の列
    while (!g.events.some((e) => e.type === 'arrive')) g.step();
    while (g.isLocked(p)) g.step();
    g.step([cmd('launch')]);
    expect(pick('reject').at(-1)).toMatchObject({ action: 'launch', reason: 'returningColumn' });
    for (const c of p.board.cols) while (c.length < 7) c.push({ kind: 'piece', piece: g.factory.make(5, 'club') });
    g.step([cmd('manualRise')]);
    expect(pick('reject').at(-1)).toMatchObject({ action: 'manualRise', reason: 'riseLimit' });
  });

  it('移動中の入力の予約（buffer）→ 実行（consume＋execute via buffer）、上書き（overwritten）、期限切れ（expired）、同時押し（simultaneous）、反復の無視（repeatIgnored）が元のコマンドと結び付く', () => {
    const { g, pick, log } = traced();
    toPlay(g);
    const a = cmd('right');
    g.step([a]);
    while (g.tick + 2 < g.players[0].charMoveEndTick) g.step();
    const b = cmd('right');
    g.step([b]); // 移動の終わり際（期限2tick以内）→ 予約
    expect(pick('buffer').at(-1)).toMatchObject({ action: 'right', cmd: b });
    while (g.isMoving(g.players[0])) g.step();
    g.step();
    expect(pick('consume').at(-1)).toMatchObject({ action: 'right' });
    expect(log.filter((e) => e.kind === 'execute').at(-1)).toMatchObject({ action: 'right', detail: { via: 'buffer' } });
    // 上書き
    while (g.isMoving(g.players[0])) g.step();
    g.step([cmd('left')]);
    const c1 = cmd('launch');
    const c2 = cmd('rotate');
    g.step([c1]);
    g.step([c2]);
    expect(pick('discard').at(-1)).toMatchObject({ action: 'launch', reason: 'overwritten', cmd: c2 });
    // 反復は予約を上書きしない
    g.step([cmd('right', { repeat: true })]);
    expect(pick('discard').at(-1)).toMatchObject({ reason: 'repeatIgnored' });
    // 同時押し
    while (g.isMoving(g.players[0]) || g.isLocked(g.players[0])) g.step();
    g.step([cmd('left'), cmd('right')]);
    expect(pick('discard').at(-1)).toMatchObject({ action: 'left+right', reason: 'simultaneous' });
    // 期限切れ：移動終了の直前に予約し、期限（2tick）を過ぎてから移動可能になるよう、移動中に予約してロックで遅らせる
    const h = traced({ base: '1s', boards: { 0: { 1: ['2s', '3s'], 2: ['2s', '3s'] }, 1: EMPTY } });
    toPlay(h.g);
    h.g.step([cmd('left')]);
    h.g.step([cmd('launch')]); // 予約（発射は期限なし）
    h.g.step([cmd('right')]); // 予約を右に上書き（期限2tick）
    h.g.players[0].charMoveEndTick = h.g.tick + 5; // 移動が長引いた状況を作る（期限超過）
    while (h.g.isMoving(h.g.players[0])) h.g.step();
    h.g.step();
    expect(h.pick('discard').at(-1)).toMatchObject({ action: 'right', reason: 'expired' });
  });
});

describe('打上硬直の比較設定（A／B）', () => {
  it('B（初期選択）：飛行200ms＋列詰め50ms＝15tick（250ms）、A：300＋120＝25tick（約416.7ms）。失敗時の総帰還はBが100ms短い', () => {
    const a = profileReport('A');
    const b = profileReport('B');
    expect([a.launchTicks, a.packTicks, a.successLockTicks, Math.round(a.successLockMs * 10) / 10]).toEqual([18, 7, 25, 416.7]);
    expect([b.launchTicks, b.packTicks, b.successLockTicks, b.successLockMs]).toEqual([12, 3, 15, 250]);
    expect(a.failTotalMs - b.failTotalMs).toBe(100);
    expect([b.bounceMs, b.arcMs, b.descendMs, b.moveBufferTicks]).toEqual([a.bounceMs, a.arcMs, a.descendMs, a.moveBufferTicks]);
    expect(LAUNCH_PROFILES.B).toMatchObject({ launchMs: 200, packMs: 50 });
  });

  it('プレイヤーと CPU に共通適用（同じ Game の timing。CPU の見積りも同じ値を読む）。他の設定は変えない', () => {
    const m = new Match({ firstTo: 2, difficulty: 'normal', seed: 5, mode: 'mode1', config: profileConfig('B') });
    const g = m.game as Game;
    const t = (g as unknown as { t: Record<string, number> }).t;
    expect([t.launchMs, t.packMs, t.bounceMs, t.arcMs, t.descendMs]).toEqual([12, 3, 7, 16, 96]);
    expect(g.config.moveBufferTicks).toBe(2);
    const base = new Match({ firstTo: 2, difficulty: 'normal', seed: 5, mode: 'mode1' });
    const { timing: tb, ...restB } = (base.game as Game).config;
    const { timing: tm, ...restM } = g.config;
    expect(restM).toEqual(restB);
    expect({ ...tm, launchMs: 0, packMs: 0, readyMs: 0 }).toEqual({ ...tb, launchMs: 0, packMs: 0, readyMs: 0 });
    // CPU も同じ硬直：CPU の発射から次の操作まで 15tick 以上空く
    const cpu = new CpuController(1, 'hard', 1, 'akane');
    const human = new CpuController(0, 'hard', 2, 'kotaro');
    while (!g.playing) g.step();
    const launches: { p: PlayerId; tick: number }[] = [];
    for (let i = 0; i < 1200; i++) g.step([...human.poll(g), ...cpu.poll(g)]);
    for (const e of g.events) if (e.type === 'launch') launches.push({ p: e.player, tick: e.tick });
    for (const p of [0, 1] as PlayerId[]) {
      const ls = launches.filter((x) => x.p === p);
      expect(ls.length).toBeGreaterThan(5);
      for (let i = 1; i < ls.length; i++) expect(ls[i].tick - ls[i - 1].tick).toBeGreaterThanOrEqual(12);
    }
  });
});
