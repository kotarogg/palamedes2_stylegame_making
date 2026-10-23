// v3.1.0 表示（DOM非依存部分）：ピンチ3/2/1の表示状態、ヒビの選択・維持・解除、連続出し／役連鎖の配置、受攻撃ストックの中央配置
import { describe, expect, it } from 'vitest';
import type { Command, Game } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import { GameView, STREAK_CRACKS } from '../src/view/gameView';
import { DEFAULT_STOCK_VIEW, FRAME_PAD, pendingGroupY, stockColumnLayout, stockGroupHeight } from '../src/view/stockLayout';
import { EMPTY, fakeAssets, makeGame, rows, stepN, toPlay } from './helpers';

const atk = (player: PlayerId, lines: number): Command => ({ player, type: 'debugAttack', lines });
const cmd = (player: PlayerId, type: Command['type']): Command => ({ player, type }) as Command;

describe('v3.1.0 ピンチの数字（表示状態）', () => {
  it('到達〜1000ms未満は数字なし、1000msで3（上から出現）、2000msで2、3000msで1。期限・解除で消える', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 3)]);
    while (!g.events.some((e) => e.type === 'attackPinch')) g.step();
    const t0 = g.tick;
    const at = (dt: number) => {
      while (g.tick < t0 + dt) g.step();
      v.syncEvents();
      return v.pinchCountView(0, g.tick);
    };
    expect(at(59)).toBeNull();
    const c3 = at(60)!;
    expect(c3.value).toBe(3);
    expect(c3.alpha).toBe(0); // 出現の始まり（上から）
    expect(c3.y).toBeLessThan(at(70)!.y); // 停止位置へ下りる
    expect(at(120)!.value).toBe(2);
    expect(at(180)!.value).toBe(1);
    const b = fakeAssets().layout.pRect(0, 'win_lose_banner');
    expect(at(200)).toMatchObject({ value: 1, x: b.x, y: b.y, alpha: 1 });
    expect(at(240)).toBeNull(); // 期限（敗北）
  });

  it('役処理中は数字が止まる（壁時計で1000msを過ぎても、有効な残り猶予が進まなければ切り替わらない）', () => {
    const g = makeGame({ boards: { 0: rows(7), 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 3)]);
    while (!g.events.some((e) => e.type === 'attackPinch')) g.step();
    stepN(g, 61);
    v.syncEvents();
    expect(v.pinchCountView(0, g.tick)?.value).toBe(3);
    g.players[0].role = { stage: 'intro', stageEnd: g.tick + 1000 } as never; // 役処理中（タイマー停止）を模擬
    stepN(g, 100);
    v.syncEvents();
    expect(v.pinchCountView(0, g.tick)?.value).toBe(3);
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

describe('v3.1.0 連続出し・役連鎖の配置（既存の倍率・連鎖領域を基礎に、画面内・盤面と重ならない）', () => {
  it('連続出し：見出し80×20、数字17px（初期表示）。1P は左上の倍率領域、2P は右上。盤面（y128〜）より上', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    for (const p of [0, 1] as const) {
      const s = v.streakHudLayout(p);
      expect(s.label.w).toBe(80);
      expect(s.label.h).toBe(20);
      expect(s.numbers.h).toBe(17);
      expect(s.label.x).toBeGreaterThanOrEqual(0);
      expect(s.label.x + s.label.w).toBeLessThanOrEqual(640);
      expect(s.numbers.y + s.numbers.h).toBeLessThanOrEqual(128);
    }
  });

  it('役連鎖：連鎖数34px（連続出しより大きい）、見出しは縦横等比1/2。盤面枠の外側の縦帯（1P x0〜48、2P x592〜640）', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    const l0 = v.roleChainHudLayout(0);
    const l1 = v.roleChainHudLayout(1);
    expect(l0.digitsH).toBe(34);
    expect(l0.digitsH).toBeGreaterThan(v.streakHudLayout(0).numbers.h);
    expect(l0.label.w / l0.label.h).toBe(96 / 24);
    expect(l0.label.x + l0.label.w).toBeLessThanOrEqual(48);
    expect(l1.label.x).toBeGreaterThanOrEqual(592);
    expect(l0.plusY + 16).toBeLessThan(168 + 96 + 100); // 連鎖ゲージの帯の中
  });
});

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
    // 列の間（1P 囲い右端 291 〜 2P 囲い左端 349）に数字を置く
    expect(cfg.origin[0][0] + 16 + FRAME_PAD).toBeLessThan(cfg.origin[1][0] - FRAME_PAD);
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([atk(0, 8), atk(1, 8)]);
    v.syncEvents();
    const a = v.pendingCountLabel(0, g.tick)!;
    const b = v.pendingCountLabel(1, g.tick)!;
    expect(a.align).toBe('left');
    expect(b.align).toBe('right');
    expect(a.x).toBeLessThan(b.x);
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
