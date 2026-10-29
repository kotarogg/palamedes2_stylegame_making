// V320-FIX-04 第4章・第5章：連鎖HUDの見出しPNG（body_origin で旧文字セルへ）、ヒビの揺れ、SINGLE 得点倍率（48×56）、教材の注目枠、
// 素材定義（v320_fix04_assets.json）との一致、候補補助表示。FIX-03 の縦帯・数字の等比収めは継承
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Game } from '../src/core/game';
import type { PlayerId } from '../src/core/types';
import type { Fix04AssetsJson } from '../src/view/assets';
import { CHAIN_HUD, chainFocusBox, chainHudLayout, crackShakeOffset, HUD_LABELS, labelAt, rateRun, type Box } from '../src/view/chainHud';
import { GameView } from '../src/view/gameView';
import { numericNaturalWidth } from '../src/view/text';
import { EMPTY, fakeAssets, makeGame, readJson, ROOT } from './helpers';

const P: PlayerId[] = [0, 1];
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const def = readJson<Fix04AssetsJson>('public/gfx/data/v320_fix04_assets.json');

describe('V320-FIX-04 素材：見出し8枚・倍率数字シート', () => {
  it('9PNGの実寸・SHA-256が定義どおり（PM検収値）。chainHud の見出し定義は JSON と同値', () => {
    const exp: Record<string, string> = {
      label_role_main: 'ceab1088',
      label_role_chain_sub: '9fa41904',
      label_launch_main: '531121a5',
      label_launch_chain_sub: '2fb1cc26',
      label_score_main: '6dd5a23e',
      label_score_rate: '9b5107c3',
      label_attack: '9abdb112',
      label_cancel: '30349ee2',
      score_rate_numeric_sheet: '140433c8',
    };
    expect(def.assets.map((a) => a.id).sort()).toEqual(Object.keys(exp).sort());
    for (const a of def.assets) {
      const buf = readFileSync(new URL(`public/gfx/${a.file}`, ROOT));
      expect([buf.readUInt32BE(16), buf.readUInt32BE(20)], a.id).toEqual(a.canvas);
      const sha = createHash('sha256').update(buf).digest('hex');
      expect(sha, a.id).toBe(a.sha256);
      expect(sha.startsWith(exp[a.id]), a.id).toBe(true);
      if (a.body_origin) expect(HUD_LABELS[a.id as keyof typeof HUD_LABELS], a.id).toEqual({ canvas: a.canvas, body_origin: a.body_origin, visible_xywh: a.visible_xywh });
    }
    expect(def.assets.find((a) => a.id === 'score_rate_numeric_sheet')!.canvas).toEqual([192, 20]);
    expect(def.score_rate_numeric.glyphs.map((g) => g.char).join('')).toBe('0123456789×.');
  });

  it('説明フォントは FONT-SUPPLEMENT-01 の388字版（PNG／JSON の対のハッシュ）', () => {
    const sha = (rel: string) => createHash('sha256').update(readFileSync(new URL(rel, ROOT))).digest('hex');
    expect(sha('public/gfx/assets/tutorial_font_16.png')).toBe('42875fb3a365cd06d1abb061acf08532fa40a711e739e246845eacf45237c102');
    expect(sha('public/gfx/data/tutorial_font_16.json')).toBe('ed5ee59fbf496ba9d09804df24005893527868f3ca61effd53774442c2fe7447');
  });
});

