// v3.2.0 移動の先行入力（2tick）：MODE1・MODE2 共通。境界・逆方向・同時押し・端・反復と予約の競合・離した時・硬直・詰まり
import { describe, expect, it } from 'vitest';
import type { Command } from '../src/core/game';
import { Mode2Game } from '../src/core/mode2';
import { makeGame, toPlay } from './helpers';

type Any = { tick: number; step(c?: readonly Command[]): void; players: { selectedCol: number; charMoveEndTick: number }[]; inputLog: { tick: number; event: string; action: string; reason?: string }[] };
const L = (repeat = false): Command => (repeat ? { player: 0, type: 'left', repeat: true } : { player: 0, type: 'left' });
const R = (repeat = false): Command => (repeat ? { player: 0, type: 'right', repeat: true } : { player: 0, type: 'right' });

function games(): [string, () => Any][] {
  return [
    ['MODE1', () => {
      const g = makeGame();
      toPlay(g);
      return g as unknown as Any;
    }],
    ['MODE2', () => {
      const g = new Mode2Game({ seed: 3, players: 1 });
      while (!g.playing) g.step();
      return g as unknown as Any;
    }],
  ];
}

/** 移動を1回始め、次に移動できる tick（charMoveEndTick）を返す */
function startMove(g: Any, c: Command = R()): number {
  g.step([c]);
  return g.players[0].charMoveEndTick;
}
const stepTo = (g: Any, tick: number, cmds: Command[] = []) => {
  while (g.tick + 1 < tick) g.step();
  g.step(cmds);
};
const finish = (g: Any) => {
  for (let i = 0; i < 40; i++) g.step();
};

describe.each(games())('%s：移動の先行入力 2tick', (_name, make) => {
  it('次に移動できるtickが E のとき、E−3 の入力は期限切れ、E−2・E−1 は E に1回、E は通常入力', () => {
    for (const [dt, moved, reason] of [
      [-3, false, 'expired'],
      [-2, true, null],
      [-1, true, null],
      [0, true, null],
    ] as const) {
      const g = make();
      const e = startMove(g);
      stepTo(g, e + dt, [R()]);
      if (dt < 0) {
        stepTo(g, e);
        expect(g.players[0].selectedCol, `dt=${dt}`).toBe(moved ? 4 : 3);
        if (moved) expect(g.players[0].charMoveEndTick).toBe(e + (e - (e - 5))); // 移動はちょうど E に開始（周期は変えない）
      }
      finish(g);
      expect(g.players[0].selectedCol, `dt=${dt}`).toBe(moved ? 4 : 3);
      if (reason) expect(g.inputLog.some((x) => x.reason === reason)).toBe(true);
    }
  });

  it('逆方向の新規押下は方向を更新。同じtickの左右同時の新規押下は中立。1回の入力で2列以上動かない', () => {
    const g = make();
    const e = startMove(g);
    stepTo(g, e - 2, [R()]);
    g.step([L()]); // 逆方向で更新
    finish(g);
    expect(g.players[0].selectedCol).toBe(2);
    const h = make();
    h.step([L(), R()]);
    finish(h);
    expect(h.players[0].selectedCol).toBe(2);
    expect(h.inputLog.some((x) => x.reason === 'simultaneous')).toBe(true);
  });

  it('端で無効になった予約は破棄（記録）。予約は1回だけ消費', () => {
    const g = make();
    const e = startMove(g, L()); // 2→1
    stepTo(g, e - 1, [L()]);
    finish(g); // 1→0
    expect(g.players[0].selectedCol).toBe(0);
    const e2 = startMove(g, L()); // 端：動かない
    expect(e2).toBeLessThanOrEqual(g.tick);
    const h = make();
    h.step([L()]);
    h.step([L()]);
    const end = h.players[0].charMoveEndTick;
    stepTo(h, end - 1, [L()]);
    finish(h);
    expect(h.players[0].selectedCol).toBe(0); // 2→1→0（期限切れの1件は数えない）
    expect(h.inputLog.filter((x) => x.event === 'consume')).toHaveLength(1);
  });

  it('自動反復：既存の予約を上書きせず期限も延ばさない。離したら反復でできた予約を捨てる。明示的な短押しは離しても期限内なら有効', () => {
    const g = make();
    const e = startMove(g);
    stepTo(g, e - 2, [L()]);
    g.step([R(true)]); // 反復は上書きしない
    finish(g);
    expect(g.players[0].selectedCol).toBe(2);
    const h = make();
    const e2 = startMove(h);
    stepTo(h, e2 - 2, [R(true)]); // 反復で予約
    h.step([{ player: 0, type: 'cancelRepeat' }]); // 移動終了前に離した
    finish(h);
    expect(h.players[0].selectedCol).toBe(3);
    expect(h.inputLog.some((x) => x.reason === 'released')).toBe(true);
    const k = make();
    const e3 = startMove(k);
    stepTo(k, e3 - 2, [R()]); // 短押し
    k.step([{ player: 0, type: 'cancelRepeat' }]); // 離しても有効
    finish(k);
    expect(k.players[0].selectedCol).toBe(4);
  });
});

