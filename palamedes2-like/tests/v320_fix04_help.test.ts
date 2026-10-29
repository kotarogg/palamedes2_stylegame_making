// V320-FIX-04 第13章：説明ページの読書時間（実時間5000ms）・送り案内（付録B）・決定待ち（早押し無視・押しっぱなしで送らない）、
// 読書中のゲーム停止、放置デモの自動送り（各説明5000ms以上）
import { describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { AudioBus } from '../src/audio/audioBus';
import { LESSON_BASIC, LESSON_M1_SINGLE, LESSON_M1_VERSUS, READ_MS } from '../src/demo/lesson';
import { HelpLessonScene, readingOf } from '../src/demo/scenes';
import { LessonStage, Mode2Stage, ReadingGate } from '../src/demo/stages';
import { defaultSettings } from '../src/input/settings';
import { fakeAssets } from './helpers';

const host = () => ({ assets: fakeAssets(), bus: new AudioBus('./') });
const nav = (key: string, repeat = false) => ({ key, repeat, source: { kind: 'keyboard' } }) as never;
const F = 1000 / 60;

describe('ReadingGate', () => {
  const r = { page: 'basic_move' as const, panel: 0, prompt: 'demo' as const };
  it('手動：5000ms までは決定を捨て（予約しない）、送り案内も出さない。5000ms 後の決定で進む', () => {
    const g = new ReadingGate(true);
    expect(g.update(r, 4999)).toBe(false);
    expect(g.confirm(r)).toBe(false);
    expect(g.prompt(r)).toBeNull();
    g.update(r, 1);
    expect(g.prompt(r)).toBe('決定で実演へ');
    expect(g.prompt({ ...r, prompt: 'next' })).toBe('決定で次へ');
    // 時間が経っても自動では進まない
    expect(g.update(r, 60000)).toBe(false);
    expect(g.confirm(r)).toBe(true);
  });

  it('放置デモ：5000ms で自動に進む（決定は使わない）', () => {
    const g = new ReadingGate(false);
    expect(g.update(r, 4990)).toBe(false);
    expect(g.confirm(r)).toBe(false);
    expect(g.update(r, 10)).toBe(true);
    expect(g.log[0]).toMatchObject({ page: 'basic_move', by: 'auto' });
    expect(g.log[0].ms).toBeGreaterThanOrEqual(READ_MS);
  });
});

describe('教材の読書区間', () => {
  it('読書中は教材のゲーム時計を進めない（実時間だけ進む）', () => {
    const st = new LessonStage(host(), LESSON_BASIC, true);
    const t0 = st.game.tick;
    for (let i = 0; i < 600; i++) st.update(F);
    expect(st.reading).toMatchObject({ page: 'basic_move', panel: 0 });
    expect(st.game.tick).toBe(t0);
    st.confirm();
    expect(st.reading).toBeNull();
    for (let i = 0; i < 30; i++) st.update(F);
    expect(st.game.tick).toBeGreaterThan(t0);
  });

  it('放置デモ（自動送り）：すべての説明パネルを5000ms以上表示してから進む', () => {
    const st = new LessonStage(host(), LESSON_BASIC, false);
    for (let i = 0; i < 60 * 120 && !st.finished; i++) st.update(F);
    expect(st.finished).toBe(true);
    expect(st.gate.log.map((l) => `${l.page}#${l.panel}`)).toEqual(['basic_move#0', 'rotate#0', 'success1#0', 'success2#0', 'adjacent_wrap#0', 'fail#0', 'fail#1', 'rise#0']);
    for (const l of st.gate.log) expect(l.ms).toBeGreaterThanOrEqual(READ_MS);
  });

  it('MODE1 の説明（静止見本）：シングル4項目・対戦3項目、すべて「決定で次へ」', () => {
    for (const [def, pages] of [
      [LESSON_M1_SINGLE, ['m1_single', 'm1_endless', 'm1_endless', 'm1_stage', 'm1_quota']],
      [LESSON_M1_VERSUS, ['m1_versus', 'm1_versus', 'm1_counter', 'm1_counter', 'm1_win', 'm1_win']],
    ] as const) {
      const st = new LessonStage(host(), def, true);
      const seen: string[] = [];
      for (let k = 0; k < 20 && !st.finished; k++) {
        for (let i = 0; i < 301; i++) st.update(F);
        if (!st.reading) break;
        expect(st.gate.prompt(st.reading)).toBe('決定で次へ');
        seen.push(st.reading.page);
        st.confirm();
        st.update(F);
      }
      expect(seen).toEqual(pages);
      expect(st.finished).toBe(true);
    }
  });

  it('MODE2 説明（手動）：完走する（詰まり→3/2/1→場の更新→全ピース消化→クリアの説明）', () => {
    const st = new Mode2Stage(host(), true);
    let reads = 0;
    for (let i = 0; i < 60 * 400 && !st.finished; i++) {
      st.update(F);
      if (st.reading && st.gate.ms >= READ_MS) {
        st.confirm();
        reads++;
      }
    }
    expect(st.finished).toBe(true);
    expect(st.game.result?.outcome).toBe('clear');
    expect(st.game.remaining(st.game.players[0])).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(10);
  });
});

describe('遊び方の画面（HelpLessonScene）', () => {
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

  it('早い決定は無視（予約しない）、押しっぱなし（リピート）では送らない、5000ms後の新しい決定で送る。戻るは読書中も有効', () => {
    const app = makeApp();
    let back = 0;
    const sc = new HelpLessonScene(app, [(a) => new LessonStage(a, LESSON_BASIC, true)], () => back++);
    const st = readingOf(sc.stage)!;
    sc.update(F);
    sc.onNav(nav('confirm'));
    for (let i = 0; i < 299; i++) sc.update(F);
    expect(st.reading).toMatchObject({ page: 'basic_move' }); // 早押しは予約されない
    sc.update(F);
    sc.onNav(nav('confirm', true)); // 押しっぱなしのリピート
    expect(st.reading).toMatchObject({ page: 'basic_move' });
    sc.onNav(nav('confirm'));
    expect(st.reading).toBeNull();
    sc.onNav(nav('back'));
    expect(back).toBe(1);
  });
});
