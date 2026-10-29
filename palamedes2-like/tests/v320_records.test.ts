// v3.2.0 記録・設定：旧データの読込、ノーリセットクリアの判定・1クリア1回の加算・CPU対戦／教材は記録しない、補助表示の設定
import { describe, expect, it } from 'vitest';
import { App, GameScene } from '../src/app';
import { AudioBus } from '../src/audio/audioBus';
import { Mode2Game } from '../src/core/mode2';
import { Mode2Stage } from '../src/demo/stages';
import { defaultSettings, parseSettings } from '../src/input/settings';
import { emptyRecords, MODE2_RULE_ID, parseRecords, STAGE_RULE_ID, submitMode2, submitStage } from '../src/ui/records';
import { fakeAssets, kind } from './helpers';

function makeApp() {
  return new App({
    assets: fakeAssets(),
    bus: new AudioBus('./'),
    pads: () => null,
    settings: defaultSettings(),
    applyDisplay: () => undefined,
    requestFullscreen: () => undefined,
    viewport: () => ({ w: 1280, h: 720, dpr: 1 }),
    openUrl: () => undefined,
    dev: false,
  });
}

describe('v3.2.0 旧データの読込', () => {
  it('記録：旧データにノーリセット達成回数がなければ0、旧タイム・他の記録は保護', () => {
    const old = JSON.stringify({ endless: { score: 1200, level: 4 }, stage: null, mode2Single: { bestMs: 61234 } });
    const r = parseRecords(old);
    expect(r.mode2NoReset).toBe(0);
    expect(r.mode2Single).toEqual({ bestMs: 61234 });
    expect(r.mode2NoResetBest).toBeNull(); // 旧達成回数から専用時間を捏造しない
    expect(r.endless).toEqual({ score: 1200, level: 4 });
    expect(parseRecords(JSON.stringify({ mode2NoReset: 3 })).mode2NoReset).toBe(3);
    expect(parseRecords('{broken').mode2NoReset).toBe(0);
  });

  it('設定：旧データに補助表示がなければON、他の設定は保護。CPUの強さは新規だけ初級（保存済みは上書きしない）', () => {
    const old = parseSettings(JSON.stringify({ firstTo: 3, difficulty: 'hard', npcLevel: 'normal' }));
    expect(old.assist).toBe(true);
    expect(old.firstTo).toBe(3);
    expect(old.difficulty).toBe('hard');
    expect(old.npcLevel).toBe('normal');
    expect(parseSettings(JSON.stringify({ assist: false })).assist).toBe(false);
    expect(defaultSettings()).toMatchObject({ assist: true, npcLevel: 'easy' });
  });

  it('V320-FIX-04 MODE2：総合ベストとノーリセット専用ベストを独立判定。同タイム（tick）は新記録でない。ルール識別を付ける', () => {
    const r = emptyRecords();
    r.mode2NoReset = 5; // 旧達成回数は加算しない
    expect(submitMode2(r, 3000, 50000, false)).toEqual({ total: true, noReset: false });
    expect(r.mode2NoResetBest).toBeNull();
    // ノーリセットで遅い → 総合は更新なし、専用は初回作成
    expect(submitMode2(r, 3300, 55000, true)).toEqual({ total: false, noReset: true });
    expect(r.mode2NoResetBest).toEqual({ bestMs: 55000, bestTicks: 3300, rule: MODE2_RULE_ID });
    // 同tick は新記録でない（総合・専用とも）
    expect(submitMode2(r, 3000, 50000, true)).toEqual({ total: false, noReset: true });
    expect(submitMode2(r, 3000, 50000, true)).toEqual({ total: false, noReset: false });
    // 更新ありのクリアは専用を更新しない
    expect(submitMode2(r, 2900, 48333, false)).toEqual({ total: true, noReset: false });
    expect(r.mode2Single).toEqual({ bestMs: 48333, bestTicks: 2900, rule: MODE2_RULE_ID });
    expect(r.mode2NoReset).toBe(5);
    // 旧保存（ms のみ）は ms で比較。同値は更新しない
    const old = parseRecords(JSON.stringify({ mode2Single: { bestMs: 50000 } }));
    expect(submitMode2(old, 3000, 50000, false).total).toBe(false);
    expect(parseRecords(JSON.stringify(r))).toEqual(r);
  });

  it('V320-FIX-04 ステージ：旧（全10面・ルール識別なし）の記録は消さずに旧ルール欄へ。20面の記録とは比較しない', () => {
    const r = parseRecords(JSON.stringify({ stage: { score: 90000, maxStage: 10, completed: true } }));
    expect(r.stage).toBeNull();
    expect(r.stageLegacy10).toEqual({ score: 90000, maxStage: 10, completed: true });
    expect(submitStage(r, 1000, 2, false)).toBe(true);
    expect(r.stage).toEqual({ score: 1000, maxStage: 2, completed: false, rule: STAGE_RULE_ID });
    const back = parseRecords(JSON.stringify(r));
    expect(back).toEqual(r);
  });
});