describe('先行入力：硬直・詰まり・状態変化では残さない', () => {
  it('MODE1：発射の硬直を横断して左右予約を残さない（硬直中の入力は保持しない）', () => {
    const g = makeGame({ base: '1s', boards: { 0: { 2: ['2s', '3s'] } } });
    toPlay(g);
    g.step([{ player: 0, type: 'launch' }]);
    g.step([R()]);
    for (let i = 0; i < 60; i++) g.step();
    expect(g.players[0].selectedCol).toBe(2);
    g.clearInputBuffers();
    expect(g.players[0].buffered).toBeNull();
  });
});

describe('v3.2.0 先行入力：フレームレート別（30/60/120fps・低fps）', () => {
  /**
   * 実際の経路を再現：キー押下はフレームの間に KeyboardController へ積まれ、次のフレームで固定ステップ（FixedStepDriver）の
   * 最初のtickに受け付けられる。受付tickが E−2 以上なら E に1回だけ移動し、それより前なら期限切れ。どのfpsでも2列移動しない
   */
  it.each([30, 60, 120, 15])('%sfps：受付tick基準の規則どおり（同じ押下で複数回動かない）', async (fps) => {
    const { KeyboardController } = await import('../src/input/controller');
    const { FixedStepDriver } = await import('../src/core/driver');
    for (const [name, make] of games()) {
      for (let offsetMs = 0; offsetMs <= 120; offsetMs += 5) {
        const g = make();
        const kb = new KeyboardController(0);
        const driver = new FixedStepDriver({ tickMs: 1000 / 60, step: () => g.step(kb.poll()) });
        g.step([R()]);
        const E = g.players[0].charMoveEndTick;
        const startCol = g.players[0].selectedCol;
        // E のtickが始まる時刻の offsetMs 前に押す（t=0 はいま、次のtickは g.tick+1）
        const pressAt = (E - (g.tick + 1)) * (1000 / 60) - offsetMs;
        let t = 0;
        const frame = 1000 / fps;
        let pressed = false;
        let acceptTick = -1;
        while (t < 600) {
          if (!pressed && t + frame > pressAt) {
            // フレームの途中で押された：次のフレームで受け付け
            kb.handleKey('KeyD', false);
            pressed = true;
            acceptTick = g.tick + 1;
          }
          driver.advance(frame);
          t += frame;
        }
        const moves = g.players[0].selectedCol - startCol;
        const consumed = g.inputLog.filter((e) => e.event === 'consume' && e.action === 'right');
        if (acceptTick >= E) expect(moves, `${name} ${fps}fps ${offsetMs}ms 通常入力`).toBe(1);
        else if (acceptTick >= E - 2) {
          expect(moves, `${name} ${fps}fps ${offsetMs}ms accept${acceptTick} E${E}`).toBe(1);
          expect(consumed.map((e) => e.tick)).toEqual([E]);
        } else {
          expect(moves, `${name} ${fps}fps ${offsetMs}ms 期限切れ`).toBe(0);
          expect(g.inputLog.some((e) => e.event === 'discard' && e.reason === 'expired')).toBe(true);
        }
      }
    }
  });
});
