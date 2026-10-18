// 描画FPS・補間コールバックがゲーム結果を変えないこと／帰還下降の固定時間と最終座標の一致
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_CONFIG } from '../src/core/config';
import { FixedStepDriver } from '../src/core/driver';
import type { Command } from '../src/core/game';
import { createSeededRng, randomInt } from '../src/core/rng';
import type { PlayerId } from '../src/core/types';
import type { Assets } from '../src/view/assets';
import { CELL, descentY } from '../src/view/geometry';
import { GameView } from '../src/view/gameView';
import { atlas, layout, makeGame, stepN, stepUntil, testConfig, toPlay } from './helpers';

const ACTIONS = ['left', 'right', 'launch', 'rotate', 'declare', 'manualRise'] as const;

function script(seed: number, ticks: number): Map<number, Command[]> {
  const rng = createSeededRng(seed);
  const m = new Map<number, Command[]>();
  for (let t = 80; t < ticks; t++) {
    const cmds: Command[] = [];
    for (const p of [0, 1] as PlayerId[]) if (rng.next() < 0.25) cmds.push({ player: p, type: ACTIONS[randomInt(rng, ACTIONS.length)] });
    if (rng.next() < 0.01) cmds.push({ player: randomInt(rng, 2) as PlayerId, type: 'debugAttack', lines: 1 + randomInt(rng, 12) });
    if (cmds.length) m.set(t, cmds);
  }
  return m;
}

const fakeAssets = (): Assets => ({ atlas: atlas(), layout: layout(), images: new Map(), darkS4: null as never, darkAlpha: 0.5 });

describe('描画FPSに依存しない', () => {
  const TICKS = 3600;
  const cfg = testConfig({ naturalRiseIntervalMs: 4000 });
  const run = (dts: (i: number) => number, withView: boolean) => {
    const g = makeGame({}, cfg, 2026);
    const sc = script(11, TICKS);
    const driver = new FixedStepDriver(g, (game) => sc.get(game.tick + 1) ?? []);
    const view = withView ? new GameView(g, fakeAssets()) : null;
    const vr = createSeededRng(5);
    for (let i = 0; g.tick < TICKS; i++) {
      driver.advance(dts(i));
      if (view && vr.next() < 0.7) {
        // 補間値の取得・イベント取込の順序やタイミングを不規則にしても結果は同じ
        view.syncEvents();
        for (const f of view.activeFlights()) view.flightPosition(f, driver.time);
        view.barVisual(0, driver.time);
        view.characterX(1, driver.time);
      }
    }
    while (g.tick > TICKS) throw new Error('overshoot');
    return { snap: g.snapshot(), events: g.events.length, g };
  };

  it('60/30/144fps・不規則フレームで同一入力から同一の状態になる', () => {
    const base = run(() => 1000 / 60, false);
    const r30 = run(() => 1000 / 30, true);
    const r144 = run(() => 1000 / 144, true);
    const jitter = createSeededRng(9);
    const rj = run(() => 2 + jitter.next() * 60, true);
    expect(base.events).toBeGreaterThan(200);
    for (const r of [r30, r144, rj]) {
      expect(r.snap).toBe(base.snap);
      expect(r.events).toBe(base.events);
    }
    // 検証が無意味でないこと：打ち上げ・到達・帰還・宣言が実際に起きている
    const types = new Set(base.g.events.map((e) => e.type));
    for (const t of ['launch', 'arrive', 'returned', 'rotate', 'rise']) expect(types.has(t as never), t).toBe(true);
  });
});

describe('失敗帰還の低速下降（表示）', () => {
  it('descentY：目標が動いても終了時刻に目標と一致し、所要時間は不変', () => {
    expect(descentY(10, 0, 10, 76, 300)).toBe(300);
    expect(descentY(0, 0, 10, 76, 300)).toBe(76);
    expect(descentY(10, 0, 10, 76, 120)).toBe(120);
    expect(descentY(5, 0, 10, 76, 300)).toBeCloseTo((76 + 300) / 2, 6);
  });

  it('下降中に盤面が上昇しても、帰還完了tickで描画位置が最新の予約位置と一致し、盤面描画へ連続して引き継ぐ', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['4d', '6h'] } } });
    const view = new GameView(g, fakeAssets());
    toPlay(g);
    g.step([{ player: 0, type: 'launch' }]);
    stepN(g, g.ticks(g.config.timing.launchMs));
    view.syncEvents();
    const f = view.activeFlights()[0];
    expect(f.failed).toBe(true);
    const duration = f.returnEnd - f.arcEnd;
    expect(duration).toBe(g.ticks(g.config.timing.descendMs));
    // 下降中：手動上昇（TWEEN）と攻撃（SNAP）を重ねる
    stepUntil(g, f.arcEnd + 5);
    g.step([{ player: 0, type: 'manualRise' }]);
    stepN(g, 3);
    g.step([{ player: 0, type: 'debugAttack', lines: 3 }]);
    stepUntil(g, f.returnEnd - 1);
    view.syncEvents();
    expect(f.returnEnd - f.arcEnd).toBe(duration);
    const tEnd = f.returnEnd - 1e-9;
    const pos = view.flightPosition(f, tEnd);
    const slotY = view.barVisual(0, tEnd); // 予約空白は最上段
    expect(pos.y).toBeCloseTo(slotY, 4);
    // 帰還完了後は盤面描画（足場Y + 32*index）へ引き継ぐ
    g.step();
    view.syncEvents();
    expect(view.activeFlights()).toHaveLength(0);
    const col = g.players[0].board.cols[2];
    expect(col[0]).toMatchObject({ kind: 'piece', piece: { id: f.piece.id } });
    expect(view.barVisual(0, f.returnEnd) + CELL * 0).toBeCloseTo(slotY, 4);
    // 山なり区間の終点は元列X・暫定Y76
    const arcEnd = view.flightPosition({ ...f }, f.arcEnd);
    expect(arcEnd.y).toBe(DEFAULT_VIEW_CONFIG.arcEndY);
  });

  it('打ち上げの直線所要時間は列・距離によらず同一', () => {
    const g = makeGame({ base: '1s' });
    toPlay(g);
    g.step([{ player: 0, type: 'launch' }]);
    g.step([{ player: 1, type: 'left' }]);
    stepN(g, g.ticks(g.config.timing.charMoveMs));
    g.step([{ player: 1, type: 'left' }]);
    stepN(g, g.ticks(g.config.timing.charMoveMs));
    g.step([{ player: 1, type: 'launch' }]);
    const launches = g.events.filter((e) => e.type === 'launch');
    expect(launches.map((e) => (e.type === 'launch' ? e.arriveTick - e.tick : 0))).toEqual([24, 24]);
    expect(launches.map((e) => (e.type === 'launch' ? e.col : -1))).toEqual([2, 0]);
  });
});