describe('v3.2.0 ノーリセットクリアの判定', () => {
  /** 1列に基準と同じ数字のピースだけ：打ち上げ1回でクリア */
  function oneShot(players: 1 | 2 = 1) {
    const g = new Mode2Game({
      seed: 5,
      players,
      setup: (x) => {
        x.base = x.factory.make(3, kind('3s').suit);
        for (const p of x.players) {
          p.board.cols.forEach((c) => (c.length = 0));
          p.board.cols[p.selectedCol].push({ kind: 'piece', piece: x.factory.make(3, kind('3h').suit) });
        }
      },
    });
    while (!g.playing) g.step();
    return g;
  }

  it('場の更新0回でSINGLEクリア → 1P。場の更新があれば対象外。打ち上げ失敗は失格条件にしない', () => {
    const g = oneShot();
    g.step([{ player: 0, type: 'launch' }]);
    for (let i = 0; i < 200 && !g.result; i++) g.step();
    expect(g.result?.outcome).toBe('clear');
    expect(g.noResetAchiever()).toBe(0);
    const h = oneShot();
    (h as unknown as { refreshCount: number }).refreshCount = 1;
    h.step([{ player: 0, type: 'launch' }]);
    for (let i = 0; i < 200 && !h.result; i++) h.step();
    expect(h.noResetAchiever()).toBeNull();
  });

  it('対戦：勝者だけ（引分けは対象外）', () => {
    const g = oneShot(2);
    g.step([{ player: 1, type: 'launch' }]);
    for (let i = 0; i < 200 && !g.result; i++) g.step();
    expect(g.result).toMatchObject({ outcome: 'win', winner: 1 });
    expect(g.noResetAchiever()).toBe(1);
    const d = oneShot(2);
    d.step([
      { player: 0, type: 'launch' },
      { player: 1, type: 'launch' },
    ]);
    for (let i = 0; i < 200 && !d.result; i++) d.step();
    expect(d.result?.outcome).toBe('draw');
    expect(d.noResetAchiever()).toBeNull();
  });
});

describe('v3.2.0 記録の登録（本編シーン）', () => {
  /** 本編の GameScene を開始待機の後まで進め、盤面を1発でクリアできる形にする */
  function scene(kindOf: 'single' | 'cpu') {
    const app = makeApp();
    app.startGame('mode2', kindOf, kindOf === 'single' ? 'mode2' : undefined, kindOf === 'single' ? undefined : ['kotaro', 'akane']);
    const sc = app.scene as GameScene;
    (sc as unknown as { holdMs: number | null }).holdMs = null;
    const g = sc.game as Mode2Game;
    for (let i = 0; i < 600 && !g.playing; i++) sc.update(1000 / 60);
    for (const p of g.players) {
      p.board.cols.forEach((c) => (c.length = 0));
      p.board.cols[p.selectedCol].push({ kind: 'piece', piece: g.factory.make(g.base.n, g.base.suit === 'spade' ? 'heart' : 'spade') });
    }
    return { app, sc, g };
  }

  it('SINGLE：ノーリセットクリアで総合・専用ベストを登録（結果表示中に何度更新しても二重登録しない）。達成回数は加算しない', () => {
    const { app, sc, g } = scene('single');
    app.onKey('KeyF', false);
    for (let i = 0; i < 900; i++) sc.update(1000 / 60);
    expect(g.result?.outcome).toBe('clear');
    expect(app.records.mode2NoReset).toBe(0);
    expect(app.records.mode2Single).toEqual({ bestMs: g.elapsedMs(), bestTicks: g.elapsedTicks(), rule: MODE2_RULE_ID });
    expect(app.records.mode2NoResetBest).toEqual(app.records.mode2Single);
    for (let i = 0; i < 300; i++) sc.update(1000 / 60);
    expect(app.records.mode2NoResetBest?.bestTicks).toBe(g.elapsedTicks());
  });

  it('CPU対戦：CPU・人間どちらの勝利も SINGLE の記録へ登録しない', () => {
    const { app, sc, g } = scene('cpu');
    for (let i = 0; i < 900 && !g.result; i++) sc.update(1000 / 60);
    expect(g.result).not.toBeNull();
    expect(app.records.mode2NoResetBest).toBeNull();
    expect(app.records.mode2Single).toBeNull();
  });

  it('MODE2説明教材：クリアしても記録しない（記録の処理を持たない）', () => {
    const app = makeApp();
    const st = new Mode2Stage({ assets: fakeAssets(), bus: new AudioBus('./') });
    for (let i = 0; i < 60 * 200 && !st.finished; i++) st.update(1000 / 60); // V320-FIX-04：説明ごとに5000msの読書
    expect(st.finished).toBe(true);
    expect(app.records).toEqual(emptyRecords());
  });
});
