// V320-FIX-06 第7章：遊び方・実演の完全自動進行。
// （旧 v320_fix04_help.test.ts の「読書5000ms・決定で送る・送り案内」は FIX-06 で仕様ごと廃止したため、本ファイルへ置き換えた）
// 項目へ入った時点を経過0とし、「実演に属する全処理の完了」かつ「最低表示時間の経過」で次の項目へ。最低時間の残りはゲームを止めて待つ
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { AudioBus } from '../src/audio/audioBus';
import { countTextChars, HELP_TIMING, LESSON_BASIC, LESSON_M1_SINGLE, LESSON_PINCH, LessonRunner, minDisplayMs, minDisplayTicks, pageText, rolesLesson, TUTORIAL_SCRIPT, type LessonDef, type PageKey } from '../src/demo/lesson';
import { HelpLessonScene } from '../src/demo/scenes';
import { LessonStage, Mode2Stage, pacedOf } from '../src/demo/stages';
import { defaultSettings } from '../src/input/settings';
import { fakeAssets } from './helpers';

const host = () => ({ assets: fakeAssets(), bus: new AudioBus('./') });
const nav = (key: string, repeat = false) => ({ key, repeat, source: { kind: 'keyboard' } }) as never;
const F = 1000 / 60;
const BOARD = [
  ['2♠', '5♥', '4♦', '1♣', '6♠', '3♦'],
  ['6♥', '3♣', '5♠', '2♦', '4♥', '1♠'],
  ['3♦', '2♠', '1♥', '5♣', '2♣', '6♦'],
];
const def = (ops: LessonDef['ops']): LessonDef => ({ id: 'basic', base: '3♠', rows: BOARD, naturalRise: false, ops });
const run = (d: LessonDef) => {
  const r = new LessonRunner(d);
  for (let i = 0; i < 60 * 120 && !r.done; i++) r.tick();
  expect(r.done).toBe(true);
  return r;
};

afterEach(() => {
  for (const k of Object.keys(HELP_TIMING.perPageMs)) delete HELP_TIMING.perPageMs[k];
});

describe('最低表示時間（第7.3節の初期値）', () => {
  it('max（3秒, 1秒＋文字数÷8秒）。句読点を数え、空白・全角空白・改行を除く。tick は切り上げ', () => {
    expect([HELP_TIMING.floorMs, HELP_TIMING.baseMs, HELP_TIMING.charsPerSec]).toEqual([3000, 1000, 8]);
    expect(countTextChars('役ができたら宣言！　役に応じた数のラインを消せるよ。')).toBe(25);
    expect(countTextChars('a b\nc')).toBe(3);
    // 「左右に動いて、打ち上げる列を選ぼう！」18字 → 1000＋2250＝3250ms → 195tick
    expect(countTextChars(pageText('basic_move').text)).toBe(18);
    expect([minDisplayMs('basic_move'), minDisplayTicks('basic_move')]).toEqual([3250, 195]);
    // 短文は下限3秒（「役を続けて宣言して、3連鎖達成！」15字 → 2875ms → 3000ms）
    expect(minDisplayMs('chain3')).toBe(3000);
    // 切り上げ：1000＋17/8×1000＝3125ms＝187.5tick → 188
    HELP_TIMING.perPageMs.rise = 3125;
    expect(minDisplayTicks('rise')).toBe(188);
  });

  it('項目別に上書きできる（perPageMs）。送り案内（決定で実演へ／次へ）は台本から廃止', () => {
    HELP_TIMING.perPageMs.basic_move = 1234;
    expect(minDisplayMs('basic_move')).toBe(1234);
    expect('advance_hint' in TUTORIAL_SCRIPT).toBe(false);
  });
});

