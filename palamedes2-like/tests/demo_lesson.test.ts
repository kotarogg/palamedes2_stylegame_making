// 遊び方・放置デモの教材を本編の Game（役判定・消去・タイマー・上昇）で実行し、設計書の推移どおりに成立することを確認する
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../src/core/game';
import { pieceLabel } from '../src/core/pieces';
import { LESSON_BASIC, LESSON_CRACK, LESSON_PINCH, LessonRunner, rolesLesson, type LessonDef } from '../src/demo/lesson';

// V320-FIX-06 で更新：説明は自動進行（実演の全処理完了＋最低表示時間）。旧「読書区間を呼出し側が5000msで解除」は廃止。
// reads は各項目の開始時点（ゲームtick）の記録
export function drive(r: LessonRunner, maxTicks = 60 * 400) {
  for (let i = 0; i < maxTicks && !r.done; i++) r.tick();
}

function runAll(def: LessonDef, maxTicks = 60 * 400) {
  const pages: string[] = [];
  const reads: { page: string; gameTick: number }[] = [];
  let r: LessonRunner;
  r = new LessonRunner(def, (p) => {
    pages.push(p);
    reads.push({ page: p, gameTick: r.game.tick });
  });
  drive(r, maxTicks);
  return { r, g: r.game, pages, reads };
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
    // V320-FIX-06：消去／基本攻撃は新しい数値表（フォーカード 2／2、フラッシュ4個 3／2、スーパーストレート 4／5）
    expect(decl.map((d) => [d.result.numberRole, d.result.suitRole, d.result.clear, d.result.baseAttack, d.chainCount, d.streak])).toEqual([
      ['four_card', null, 2, 2, 1, 4],
      [null, 'flush', 3, 2, 2, 8],
      ['super_straight', null, 4, 5, 3, 14],
    ]);
    // 2回目は数字がばらばらの4個フラッシュ
    expect(new Set(decl[1].result.subset.map((p) => p.n)).size).toBe(4);
    // V320-FIX-06：打上連鎖の攻撃加算（4連鎖＋0、8連鎖＋1、14連鎖＋2）。旧攻撃倍率は廃止
    expect(decl.map((d) => d.streakBonus)).toEqual([0, 1, 2]);
    // 連鎖切れは3回目の宣言より後（教材の最後に受付時間が自然に切れる）だけ
    expect(ev(g, 'streakCut').filter((x) => x.tick <= decl[2].tick)).toEqual([]);
    expect(g.result).toBeNull();
  });

  // V320-FIX-06 で更新：初期5段（消去用の1行を追加）、3回目の宣言前に補充G（D/E/G で 444455）。他の節目は旧教材と同じ
  it('盤面推移：555555→222233→111133→A 222244→000011→B/C 222233→111122→D/E/G 444455→000011→F 111122', () => {
    const r = new LessonRunner(rolesLesson());
    const seen: string[] = [colHeights(r.game)];
    let last = seen[0];
    for (let i = 0; i < 60 * 400 && !r.done; i++) {
      r.tick();
      const h = colHeights(r.game);
      if (h !== last) {
        seen.push(h);
        last = h;
      }
    }
    // 取得・消去の途中経過を除いた節目の推移が設計書どおり現れる（順序を保って部分列として含む）
    const want = ['555555', '222233', '111133', '222244', '000011', '222233', '111122', '444455', '000011', '111122'];
    let k = 0;
    for (const h of seen) if (h === want[k]) k++;
    expect(k, seen.join(' ')).toBe(want.length);
    expect(colHeights(r.game)).toBe('111122');
  });

  it('未発射のまま役で消えるピースを含む：1回目の消去2ラインで追加行と列5の2♣・列6の5♦が消える。演出途中の差替えなし', () => {
    const { g } = runAll(rolesLesson());
    const clears = ev(g, 'lineClear');
    expect(clears).toHaveLength(9); // V320-FIX-06：2＋3＋4（旧 1＋3＋3）
    expect(clears[0].removed.map((x) => `${x.col + 1}:${pieceLabel(x.piece)}`)).toEqual(['1:1♦', '2:6♣', '3:2♦', '4:5♣', '5:2♣', '6:5♦']);
    expect(clears[1].removed.map((x) => `${x.col + 1}:${pieceLabel(x.piece)}`)).toEqual(['1:6♦', '2:1♣', '3:5♦', '4:2♣', '5:6♦', '6:1♥']);
    // 上昇（補充）は役処理の外だけ（宣言〜役終了の間に行が増えない）
    const rises = ev(g, 'rise');
    const roles = ev(g, 'declare').map((d, i) => [d.tick, ev(g, 'roleEnd')[i].tick]);
    for (const ri of rises) for (const [a, b] of roles) expect(ri.tick < a || ri.tick > b, `rise@${ri.tick}`).toBe(true);
    expect(rises.map((x) => x.kind)).toEqual(['manual', 'manual', 'manual', 'manual', 'manual', 'manual', 'manual']); // V320-FIX-06：補充G を追加
  });

  it('時間（ゲーム内時間・最低表示時間の待ちを除く）：成功間隔1200ms、役終了→最初の成功1200ms。打上連鎖・役連鎖は猶予内で途切れない', () => {
    const { g, reads } = runAll(rolesLesson());
    const ms = (t: number) => Math.round(t * g.tickMs);
    const succ = ev(g, 'arrive').map((a) => a.tick);
    const decl = ev(g, 'declare').map((d) => d.tick);
    const ends = ev(g, 'roleEnd').map((d) => d.tick);
    const gaps = succ.slice(1).map((t, i) => t - succ[i]);
    const roleGaps = [3, 7]; // 役を挟む位置
    gaps.forEach((d, i) => {
      if (!roleGaps.includes(i)) expect(ms(d), `gap${i}`).toBe(1200);
    });
    expect([ms(succ[4] - ends[0]), ms(succ[8] - ends[1])]).toEqual([1200, 1200]);
    // V320-FIX-05 で更新：打上連鎖は時間制限なし（旧：成功→宣言＋役終了→成功の消費が3000ms未満）。連鎖は切れずに14まで続く
    expect(ev(g, 'streakCut')).toEqual([]);
    // 次宣言までの役連鎖の消費（役処理中は停止）は 10000ms 以内（V320-FIX-05：10秒）
    expect(ms(decl[1] - ends[0])).toBeLessThan(10000);
    expect(ms(decl[2] - ends[1])).toBeLessThan(10000);
    // 項目の切替（V320-FIX-06：直前の実演の全処理完了後）は役処理中・飛行中に起きない
    const roles = decl.map((d, i) => [d, ends[i]]);
    for (const rd of reads) for (const [a, b] of roles) expect(rd.gameTick < a || rd.gameTick >= b, `${rd.page}@${rd.gameTick}`).toBe(true);
    // V320-FIX-06-R1：「ライン消去」は宣言の項目内で最初のライン消去と同時、「3連鎖達成」は役連鎖の項目内で3回目の宣言と同時に表示（独立項目にしない）
    expect(reads.map((x) => x.page)).toEqual(['role_ready', 'declare', 'streak', 'streak_rate', 'flush', 'chain']);
  });
});

