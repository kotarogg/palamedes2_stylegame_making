import { describe, expect, it } from 'vitest';
import { addLevelProgress, levelDef, MODE1_BALANCE, scoreMultiplier, stageDef } from '../src/core/balance';
import { Game, type Command, type GameEvent, type SingleOptions } from '../src/core/game';
import { SingleSession } from '../src/core/match';
import { EMPTY, kind, rows, setStock, stepN, testConfig, toPlay } from './helpers';
import type { GameConfig } from '../src/core/config';

const cmd = (type: Exclude<Command['type'], 'debugAttack'>): Command => ({ player: 0, type });
const evs = <T extends GameEvent['type']>(g: Game, type: T) => g.events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

interface SSetup {
  base?: string;
  cols?: Record<number, string[]>;
  stock?: string[];
}

function single(opts: SingleOptions, setup: SSetup = {}, config: GameConfig = testConfig()): Game {
  return new Game({
    seed: 3,
    config,
    single: opts,
    setup: (g) => {
      if (setup.base) g.base = g.factory.make(kind(setup.base).n, kind(setup.base).suit);
      for (const [c, codes] of Object.entries(setup.cols ?? {}))
        g.players[0].board.cols[Number(c)] = codes.map((code) => ({ kind: 'piece' as const, piece: g.factory.make(kind(code).n, kind(code).suit) }));
    },
  });
}

/** 成功打ち上げを1回行う（基準と一致する列2の最上段を発射して到達まで進める） */
function launchAndArrive(g: Game): void {
  g.step([cmd('launch')]);
  stepN(g, g.ticks(g.config.timing.launchMs) + g.ticks(g.config.timing.packMs) + 1);
}

describe('数値正本 mode1_balance_v1.json（28_MODE1_NUMERIC_DESIGN）', () => {
  it('ステージ全20面（V320-FIX-04 第10章の表）・Lv20到達2370・得点倍率表（攻撃倍率とは別）', () => {
    expect(MODE1_BALANCE.stages.map((s) => s.quota)).toEqual([30, 40, 50, 60, 70, 90, 110, 130, 150, 180, 100, 120, 140, 160, 180, 200, 220, 240, 260, 300]);
    expect(MODE1_BALANCE.stages.map((s) => s.natural_rise_ms)).toEqual([7000, 7000, 6000, 6000, 5000, 5000, 4000, 4000, 3000, 3000, 7000, 7000, 6000, 6000, 5000, 5000, 4000, 4000, 3000, 3000]);
    expect(MODE1_BALANCE.stages.map((s) => s.stage_clear_bonus)).toEqual(Array.from({ length: 20 }, (_, i) => (i + 1) * 1000));
    expect(MODE1_BALANCE.stages.every((s) => s.initial_pieces === 18)).toBe(true);
    expect(MODE1_BALANCE.stage_transition).toMatchObject({ restore_streak_remaining_ms: null, restore_chain_remaining_ms: 10000, danger_grace_max_ms: 4000 }); // V320-FIX-05
    expect(levelDef(20).cumulative_clears_to_enter).toBe(2370);
    expect(levelDef(20).required_clears_to_next).toBeNull();
    expect([1, 2, 3, 4, 5, 6, 7, 9].map((n) => scoreMultiplier(n)).map((m) => m.num / m.den)).toEqual([1, 1, 1.5, 1.5, 2, 2, 2.5, 2.5]);
  });

  it('Lv進捗：超過分は次Lvへ繰越し（29+6→Lv2の5）、全量を一度に加えても上限20で止まる', () => {
    expect(addLevelProgress(1, 29, 6)).toEqual({ level: 2, progress: 5, ups: [2] });
    const all = addLevelProgress(1, 0, 100000);
    expect(all.level).toBe(20);
    expect(all.ups).toHaveLength(19);
    expect(addLevelProgress(20, 0, 999).ups).toEqual([]);
    // 各Lvの到達累計と境界が一致
    for (let lv = 2; lv <= 20; lv++) expect(addLevelProgress(1, 0, levelDef(lv).cumulative_clears_to_enter).level).toBe(lv);
    expect(addLevelProgress(1, 0, levelDef(11).cumulative_clears_to_enter - 1).level).toBe(10);
  });
});

