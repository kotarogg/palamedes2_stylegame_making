// V320-FIX-06 第6章：CPU の難易度別操作速度（移動開始間隔・最終移動完了から打上まで）、ピンチ所要見積り、7個目の改善判定
import { describe, expect, it } from 'vitest';
import type { Game } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { CPU_CONFIG, CpuController, roleRank, type CpuConfig } from '../src/input/cpu';
import { acquireMs } from '../src/input/cpuPlan';
import { EMPTY, makeGame, setStock, toPlay } from './helpers';

type Level = 'easy' | 'normal' | 'hard';
const LEVELS: Level[] = ['easy', 'normal', 'hard'];
const GAP = { easy: 12, normal: 9, hard: 7 } as const;
const AFTER = { easy: 6, normal: 4, hard: 2 } as const;

/** 停止・失念・必須待ち・認識誤りを外し、操作速度だけを見る設定（speed は残す） */
function speedOnly(level: Level): CpuConfig {
  const c = JSON.parse(JSON.stringify(CPU_CONFIG)) as CpuConfig;
  delete c.mode1Adjust;
  c.mandatoryWait = {};
  for (const ch of ['kotaro', 'akane', 'zunko'] as const) {
    c.decisionStop[level].pct[ch] = 0;
    c.forget[level].normal[ch] = { pct: 0, ms: 0 };
    c.forget[level].pinch[ch] = { pct: 0, ms: 0 };
  }
  return c;
}

/** 列6だけに出せる4♠（場3♠）。他の列の最上段は出せない6♥。全列3段（手動上昇なし） */
function farGame() {
  const col = (top: string) => [top, '5c', '5c'];
  return makeGame({ base: '3s', boards: { 0: { 0: col('6h'), 1: col('6h'), 2: col('6h'), 3: col('6h'), 4: col('6h'), 5: col('4s') }, 1: EMPTY } });
}

function play(g: Game | Mode2Game, cpu: CpuController, ticks: number) {
  for (let i = 0; i < ticks && !g.result; i++) g.step(cpu.poll(g as Game) as never);
}

