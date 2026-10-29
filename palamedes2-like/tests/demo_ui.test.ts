// 遊び方・放置デモ：台本文字の収録・寸法、役一覧の値、SINGLE自動操作の抽選、対戦デモの seed、章の進行・暗転・割り込み・入力の規則
import { describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { AudioBus } from '../src/audio/audioBus';
import { computeAttack } from '../src/core/attack';
import type { Game } from '../src/core/game';
import { Match, SingleSession } from '../src/core/match';
import { createSeededRng } from '../src/core/rng';
import { evaluateSubset, roleLogoIndices } from '../src/core/roles';
import { pieceKind, TUTORIAL_SCRIPT } from '../src/demo/lesson';
import { PANEL } from '../src/demo/panel';
import { DemoScene, fadeAlpha, PadEdges } from '../src/demo/scenes';
import { pickWait, SINGLE_AUTO, SingleAutoController } from '../src/demo/singleAuto';
import { DEMO, roleDisplayName, type Stage } from '../src/demo/stages';
import { CpuController } from '../src/input/cpu';
import type { PadState } from '../src/input/controller';
import { defaultSettings } from '../src/input/settings';
import { measureBitmap, uncovered, type BitmapFontDef } from '../src/view/bitmapFont';
import { fakeAssets, readJson } from './helpers';

const font = readJson<BitmapFontDef>('public/gfx/data/tutorial_font_16.json');

describe('台本と収録文字（tutorial_font_16：V320-FIX-04 採用版 388字）', () => {
  const S = TUTORIAL_SCRIPT;
  const all: string[] = [
    ...Object.values(S.pages).flatMap((p) => [p.heading, ...p.lines]),
    ...S.return_hint.two_lines,
    S.return_hint.one_line,
    S.title_hint,
    ...S.help_menu,
    ...Object.values(S.help_choices),
    ...Object.values(S.role_list.categories),
    ...Object.values(S.role_list.labels),
    ...S.role_list.roles.flatMap((r) => [r.name, ...r.condition]),
    '操作一覧',
    'B/Esc:戻る',
    '消去０１２３４５６７８９ライン',
  ];

  it('表示する文字はすべて収録済み（台本・目次・打上連鎖・ノーリセットクリアに欠字なし）', () => {
    expect([...new Set([...all, '打上連鎖', 'ノーリセットクリア！'].flatMap((s) => uncovered(font, s)))].join('')).toBe('');
  });

  it('V320-FIX-04 採用フォント（FONT-SUPPLEMENT-01）：388字・512×208。既存327字の定義（矩形・送り・offset）は不変、追加61字は末尾。U+3000 は透明・送り16', () => {
    expect(Object.keys(font.glyphs)).toHaveLength(388);
    const f = font as unknown as { glyph_count: number; size: number[]; glyphs: Record<string, { rect: number[]; advance: number; offset: number[]; ink_box: unknown }> };
    expect(f.glyph_count).toBe(388);
    expect(f.size).toEqual([512, 208]);
    expect(Object.keys(font.glyphs).slice(313, 327).join('')).toBe('、んウダリ切後新明更残説離ノ');
    // 既存の代表字（ASCII 8px・全角16px）の字送りは不変
    expect(f.glyphs[' '].advance).toBe(8);
    expect(f.glyphs['の'].advance).toBe(16);
    expect(f.glyphs['\u3000']).toMatchObject({ rect: [48, 192, 16, 16], advance: 16, offset: [0, 0], ink_box: null });
    for (const ch of Object.keys(font.glyphs).slice(327)) expect(f.glyphs[ch].advance, ch).toBe(16);
  });

  it('本文は最大4行・各行168px以内（10全角相当。縮小しない）、見出し168px以内、戻る案内は1行192px（領域196px）', () => {
    for (const [k, p] of Object.entries(S.pages)) {
      expect(p.lines.length, k).toBeLessThanOrEqual(PANEL.body.maxLines);
      for (const l of [p.heading, ...p.lines]) expect(measureBitmap(font, l), `${k}:${l}`).toBeLessThanOrEqual(PANEL.body.w);
    }
    // 宣言中は本文3行＋「消去Ｎライン」
    for (const k of ['declare', 'flush', 'chain', 'chain3', 'line_clear'] as const) expect(S.pages[k].lines.length, k).toBeLessThanOrEqual(3);
    expect(measureBitmap(font, S.return_hint.one_line)).toBe(192);
    for (const l of S.return_hint.two_lines) expect(measureBitmap(font, l)).toBeLessThanOrEqual(PANEL.body.w);
    // 教材の役名（宣言時の見出し）
    for (const n of ['フォーカード', 'フラッシュ', 'スーパーストレート']) expect(measureBitmap(font, n)).toBeLessThanOrEqual(PANEL.heading.w);
  });

  it('台本の改行・本文は設計書 第5節の文と一致（台本データで改行）', () => {
    expect(S.pages.chain3.lines).toEqual(['３回続けて宣言', '役連鎖が３連鎖に！']);
    expect(S.pages.miss.lines).toEqual(['猶予がなくなると', 'ミス！', '打ち上げ失敗とは', '別のミス条件だよ']);
    expect(S.pages.pinch.lines).toEqual(['７段のまま次の', '自然上昇を迎えると', 'ピンチ！']);
    // v3.2.0 PM 追加指示
    expect(S.pages.m2_intro.lines).toEqual(['６列から選んで', '場へ出そう', 'となりの数字なら', '成功！']);
    expect(S.pages.streak_rate.lines).toEqual(['打上連鎖で', '攻撃力アップ', '対戦で力を発揮！']);
  });
});

describe('役一覧（本体の役データを共用）', () => {
  it('16役の実例は本体の役判定でその役名ロゴ1つだけになる。消去＝合計翻数、基本攻撃＝max(合計翻数−1,0)（倍率1・連鎖加算なし）', () => {
    const roles = TUTORIAL_SCRIPT.role_list.roles;
    expect(roles.map((r) => r.logo)).toEqual([...Array(16).keys()]);
    for (const r of roles) {
      const res = evaluateSubset(r.example.map((c, i) => ({ id: i + 1, ...pieceKind(c) })));
      expect(roleLogoIndices(res), r.name).toEqual([r.logo]);
      expect(roleDisplayName([r.logo])).toBe(r.name);
      expect(computeAttack(res.han, 100, 1).power, r.name).toBe(Math.max(res.han - 1, 0));
    }
    const v = (name: string) => {
      const r = roles.find((x) => x.name === name)!;
      const h = evaluateSubset(r.example.map((c, i) => ({ id: i + 1, ...pieceKind(c) }))).han;
      return [h, computeAttack(h, 100, 1).power];
    };
    expect([v('フォーカード'), v('フラッシュ'), v('スーパーストレート')]).toEqual([
      [1, 0],
      [3, 2],
      [3, 2],
    ]);
  });
});

describe('SINGLE 専用の自動操作（設計書 第7節）', () => {
  it('判断待ちの抽選：固定seedで 600/1000/1400ms＝30/45/25%、ピンチ中 300/500/800ms＝40/40/20%（±1.5%）', () => {
    const rng = createSeededRng(99);
    const count = (t: { ms: readonly number[]; pct: readonly number[] }) => {
      const c = new Map<number, number>();
      for (let i = 0; i < 20000; i++) {
        const w = pickWait(rng, t);
        c.set(w, (c.get(w) ?? 0) + 1);
      }
      return t.ms.map((m) => (c.get(m) ?? 0) / 200);
    };
    count(SINGLE_AUTO.wait).forEach((p, i) => expect(Math.abs(p - SINGLE_AUTO.wait.pct[i])).toBeLessThan(1.5));
    count(SINGLE_AUTO.pinchWait).forEach((p, i) => expect(Math.abs(p - SINGLE_AUTO.pinchWait.pct[i])).toBeLessThan(1.5));
  });

  it('本編のひたすら（Lv1）を35秒：判断ごとに1回だけ抽選、成立した4個役は宣言、手動上昇で5段以上にしない。同じseedなら同じ進行', () => {
    const run = () => {
      const s = new SingleSession({ mode: 'endless', seed: DEMO.singleSeed });
      const auto = new SingleAutoController(DEMO.singleSeed ^ 0x1234);
      const g = () => s.game as Game;
      while (!g().playing) s.step([]);
      const end = g().tick + g().ticks(DEMO.singleMs);
      while (g().tick < end && !g().result) s.step(auto.poll(g()));
      return { g: g(), auto };
    };
    const a = run();
    const b = run();
    expect(a.g.snapshot()).toBe(b.g.snapshot());
    const ev = a.g.events;
    expect(a.auto.log.length).toBeGreaterThan(10);
    for (const d of a.auto.log) expect((d.pinch ? SINGLE_AUTO.pinchWait : SINGLE_AUTO.wait).ms).toContain(d.waitMs);
    expect(ev.filter((e) => e.type === 'arrive' && e.success).length).toBeGreaterThan(5);
    expect(ev.filter((e) => e.type === 'declare').length).toBeGreaterThan(0);
    expect(ev.filter((e) => e.type === 'declareFail')).toEqual([]);
    for (const e of ev) if (e.type === 'rise' && e.kind === 'manual') expect(e.heightAfter).toBeLessThanOrEqual(SINGLE_AUTO.heightHigh);
  });
});

describe('対戦デモ（アカネ中級 対 ずん子中級、seed 選定）', () => {
  it('seed 60（v3.2.0 で再選定）：両者の攻撃送信・攻撃段の適用・相殺が見え、60秒以内に決着（勝敗補正なし、既存CPU設定）', () => {
    const seed = DEMO.versusSeed;
    const m = new Match({ firstTo: 1, difficulty: 'normal', seed, mode: 'mode1' });
    const c = [new CpuController(0, 'normal', seed * 7 + 1, 'akane'), new CpuController(1, 'normal', seed * 7 + 2, 'zunko')];
    const limit = m.game.playStartTick + m.game.ticks(DEMO.versusMs + DEMO.breakWaitMs);
    while (m.game.tick < limit && m.state === 'round') m.step([...c[0].poll(m.game), ...c[1].poll(m.game)], false);
    const g = m.game as Game;
    const senders = new Set(g.events.filter((e) => e.type === 'attack' && e.counter.sent > 0).map((e) => (e as { player: number }).player));
    expect(senders.size).toBe(2);
    expect(g.events.filter((e) => e.type === 'attackRow').length).toBeGreaterThan(10);
    expect(g.events.filter((e) => e.type === 'attackCancel').length).toBeGreaterThan(3);
    expect(g.result).not.toBeNull();
    expect((g.result!.tick - g.playStartTick) * g.tickMs).toBeLessThanOrEqual(DEMO.versusMs);
  });
});

// ---------------------------------------------------------------- 章の進行・暗転・割り込み（DOM なし）

function makeApp(pads: (i: number) => PadState | null = () => null) {
  return new App({
    assets: fakeAssets(),
    bus: new AudioBus('./'),
    pads,
    settings: defaultSettings(),
    applyDisplay: () => undefined,
    requestFullscreen: () => undefined,
    viewport: () => ({ w: 1280, h: 720, dpr: 1 }),
    openUrl: () => undefined,
    dev: false,
  });
}

/** 指定時間で終わる仮の章（章の切替・暗転の規則だけを調べる） */
function fakeStage(ms: number, hint: 'single' | 'versus', log: string[], id: string): Stage {
  let t = 0;
  log.push(`make:${id}`);
  return {
    hint,
    get finished() {
      return t >= ms;
    },
    update: (dt) => {
      t += dt;
    },
    render: () => undefined,
  };
}

const step = (s: { update(dt: number): void }, ms: number) => {
  for (let t = 0; t < ms; t += 1000 / 60) s.update(1000 / 60);
};

describe('放置デモの進行（暗転 600/300/600ms・章ごとに作り直す・割り込み）', () => {
  it('暗転の濃さ：フェードアウト600ms→黒300ms→フェードイン600ms', () => {
    expect([fadeAlpha('fadeOut', 0), fadeAlpha('fadeOut', 300), fadeAlpha('fadeOut', 600), fadeAlpha('black', 100), fadeAlpha('fadeIn', 300), fadeAlpha('fadeIn', 600), fadeAlpha('play', 0)]).toEqual([0, 0.5, 1, 1, 0.5, 0, 0]);
  });

  it('完走：章を順に新しく作り、黒の後に次の章（案内の形式は次の章の表示開始で切替）。最後は暗転してタイトル', () => {
    const app = makeApp();
    const log: string[] = [];
    const chapters = [
      { id: 'a', make: () => fakeStage(1000, 'single', log, 'a') },
      { id: 'b', make: () => fakeStage(1000, 'versus', log, 'b') },
    ];
    const d = new DemoScene(app, 'option', chapters);
    app.setScene(d);
    expect(d.chapterId).toBe('a');
    step(d, 1000 + 50); // 章a（フェードイン中も進む）が終わるとフェードアウト
    expect(d.phase).toBe('fadeOut');
    step(d, 600 + 100);
    expect(d.phase).toBe('black');
    expect(log).toEqual(['make:a']); // 黒の間は次の章を作らない（前の形式の案内を保つ）
    step(d, 200);
    expect(log).toEqual(['make:a', 'make:b']);
    expect(d.generation).toBe(2);
    step(d, 1000 + 600 + 300 + 100);
    expect(app.scene.constructor.name).toBe('TitleScene');
  });

  it('割り込み：入力は消費して暗転→タイトル（区切り待ちより優先）。押しっぱなし（リピート）では終了しない。暗転中も受け付ける', () => {
    const app = makeApp();
    const log: string[] = [];
    const d = new DemoScene(app, 'idle', [{ id: 'a', make: () => fakeStage(60000, 'single', log, 'a') }]);
    app.setScene(d);
    step(d, 2000);
    expect(d.onKey('Enter', true)).toBe(true);
    expect(d.ending).toBe(false);
    expect(d.onKey('Enter', false)).toBe(true);
    expect(d.ending).toBe(true);
    step(d, 600 + 300 + 50);
    expect(app.scene.constructor.name).toBe('TitleScene');
    // 暗転（章の切替の黒）の最中の入力も受け付ける
    const d2 = new DemoScene(app, 'idle', [
      { id: 'a', make: () => fakeStage(100, 'single', log, 'a2') },
      { id: 'b', make: () => fakeStage(60000, 'single', log, 'b2') },
    ]);
    app.setScene(d2);
    step(d2, 600 + 600 + 100); // フェードイン後に終了判定→フェードアウト→黒
    expect(d2.phase).toBe('black');
    d2.onPointer();
    step(d2, 400);
    expect(app.scene.constructor.name).toBe('TitleScene');
    expect(log).not.toContain('make:b2');
  });

  it('非アクティブ：進行を止め、復帰でタイトルへ', () => {
    const app = makeApp();
    const log: string[] = [];
    const d = new DemoScene(app, 'idle', [{ id: 'a', make: () => fakeStage(60000, 'single', log, 'a') }]);
    app.setScene(d);
    step(d, 1000);
    const phaseMs = (d as unknown as { phaseMs: number }).phaseMs;
    d.onVisibility(true);
    step(d, 5000);
    expect((d as unknown as { phaseMs: number }).phaseMs).toBe(phaseMs);
    d.onVisibility(false);
    expect(app.scene.constructor.name).toBe('TitleScene');
  });
});

describe('パッドの終了判定（新しい操作だけ）', () => {
  it('開始時に押していたボタンは離すまで数えない。小さな傾き（ドリフト）では反応せず、0.7以上へ倒した瞬間だけ', () => {
    const axes = [0, 0, 0, 0];
    const st: PadState = { buttons: Array.from({ length: 17 }, () => ({ pressed: false })), axes };
    st.buttons[0].pressed = true;
    const e = new PadEdges((i) => (i === 0 ? st : null));
    expect(e.poll()).toBe(false); // 押しっぱなし
    axes[0] = 0.35;
    expect(e.poll()).toBe(false);
    axes[0] = 0.5;
    expect(e.poll()).toBe(false);
    st.buttons[0].pressed = false;
    expect(e.poll()).toBe(false);
    st.buttons[0].pressed = true;
    expect(e.poll()).toBe(true); // 新しい押下
    expect(e.poll()).toBe(false); // 保持
    axes[1] = -0.9;
    expect(e.poll()).toBe(true);
    expect(e.poll()).toBe(false);
  });
});
