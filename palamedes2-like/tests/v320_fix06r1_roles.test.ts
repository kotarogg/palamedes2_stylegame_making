// V320-FIX-06-R1 第2項：役一覧のオールマーク・フラッシュを4個／6個の副ページに分け、両方の実例と消去数・基本攻撃数を表示
import { describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { AudioBus } from '../src/audio/audioBus';
import { evaluateSubset } from '../src/core/roles';
import { pieceKind, TUTORIAL_SCRIPT } from '../src/demo/lesson';
import { PANEL } from '../src/demo/panel';
import { RoleListScene } from '../src/demo/scenes';
import { defaultSettings } from '../src/input/settings';
import { measureBitmap, uncovered, type BitmapFontDef } from '../src/view/bitmapFont';
import { fakeAssets, readJson } from './helpers';

const font = readJson<BitmapFontDef>('public/gfx/data/tutorial_font_16.json');
const nav = (key: string) => ({ key, repeat: false, source: { kind: 'keyboard' } }) as never;
const app = () =>
  new App({
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

describe('役一覧の副ページ（4個／6個）', () => {
  it('右送りで16役・18ページ（オールマーク・フラッシュは4個→6個）。各ページの実例・消去・基本攻撃は本体の数値表', () => {
    const sc = new RoleListScene(app(), () => undefined);
    const pages: string[] = [];
    for (let i = 0; i < 18; i++) {
      const v = sc.info();
      const role = TUTORIAL_SCRIPT.role_list.roles[sc.index];
      pages.push(`${role.name}:${v.pieces}個:${v.clear}/${v.attack}:${sc.counter()}`);
      sc.onNav(nav('right'));
    }
    expect([sc.index, sc.sub]).toEqual([0, 0]); // 一周して先頭へ
    expect(pages.slice(11, 15)).toEqual([
      'オールマーク:4個:2/2:12/16・1/2',
      'オールマーク:6個:3/3:12/16・2/2',
      'フラッシュ:4個:3/2:13/16・1/2',
      'フラッシュ:6個:4/3:13/16・2/2',
    ]);
    expect(pages[0]).toBe('フォーカード:4個:2/2:1/16');
    expect(pages).toHaveLength(18);
  });

  it('左送りは前の役の最後の副ページへ（フラッシュ1/2 → オールマーク2/2 → オールマーク1/2）', () => {
    const sc = new RoleListScene(app(), () => undefined);
    for (let i = 0; i < 13; i++) sc.onNav(nav('right')); // フラッシュ 1/2
    expect(sc.counter()).toBe('13/16・1/2');
    sc.onNav(nav('left'));
    expect(sc.counter()).toBe('12/16・2/2');
    sc.onNav(nav('left'));
    expect(sc.counter()).toBe('12/16・1/2');
  });

  it('6個の実例は6個全体でその属性役だけが成立（数字役なし）し、役名ロゴは同じ1つ', () => {
    for (const [i, logo] of [
      [11, 11],
      [12, 12],
    ] as const) {
      const role = TUTORIAL_SCRIPT.role_list.roles[i] as unknown as { variants: { condition: string[]; example: string[] }[] };
      expect(role.variants.map((v) => v.example.length)).toEqual([4, 6]);
      const r = evaluateSubset(role.variants[1].example.map((c, k) => ({ id: k + 1, ...pieceKind(c) })));
      expect([r.size, r.numberRole, r.suitRole]).toEqual([6, null, i === 11 ? 'all_mark' : 'flush']);
      const sc = new RoleListScene(app(), () => undefined);
      while (sc.index !== i) sc.onNav(nav('right'));
      sc.onNav(nav('right'));
      expect(sc.info().logos).toEqual([logo]);
    }
  });

  it('既存の領域・素材で表示（追加文字なし）：条件・ページ表示はすべて収録字、本文は4行以内、ページ表示は見出しと重ならない幅', () => {
    for (const i of [11, 12]) {
      const role = TUTORIAL_SCRIPT.role_list.roles[i] as unknown as { category: string; variants: { condition: string[] }[] };
      for (const v of role.variants) {
        expect(v.condition.length + 2).toBeLessThanOrEqual(PANEL.body.maxLines); // 条件＋消去＋基本攻撃
        for (const l of v.condition) {
          expect(uncovered(font, l)).toEqual([]);
          expect(measureBitmap(font, l)).toBeLessThanOrEqual(PANEL.body.w);
        }
      }
      const cat = TUTORIAL_SCRIPT.role_list.categories[role.category as 'suit'];
      for (const c of [`${i + 1}/16・1/2`, `${i + 1}/16・2/2`]) {
        expect(uncovered(font, c)).toEqual([]);
        expect(measureBitmap(font, cat) + 8 + measureBitmap(font, c)).toBeLessThanOrEqual(PANEL.heading.w);
      }
    }
  });
});