describe('移動開始間隔・打上待ち（tick が正本）', () => {
  it('設定値：初級12／中級9／上級7tick、打上待ち 6／4／2tick（MODE1・MODE2 共通の調整データ）', () => {
    expect(CPU_CONFIG.speed).toMatchObject({ moveGapTicks: GAP, launchAfterMoveTicks: AFTER });
  });

  it.each(LEVELS)('%s：初回移動は待たず、移動開始の間隔は前回の移動開始から最短 GAP tick。最終移動完了から打上まで AFTER tick', (level) => {
    const g = farGame();
    toPlay(g);
    const cpu = new CpuController(0, level, 1, 'kotaro', speedOnly(level));
    const firstPoll = g.tick + 1;
    play(g, cpu, 200);
    const launch = cpu.speedLog.find((x) => x.kind === 'launch')!;
    const moves = cpu.speedLog.filter((x) => x.kind === 'move' && x.tick < launch.tick); // 最初の打上まで
    expect(moves.map((m) => m.dir)).toEqual(['right', 'right', 'right']);
    expect(moves[0].tick).toBe(firstPoll); // 架空の前回移動による待ちを作らない
    expect(moves.slice(1).map((m, i) => m.tick - moves[i].tick)).toEqual([GAP[level], GAP[level]]);
    // 実際のゲームの移動イベントと一致（コマンドが適用された tick）
    expect(g.events.filter((e) => e.type === 'move' && e.player === 0 && e.tick < launch.tick).map((e) => e.tick)).toEqual(moves.map((m) => m.tick));
    expect(launch.tick - launch.moveEndTick).toBe(AFTER[level]);
    expect(launch.moveEndTick).toBe(moves[2].moveEndTick);
    // 移動完了後に間隔を丸ごと足していない（移動1歩90ms＝5tick ＜ 間隔）
    expect(moves[1].tick - moves[0].moveEndTick).toBe(GAP[level] - g.ticks(g.config.timing.charMoveMs));
  });

  it('難易度差：同じ盤面で打上までの tick は 初級＞中級＞上級（人間側の設定は変えない）', () => {
    const at = LEVELS.map((level) => {
      const g = farGame();
      toPlay(g);
      const cpu = new CpuController(0, level, 1, 'kotaro', speedOnly(level));
      const t0 = g.tick + 1;
      play(g, cpu, 200);
      return cpu.speedLog.find((x) => x.kind === 'launch')!.tick - t0;
    });
    // 3歩：2×GAP＋移動5tick＋AFTER
    expect(at).toEqual(LEVELS.map((l) => 2 * GAP[l] + 5 + AFTER[l]));
    expect(at[0]).toBeGreaterThan(at[1]);
    expect(at[1]).toBeGreaterThan(at[2]);
    expect(CPU_CONFIG.speed).toBeDefined();
    expect(makeGame().config.moveBufferTicks).toBe(2); // 人間側の先行入力は変更なし
  });

  it('最初から目的列にいて移動しなければ、打上の追加待ちはない', () => {
    const g = farGame();
    toPlay(g);
    g.players[0].selectedCol = 5;
    const cpu = new CpuController(0, 'easy', 1, 'kotaro', speedOnly('easy'));
    const t0 = g.tick + 1;
    play(g, cpu, 30);
    expect(cpu.speedLog.filter((x) => x.kind === 'move')).toEqual([]);
    expect(cpu.speedLog.find((x) => x.kind === 'launch')!.tick).toBe(t0);
  });

  it('反転・目標の再選択も同じ間隔：移動中に目標が消えて逆方向へ向かっても、前回の移動開始から GAP tick 未満では動かない', () => {
    const level: Level = 'normal';
    const col = (top: string) => [top, '5c', '5c'];
    const g = makeGame({ base: '3s', boards: { 0: { 0: col('6h'), 1: col('6h'), 2: col('6h'), 3: col('6h'), 4: col('6h'), 5: col('4s') }, 1: EMPTY } });
    toPlay(g);
    g.players[0].selectedCol = 3;
    const cfg = speedOnly(level);
    for (const ch of ['kotaro', 'akane', 'zunko'] as const) cfg.bestPick[level].normal[ch] = 100;
    const cpu = new CpuController(0, level, 1, 'kotaro', cfg);
    // 最初の移動（右：列6が近い）
    for (let i = 0; i < 40 && cpu.speedLog.length === 0; i++) g.step(cpu.poll(g));
    const first = cpu.speedLog[0];
    expect(first.dir).toBe('right');
    // 目標の4♠を消し、列1に2♠を出す → 列1へ再計画（反転）
    g.players[0].board.cols[5].shift();
    g.players[0].board.cols[0][0] = { kind: 'piece', piece: g.factory.make(2, 'spade') };
    for (let i = 0; i < 60 && cpu.speedLog.length < 2; i++) g.step(cpu.poll(g));
    const second = cpu.speedLog[1];
    expect(second.dir).toBe('left');
    expect(second.tick - first.tick).toBeGreaterThanOrEqual(GAP[level]);
    expect(second.tick - first.tick).toBe(GAP[level]); // 再判断で待ちをやり直さない（追加の待ちも無い）
  });

  it('ピンチでも操作間隔は同じ（既存の判断待ち半減だけ維持）', () => {
    const level: Level = 'hard';
    const g = farGame();
    toPlay(g);
    g.players[0].incoming.pinchRemaining = 100000;
    const cpu = new CpuController(0, level, 1, 'kotaro', speedOnly(level));
    play(g, cpu, 120);
    const launch = cpu.speedLog.find((x) => x.kind === 'launch')!;
    const moves = cpu.speedLog.filter((x) => x.kind === 'move' && x.tick < launch.tick);
    expect(moves.slice(1).map((m, i) => m.tick - moves[i].tick)).toEqual([GAP[level], GAP[level]]);
    expect(launch.tick - launch.moveEndTick).toBe(AFTER[level]);
  });

  it('新ラウンド（別のゲーム）では操作履歴を初期化：前のゲームの移動から間隔を数えない', () => {
    const level: Level = 'easy';
    const cpu = new CpuController(0, level, 1, 'kotaro', speedOnly(level));
    const g1 = farGame();
    toPlay(g1);
    for (let i = 0; i < 10 && cpu.speedLog.length === 0; i++) g1.step(cpu.poll(g1));
    expect(cpu.speedLog).toHaveLength(1);
    const g2 = farGame();
    toPlay(g2);
    const t0 = g2.tick + 1;
    g2.step(cpu.poll(g2));
    expect(cpu.speedLog[1]).toMatchObject({ kind: 'move', tick: t0 });
  });

  it('待機中に操作を溜めない・同じ操作を重複発行しない（1tickに1操作、待機中は空）', () => {
    const g = farGame();
    toPlay(g);
    const cpu = new CpuController(0, 'easy', 1, 'kotaro', speedOnly('easy'));
    const outs: number[] = [];
    for (let i = 0; i < 80; i++) {
      const out = cpu.poll(g);
      outs.push(out.length);
      g.step(out);
      if (out.some((c) => c.type === 'launch')) break;
    }
    expect(Math.max(...outs)).toBe(1);
    expect(outs.filter((n) => n === 1)).toHaveLength(4); // 移動3＋打上1
    expect(cpu.stats.speedMoveWaitTicks).toBeGreaterThan(0);
    expect(cpu.stats.speedLaunchWaitTicks).toBeGreaterThan(0); // 移動中（既存の操作不可）の tick は数えない
  });

  it('MODE2 も同じ操作速度', () => {
    const g = new Mode2Game({ seed: 5, players: 1 });
    while (!g.playing) g.step();
    const cpu = new CpuController(0, 'normal', 3, 'kotaro', speedOnly('normal'));
    for (let i = 0; i < 60 * 60 && !g.result; i++) g.step(cpu.poll(g as never) as never);
    const moves = cpu.speedLog.filter((x) => x.kind === 'move');
    const launches = cpu.speedLog.filter((x) => x.kind === 'launch');
    expect(moves.length).toBeGreaterThan(5);
    for (let i = 1; i < moves.length; i++) expect(moves[i].tick - moves[i - 1].tick).toBeGreaterThanOrEqual(GAP.normal);
    // 移動の後の打上は、最終移動完了から4tick以上（移動しなかった打上は待たない）
    let lastMove = -1;
    let k = 0;
    for (const l of launches) {
      while (k < moves.length && moves[k].tick < l.tick) lastMove = k++;
      const prevLaunch = launches.filter((x) => x.tick < l.tick).at(-1);
      if (lastMove >= 0 && (!prevLaunch || moves[lastMove].tick > prevLaunch.tick)) expect(l.tick - l.moveEndTick).toBeGreaterThanOrEqual(AFTER.normal);
    }
  });
});

