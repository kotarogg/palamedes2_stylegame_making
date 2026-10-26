// 遊び方・放置デモの教材を本編の Game（役判定・消去・タイマー・上昇）で実行し、設計書の推移どおりに成立することを確認する
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../src/core/game';
import { pieceLabel } from '../src/core/pieces';
import { LESSON_BASIC, LESSON_PINCH, LessonRunner, rolesLesson, type LessonDef } from '../src/demo/lesson';

function runAll(def: LessonDef, maxTicks = 60 * 120) {
  const pages: string[] = [];
  const r = new LessonRunner(def, (p) => pages.push(p));
  const heights: string[] = [];
  for (let i = 0; i < maxTicks && !r.done; i++) r.tick();
  return { r, g: r.game, pages, heights };
}

const ev = <T extends GameEvent['type']>(g: { events: GameEvent[] }, t: T) => g.events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === t);
const colHeights = (g: LessonRunner['game']) => g.players[0].board.cols.map((c) => c.length).join('');

describe('4/4/6 共用教材（設計書 第6節）を本編の処理で実行', () => {
  it('連続取得14回・役連鎖3回が実処理で成立し、予定時刻どおりに操作できる（遅れ・失敗なし）', () => {
    const { r, g } = runAll(rolesLesson());
    expect(r.problems).toEqual([]);
    expect(r.done).toBe(true);
    const arrives = ev(g, 'arrive');
    expect(arrives.every((a) => a.success)).toBe(true);
    expect(arrives.map((a) => a.streak)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const decl = ev(g, 'declare');
    expect(decl.map((d) => [d.result.numberRole, d.result.suitRole, d.result.han, d.chainCount, d.streak])).toEqual([
      ['four_card', null, 1, 1, 4],
      [null, 'flush', 3, 2, 8],
      ['super_straight', null, 3, 3, 14],
    ]);
    // 7個目・13個目で攻撃倍率 1.25／1.5（本編の連続取得表）
    expect(decl.map((d) => d.streakPercent)).toEqual([100, 125, 150]);
    // 連鎖切れは3回目の宣言より後（教材の最後に受付時間が自然に切れる）だけ
    expect(ev(g, 'streakCut').filter((x) => x.tick <= decl[2].tick)).toEqual([]);
    expect(g.result).toBeNull();
  });

  it('盤面推移：444444→222233→111133→A 222244→000011→B/C 222233→111122→D/E 333344→000011→F 111122', () => {
    const r = new LessonRunner(rolesLesson());
    const seen: string[] = [colHeights(r.game)];
    let last = seen[0];
    for (let i = 0; i < 60 * 120 && !r.done; i++) {
      r.tick();
      const h = colHeights(r.game);
      if (h !== last) {
        seen.push(h);
        last = h;
      }
    }
    // 取得・消去の途中経過を除いた節目の推移が設計書どおり現れる（順序を保って部分列として含む）
    const want = ['444444', '222233', '111133', '222244', '000011', '222233', '111122', '333344', '000011', '111122'];
    let k = 0;
    for (const h of seen) if (h === want[k]) k++;
    expect(k, seen.join(' ')).toBe(want.length);
    expect(colHeights(r.game)).toBe('111122');
  });

  it('未発射のまま役で消えるピースを含む：1回目の1ライン消去で列5の2♣・列6の5♦が消える。演出途中の差替えなし', () => {
    const { g } = runAll(rolesLesson());
    const clears = ev(g, 'lineClear');
    expect(clears).toHaveLength(7); // 1＋3＋3
    expect(clears[0].removed.map((x) => `${x.col + 1}:${pieceLabel(x.piece)}`)).toEqual(['1:6♦', '2:1♣', '3:5♦', '4:2♣', '5:2♣', '6:5♦']);
    // 上昇（補充）は役処理の外だけ（宣言〜役終了の間に行が増えない）
    const rises = ev(g, 'rise');
    const roles = ev(g, 'declare').map((d, i) => [d.tick, ev(g, 'roleEnd')[i].tick]);
    for (const ri of rises) for (const [a, b] of roles) expect(ri.tick < a || ri.tick > b, `rise@${ri.tick}`).toBe(true);
    expect(rises.map((x) => x.kind)).toEqual(['manual', 'manual', 'manual', 'manual', 'manual', 'manual']);
  });

  it('時間：成功間隔1200ms、宣言は最終成功の300/500/800ms後、役終了→最初の成功1200ms、役を挟む連続取得の消費は2000ms以内', () => {
    const { g } = runAll(rolesLesson());
    const ms = (t: number) => Math.round(t * g.tickMs);
    const succ = ev(g, 'arrive').map((a) => a.tick);
    const decl = ev(g, 'declare').map((d) => d.tick);
    const ends = ev(g, 'roleEnd').map((d) => d.tick);
    const gaps = succ.slice(1).map((t, i) => t - succ[i]);
    const roleGaps = [3, 7]; // 役を挟む位置
    gaps.forEach((d, i) => {
      if (!roleGaps.includes(i)) expect(ms(d), `gap${i}`).toBe(1200);
    });
    expect([ms(decl[0] - succ[3]), ms(decl[1] - succ[7]), ms(decl[2] - succ[13])]).toEqual([300, 500, 800]);
    expect([ms(succ[4] - ends[0]), ms(succ[8] - ends[1])]).toEqual([1200, 1200]);
    // 役処理中は停止：成功→宣言＋役終了→成功 の消費
    expect(ms(decl[0] - succ[3] + succ[4] - ends[0])).toBeLessThan(2000);
    expect(ms(decl[1] - succ[7] + succ[8] - ends[1])).toBeLessThan(2000);
    // 次宣言までの有効時間（役連鎖の消費）5300／8000ms、いずれも12000ms以内
    expect([ms(decl[1] - ends[0]), ms(decl[2] - ends[1])]).toEqual([5300, 8000]);
  });
});

describe('基本操作・ピンチの教材', () => {
  it('基本操作：列2を3回入替（元へ戻る）→列1の2♠成功→列3の4♦失敗（場2♠）→帰還→手動上昇', () => {
    const { r, g } = runAll(LESSON_BASIC);
    expect(r.problems).toEqual([]);
    expect(ev(g, 'rotate').map((x) => x.col)).toEqual([1, 1, 1]);
    const a = ev(g, 'arrive');
    expect(a.map((x) => [x.col, pieceLabel(x.piece), x.success, pieceLabel(x.baseBefore)])).toEqual([
      [0, '2♠', true, '3♠'],
      [2, '4♦', false, '2♠'],
    ]);
    expect(ev(g, 'returned')).toHaveLength(1);
    expect(ev(g, 'rise').map((x) => [x.kind, x.heightBefore, x.heightAfter])).toEqual([['manual', 3, 4]]);
  });

  it('ピンチ：手動上昇で7段→自然上昇の時刻で4秒猶予→1秒後から3/2/1→ミス（本編の猶予と同じ）', () => {
    const { r, g, pages } = runAll(LESSON_PINCH);
    expect(r.problems).toEqual([]);
    expect(ev(g, 'rise').map((x) => x.heightAfter)).toEqual([5, 6, 7]);
    const w = ev(g, 'pinchWarn');
    const start = w.find((x) => x.state === 'start')!;
    const counts = w.filter((x) => x.state === 'count').map((x) => [x.value, Math.round((x.tick - start.tick) * g.tickMs)]);
    expect(counts).toEqual([
      [3, 1000],
      [2, 2000],
      [1, 3000],
    ]);
    expect(g.result?.outcome).toBe('gameOver');
    expect(Math.round((g.result!.tick - start.tick) * g.tickMs)).toBe(4000);
    expect(pages).toEqual(['limit', 'natural', 'pinch', 'avoid', 'miss']);
  });
});