describe('V320-FIX-04 連鎖HUD（第4.1節の表）', () => {
  it('採用PNG左上：役(2,129)／(594,129)、役の連鎖(2,166)、打上(2,256)、打上の連鎖(2,276)。原寸', () => {
    const exp = {
      0: { role: [2, 129, 44, 36], ren1: [2, 166, 44, 20], up: [2, 256, 44, 20], ren2: [2, 276, 44, 20], cx: 24 },
      1: { role: [594, 129, 44, 36], ren1: [594, 166, 44, 20], up: [594, 256, 44, 20], ren2: [594, 276, 44, 20], cx: 616 },
    } as const;
    for (const p of P) {
      const l = chainHudLayout(p);
      const box = (r: Box) => [r.x, r.y, r.w, r.h];
      expect(l.cx).toBe(exp[p].cx);
      expect(box(l.roleTitle)).toEqual(exp[p].role);
      expect(box(l.roleSub)).toEqual(exp[p].ren1);
      expect(box(l.streakTitle)).toEqual(exp[p].up);
      expect(box(l.streakSub)).toEqual(exp[p].ren2);
      expect([l.roleTitle.id, l.roleSub.id, l.streakTitle.id, l.streakSub.id]).toEqual(['label_role_main', 'label_role_chain_sub', 'label_launch_main', 'label_launch_chain_sub']);
      expect(l.roleDigits).toEqual({ cx: exp[p].cx, y: 190, h: 34, maxW: 46 });
      expect(l.plus).toEqual({ cx: exp[p].cx, y: 228, size: 16 });
      expect(l.streakDigits).toEqual({ cx: exp[p].cx, y: 300, h: 17, maxW: 46 });
    }
  });

  it('画像（キャンバスごと）が帯（48px）の内側。左右は同じ縦位置。描画画素は行どうしで重ならない', () => {
    for (const p of P) {
      const l = chainHudLayout(p);
      for (const r of [l.roleTitle, l.roleSub, l.streakTitle, l.streakSub]) {
        expect(r.x).toBeGreaterThanOrEqual(l.strip.x);
        expect(r.x + r.w).toBeLessThanOrEqual(l.strip.x + l.strip.w);
      }
      const rows: Box[] = [
        l.roleTitle.visible,
        l.roleSub.visible,
        { x: l.cx - 23, y: l.roleDigits.y, w: 46, h: l.roleDigits.h },
        { x: l.cx - 23, y: l.plus.y, w: 46, h: l.plus.size + 4 },
        l.streakTitle.visible,
        l.streakSub.visible,
        { x: l.cx - 23, y: l.streakDigits.y, w: 46, h: l.streakDigits.h },
      ];
      for (let i = 1; i < rows.length; i++) expect(overlap(rows[i], rows[i - 1]), `${p}:${i}`).toBe(false);
    }
    expect(chainHudLayout(1).roleTitle.x - chainHudLayout(0).roleTitle.x).toBe(592);
  });

  it('盤面・連鎖ゲージ・受攻撃ストック・役名ロゴの位置は動かさず、帯と重ならない', () => {
    const L = fakeAssets().layout;
    for (const p of P) {
      const strip = chainHudLayout(p).strip;
      for (const k of ['board', 'chain_gauge', 'stock_background', 'role_logo', 'win_counter']) expect(overlap(strip, L.pRect(p, k)), `${p}:${k}`).toBe(false);
    }
  });

  it('数字 0／1／7／12／19／99／999：既存S12の等比収め（幅46・高さ上限、縦横比維持）', () => {
    const A = fakeAssets();
    for (const s of ['0', '1', '7', '12', '19', '99', '999'])
      for (const h of [34, 17]) {
        const n = numericNaturalWidth(A, s);
        const k = Math.min(h / 34, 46 / n);
        expect(Math.round(n * k), s).toBeLessThanOrEqual(46);
        expect(Math.round(34 * k), s).toBeLessThanOrEqual(h);
      }
  });

  it('教材の注目枠は見出し画像の実際の装飾範囲と数字の最大範囲の外接（旧文字位置・空白を囲わない）', () => {
    expect(chainFocusBox(0, 'chain', false)).toEqual({ x: 1, y: 130, w: 46, h: 94 });
    expect(chainFocusBox(0, 'streak', false)).toEqual({ x: 1, y: 257, w: 46, h: 60 });
    expect(chainFocusBox(0, 'chain', true)).toEqual({ x: 1, y: 130, w: 46, h: 228 + 16 + 2 - 130 });
    expect(overlap(chainFocusBox(0, 'chain', false), chainFocusBox(0, 'streak', false))).toBe(false);
  });
});

