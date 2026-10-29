// V320-FIX-04 第12章：CPU観戦（メニュー・設定・本編Match＋CPU・自動進行・終了確認・記録なし）と付録Cのメニュー説明
import { describe, expect, it } from 'vitest';
import { App, defaultWatchSettings, GameScene, MENU_DESC, menuDescLines, MenuScene, nextWatchCharacter, WatchSettingsScene } from '../src/app';
import { AudioBus } from '../src/audio/audioBus';
import type { Match } from '../src/core/match';
import { CpuController } from '../src/input/cpu';
import { defaultSettings } from '../src/input/settings';
import { emptyRecords } from '../src/ui/records';
import { fakeAssets } from './helpers';

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
const nav = (key: string) => ({ key, source: { kind: 'keyboard' } }) as never;

describe('V320-FIX-04 CPU観戦：メニューと設定', () => {
  it('メインメニュー：MODE2 とオプションの間に「CPU観戦」。説明は付録Cの本文', () => {
    const app = makeApp();
    const m = new MenuScene(app) as unknown as { stack: { items: { label: string; desc: string }[] }[] };
    expect(m.stack[0].items.map((i) => i.label)).toEqual(['MODE1', 'MODE2', 'CPU観戦', 'オプション', '遊び方']);
    expect(m.stack[0].items[2].desc).toBe('キャラと強さを選んで、CPU同士の対戦を観戦しよう！');
    expect(m.stack[0].items[0].desc).toBe(MENU_DESC.mode1);
  });

  it('付録C：300pxへ縮小せず、収まらない説明は全角空白の区切りで行分け（本文は変えない）', () => {
    const w = (s: string) => [...s].length * 11;
    for (const d of Object.values(MENU_DESC)) {
      const lines = menuDescLines(null, d, w);
      // 行をつなぐと本文に戻る（区切りの全角空白だけを行の境目で省く）
      expect(lines.join('').replaceAll('　', '')).toBe(d.replaceAll('　', ''));
      for (const l of lines) expect(w(l)).toBeLessThanOrEqual(300);
    }
  });

  it('初期値：MODE1・左アカネ初級・右ずん子初級・2本先取・自然上昇7秒。項目順。MODE2では自然上昇を隠す', () => {
    expect(defaultWatchSettings()).toEqual({ mode: 'mode1', left: 'akane', leftLevel: 'easy', right: 'zunko', rightLevel: 'easy', firstTo: 2, riseMs: 7000 });
    const app = makeApp();
    const sc = new WatchSettingsScene(app);
    expect(sc.rows().map((r) => r.label)).toEqual(['モード', '左キャラ', '左の強さ', '右キャラ', '右の強さ', '先取本数', '自然上昇', '観戦開始', '戻る']);
    sc.onNav(nav('right')); // モード → MODE2
    expect(app.watch.mode).toBe('mode2');
    expect(sc.rows().map((r) => r.label)).toEqual(['モード', '左キャラ', '左の強さ', '右キャラ', '右の強さ', '先取本数', '観戦開始', '戻る']);
  });

  it('左右同キャラ不可：相手の選択キャラを飛ばして次の候補へ', () => {
    expect(nextWatchCharacter('akane', 'zunko', 1)).toBe('kotaro');
    expect(nextWatchCharacter('kotaro', 'akane', 1)).toBe('zunko');
    expect(nextWatchCharacter('kotaro', 'zunko', -1)).toBe('akane');
    const app = makeApp();
    const sc = new WatchSettingsScene(app);
    sc.cursor = 1;
    for (let i = 0; i < 6; i++) {
      sc.onNav(nav(i % 2 ? 'left' : 'right'));
      expect(app.watch.left).not.toBe(app.watch.right);
    }
  });

  it('観戦設定は通常の対戦設定と別（設定を書き換えない）', () => {
    const app = makeApp();
    const before = JSON.stringify(app.settings);
    const sc = new WatchSettingsScene(app);
    for (const k of ['right', 'down', 'right', 'down', 'right', 'down', 'down', 'right', 'down', 'right']) sc.onNav(nav(k));
    expect(JSON.stringify(app.settings)).toBe(before);
  });
});

