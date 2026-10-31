// V320-FIX-06-R1 第1項：説明と実演の同期。説明の切替が対応する実イベントと同じ tick に起き、終わった動作の説明が後から始まらないこと
import { describe, expect, it } from 'vitest';
import { AudioBus } from '../src/audio/audioBus';
import type { GameEvent } from '../src/core/game';
import { HELP_TIMING, LESSON_BASIC, LESSON_CRACK, LESSON_PINCH, LessonRunner, minDisplayTicks, pageText, rolesLesson, type LessonDef } from '../src/demo/lesson';
import { LessonStage } from '../src/demo/stages';
import { Mode2LessonRunner } from '../src/demo/mode2Lesson';
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
    // V320-FIX-06-R2：最低表示時間は項目開始時に確定（宣言＋ライン消去の本文の文字数）。切替後に数え直さず、移行＝max（開始＋最低, 実演完了）
    expect(decl.minTicks).toBe(minDisplayTicks('declare', 60, ['line_clear']));
    expect(shownEnd).toBe(Math.max(decl.startTick + decl.minTicks, decl.doneTick!));
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

describe('V320-FIX-06-R2 最低表示時間は項目開始から（切替で数え直さない）', () => {
  const BOARD = [
    ['2♠', '5♥', '4♦', '1♣', '6♠', '3♦'],
    ['6♥', '3♣', '5♠', '2♦', '4♥', '1♠'],
    ['3♦', '2♠', '1♥', '5♣', '2♣', '6♦'],
  ];

  it('全教材：すべての項目の移行時刻＝max（項目開始＋開始時に確定した最低表示時間, 実演の全処理完了）。最低時間は統合した本文の文字数で計算', () => {
    for (const def of [LESSON_BASIC, rolesLesson(), LESSON_CRACK, LESSON_PINCH]) {
      const r = run(def);
      for (const x of r.items.log) {
        const pages = [...new Set(x.segments.map((sg) => sg.page).filter((p) => p !== x.page))];
        expect(x.minTicks, `${def.id}:${x.page}`).toBe(minDisplayTicks(x.page, 60, pages));
        expect(x.endTick, `${def.id}:${x.page}`).toBe(Math.max(x.startTick + x.minTicks, x.doneTick!));
      }
    }
  });

  it('再現例（宣言の項目：開始331・実演完了622）：最低表示は統合した本文（宣言25字＋ライン消去22字）で開始時に413tick と確定し、移行は max（331＋413, 622）＝744（R1 の 778 から再計測分を除去）', () => {
    const r = run(rolesLesson());
    const d = item(r, 'declare');
    expect([d.startTick, d.doneTick, d.minTicks]).toEqual([331, 622, 413]);
    expect(d.endTick).toBe(744);
    // 切替（ライン消去）以後に期限を追加していない：切替の時点で残る期限は開始時の値だけ
    const lc = d.segments.find((sg) => sg.page === 'line_clear')!;
    expect(d.endTick! - lc.startTick).toBeLessThan(minDisplayTicks('line_clear'));
  });

  it('統合本文を含めた最低時間を実演が超える項目は、実演完了の tick で移行（例：役連鎖・ピンチ・MODE2 以外の教材すべてを上の一般則で確認）', () => {
    const r = run(rolesLesson());
    const ch = item(r, 'chain');
    expect(ch.doneTick! - ch.startTick).toBeGreaterThan(ch.minTicks);
    expect(ch.endTick).toBe(ch.doneTick);
  });

  it('説明が遅い時点で切り替わる場合：最低時間の経過後に別の説明へ切り替わっても、完了直後に移行し時間を再計測しない', () => {
    HELP_TIMING.perPageMs.fail = 1000; // 項目の最低時間を短くし、切替（失敗の到達・約2.5秒後）を最低時間の後にする
    try {
      const r = run({
        id: 'basic',
        base: '2♠',
        rows: BOARD,
        naturalRise: false,
        ops: [
          { op: 'page', page: 'fail', steps: [{ on: 'arrive', match: (e) => e.success === false, page: 'rise' }] },
          { op: 'move', col: 2 },
          { op: 'wait', ms: 2000 },
          { op: 'act', action: 'launch' },
          { op: 'until', event: 'arrive', maxMs: 1000 },
          { op: 'page', page: 'success1' },
          { op: 'end' },
        ],
      });
      const x = item(r, 'fail');
      const late = x.segments.find((sg) => sg.page === 'rise')!;
      expect(x.minTicks).toBe(60);
      expect(late.startTick - x.startTick).toBeGreaterThan(x.minTicks); // 切替は最低時間の後
      expect(x.endTick).toBe(x.doneTick); // 帰還完了の直後に移行
      expect(x.endTick! - late.startTick).toBeLessThan(minDisplayTicks('rise')); // 切替後の説明に別の期限を足していない
    } finally {
      delete HELP_TIMING.perPageMs.fail;
    }
  });

  it('MODE2 説明も同じ規則（クリアの説明を統合した項目を含む）', () => {
    const m = new Mode2LessonRunner();
    for (let i = 0; i < 60 * 600 && !m.done; i++) m.tick();
    expect(m.done).toBe(true);
    for (const x of m.items.log) {
      const pages = [...new Set(x.segments.map((sg) => sg.page).filter((p) => p !== x.page))];
      expect(x.minTicks, x.page).toBe(minDisplayTicks(x.page, 60, pages));
      expect(x.endTick, x.page).toBe(Math.max(x.startTick + x.minTicks, x.doneTick!));
    }
  });

  it('実演が最低時間より早く終わる項目は、項目開始＋最低時間で移行（切替の有無に関係なく同じ期限）', () => {
    const r = run(rolesLesson());
    const ch = item(r, 'role_ready');
    expect(ch.segments.length).toBe(2);
    expect(ch.endTick).toBe(Math.max(ch.startTick + ch.minTicks, ch.doneTick!));
  });
});