describe('V320-FIX-04 ヒビの揺れ（第4.2節）', () => {
  it('600ms周期の最初の200msだけ、50msごとに (0,0)→(-1,0)→(1,-1)→(0,1)。残りは基準位置。整数・最大±1', () => {
    const seq = [0, 50, 100, 150, 199, 200, 599, 600, 650].map((ms) => crackShakeOffset(ms));
    expect(seq).toEqual([[0, 0], [-1, 0], [1, -1], [0, 1], [0, 1], [0, 0], [0, 0], [0, 0], [-1, 0]]);
    expect(CHAIN_HUD.shake).toMatchObject({ periodMs: 600, activeMs: 200, stepMs: 50 });
  });

  it('予約に入ったtickが起点（数字更新で戻さない）。予約解除・結果確定で基準位置。帯をはみ出さない', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    const st = g.players[0];
    while (!g.playing) g.step();
    st.streakCount = 3;
    st.streakRemaining = 600;
    st.streakCutReserved = true;
    const t0 = g.tick;
    expect(v.crackShake(0, t0)).toEqual([0, 0]);
    expect(v.crackShake(0, t0 + 3)).toEqual([-1, 0]); // 50ms
    st.streakCount = 4; // 数字更新
    expect(v.crackShake(0, t0 + 6)).toEqual([1, -1]); // 100ms（起点は不変）
    expect(v.crackShake(0, t0 + 36 + 3)).toEqual([-1, 0]); // 次周期
    st.streakCutReserved = false;
    expect(v.crackShake(0, t0 + 3)).toEqual([0, 0]);
    const l = chainHudLayout(0);
    expect(l.cx - l.streakDigits.maxW / 2 - 1).toBeGreaterThanOrEqual(l.strip.x);
    expect(l.cx + l.streakDigits.maxW / 2 + 1).toBeLessThanOrEqual(l.strip.x + l.strip.w);
  });
});

describe('V320-FIX-04 SINGLE 得点倍率（第4.3節）', () => {
  const G = def.score_rate_numeric.glyphs;
  it('領域(24,64,48,56)：得点PNG(2,0)、倍率PNG(2,18)、数字上端y36。旧領域[24,94,120,34]は使わない', () => {
    const r = CHAIN_HUD.singleRate;
    expect(r.area).toEqual({ x: 24, y: 64, w: 48, h: 56 });
    expect([r.score.dx, r.score.dy, r.rate.dx, r.rate.dy, r.digitsTop]).toEqual([2, 0, 2, 18, 36]);
    // 見出しの描画画素は重ならない（透明キャンバスの重なりは可）
    const s = labelAt('label_score_main', 0, 0);
    const k = labelAt('label_score_rate', 0, 0);
    const vis = (l: typeof s, dy: number): Box => ({ x: l.visible.x - l.x + 2, y: l.visible.y - l.y + dy, w: l.visible.w, h: l.visible.h });
    expect(overlap(vis(s, 0), vis(k, 18))).toBe(false);
    expect(vis(k, 18).y + vis(k, 18).h).toBeLessThanOrEqual(36 + 2); // 数字の可視上端（セル上端+2）より上
  });

  it('倍率4種の列幅は ×1=25、×1.5=46、×2=27、×2.5=48。いずれも幅48・高さ20（y36〜56）に収まる', () => {
    const w = Object.fromEntries(['×1', '×1.5', '×2', '×2.5'].map((s) => [s, rateRun(G, s).width]));
    expect(w).toEqual({ '×1': 25, '×1.5': 46, '×2': 27, '×2.5': 48 });
    for (const s of Object.keys(w)) {
      const run = rateRun(G, s);
      const x0 = Math.floor((48 - run.width) / 2);
      for (const c of run.cells) {
        const vx = x0 + c.dx + c.g.visible_xywh[0];
        expect(vx, s).toBeGreaterThanOrEqual(0);
        expect(vx + c.g.visible_xywh[2], s).toBeLessThanOrEqual(48);
      }
      expect(36 + 20).toBeLessThanOrEqual(56);
    }
  });

  it('SINGLE のゲーム画面だけ（教材の情報欄非表示・攻撃倍率扱い・対戦では出さない）', () => {
    const single = new GameView(new Game({ seed: 1, single: { kind: 'endless' } }), fakeAssets());
    const vs = new GameView(makeGame({ boards: { 0: EMPTY, 1: EMPTY } }), fakeAssets());
    expect(vs.showsScoreRate).toBe(false);
    expect(single.showsScoreRate).toBe(true);
    single.hud = { hideSingleInfo: true };
    expect(single.showsScoreRate).toBe(false);
    single.hud = { streakRate: 'attack' };
    expect(single.showsScoreRate).toBe(false);
  });
});

