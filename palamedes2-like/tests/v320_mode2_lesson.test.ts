// v3.2.0 MODE2 説明教材（指示書 第9節）：通常の Mode2Game で固定盤面・固定入力を最後までクリアし、説明は実イベントに同期
import { describe, expect, it } from 'vitest';
import { pieceLabel } from '../src/core/pieces';
import { Mode2LessonRunner, MODE2_LESSON_ORDER } from '../src/demo/mode2Lesson';

function run() {
  const pages: { page: string; tick: number }[] = [];
  let r: Mode2LessonRunner;
  r = new Mode2LessonRunner((p) => pages.push({ page: p, tick: r?.game.tick ?? 0 }));
  let simTicks = 0;
  for (let i = 0; i < 60 * 200 && !r.done; i++) if (r.tick()) simTicks++;
  return { r, g: r.game, pages, simTicks };
}

describe('MODE2 説明教材（固定盤面・固定入力・seed 20261027）', () => {
  it('42成功・失敗0・場の更新1回（3♠→4♥の後に全候補が出せず、更新後の場は5♦）・残り0でクリア', () => {
    const { r, g } = run();
    expect(r.problems).toEqual([]);
    const arr = g.events.filter((e) => e.type === 'arrive');
    expect(arr).toHaveLength(42);
    expect(arr.every((e) => e.type === 'arrive' && e.success)).toBe(true);
    expect(MODE2_LESSON_ORDER).toHaveLength(42);
    const ref = g.events.filter((e) => e.type === 'cardRefresh');
    expect(ref).toHaveLength(1);
    expect(ref[0].type === 'cardRefresh' && pieceLabel(ref[0].base)).toBe('5♦');
    expect(g.refreshCount).toBe(1);
    expect(g.result?.outcome).toBe('clear');
    expect(g.remaining(g.players[0])).toBe(0);
    expect(g.noResetAchiever()).toBeNull(); // 更新1回なのでノーリセットではない
    // 更新後の最初の3取得：同じ記号・同じ数字・1と6
    const a = arr.slice(1, 4).map((e) => e.type === 'arrive' && `${pieceLabel(e.baseBefore)}→${pieceLabel(e.piece)}`);
    expect(a).toEqual(['5♦→1♦', '1♦→1♠', '1♠→6♥']);
    expect(arr[0].type === 'arrive' && `${arr[0].col + 1}:${pieceLabel(arr[0].baseBefore)}→${pieceLabel(arr[0].piece)}`).toBe('1:3♠→4♥');
  });

  it('説明は実イベント順：冒頭→（初回成功と同tickの詰まり）場の更新→同じ記号→同じ数字→1と6→クリア条件→クリア→対戦では。固定尺で終わらない', () => {
    const { pages, g } = run();
    expect(pages.map((p) => p.page)).toEqual(['m2_intro', 'm2_refresh', 'm2_suit', 'm2_number', 'm2_adjacent', 'm2_rule', 'm2_clear', 'm2_versus']);
    const stuck = g.events.find((e) => e.type === 'stuck')!;
    const first = g.events.find((e) => e.type === 'arrive')!;
    expect(stuck.tick).toBe(first.tick);
    expect(pages[1].tick).toBe(stuck.tick);
    const refresh = g.events.find((e) => e.type === 'cardRefresh')!;
    expect(pages[2].tick).toBe(refresh.tick);
    const end = g.events.find((e) => e.type === 'roundEnd')!;
    expect(pages[6].tick).toBe(end.tick);
  });

  it('カウントダウン中も止めない：3→2→1 は1000msごと。クリア時間は詰まり・カウントダウン・場の更新を含む通常のゲーム内時間', () => {
    const { g, simTicks } = run();
    const cd = g.events.filter((e) => e.type === 'countdown').map((e) => e.tick);
    expect(cd.slice(1).map((t, i) => t - cd[i])).toEqual([60, 60]);
    const end = g.result!.tick;
    expect(g.elapsedMs()).toBeCloseTo((end - g.playStartTick) * g.tickMs, 6);
    // シミュレーションを進めた tick（読ませる停止を除く）＝ゲーム内時間：詰まり〜更新の240tickも含む
    expect(end - g.playStartTick).toBeLessThanOrEqual(simTicks);
    const stuck = g.events.find((e) => e.type === 'stuck')!.tick;
    const refresh = g.events.find((e) => e.type === 'cardRefresh')!.tick;
    expect(refresh - stuck).toBe(180);
    expect(g.elapsedMs() / 1000).toBeGreaterThan(20);
  });
});
