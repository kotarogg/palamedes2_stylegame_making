// 修正R1：対戦デモの決着後、中央の「対戦結果」見出しを出さない（左右の勝利／敗北・落下・勝者演出・クラッカーは維持）。本編は従来どおり
import { describe, expect, it } from 'vitest';
import { AudioBus } from '../src/audio/audioBus';
import { DEMO, VersusDemoStage } from '../src/demo/stages';
import { GameView } from '../src/view/gameView';
import { planResult } from '../src/view/presentation';
import { EMPTY, fakeAssets, makeGame } from './helpers';

describe('修正R1：結果の中央見出しの表示条件', () => {
  it('対戦の決着：本編（matchOver）は「対戦結果」、放置デモ（matchOver なし）は中央見出しなし。結果前・他の結果種別は従来どおり', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    (g as unknown as { result: unknown }).result = { outcome: 'win', winner: 1, tick: 100 };
    const plan = planResult(g)!;
    v.hud = { result: plan, matchOver: true };
    expect(v.resultBanner(99)).toBeNull(); // 結果開始前
    expect(v.resultBanner(100)).toBe('extra:result_match_ja'); // 本編の最終結果（変更なし）
    v.hud = { result: plan, matchOver: false };
    expect(v.resultBanner(100)).toBeNull();
    v.hud = { result: plan };
    expect(v.resultBanner(500)).toBeNull();
    // 引分け・シングルの結果は従来どおり
    (g as unknown as { result: unknown }).result = { outcome: 'draw', winner: null, tick: 100 };
    v.hud = { result: planResult(g)!, matchOver: false };
    expect(v.resultBanner(100)).toBe('extra:result_draw_ja');
  });
});

describe('修正R1：対戦デモ（DEMO.versusSeed＝V320-FIX-05 で 5）の終盤', () => {
  it('決着後も中央見出しなし。左右の勝利／敗北・敗者の落下・勝者のボイス・クラッカー・勝利SEは結果演出どおり。終了は演出後（短縮しない）', () => {
    const bus = new AudioBus('./');
    const st = new VersusDemoStage({ assets: fakeAssets(), bus });
    expect(st.hud().matchOver).toBe(false);
    let guard = 0;
    while (!st.finished && guard++ < 60 * 120) st.update(1000 / 60);
    const g = st.game;
    const plan = st.resultPlan!;
    // V320-FIX-05：seed 変更で勝者は seed に依存（勝敗補正なし）。勝者・敗者を結果から読む
    const w = g.result!.winner!;
    expect([0, 1]).toContain(w);
    expect(plan.kind).toBe('versus');
    expect([plan.loser, plan.winner]).toEqual([1 - w, w]);
    expect(plan.fallEndTick).toBeGreaterThan(plan.fallStartTick);
    expect(plan.crackerTick).toBe(plan.winnerTick);
    // 終了判定の時点で勝者演出・受付・結果演出の保持（1500ms）を過ぎている
    expect(g.tick).toBeGreaterThanOrEqual(plan.acceptTick + g.ticks(DEMO.resultHoldMs) - 1);
    // 描画と同じ HUD で、決着後の全区間で中央見出しが出ない
    st.view.hud = { ...st.hud(), result: plan };
    for (let t = plan.startTick; t <= g.tick; t += 10) expect(st.view.resultBanner(t), `t=${t}`).toBeNull();
    // 結果演出の音（未解除のため locked 記録）：敗者ボイス→落下→勝者ボイス＋勝利SE→クラッカー
    const ids = bus.log.filter((e) => !e.skipped && e.t >= 0).map((e) => e.id);
    const name = ['akane', 'zunko'];
    const lose = `${name[1 - w]}_lose`;
    const win = `${name[w]}_win`;
    for (const id of [lose, 'character_fall', win, 'win', 'result_cracker']) expect(ids, id).toContain(id);
    expect(ids.indexOf(lose)).toBeLessThan(ids.indexOf(win));
  });
});
