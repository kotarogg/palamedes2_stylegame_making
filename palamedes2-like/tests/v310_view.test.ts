// v3.1.0 表示（DOM非依存部分）：ピンチ3/2/1の表示状態、ヒビの選択・維持・解除、連続出し／役連鎖の配置、受攻撃ストックの中央配置
import { describe, expect, it } from 'vitest';
import type { Command, Game } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import { GameView, STREAK_CRACKS } from '../src/view/gameView';
import { DEFAULT_STOCK_VIEW, FRAME_PAD, pendingGroupY, stockColumnLayout, stockGroupHeight } from '../src/view/stockLayout';
import { EMPTY, fakeAssets, makeGame, rows, stepN, toPlay } from './helpers';

const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });
const cmd = (player: PlayerId, type: Command['type']): Command => ({ player, type }) as Command;

// V320-FIX-05 で更新：盤面上の大型 3/2/1 と「危険○秒」を廃止し、盤面の上の帯の警告「ピンチ」「ピンチ X.X秒」へ置換
describe('V320-FIX-05 ピンチ警告（表示状態）', () => {
  it('到達〜1000ms未満は「ピンチ」、1000ms以降は「ピンチ X.X秒」（0.1秒単位で切上げ）。期限（敗北）で消える。1P は (88,16,144,14)', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 3)]);
    while (!g.events.some((e) => e.type === 'attackPinch')) g.step();
    const t0 = g.tick;
    const at = (dt: number) => {
      while (g.tick < t0 + dt) g.step();
      v.syncEvents();
      return v.pinchWarnView(0);
    };
    expect(at(0)).toMatchObject({ text: 'ピンチ', cx: 160, area: { x: 88, y: 16, w: 144, h: 14 } });
    expect(at(59)?.text).toBe('ピンチ');
    // 残秒はゲームの有効な残り猶予（tick）を 0.1秒単位で切上げ
    const want = () => `ピンチ ${(Math.ceil((g.pinchRemainingTicks(g.players[0])! * g.tickMs) / 100) / 10).toFixed(1)}秒`;
    expect(at(60)?.text).toBe('ピンチ 3.0秒');
    let lastText = '';
    for (let dt = 61; dt < 300 && !g.result; dt++) {
      const w = at(dt);
      if (!w) break;
      expect(w.text, `dt=${dt}`).toBe(want());
      expect(w.text, `dt=${dt}`).not.toBe('ピンチ 0.0秒'); // 期限前に 0.0秒 と見せない
      lastText = w.text;
    }
    expect(lastText).toBe('ピンチ 0.1秒');
    while (!g.result) g.step();
    v.syncEvents();
    expect(v.pinchWarnView(0)).toBeNull(); // 期限（敗北）で消える
    expect(v.pinchWarnView(1)).toBeNull();
  });

  it('役処理中は残秒が止まる（有効な残り猶予が進まなければ表示も進まない）', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 3)]);
    while (!g.events.some((e) => e.type === 'attackPinch')) g.step();
    stepN(g, 61);
    v.syncEvents();
    const before = v.pinchWarnView(0)?.text;
    g.players[0].role = { stage: 'intro', stageEnd: g.tick + 1000 } as never; // 役処理中（タイマー停止）を模擬
    stepN(g, 100);
    v.syncEvents();
    expect(v.pinchWarnView(0)?.text).toBe(before);
  });
});

describe('v3.1.0 連鎖切り予約のヒビ（表示状態）', () => {
  const board = { 0: ['4d', '5c'], 1: ['2s', '5c'], 2: ['4h', '5c'], 3: ['3s', '5c'], 4: ['4c', '5c'], 5: ['2s', '5c'] };
  function launch(g: Game, col: number) {
    g.players[0].selectedCol = col;
    g.step([cmd(0, 'launch')]);
    stepN(g, 30);
  }
  it('予約発生時に3種から1つ選び予約中は固定（成功で数字が変わっても維持）。終了で解除し新しい連鎖へ残さない', () => {
    const g = makeGame({ base: '1s', boards: { 0: board, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.players[0].streakCount = 7;
    g.players[0].streakRemaining = 100;
    launch(g, 0);
    v.syncEvents();
    const pv = (v as unknown as { pv: { crack: string | null }[] }).pv;
    const c = pv[0].crack;
    expect(STREAK_CRACKS).toContain(c);
    launch(g, 1); // 成功（8回）
    v.syncEvents();
    expect(pv[0].crack).toBe(c);
    launch(g, 2); // 再ミスで終了
    v.syncEvents();
    expect(pv[0].crack).toBeNull();
  });
});

// v3.1.0 の打上連鎖（上部の倍率領域）・役連鎖（見出し1/2縮小）の配置は V320-FIX-03 で縦帯へ変更（tests/v320_fix03_hud.test.ts）

describe('v3.1.0 受攻撃ストックの中央配置', () => {
  it('1P／2P の最大表示（予約29＋待機28＋相殺）が中央エリア（x264〜376）に収まり、左右の列・数字が重ならない', () => {
    const cfg = DEFAULT_STOCK_VIEW;
    for (const p of [0, 1] as const) {
      const [x0, top] = cfg.origin[p];
      const py = top + pendingGroupY(stockGroupHeight(29), null, null);
      const L = stockColumnLayout(x0, top, py, 1, 28, [{ kind: 'counter', lines: 12, ms: 0, y: py + stockGroupHeight(16) }]);
      for (const e of L) {
        expect(e.x).toBeGreaterThanOrEqual(264);
        expect(e.x + e.w).toBeLessThanOrEqual(376);
        expect(e.y + e.h).toBeLessThanOrEqual(360);
      }
    }
    // V320-FIX-06 で更新：アイコン横の数量数字（旧 pendingCountLabel）は 1P・2P とも削除。列の間に数字を置かない
    expect(cfg.origin[0][0] + 16 + FRAME_PAD).toBeLessThan(cfg.origin[1][0] - FRAME_PAD);
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 8), atk(1, 8)]);
    v.syncEvents();
    expect('pendingCountLabel' in v).toBe(false);
    for (const p of [0, 1] as const) {
      const plan = v.stockDrawPlan(p, g.tick);
      expect(Object.keys(plan)).toEqual(['entries']);
      expect(plan.entries.filter((e) => e.type === 'icon').length).toBeGreaterThan(0); // アイコンは残る
    }
  });
});

describe('v3.1.0 修正R1：開始前待機中は READY・GO を出さない', () => {
  it('待機中（tick 0）は見出しなし → 待機後に READY → GO。新ラウンド（reset）でも同じ', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    v.hud = { preStart: true };
    for (const t of [0, 0.5, 1]) expect(v.startBanner(t)).toBeNull();
    v.hud = { preStart: false };
    expect(v.startBanner(0)).toBe('show_ready');
    expect(v.startBanner(g.playStartTick)).toBe('show_go');
    expect(v.startBanner(g.playStartTick + g.ticks(g.config.timing.goMs))).toBeNull();
    // 新ラウンド・再戦（盤面を準備し直す）：待機中は同じく出さない
    const g2 = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    v.reset(g2);
    v.hud = { preStart: true };
    expect(v.startBanner(0)).toBeNull();
    expect(v.startBanner(g2.playStartTick)).toBeNull();
  });
});