describe('自動進行（LessonRunner）', () => {
  // 最低6秒（360tick）に固定して、実演の長さが 短い／同じ／長い 場合を比べる（依頼書 第7.1節の例）
  const paced = (demoMs: number) => {
    HELP_TIMING.perPageMs.basic_move = 6000;
    const r = run(def([{ op: 'page', page: 'basic_move' }, { op: 'wait', ms: demoMs }, { op: 'page', page: 'rotate' }, { op: 'end' }]));
    const [a, b] = r.items.log;
    return { a, b, r };
  };

  it('実演が2秒で完了 → 残り4秒だけ止めて待ち、開始6秒後に次へ（実演の途中に停止を挟まない）', () => {
    const { a, b } = paced(2000);
    expect(a.minTicks).toBe(360);
    expect(a.doneTick! - a.startTick).toBe(120); // wait 120tick の完了
    expect(b.startTick - a.startTick).toBe(360);
  });

  it('実演が6秒で完了 → 追加待ちなし', () => {
    const { a, b } = paced(6000);
    expect(b.startTick - a.startTick).toBe(360);
    expect(b.startTick).toBe(a.doneTick);
  });

  it('実演が9秒で完了 → 完了直後に次へ（最低時間を丸ごと待ち直さない）', () => {
    const { a, b } = paced(9000);
    expect(a.doneTick! - a.startTick).toBe(540);
    expect(b.startTick).toBe(a.doneTick);
  });

  it('文字だけの項目は最低表示時間で自動進行（ゲームは止めたまま）', () => {
    const r = new LessonRunner(def([{ op: 'page', page: 'success2' }, { op: 'page', page: 'adjacent_wrap' }, { op: 'end' }]));
    const t0 = r.game.tick;
    for (let i = 0; i < 60 * 30 && !r.done; i++) r.tick();
    const [a, b] = r.items.log;
    expect(a.doneTick).toBe(a.startTick);
    expect(b.startTick - a.startTick).toBe(minDisplayTicks('success2'));
    expect(b.endTick! - b.startTick).toBe(minDisplayTicks('adjacent_wrap'));
    expect(r.game.tick).toBe(t0); // 実演が無いのでゲームは1tickも進まない
  });

  it('台本の最後の命令の後に帰還が残る：最後の操作命令ではなく、跳ね返り・山なり・下降の帰還完了を待って次へ', () => {
    HELP_TIMING.perPageMs.fail = 500; // 最低時間を短くして、処理完了の方が遅い場合を作る
    const pages: { p: PageKey; tick: number }[] = [];
    let r: LessonRunner;
    r = new LessonRunner(
      { ...def([{ op: 'page', page: 'fail' }, { op: 'move', col: 2 }, { op: 'act', action: 'launch' }, { op: 'page', page: 'rise' }, { op: 'end' }]), base: '2♠' },
      (p) => pages.push({ p, tick: r.game.tick }),
    );
    for (let i = 0; i < 60 * 30 && !r.done; i++) r.tick();
    const ret = r.game.events.find((e) => e.type === 'returned')!;
    const launch = r.game.events.find((e) => e.type === 'launch')!;
    expect(r.game.events.find((e) => e.type === 'arrive' && !e.success)).toBeTruthy();
    expect(pages[1].tick).toBeGreaterThanOrEqual(ret.tick);
    const a = r.items.log[0];
    expect(a.doneTick! - a.startTick).toBeGreaterThan(a.minTicks);
    expect(ret.tick - launch.tick).toBeGreaterThan(100); // 帰還は2秒超
  });

  it('最低時間の残りを待つ間はゲームを止める（自然上昇・猶予を進めず、完了画面と説明を保つ）', () => {
    const r = new LessonRunner(LESSON_PINCH);
    let held = 0;
    let frozen = true;
    let prev = r.game.tick;
    for (let i = 0; i < 60 * 60 && !r.done; i++) {
      r.tick();
      if (r.holding) {
        held++;
        if (r.game.tick !== prev) frozen = false;
      }
      prev = r.game.tick;
    }
    expect(held).toBeGreaterThan(60);
    expect(frozen).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('複数パネルの頁は、最低時間を文字数で按分した時刻にパネルを切り替える（切替ごとに時間を加算しない）', () => {
    const r = new LessonRunner(rolesLesson());
    for (let i = 0; i < 60 * 120 && !r.done; i++) r.tick();
    const st = r.items.log.find((x) => x.page === 'streak')!;
    expect(pageText('streak').panels).toHaveLength(2);
    expect(st.panelTicks).toHaveLength(2);
    expect(st.panelTicks[1] - st.startTick).toBeLessThan(st.minTicks);
    expect(st.panelTicks[1]).toBeGreaterThan(st.startTick);
  });
});

describe('舞台・画面', () => {
  it('役名スライドが残る間は次の項目へ進まない（役処理の終了＝役名表示の終了後）', () => {
    const st = new LessonStage(host(), rolesLesson('first'));
    const roleNames = (st as unknown as { presenter: { roleNames: { logosAt: (p: 0, t: number) => unknown[] } } }).presenter.roleNames;
    let checked = false;
    let lastPages = 0;
    for (let i = 0; i < 60 * 60 && !st.finished; i++) {
      st.update(F);
      if (st.items.log.length !== lastPages) {
        lastPages = st.items.log.length;
        if (st.items.current?.page === 'line_clear') {
          expect(roleNames.logosAt(0, st.game.tick)).toEqual([]);
          checked = true;
        }
      }
    }
    expect(checked).toBe(true);
    expect(st.finished).toBe(true);
  });

  it('ピンチの教材：GAME OVER の結果演出（受付可能時刻まで）を実演の処理に含めてから「ゲームオーバー」の説明へ', () => {
    const st = new LessonStage(host(), LESSON_PINCH);
    for (let i = 0; i < 60 * 90 && !st.finished; i++) st.update(F);
    expect(st.finished).toBe(true);
    const avoid = st.items.log.find((x) => x.page === 'avoid')!;
    const miss = st.items.log.find((x) => x.page === 'miss')!;
    expect(miss.startTick).toBeGreaterThanOrEqual(avoid.doneTick!);
    expect(st.game.result?.outcome).toBe('gameOver');
  });

  it('MODE2 説明：自動で完走（詰まり→3/2/1→場の更新→全ピース消化→クリア処理→説明10項目）', () => {
    const st = new Mode2Stage(host());
    for (let i = 0; i < 60 * 400 && !st.finished; i++) st.update(F);
    expect(st.finished).toBe(true);
    expect(st.game.result?.outcome).toBe('clear');
    expect(st.game.remaining(st.game.players[0])).toBe(0);
    expect(st.items.log.map((x) => x.page)).toEqual(['m2_intro', 'm2_refresh', 'm2_suit', 'm2_number', 'm2_adjacent', 'm2_rule', 'm2_difference', 'm2_clear', 'm2_versus', 'm2_versus_refresh']);
    for (const x of st.items.log) expect(x.endTick! - x.startTick).toBeGreaterThanOrEqual(x.minTicks);
  });

  function makeApp() {
    return new App({
      assets: fakeAssets(),
      bus: new AudioBus('./'),
      pads: () => null,
      settings: defaultSettings(),
      applyDisplay: () => undefined,
      requestFullscreen: () => undefined,
      viewport: () => ({ w: 1280, h: 720, dpr: 1 }),
      openUrl: () => undefined,
      dev: false,
    });
  }

  it('遊び方：入った時点で説明と実演を自動開始。決定入力では何も起きず、自動で次の舞台へ。キャンセルで目次へ戻る', () => {
    const app = makeApp();
    let back = 0;
    const sc = new HelpLessonScene(app, [(a) => new LessonStage(a, LESSON_M1_SINGLE), (a) => new LessonStage(a, LESSON_BASIC)], () => back++);
    sc.update(F);
    const first = pacedOf(sc.stage)!;
    expect(first.items.current?.page).toBe('m1_single');
    sc.onNav(nav('confirm')); // 入場の決定の持ち越し・早押し：進行に使わない
    sc.onNav(nav('confirm', true));
    expect(first.items.current?.page).toBe('m1_single');
    for (let i = 0; i < 60 * 60 && pacedOf(sc.stage) === first; i++) sc.update(F);
    expect(pacedOf(sc.stage)).not.toBe(first); // 自動で次の舞台（基本操作）へ
    sc.update(F);
    expect(pacedOf(sc.stage)!.items.current?.page).toBe('basic_move');
    sc.onNav(nav('back'));
    expect(back).toBe(1);
  });
});
