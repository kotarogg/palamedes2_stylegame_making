// V320-FIX-06-R1 第1項：説明と実演の同期。説明の切替が対応する実イベントと同じ tick に起き、終わった動作の説明が後から始まらないこと
import { describe, expect, it } from 'vitest';
import { AudioBus } from '../src/audio/audioBus';
import type { GameEvent } from '../src/core/game';
import { LESSON_BASIC, LESSON_CRACK, LESSON_PINCH, LessonRunner, minDisplayTicks, pageText, rolesLesson, type LessonDef } from '../src/demo/lesson';
import { LessonStage } from '../src/demo/stages';
import { fakeAssets } from './helpers';

const run = (def: LessonDef) => {
  const r = new LessonRunner(def);
  for (let i = 0; i < 60 * 300 && !r.done; i++) r.tick();
  expect(r.done).toBe(true);
  expect(r.problems).toEqual([]);
  return r;
};
const ev = <T extends GameEvent['type']>(r: LessonRunner, t: T) => r.game.events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === t);
const item = (r: LessonRunner, page: string) => r.items.log.find((x) => x.page === page)!;

describe('実演のある頁は実イベントで説明を切り替える', () => {
  it('台本の全教材：実演（操作・待ち）を含む項目で複数パネルの頁は、すべてイベントの手順（steps）を持つ（時間按分しない）', () => {
    for (const def of [LESSON_BASIC, rolesLesson(), LESSON_CRACK, LESSON_PINCH]) {
      def.ops.forEach((op, i) => {
        if (op.op !== 'page') return;
        let demo = false;
        for (let k = i + 1; k < def.ops.length && def.ops[k].op !== 'page' && def.ops[k].op !== 'end'; k++) if (def.ops[k].op !== 'anchor') demo = true;
        if (demo && pageText(op.page).panels.length > 1) expect(op.steps?.length, `${def.id}:${op.page}`).toBeGreaterThan(0);
      });
    }
  });

  it('ライン消去：宣言の項目内で、最初のライン消去と同じ tick に「ライン消去」の説明へ（ライン消去の後から説明を始めない）', () => {
    const r = run(rolesLesson());
    const decl = item(r, 'declare');
    const first = ev(r, 'lineClear')[0];
    const lc = decl.segments.find((s) => s.page === 'line_clear')!;
    expect([lc.gameTick, lc.trigger]).toEqual([first.tick, `lineClear@${first.tick}`]);
    // 2本目のライン消去・攻撃・役終了は、この説明の表示中に起きる
    const end = ev(r, 'roleEnd')[0];
    const shownEnd = decl.endTick!;
    const evTicks = decl.events.filter((e) => ['lineClear', 'attack', 'roleEnd'].includes(e.type));
    expect(evTicks.length).toBeGreaterThanOrEqual(4);
    for (const e of evTicks) expect(e.gameTick).toBeGreaterThanOrEqual(first.tick);
    expect(evTicks.some((e) => e.type === 'roleEnd' && e.gameTick === end.tick)).toBe(true);
    // 独立した「ライン消去」の項目は無い（後追いの項目を作らない）
    expect(r.items.log.map((x) => x.page)).not.toContain('line_clear');
    // 後から切り替えた説明も、その頁の最低表示時間は表示する
    expect(shownEnd - lc.startTick).toBeGreaterThanOrEqual(minDisplayTicks('line_clear'));
  });

  it('3連鎖：役連鎖の項目内で、3回目の宣言（役連鎖3）と同じ tick に「3連鎖達成」へ', () => {
    const r = run(rolesLesson());
    const d3 = ev(r, 'declare').find((d) => d.chainCount === 3)!;
    const seg = item(r, 'chain').segments;
    expect(seg.map((s) => [s.page, s.trigger])).toEqual([
      ['chain', 'start'],
      ['chain3', `declare@${d3.tick}`],
    ]);
    expect(r.items.log.map((x) => x.page)).not.toContain('chain3');
  });

  it('連鎖切り予約：ヒビ発生（予約）・予約中の成功でヒビが残る・次の打ち上げで切断、の各イベントと説明（3枚）が対応', () => {
    const r = run(LESSON_CRACK);
    const reserved = ev(r, 'streakCut').find((e) => e.state === 'reserved')!;
    const ended = ev(r, 'streakCut').find((e) => e.state === 'ended')!;
    const okAfter = ev(r, 'arrive').find((a) => a.success && a.tick > reserved.tick)!;
    const lastLaunch = ev(r, 'launch').at(-1)!;
    const seg = item(r, 'streak_crack').segments;
    expect(seg.map((s) => [s.panel, s.trigger])).toEqual([
      [0, 'start'],
      [0, `streakCut@${reserved.tick}`],
      [1, `arrive@${okAfter.tick}`],
      [2, `launch@${lastLaunch.tick}`],
    ]);
    // 2枚目（成功してもヒビは残る）の表示中、予約は解除されていない（切断は3枚目の表示中）
    expect(okAfter.streak).toBe(2);
    expect(ended.tick).toBeGreaterThan(lastLaunch.tick);
    expect(pageText('streak_crack').panels[1].join('')).toContain('ヒビは残る');
    expect(pageText('streak_crack').panels[2].join('')).toContain('連鎖が切れる');
  });

  it('基本操作の失敗：2枚目（戻るまで打ち上げできない）は失敗の到達（跳ね返り開始）と同じ tick。役成立・打上連鎖・せり上げも対応', () => {
    const b = run(LESSON_BASIC);
    const fail = ev(b, 'arrive').find((a) => !a.success)!;
    expect(item(b, 'fail').segments.map((s) => [s.panel, s.gameTick])).toEqual([
      [0, item(b, 'fail').segments[0].gameTick],
      [1, fail.tick],
    ]);
    expect(ev(b, 'returned')[0].tick).toBeGreaterThan(fail.tick); // 帰還は2枚目の表示中
    const r = run(rolesLesson());
    const rr = item(r, 'role_ready').segments;
    const avail = ev(r, 'roleAvailable')[0];
    expect(rr[1].gameTick).toBeLessThan(avail.tick); // 「役ができると光る」の表示中に役が成立して光る
    const p = run(LESSON_PINCH);
    const r7 = ev(p, 'rise').find((x) => x.heightAfter >= 7)!;
    expect(item(p, 'limit').segments[1].gameTick).toBe(r7.tick);
  });

  it('項目の切替は実演の処理中に起きない（各項目の開始時、直前の項目の飛行・役処理・上昇が終わっている）', () => {
    for (const def of [LESSON_BASIC, rolesLesson(), LESSON_CRACK, LESSON_PINCH]) {
      const r = run(def);
      for (const x of r.items.log.slice(1)) {
        const prev = r.items.log[r.items.log.indexOf(x) - 1];
        expect(prev.doneTick, `${def.id}:${prev.page}`).not.toBeNull();
        expect(x.startTick).toBeGreaterThanOrEqual(prev.doneTick!);
      }
    }
  });
});

describe('画面のパネル（役処理中の表示）', () => {
  it('宣言後は役名・消去数・採択ピース。最初のライン消去からは「ライン消去」の説明＋消去数を表示', () => {
    const st = new LessonStage({ assets: fakeAssets(), bus: new AudioBus('./') }, rolesLesson('first'));
    const g = st.game;
    let beforeClear: string[] | undefined;
    let afterClear: string[] | undefined;
    for (let i = 0; i < 60 * 60 && !st.finished; i++) {
      st.update(1000 / 60);
      const decl = g.events.find((e) => e.type === 'declare');
      const lc = g.events.find((e) => e.type === 'lineClear');
      if (decl && !lc && !beforeClear) beforeClear = st.panel().lines as string[];
      if (lc && !afterClear) afterClear = st.panel().lines as string[];
    }
    expect(beforeClear).toEqual(['消去２ライン']);
    expect(afterClear).toEqual([...pageText('line_clear').panels[0], '消去２ライン']);
  });
});