describe('ピンチ所要見積り・7個目の改善', () => {
  it('取得の所要時間に移動開始間隔と打上待ちを含める（n歩：（n−1）×間隔＋移動1歩＋打上待ち＋発射＋上詰め）', () => {
    const t = { charMoveMs: 90, launchMs: 300, packMs: 120, moveGapMs: 7 * (1000 / 60), launchAfterMoveMs: 2 * (1000 / 60) };
    expect(acquireMs(2, 2, t)).toBe(420);
    expect(acquireMs(2, 3, t)).toBeCloseTo(90 + 33.333 + 420, 2);
    expect(acquireMs(2, 5, t)).toBeCloseTo(2 * 116.667 + 90 + 33.333 + 420, 2);
    // 旧（速度なし）の見積りと一致する互換
    expect(acquireMs(0, 3, { charMoveMs: 90, launchMs: 300, packMs: 120 })).toBe(690);
  });

  /** 手役 1♥5♦1♠2♠3♠4♠（ストレートフラッシュ 4/4）。列0の5♠でハイストレートフラッシュ 5/5、列1の6♠で6個全体のスーパーストレート 4/5 */
  function seventh(pinch: number | null, cfg: CpuConfig) {
    cfg.seventhImprove.hard.normal.kotaro = 100;
    cfg.seventhImprove.hard.pinch.kotaro = 100;
    const g = makeGame({ base: '4s', boards: { 0: { 0: ['5s', '1h'], 1: ['6s', '1h'], 2: ['1h'], 3: ['3h'], 4: ['1h'], 5: ['1h'] }, 1: EMPTY } });
    toPlay(g);
    setStock(g, 0, '1h', '5d', '1s', '2s', '3s', '4s');
    g.players[0].selectedCol = 2;
    g.players[0].incoming.pinchRemaining = pinch;
    return { g, cpu: new CpuController(0, 'hard', 1, 'kotaro', cfg) };
  }

  it('7個目の改善＝消去が増える、または消去が同じで基本攻撃が増える（6♠：4/4→4/5 も改善候補）。消去の増える5♠を優先', () => {
    expect(roleRank({ clear: 4, baseAttack: 5 })).toBeGreaterThan(roleRank({ clear: 4, baseAttack: 4 }));
    expect(roleRank({ clear: 5, baseAttack: 1 })).toBeGreaterThan(roleRank({ clear: 4, baseAttack: 8 }));
    const a = seventh(null, speedOnly('hard'));
    expect(a.cpu.poll(a.g).map((c) => c.type)).toEqual(['left']);
    expect(a.cpu.log.filter((l) => l.kind === 'seventhImprove')).toMatchObject([{ hit: true, detail: 'normal +101' }]);
    // 5♠を除くと 6♠（消去同じ・攻撃+1）を取りに行く
    const b = seventh(null, speedOnly('hard'));
    b.g.players[0].board.cols[0].shift();
    expect(b.cpu.poll(b.g).map((c) => c.type)).toEqual(['left']);
    expect(b.cpu.log.filter((l) => l.kind === 'seventhImprove')).toMatchObject([{ hit: true, detail: 'normal +1' }]);
  });

  it('ピンチ：所要見積りに新しい移動間隔・打上待ちを含める（上級：2歩＝7tick間隔＋移動5tick＋打上待ち2tick＋発射＋上詰め＋宣言1tick＋余裕200ms）', () => {
    const cfg = speedOnly('hard');
    const g0 = seventh(null, cfg).g;
    const tk = g0.tickMs;
    const need = 7 * tk + 90 + 2 * tk + 300 + 120 + tk + CPU_CONFIG.pinchMarginMs.hard;
    const edge = Math.floor(need / tk); // この tick 数では足りない
    const a = seventh(edge + 1, speedOnly('hard'));
    expect(a.cpu.poll(a.g).map((c) => c.type)).toEqual(['left']);
    // 速度なし（旧見積り）なら edge でも間に合う判定になる（新しい待ちが見積りに入っていることの確認）
    const old = speedOnly('hard');
    delete old.speed;
    const c = seventh(edge, old);
    expect(c.cpu.poll(c.g).map((x) => x.type)).toEqual(['left']);
    // 6♠（1歩）も同じ見積りで除外されるよう、1歩分の所要より短い残り猶予では宣言
    const one = 90 + 2 * tk + 300 + 120 + tk + CPU_CONFIG.pinchMarginMs.hard;
    const d = seventh(Math.floor(one / tk), speedOnly('hard'));
    expect(d.cpu.poll(d.g).map((x) => x.type)).toEqual(['declare']);
    expect(d.cpu.stats).toMatchObject({ seventhNoMargin: 1 });
  });
});