describe('V320-FIX-04 候補補助表示（第5章）', () => {
  it('不透明度は 0.50〜0.95 を 1000ms 周期で往復', () => {
    const xs = Array.from({ length: 100 }, (_, i) => GameView.assistAlpha(i * 10));
    expect(Math.min(...xs)).toBeCloseTo(0.5, 3);
    expect(Math.max(...xs)).toBeCloseTo(0.95, 3);
    expect(GameView.assistAlpha(0)).toBeCloseTo(GameView.assistAlpha(1000), 6);
  });
});

describe('V320-FIX-04 相殺・送信の表示（第9章）', () => {
  /** 1P：待機3の状態で攻撃力4（ストレートフラッシュ）を宣言 → 相殺3・送信2 */
  function setup(pending: number) {
    const g = makeGame({ boards: { 0: { 0: ['5c'], 1: ['5c'], 2: ['5c'], 3: ['5c'], 4: ['5c'], 5: ['5c'] }, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    while (!g.playing) g.step();
    if (pending) g.step([{ player: 0, type: 'debugAttack', lines: pending } as never]);
    g.players[0].roleStock = [1, 2, 3, 4].map((n) => g.factory.make(n, 'spade'));
    g.step([{ player: 0, type: 'declare' }]);
    let a: { tick: number; counter: { canceled: number; sent: number } } | undefined;
    for (let i = 0; i < 300 && !a; i++) {
      g.step();
      a = g.events.find((e) => e.type === 'attack') as typeof a;
    }
    v.syncEvents();
    return { g, v, a: a! };
  }

  it('V320-FIX-04-R1 相殺・攻撃の両方：上段「相殺 N」（y48/68）、下段「攻撃 N」（y87/107）。1Pは外側の縦帯 x0〜48 の中央（x24）', () => {
    const { v, a } = setup(3);
    expect(a.counter).toMatchObject({ canceled: 3, sent: 2 });
    const r = v.attackResult(0, a.tick)!;
    expect(r.rows.map((x) => [x.kind, x.value, x.label.y, x.digits.y, x.digits.cx])).toEqual([
      ['cancel', 3, 48, 68, 24],
      ['attack', 2, 87, 107, 24],
    ]);
    for (const x of r.rows) {
      expect(x.label.visible.x).toBeGreaterThanOrEqual(0);
      expect(x.label.visible.x + x.label.visible.w).toBeLessThanOrEqual(48);
      expect(x.digits).toMatchObject({ h: 17, maxW: 46 });
    }
    expect(r.dot).not.toBeNull();
    expect(v.attackResult(1, a.tick)).toBeNull();
  });

  it('相殺0：攻撃だけ（上段は空ける）。送信0：相殺だけで光点なし。900msで終了', () => {
    const s = setup(0);
    const r = s.v.attackResult(0, s.a.tick)!;
    expect(r.rows.map((x) => [x.kind, x.label.y])).toEqual([['attack', 87]]);
    expect(s.v.attackResult(0, s.a.tick + 53)).not.toBeNull();
    expect(s.v.attackResult(0, s.a.tick + 54)).toBeNull(); // 900ms
    expect(s.v.attackResult(0, s.a.tick + 15)!.dot).toBeNull(); // 光点は250msまで
    const c = setup(9);
    const rc = c.v.attackResult(0, c.a.tick)!;
    expect(c.a.counter).toMatchObject({ canceled: 8, sent: 0 });
    expect(rc.rows.map((x) => x.kind)).toEqual(['cancel']);
    expect(rc.dot).toBeNull();
  });

  it('結果確定・新ラウンドで表示を終える（後から再出現しない）', () => {
    const { g, v, a } = setup(3);
    expect(v.attackResult(0, a.tick)).not.toBeNull();
    g.result = { winner: 1, tick: g.tick, outcome: 'win' };
    expect(v.attackResult(0, a.tick)).toBeNull();
    g.result = null;
    v.reset(makeGame({ boards: { 0: EMPTY, 1: EMPTY } }));
    expect(v.attackResult(0, a.tick)).toBeNull();
  });
});

describe('V320-FIX-04-R1 相殺・送信の表示と受ストック・連鎖HUD・盤面の非干渉', () => {
  const overlapB = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  it('双方の受ストック最大（予約29＋待機28）と双方の相殺・攻撃表示が同時でも、表示（見出し可視範囲・数字の最大枠・光点の始点）は受ストック・待機数・連鎖HUD・盤面・勝利数に重ならない', () => {
    const g = makeGame({ boards: { 0: EMPTY, 1: EMPTY } });
    const v = new GameView(g, fakeAssets());
    while (!g.playing) g.step();
    for (const p of g.players) Object.assign(p.incoming, { blockActive: true, blockReserved: 29, blockRemaining: 27, waveRemaining: 2, nextPending: 28 });
    const L = fakeAssets().layout;
    for (const p of P) {
      const rows = (v as unknown as { pv: { attackShow: unknown }[] }).pv;
      rows[p].attackShow = { canceled: 12, sent: 29, start: g.tick };
    }
    for (const p of P) {
      const r = v.attackResult(p, g.tick)!;
      expect(r.rows).toHaveLength(2);
      const boxes: Box[] = r.rows.flatMap((x) => [x.label.visible, { x: x.digits.cx - x.digits.maxW / 2, y: x.digits.y, w: x.digits.maxW, h: x.digits.h }]);
      for (const q of P) {
        const plan = v.stockDrawPlan(q, g.tick);
        for (const e of plan.entries) for (const b of boxes) expect(overlapB(b, { x: e.x, y: e.y, w: e.w, h: e.h }), `${p}→stock${q}`).toBe(false);
        const lb = plan.label!;
        const lbox: Box = { x: lb.align === 'left' ? lb.x - 2 : lb.x - 20, y: lb.y - 2, w: 22, h: 16 };
        for (const b of boxes) expect(overlapB(b, lbox), `${p}→label${q}`).toBe(false);
        const hud = chainHudLayout(q);
        for (const b of boxes) {
          for (const row of [hud.roleTitle.visible, hud.roleSub.visible, hud.streakTitle.visible, hud.streakSub.visible]) expect(overlapB(b, row)).toBe(false);
          for (const k of ['board', 'chain_gauge', 'stock_background', 'win_counter', 'role_logo']) expect(overlapB(b, L.pRect(q, k)), `${p}:${k}${q}`).toBe(false);
        }
      }
      // 自分の側の縦帯（48px）の中
      const strip = chainHudLayout(p).strip;
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(strip.x);
        expect(b.x + b.w).toBeLessThanOrEqual(strip.x + strip.w);
        expect(b.y + b.h).toBeLessThanOrEqual(chainHudLayout(p).roleTitle.visible.y);
      }
    }
  });
});
