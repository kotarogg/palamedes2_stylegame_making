// 表示側の確定事項：役成立光（区間・原点オフセット・共有時計・描画順）、ライン消去後の段数推移、読み込み許可リスト
import { describe, expect, it } from 'vitest';
import { STOCK_PIECE_Z, GameView } from '../src/view/gameView';
import { CELL, Z } from '../src/view/geometry';
import { fakeAssets, makeGame, manifest, rows, setStock, stepN, toPlay, atlas } from './helpers';

describe('役成立光 v2.1（確定）', () => {
  it('採用位置の連続区間ごとに role_glow_<長さ> を1個。画像位置＝対象左上−原点オフセット', () => {
    const g = makeGame();
    const v = new GameView(g, fakeAssets());
    // 「12234」採用位置1・2・4・5 → 開始位置1と4に2枠用（1Pストック枠 x=66+24i, y=36）
    const two = v.glowPlacements(0, [0, 1, 3, 4], 'a');
    expect(two.map((p) => [p.back.id, p.front.id, p.x, p.y])).toEqual([
      ['role_glow_2_back_a', 'role_glow_2_front_a', 66, 32],
      ['role_glow_2_back_a', 'role_glow_2_front_a', 138, 32],
    ]);
    // 4枠・6枠は48px高で原点(0,12)、1〜3・5枠は32px高で原点(0,4)
    expect(v.glowPlacements(0, [1, 2, 3, 4], 'b').map((p) => [p.back.id, p.x, p.y])).toEqual([['role_glow_4_back_b', 90, 24]]);
    expect(v.glowPlacements(1, [0, 1, 2, 3, 4, 5], 'a').map((p) => [p.back.id, p.x, p.y])).toEqual([['role_glow_6_back_a', 386, 24]]);
    expect(v.glowPlacements(0, [0, 2, 3, 4, 5], 'a').map((p) => [p.back.id, p.back.w, p.back.h, p.x, p.y])).toEqual([
      ['role_glow_1_back_a', 24, 32, 66, 32],
      ['role_glow_4_back_a', 96, 48, 114, 24],
    ]);
    for (let n = 1; n <= 6; n++) {
      const f = atlas().frame('S6', `role_glow_${n}_back_a`);
      expect(f.target_rect).toEqual({ x: 0, y: n === 4 || n === 6 ? 12 : 4, w: 24 * n, h: 24 });
      expect([f.w, f.h]).toEqual([24 * n, n === 4 || n === 6 ? 48 : 32]);
    }
  });

  it('A/B 各250ms・周期500ms の共有時計。ラウンドの切替や採用対象の更新でリセットしない', () => {
    const g = makeGame();
    const v = new GameView(g, fakeAssets());
    const at = (ms: number) => v.glowPhase(ms / g.tickMs);
    expect([0, 249, 250, 499, 500, 750].map(at)).toEqual(['a', 'a', 'b', 'b', 'a', 'b']);
    // 採用対象の更新（ストック変化）は時計に影響しない：位相は時刻だけで決まる
    setStock(g, 0, '1s', '2s', '3s', '4s');
    expect(at(260)).toBe('b');
    // ラウンド切替：経過時間を引き継ぐ
    stepN(g, 15); // 250ms
    const h = makeGame();
    v.reset(h);
    expect(v.glowClockMs(0)).toBeCloseTo(250, 6);
    expect(v.glowPhase(0)).toBe('b');
  });

  it('成立している間は宣言前から発光し、役名表示中は消費したストックを採用位置ごと表示する。不成立なら発光しない', () => {
    const g = makeGame({ boards: { 0: rows(4) } });
    const v = new GameView(g, fakeAssets());
    setStock(g, 0, '1s', '6d', '2c', '3s', '4c');
    toPlay(g);
    expect(v.glowTargets(0, g.tick)?.indices).toEqual([0, 2, 3, 4]);
    setStock(g, 1, '1s', '1d', '2s', '4d');
    expect(v.glowTargets(1, g.tick)).toBeNull();
    g.step([{ player: 0, type: 'declare' }]);
    v.syncEvents();
    expect(g.players[0].roleStock).toHaveLength(0);
    const during = v.glowTargets(0, g.tick + 1);
    expect(during?.pieces).toHaveLength(5);
    expect(during?.indices).toEqual([0, 2, 3, 4]);
    expect(v.glowTargets(0, g.tick + g.ticks(g.config.timing.roleIntroMs) + 1)).toBeNull();
  });

  it('描画順は 背面光→ストックのピース→前面光（キャラは前面光の下）', () => {
    expect(Z.glowBack < STOCK_PIECE_Z && STOCK_PIECE_Z < Z.character && Z.character < Z.glowFront).toBe(true);
  });

  it('旧来の role_glow_6_spark は常時囲み光のアニメーションに含めない', () => {
    const anims = manifest().animations;
    for (const [k, ids] of Object.entries(anims)) if (k.startsWith('S6/role_glow')) expect(ids).not.toContain('role_glow_6_spark');
  });
});

describe('ライン消去後の段数推移（表示）', () => {
  it('消去したラインの下のピースは絶対位置に留まり、足場・キャラだけが1段ずつTWEENする', () => {
    const g = makeGame({ boards: { 0: rows(4) } });
    const v = new GameView(g, fakeAssets());
    setStock(g, 0, '1s', '2s', '3s', '4s');
    toPlay(g);
    v.syncEvents();
    const before = { piece: v.pieceBar(0, g.tick), bar: v.barVisual(0, g.tick) };
    const secondRowY = before.piece + CELL; // 消去前の2段目
    g.step([{ player: 0, type: 'declare' }]);
    stepN(g, g.ticks(g.config.timing.roleIntroMs));
    v.syncEvents();
    const lc = g.events.find((e) => e.type === 'lineClear')!;
    if (lc.type !== 'lineClear') throw new Error();
    // 消去直後：残ったピース（新しい最上段）は元の2段目の位置のまま
    expect(v.pieceBar(0, lc.tick)).toBeCloseTo(secondRowY, 6);
    expect(v.barVisual(0, lc.tick)).toBeCloseTo(before.bar, 6); // 足場は消去演出中まだ動かない
    expect(v.barVisual(0, lc.shiftEnd)).toBeCloseTo(before.bar + CELL, 6);
    const mid = (lc.clearEnd + lc.shiftEnd) / 2;
    expect(v.barVisual(0, mid)).toBeGreaterThan(before.bar);
    expect(v.pieceBar(0, mid)).toBeCloseTo(secondRowY, 6);
  });
});