describe('V320-FIX-04 CPU観戦：試合', () => {
  function start(over: Partial<ReturnType<typeof defaultWatchSettings>> = {}) {
    const app = makeApp();
    Object.assign(app.watch, over);
    app.startWatch();
    const sc = app.scene as GameScene;
    // 描画なしで進めるため、開始前待機の「最初の描画済み」を立てる
    const raw = sc.update.bind(sc);
    sc.update = (dt: number) => {
      (sc as unknown as { holdRendered: boolean }).holdRendered = true;
      raw(dt);
    };
    return { app, sc };
  }

  it('本編 Match と CPU 2体（左右の強さ・キャラを独立指定）。自然上昇は設定どおり。補助表示なし', () => {
    const { sc } = start({ leftLevel: 'hard', rightLevel: 'normal', riseMs: 3000, firstTo: 3 });
    expect(sc.kind).toBe('watch');
    expect(sc.devices).toEqual([
      { kind: 'cpu', level: 'hard' },
      { kind: 'cpu', level: 'normal' },
    ]);
    expect(sc.characters).toEqual(['akane', 'zunko']);
    const ctl = sc.controllers as CpuController[];
    expect(ctl.map((c) => [c.level, c.character])).toEqual([
      ['hard', 'akane'],
      ['normal', 'zunko'],
    ]);
    const m = sc.session as Match;
    expect(m.settings.firstTo).toBe(3);
    expect(m.config.naturalRiseIntervalMs).toBe(3000);
  });

  it('MODE2・1本先取：ラウンド間は結果演出の後1500ms保持して自動進行、最終結果は 再戦／観戦設定へ／メインメニューへ。記録なし・ログあり', () => {
    const { app, sc } = start({ mode: 'mode2', firstTo: 2, leftLevel: 'hard', rightLevel: 'hard' });
    const m = sc.session as Match;
    let rounds = 0;
    let prev = m.game;
    for (let i = 0; i < 60 * 60 * 12 && m.state !== 'matchResult'; i++) {
      sc.update(1000 / 60);
      if (m.game !== prev) {
        rounds++;
        prev = m.game;
      }
    }
    expect(m.state).toBe('matchResult');
    expect(rounds).toBeGreaterThanOrEqual(1);
    expect(sc.finalChoices().map((c) => c.label)).toEqual(['再戦', '観戦設定へ', 'メインメニューへ']);
    expect(app.records).toEqual(emptyRecords());
    expect(app.watchLog.length).toBe(rounds + 1);
    expect(app.watchLog[0]).toMatchObject({ mode: 'mode2', left: { character: 'akane', level: 'hard' }, right: { character: 'zunko', level: 'hard' }, riseMs: null, round: 1 });
  });

  it('自動進行は結果演出完了から1500ms（それより前には進まない）', () => {
    const { sc } = start({ mode: 'mode2', firstTo: 3, leftLevel: 'hard', rightLevel: 'hard' });
    const m = sc.session as Match;
    for (let i = 0; i < 60 * 60 * 6 && m.state !== 'roundResult'; i++) sc.update(1000 / 60);
    expect(m.state).toBe('roundResult');
    const staging = (sc as unknown as { staging: { acceptReady: boolean } }).staging;
    let n = 0;
    while (!staging.acceptReady && n++ < 60 * 30) sc.update(1000 / 60);
    const g = m.game;
    for (let i = 0; i < 88; i++) sc.update(1000 / 60); // 1466ms
    expect(m.game).toBe(g);
    for (let i = 0; i < 6 && m.game === g; i++) sc.update(1000 / 60);
    expect(m.game).not.toBe(g);
  });

  it('試合中の戻る：終了確認（ゲームは進行）→「終了する」で観戦設定へ。入力漏れ（ゲームへの操作）なし', () => {
    const { app, sc } = start();
    for (let i = 0; i < 200; i++) sc.update(1000 / 60);
    sc.onKey('Escape', false);
    expect(sc.quit).toHaveLength(1);
    const t = sc.game.tick;
    for (let i = 0; i < 30; i++) sc.update(1000 / 60);
    expect(sc.game.tick).toBeGreaterThan(t);
    expect(sc.onKey('ArrowRight', false)).toBe(true);
    expect(sc.quit[0].cursor).toBe(1);
    sc.onKey('Enter', false);
    expect(app.scene).toBeInstanceOf(WatchSettingsScene);
  });
});