describe('基本操作・ピンチの教材', () => {
  it('基本操作：列2を3回入替（元へ戻る）→列1の2♠成功→列3の4♦失敗（場2♠）→帰還→手動上昇', () => {
    const { r, g, reads } = runAll(LESSON_BASIC);
    expect(reads.map((x) => x.page)).toEqual(['basic_move', 'rotate', 'success1', 'success2', 'adjacent_wrap', 'fail', 'rise']);
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
    const shown = r.items.log.flatMap((x) => x.segments.map((s) => s.page));
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
    // V320-FIX-06-R1：自然上昇〜ピンチ〜ゲームオーバーは1項目で、実イベントに合わせて説明を切り替える。対戦のピンチは終了後に文字だけ
    expect(pages).toEqual(['limit', 'natural', 'attack_pinch']);
    expect(shown).toEqual(['limit', 'limit', 'natural', 'pinch', 'avoid', 'miss', 'attack_pinch']);
  });

  it('ピンチ：猶予の3→2→1の途中に項目を切り替えない。説明はピンチ開始・猶予2・ゲームオーバーの各イベントと同じ tick に切り替わる（R1）', () => {
    const { r, g, reads } = runAll(LESSON_PINCH);
    const w = ev(g, 'pinchWarn');
    const start = w.find((x) => x.state === 'start')!.tick;
    const two = w.find((x) => x.state === 'count' && x.value === 2)!.tick;
    const end = g.result!.tick;
    for (const rd of reads) expect(rd.gameTick < start || rd.gameTick >= end, `${rd.page}@${rd.gameTick}`).toBe(true);
    const seg = r.items.log.find((x) => x.page === 'natural')!.segments;
    expect(seg.map((s) => [s.page, s.gameTick])).toEqual([
      ['natural', seg[0].gameTick],
      ['pinch', start],
      ['avoid', two],
      ['miss', end],
    ]);
    // 自然上昇（7段で保留）は「自然上昇」の説明の表示中に起きる
    expect(seg[0].gameTick).toBeLessThan(start);
  });

  // V320-FIX-05 で更新：成功してもヒビ（予約）は残ることを実演に含める（旧：2回成功→失敗→失敗）
  it('V320-FIX-05 ヒビの独立例：成功→失敗でヒビ→成功してもヒビは残る（連鎖2）→再失敗で連鎖が切れる。時間では切れない', () => {
    const { r, g } = runAll(LESSON_CRACK);
    expect(r.problems).toEqual([]);
    expect(ev(g, 'arrive').map((a) => a.success)).toEqual([true, false, true, false]);
    expect(ev(g, 'arrive').map((a) => a.streak)).toEqual([1, 0, 2, 0]);
    expect(ev(g, 'streakCut').map((x) => [x.state, x.count, x.reason])).toEqual([
      ['reserved', 1, 'miss'],
      ['ended', 2, 'miss'],
    ]);
    // 予約中の成功の後も予約は解除されていない（間に解除イベントなし）
    expect(ev(g, 'streakCut')).toHaveLength(2);
  });
});