describe('MODE1シングル：消去数と得点（成功1／1ライン6）', () => {
  it('成功確定で消去数1・10点×成功後の連続取得の得点倍率。3連続目は15点。発射時点・失敗では加算しない', () => {
    const g = single({ kind: 'endless' }, { base: '1s', cols: { 2: ['2s', '3s', '4s', '6d', '5c'] } });
    toPlay(g);
    g.step([cmd('launch')]);
    expect(g.single!.score).toBe(0); // 発射時点では加算しない
    stepN(g, 40);
    launchAndArrive(g);
    launchAndArrive(g);
    expect(evs(g, 'score').map((e) => e.delta)).toEqual([10, 10, 15]);
    expect(g.single!.totalClears).toBe(3);
    launchAndArrive(g); // 6d は 4s に対して失敗
    stepN(g, 120);
    expect(evs(g, 'arrive').map((a) => a.success)).toEqual([true, true, true, false]);
    expect(g.single!.score).toBe(35);
    expect(g.single!.totalClears).toBe(3);
  });

  it('役による1ライン消去は空マスを含め消去数6・100×宣言時の得点倍率。盤面が空で実行されないラインは加算しない', () => {
    const g = single({ kind: 'endless' }, { cols: { 0: ['5c'], 1: [], 2: [], 3: [], 4: [], 5: [] } });
    toPlay(g);
    // 4s 3連続の得点倍率×1.5 を宣言時に保持
    g.players[0].streakCount = 3;
    g.players[0].streakRemaining = 999;
    setStock(g, 0, '1s', '2s', '3s', '4s'); // ストレートフラッシュ4翻＝4ライン予定
    g.step([cmd('declare')]);
    g.players[0].streakCount = 7; // 宣言後の変化はスナップショットに影響しない
    stepN(g, 200);
    const lines = evs(g, 'lineClear');
    expect(lines).toHaveLength(1); // 1列1個だけ：1ライン目で盤面が空になり打切り
    expect(evs(g, 'score').filter((e) => e.cause === 'line').map((e) => e.delta)).toEqual([150]);
    expect(g.single!.totalClears).toBe(6);
  });

  it('全消しは盤面が非空→空へ変化した時に1回だけ500点。帰還予約が残る見かけの空では確定しない。空盤面の毎tickでは加算しない', () => {
    const g = single({ kind: 'endless' }, { base: '1s', cols: { 0: [], 1: [], 2: ['2s'], 3: ['4h'], 4: [], 5: [] } });
    toPlay(g);
    // 列3の4hを失敗で打ち、帰還中に列2の2sを成功させても、帰還予約があるので全消しにならない
    g.players[0].selectedCol = 3;
    g.step([cmd('launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) + 1);
    g.players[0].selectedCol = 2;
    g.step([cmd('launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs) + 1);
    expect(evs(g, 'allClear')).toHaveLength(0);
    stepN(g, 200);
    // 4h（帰還済み）を成功させて空にする
    g.base = g.factory.make(4, 'heart');
    g.players[0].selectedCol = 3;
    launchAndArrive(g);
    expect(evs(g, 'allClear')).toHaveLength(1);
    stepN(g, 300);
    expect(evs(g, 'allClear')).toHaveLength(1);
    expect(evs(g, 'score').filter((e) => e.cause === 'allClear').map((e) => e.delta)).toEqual([500]);
  });
});

describe('MODE1シングル：ステージクリア', () => {
  it('ノルマ達成でクリア予約を1回だけ立て、新たな操作・自然上昇を止める。クリアボーナス1000×面番号。11面は生成しない', () => {
    const g = single({ kind: 'stage', stage: 3 }, { base: '1s', cols: { 2: ['2s', '3s'] } }, testConfig({ naturalRiseIntervalMs: 1000 }));
    toPlay(g);
    g.single!.progress = stageDef(3).quota - 1;
    launchAndArrive(g);
    expect(evs(g, 'quotaReached')).toHaveLength(1);
    expect(evs(g, 'stageClear')).toEqual([expect.objectContaining({ stage: 3, bonus: 3000, final: false })]);
    expect(g.result).toMatchObject({ outcome: 'stageClear' });
    const n = g.events.length;
    stepN(g, 300, () => [cmd('launch'), cmd('manualRise')]);
    expect(g.events.length).toBe(n);
  });

  it('同じアクションでノルマ達成と全消し：通常得点＋全消し500＋クリア1000×面番号（例：倍率1.5で2ライン＋全消し＋面3＝3800）', () => {
    const g = single({ kind: 'stage', stage: 3 }, { cols: { 0: ['5c', '5c'], 1: [], 2: [], 3: [], 4: [], 5: [] } });
    toPlay(g);
    g.single!.progress = stageDef(3).quota - 1;
    g.players[0].streakCount = 3;
    g.players[0].streakRemaining = 999;
    setStock(g, 0, '1s', '2s', '3s', '4s');
    g.step([cmd('declare')]);
    stepN(g, g.ticks(g.config.timing.roleIntroMs) + 2);
    // 1ライン目でノルマ達成：クリア予約。実行中の役は消去反復・加点まで完了させる
    expect(evs(g, 'quotaReached')).toHaveLength(1);
    expect(g.result).toBeNull();
    stepN(g, 300);
    expect(evs(g, 'lineClear')).toHaveLength(2);
    expect(g.single!.score).toBe(150 * 2 + 500 + 3000);
    expect(evs(g, 'stageClear')).toHaveLength(1);
  });

  it('ステージ間：得点・打上連鎖数・役連鎖数を引継ぎ、打上は時間制限なし・役連鎖は10秒（V320-FIX-05）へ戻す。盤面18・進捗0・危険非発動・その面の自然上昇周期', () => {
    const s = new SingleSession({ mode: 'stage', seed: 4, config: { naturalRiseIntervalMs: 5000 } });
    const g = s.game as Game;
    toPlay(g);
    g.single!.progress = 29;
    g.single!.score = 1234;
    g.players[0].chainCount = 2;
    g.players[0].chainRemaining = 999;
    // 基準と一致する列を用意して成功1回で達成
    g.players[0].board.cols[2] = [{ kind: 'piece', piece: g.factory.make(g.base.n, g.base.suit) }];
    g.players[0].selectedCol = 2;
    launchAndArrive(g);
    s.step([]);
    expect(s.state).toBe('result');
    expect(s.hasNext).toBe(true);
    const score = g.single!.score;
    expect(score).toBe(1234 + 10 + 1000);
    for (let i = 0; i < 60; i++) s.step([], true);
    const n = s.game as Game;
    expect(n).not.toBe(g);
    expect(s.stage).toBe(2);
    expect(n.single!.score).toBe(score);
    expect(n.single!.progress).toBe(0);
    expect(n.players[0].board.allIds()).toHaveLength(18);
    expect(n.players[0].streakCount).toBe(1);
    expect(n.players[0].streakRemaining).toBeNull(); // V320-FIX-05：打上連鎖は時間制限なし（旧：3000ms へ復帰）
    expect(n.players[0].chainCount).toBe(2);
    expect(n.players[0].chainRemaining).toBe(n.ticks(10000)); // V320-FIX-05：10秒（旧12秒）
    expect(n.players[0].graceRemaining).toBeNull();
    expect(n.players[0].riseIntervalTicks).toBe(n.ticks(stageDef(2).natural_rise_ms));
    // READY中は受付時間を減らさない
    stepN(n, 30);
    expect([n.players[0].streakRemaining, n.players[0].streakCount]).toEqual([null, 1]);
  });

  it('V320-FIX-04：ステージ10クリアは通常クリアで11面へ（ボーナス10000・11面の自然上昇7000ms・18個）', () => {
    const s = new SingleSession({ mode: 'stage', seed: 4, startStage: 10 });
    const g = s.game as Game;
    toPlay(g);
    g.single!.progress = 179;
    g.players[0].board.cols[2] = [{ kind: 'piece', piece: g.factory.make(g.base.n, g.base.suit) }];
    g.players[0].selectedCol = 2;
    launchAndArrive(g);
    s.step([]);
    expect(g.result).toMatchObject({ outcome: 'stageClear' });
    expect(evs(g, 'stageClear')[0]).toMatchObject({ stage: 10, bonus: 10000, final: false });
    expect(s.hasNext).toBe(true);
    for (let i = 0; i < 60; i++) s.step([], true);
    const n = s.game as Game;
    expect(s.stage).toBe(11);
    expect(n.single!.quota).toBe(100);
    expect(n.players[0].board.allIds()).toHaveLength(18);
    expect(n.players[0].riseIntervalTicks).toBe(n.ticks(7000));
  });

  it('V320-FIX-04：19→20面、ステージ20クリアだけ全ステージクリア（次面なし。ボーナス20000に倍率を掛けない）', () => {
    const s19 = new SingleSession({ mode: 'stage', seed: 4, startStage: 19 });
    const g19 = s19.game as Game;
    toPlay(g19);
    g19.single!.progress = 259;
    g19.players[0].board.cols[2] = [{ kind: 'piece', piece: g19.factory.make(g19.base.n, g19.base.suit) }];
    g19.players[0].selectedCol = 2;
    launchAndArrive(g19);
    s19.step([]);
    expect(g19.result).toMatchObject({ outcome: 'stageClear' });
    for (let i = 0; i < 60; i++) s19.step([], true);
    expect(s19.stage).toBe(20);
    expect((s19.game as Game).single!.quota).toBe(300);
    const s = new SingleSession({ mode: 'stage', seed: 4, startStage: 20 });
    const g = s.game as Game;
    toPlay(g);
    g.players[0].streakCount = 9;
    g.players[0].streakRemaining = 999;
    g.single!.progress = 299;
    g.players[0].board.cols[2] = [{ kind: 'piece', piece: g.factory.make(g.base.n, g.base.suit) }];
    g.players[0].selectedCol = 2;
    const before = g.single!.score;
    launchAndArrive(g);
    s.step([]);
    expect(g.result).toMatchObject({ outcome: 'allStagesClear' });
    expect(evs(g, 'stageClear')[0]).toMatchObject({ stage: 20, bonus: 20000, final: true });
    expect(evs(g, 'score').filter((e) => e.cause === 'stageClear').map((e) => e.delta)).toEqual([20000]);
    expect(g.single!.score - before).toBe(20000 + 25); // 成功10点×2.5（倍率は打上の得点だけ）
    expect(s.hasNext).toBe(false);
    for (let i = 0; i < 60; i++) s.step([], true);
    expect(s.state).toBe('finished');
  });

  it('危険猶予切れはゲームオーバー（勝者なし）', () => {
    const g = single({ kind: 'stage', stage: 1 }, { cols: rows(7) }, testConfig({ naturalRiseIntervalMs: 500 }));
    toPlay(g);
    stepN(g, 700); // 自然上昇の危険猶予4000ms（v3.1.0 修正R2）
    expect(g.result).toMatchObject({ winner: null, outcome: 'gameOver' });
  });
});

describe('MODE1シングル：ひたすら Lv1〜20', () => {
  it('昇格時は自然上昇の残時間を新Lvの全周期へ。Lv10→11で3秒→7秒。Lv20はMAXで以後昇格しない', () => {
    const g = single({ kind: 'endless' }, { base: '1s', cols: { 2: ['2s', '3s', '4s'] } }, testConfig({ naturalRiseIntervalMs: 5000 }));
    toPlay(g);
    expect(g.players[0].riseIntervalTicks).toBe(g.ticks(7000));
    g.single!.level = 10;
    g.single!.levelProgress = 179;
    launchAndArrive(g);
    expect(evs(g, 'levelUp').map((e) => e.level)).toEqual([11]);
    expect(g.players[0].riseIntervalTicks).toBe(g.ticks(7000));
    g.single!.level = 19;
    g.single!.levelProgress = 299;
    launchAndArrive(g);
    expect(evs(g, 'levelUp').map((e) => [e.level, e.max])).toEqual([
      [11, false],
      [20, true],
    ]);
    launchAndArrive(g);
    expect(g.single!.level).toBe(20);
    expect(evs(g, 'levelUp')).toHaveLength(2);
    expect(g.players[0].riseIntervalTicks).toBe(g.ticks(3000));
  });

  it('Lv変更だけで危険猶予を延長・解除しない（猶予中は残時間を維持）', () => {
    const g = single({ kind: 'endless' }, { base: '1s', cols: { ...rows(7), 2: ['2s', '5c', '5c', '5c', '5c', '5c', '5c'] } }, testConfig({ naturalRiseIntervalMs: 5000 }));
    toPlay(g);
    g.players[0].riseCountdown = 1;
    stepN(g, 2);
    expect(g.players[0].graceRemaining).not.toBeNull();
    const grace = g.players[0].graceRemaining!;
    g.single!.levelProgress = 29;
    g.step([cmd('launch')]);
    stepN(g, g.ticks(g.config.timing.launchMs));
    expect(evs(g, 'levelUp')).toHaveLength(1);
    expect(g.players[0].graceRemaining).toBe(grace - 1 - g.ticks(g.config.timing.launchMs));
  });

  it('全消しは500点、ステージボーナスなし。消去数・Lvは増やさない', () => {
    const g = single({ kind: 'endless' }, { base: '1s', cols: { ...EMPTY, 2: ['2s'] } });
    toPlay(g);
    launchAndArrive(g);
    expect(evs(g, 'allClear')).toHaveLength(1);
    expect(g.single!.score).toBe(10 + 500);
    expect(g.single!.totalClears).toBe(1);
    expect(evs(g, 'stageClear')).toHaveLength(0);
  });
});
