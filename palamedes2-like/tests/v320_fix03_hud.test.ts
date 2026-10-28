// V320-FIX-03 連鎖HUDの縦配置・可読性改善：配置定義（chainHud.ts）の座標・寸法・倍率、中心の揃い、帯の内側、
// 他要素（連鎖ゲージ・盤面・受攻撃ストック）との非干渉、数字 0／3／12／19／99／999 の等比収め、SINGLE 倍率、教材の注目枠
import { describe, expect, it } from 'vitest';
import type { PlayerId } from '../src/core/types';
import { CHAIN_HUD, chainFocusBox, chainHudLayout, type Box } from '../src/view/chainHud';
import { GameView } from '../src/view/gameView';
import { numericNaturalWidth } from '../src/view/text';
import type { BitmapFontDef } from '../src/view/bitmapFont';
import { EMPTY, fakeAssets, makeGame, readJson } from './helpers';

const P: PlayerId[] = [0, 1];
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** 縁取り（倍率と同じ px）を含む外接 */
const outlined = (r: Box & { scale: number }): Box => ({ x: r.x - r.scale, y: r.y - r.scale, w: r.w + 2 * r.scale, h: r.h + 2 * r.scale });

describe('V320-FIX-03 連鎖HUD：配置定義（指示書 第4章の表）', () => {
  it('文字本体の位置・寸法・倍率は指示どおり（1P／2P）', () => {
    const exp = {
      0: { role: [8, 130, 32, 32], ren1: [8, 168, 32, 16], up: [8, 258, 32, 16], ren2: [8, 278, 32, 16], cx: 24 },
      1: { role: [600, 130, 32, 32], ren1: [600, 168, 32, 16], up: [600, 258, 32, 16], ren2: [600, 278, 32, 16], cx: 616 },
    } as const;
    for (const p of P) {
      const l = chainHudLayout(p);
      const box = (r: Box) => [r.x, r.y, r.w, r.h];
      expect(l.cx).toBe(exp[p].cx);
      expect(box(l.roleTitle)).toEqual(exp[p].role);
      expect(l.roleTitle.scale).toBe(2);
      expect(l.roleTitle.text).toBe('役');
      expect(box(l.roleSub)).toEqual(exp[p].ren1);
      expect(box(l.streakTitle)).toEqual(exp[p].up);
      expect(box(l.streakSub)).toEqual(exp[p].ren2);
      expect([l.roleSub.text, l.streakTitle.text, l.streakSub.text]).toEqual(['連鎖', '打上', '連鎖']);
      for (const r of [l.roleSub, l.streakTitle, l.streakSub]) expect(r.scale).toBe(1);
      expect(l.roleDigits).toEqual({ cx: exp[p].cx, y: 190, h: 34, maxW: 46 });
      expect(l.plus).toEqual({ cx: exp[p].cx, y: 228, size: 16 });
      expect(l.streakDigits).toEqual({ cx: exp[p].cx, y: 300, h: 17, maxW: 46 });
    }
  });

  it('全行の中心が帯の中心線（x24／x616）に揃い、左右は鏡像でなく同じ縦位置。縁取り込みで帯（48px）の内側', () => {
    const l0 = chainHudLayout(0);
    const l1 = chainHudLayout(1);
    for (const l of [l0, l1]) {
      for (const r of [l.roleTitle, l.roleSub, l.streakTitle, l.streakSub]) {
        expect(r.x + r.w / 2).toBe(l.cx);
        const o = outlined(r);
        expect(o.x).toBeGreaterThanOrEqual(l.strip.x);
        expect(o.x + o.w).toBeLessThanOrEqual(l.strip.x + l.strip.w);
      }
      expect(l.cx - l.roleDigits.maxW / 2).toBeGreaterThanOrEqual(l.strip.x);
      expect(l.cx + l.roleDigits.maxW / 2).toBeLessThanOrEqual(l.strip.x + l.strip.w);
    }
    const ys = (l: typeof l0) => [l.roleTitle.y, l.roleSub.y, l.roleDigits.y, l.plus.y, l.streakTitle.y, l.streakSub.y, l.streakDigits.y];
    expect(ys(l0)).toEqual(ys(l1));
    expect(l1.cx - l0.cx).toBe(592);
  });

  it('行どうし（縁取り込み）が重ならず、上から 役→連鎖→役連鎖数→攻撃加算→打上→連鎖→打上連鎖数 の順', () => {
    for (const p of P) {
      const l = chainHudLayout(p);
      const rows: Box[] = [
        outlined(l.roleTitle),
        outlined(l.roleSub),
        { x: l.cx - 23, y: l.roleDigits.y, w: 46, h: l.roleDigits.h },
        { x: l.cx - 23, y: l.plus.y, w: 46, h: l.plus.size + 4 },
        outlined(l.streakTitle),
        outlined(l.streakSub),
        { x: l.cx - 23, y: l.streakDigits.y, w: 46, h: l.streakDigits.h },
      ];
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].y).toBeGreaterThanOrEqual(rows[i - 1].y + rows[i - 1].h);
        expect(overlap(rows[i], rows[i - 1])).toBe(false);
      }
      // 画面内（下端 360）
      expect(rows.at(-1)!.y + rows.at(-1)!.h).toBeLessThanOrEqual(360);
    }
  });

  it('盤面・連鎖ゲージ・受攻撃ストック・役名ロゴの位置は動かさず、帯と重ならない', () => {
    const L = fakeAssets().layout;
    for (const p of P) {
      const strip = chainHudLayout(p).strip;
      for (const k of ['board', 'chain_gauge', 'stock_background', 'role_logo', 'win_counter']) expect(overlap(strip, L.pRect(p, k)), `${p}:${k}`).toBe(false);
    }
    expect(L.pRect(0, 'chain_gauge')).toMatchObject({ x: 52, y: 168, w: 8, h: 96 });
    expect(L.pRect(0, 'board')).toMatchObject({ x: 64, y: 128, w: 192, h: 224 });
  });

  it('数字 0／3／12／19／99／999：既存S12の等比収め（縦横比を保ち、幅46・高さ上限に収まる。値は省略しない）', () => {
    const A = fakeAssets();
    const fit = (s: string, h: number, maxW: number) => {
      const n = numericNaturalWidth(A, s);
      const k = Math.min(h / 34, maxW / n);
      return { w: Math.round(n * k), h: Math.round(34 * k), k, natural: n };
    };
    const out: Record<string, unknown> = {};
    for (const s of ['0', '3', '12', '19', '99', '999']) {
      const r = fit(s, 34, 46);
      const st = fit(s, 17, 46);
      for (const x of [r, st]) {
        expect(x.w).toBeLessThanOrEqual(46);
        expect(x.w / x.h).toBeCloseTo(x.natural / 34, 1);
      }
      expect(r.h).toBeLessThanOrEqual(34);
      expect(st.h).toBeLessThanOrEqual(17);
      out[s] = { role: `${r.w}×${r.h}`, streak: `${st.w}×${st.h}` };
    }
    // 1桁の役連鎖数は原寸34、2桁は幅46へ等比収め（おおむね24〜27px）、打上連鎖数（17）より小さくならない
    expect((out['3'] as { role: string }).role.endsWith('×34')).toBe(true);
    for (const s of ['12', '19', '99']) {
      const h = Number((out[s] as { role: string }).role.split('×')[1]);
      expect(h).toBeGreaterThanOrEqual(17);
      expect(h).toBeLessThanOrEqual(34);
    }
  });

  it('SINGLE の得点倍率は上部の既存倍率領域［24,94,120,34］へ独立（見出し(24,94) 9px、値 左基準(24,108)・高さ17・幅116）', () => {
    const r = CHAIN_HUD.singleRate;
    const L = fakeAssets().layout;
    expect(r.area).toEqual({ x: 24, y: 94, w: 120, h: 34 });
    expect(L.pRect(0, 'multiplier')).toMatchObject(r.area);
    expect(r.heading).toMatchObject({ x: 24, y: 94, size: 9, text: '得点倍率' });
    expect(r.value).toEqual({ x: 24, y: 108, h: 17, maxW: 116 });
    expect(r.value.y + r.value.h).toBeLessThanOrEqual(r.area.y + r.area.h + 1);
    expect(overlap(r.area, chainHudLayout(0).strip)).toBe(false);
  });

  it('教材の注目枠は同じ定義から：役連鎖（役〜連鎖数）・打上連鎖（打上〜連鎖数）。帯の内側、互いに重ならない', () => {
    const c = chainFocusBox(0, 'chain', false);
    const s = chainFocusBox(0, 'streak', false);
    expect(c).toEqual({ x: 1, y: 130, w: 46, h: 94 });
    expect(s).toEqual({ x: 1, y: 258, w: 46, h: 59 });
    expect(overlap(c, s)).toBe(false);
    expect(chainFocusBox(0, 'chain', true).h).toBe(228 + 16 + 2 - 130);
  });

  it('GameView は同じ定義を返す（描画・検査・教材で座標を重複保有しない）。共通フォントに「役」「連」「鎖」「打」「上」がある', () => {
    const v = new GameView(makeGame({ boards: { 0: EMPTY, 1: EMPTY } }), fakeAssets());
    for (const p of P) expect(v.chainHud(p)).toEqual(chainHudLayout(p));
    const font = readJson<BitmapFontDef>('public/gfx/data/tutorial_font_16.json');
    for (const ch of '役連鎖打上') expect(font.glyphs[ch]?.advance, ch).toBe(16);
  });
});
