import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layoutAttackIcons } from '../src/core/attack';
import { barY, cellX, columnCenterX, Z } from '../src/view/geometry';
import { atlas, layout, layoutData, manifest, ROOT } from './helpers';

function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('仮スプライトシート7枚とマニフェスト', () => {
  const m = manifest();

  it('7枚の実PNGがマニフェストの寸法・SHA-256と一致', () => {
    expect(m.sheets.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    for (const s of m.sheets) {
      const buf = readFileSync(new URL(`public/assets/sprites/${s.file}`, ROOT));
      expect(pngSize(buf), s.file).toEqual([s.width, s.height]);
      expect(createHash('sha256').update(buf).digest('hex'), s.file).toBe(s.sha256);
    }
  });

  it('302矩形（v2.1：役成立光16追加）がすべてシート内に収まり、シート内で重複しない', () => {
    expect(m.frames).toHaveLength(302);
    const counts: Record<string, number> = {};
    for (const f of m.frames) {
      const s = m.sheets.find((x) => x.id === f.sheet)!;
      expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= s.width && f.y + f.h <= s.height, `${f.sheet}/${f.id}`).toBe(true);
      counts[f.sheet] = (counts[f.sheet] ?? 0) + 1;
    }
    expect(counts).toEqual({ S1: 30, S2: 30, S3: 25, S4: 48, S5: 69, S6: 52, S7: 48 });
    for (const sheet of Object.keys(counts)) {
      const fs = m.frames.filter((f) => f.sheet === sheet);
      for (let i = 0; i < fs.length; i++)
        for (let j = i + 1; j < fs.length; j++) {
          const a = fs[i];
          const b = fs[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${sheet}: ${a.id} / ${b.id}`).toBe(false);
        }
    }
  });

  it('S1/S2 は48×56・slot式どおり。予備枠は通常アニメーションに含めない', () => {
    const A = atlas();
    for (const sheet of ['S1', 'S2']) {
      for (const f of m.frames.filter((x) => x.sheet === sheet)) {
        expect([f.x, f.y, f.w, f.h]).toEqual([(f.slot! % 5) * 48, Math.floor(f.slot! / 5) * 56, 48, 56]);
      }
      for (const name of ['idle', 'walk', 'launch', 'attack', 'win', 'lose_fall'])
        expect(A.animation(sheet, name).every((f) => !f.reserved)).toBe(true);
      expect(A.animation(sheet, 'attack').map((f) => f.slot)).toEqual([12, 13, 14, 15]);
      expect(A.animation(sheet, 'reserved')).toEqual([]);
    }
  });

  it('S4：通常32×32は(0,0)起点、小型24×24は Y=96 起点、数字昇順・♠♦♣♥', () => {
    const A = atlas();
    let i = 0;
    for (const n of [1, 2, 3, 4, 5, 6])
      for (const suit of ['spade', 'diamond', 'club', 'heart'] as const) {
        expect(A.piece(n, suit)).toMatchObject({ x: (i % 8) * 32, y: Math.floor(i / 8) * 32, w: 32, h: 32 });
        expect(A.piece(n, suit, true)).toMatchObject({ x: (i % 8) * 24, y: 96 + Math.floor(i / 8) * 24, w: 24, h: 24 });
        i++;
      }
  });

  it('S7：16役×A/B/C、1枠160×64、役ブロック式どおり', () => {
    const A = atlas();
    for (let i = 0; i < 16; i++)
      (['A', 'B', 'C'] as const).forEach((fr, k) => {
        expect(A.role(i, fr)).toMatchObject({ x: (i % 4) * 160, y: Math.floor(i / 4) * 192 + 64 * k, w: 160, h: 64 });
      });
  });

  it('描画で使う全フレームIDがマニフェストに存在する', () => {
    const A = atlas();
    const s5 = ['panel_fill_dark', 'panel_edge_h', 'panel_edge_v', 'panel_corner_tl', 'panel_corner_tr', 'panel_corner_bl', 'panel_corner_br', 'multiplier_panel', 'chain_bar_frame', 'win_count_frame_3', 'p1_badge', 'p2_badge', 'base_piece_frame', 'attack_icon_big', 'attack_icon_small', 'banner_ready', 'banner_go'];
    for (const id of s5) expect(() => A.frame('S5', id)).not.toThrow();
    const s6 = ['launch_fx_1', 'launch_fx_4', 'hit_base_fx_1', 'hit_base_fx_2', 'bounce_fx_1', 'bounce_fx_3', 'return_fx_1', 'return_fx_2'];
    for (const size of [4, 6]) for (const k of ['back', 'front']) for (const ab of ['a', 'b']) s6.push(`role_glow_${size}_${k}_${ab}`);
    for (const id of s6) expect(() => A.frame('S6', id)).not.toThrow();
    for (const name of ['idle', 'ready', 'start', 'joy', 'panic']) expect(A.animation('S3', name).length).toBeGreaterThan(0);
  });
});

describe('画面座標（screen_layout_v2.json revision 2.1）', () => {
  const L = layout();

  it('論理640×360、盤面6列×7段・32pxセル', () => {
    expect(layoutData().revision).toBe('2.1');
    expect(layoutData().canvas).toEqual({ w: 640, h: 360 });
    for (const p of [0, 1] as const) {
      const b = L.pRect(p, 'board');
      expect([b.w, b.h]).toEqual([192, 224]);
      for (let r = 0; r < 7; r++)
        for (let c = 0; c < 6; c++) {
          const cell = L.rect(`p${p + 1}_cell_r${r}_c${c}`);
          expect([cell.x, cell.y]).toEqual([cellX(b, c), b.y + 32 * r]);
        }
    }
    expect(L.pRect(0, 'board')).toMatchObject({ x: 64, y: 128 });
    expect(L.pRect(1, 'board')).toMatchObject({ x: 384, y: 128 });
  });

  it('キャラ列中心X：1P 80〜240、2P 400〜560。足場Yは7段で盤面上端', () => {
    const b1 = L.pRect(0, 'board');
    const b2 = L.pRect(1, 'board');
    expect([0, 1, 2, 3, 4, 5].map((c) => columnCenterX(b1, c))).toEqual([80, 112, 144, 176, 208, 240]);
    expect([0, 1, 2, 3, 4, 5].map((c) => columnCenterX(b2, c))).toEqual([400, 432, 464, 496, 528, 560]);
    expect(barY(b1, 3)).toBe(256);
    expect(barY(b1, 7)).toBe(128);
  });

  it('主要UI座標（統合仕様12.2）', () => {
    expect(L.rect('base_frame')).toMatchObject({ x: 294, y: 40, w: 48, h: 48 });
    expect(L.rect('base_piece')).toMatchObject({ x: 302, y: 48, w: 32, h: 32 });
    expect(L.rect('mascot')).toMatchObject({ x: 298, y: 296 });
    expect(L.rect('ready_banner')).toMatchObject({ x: 272, y: 144, w: 96, h: 32 });
    expect(L.rect('go_banner')).toMatchObject({ x: 288, y: 144, w: 64, h: 32 });
    for (let i = 0; i < 6; i++) {
      expect(L.pRect(0, `stock_${i}`)).toMatchObject({ x: 66 + 24 * i, y: 36, w: 24, h: 24 });
      expect(L.pRect(1, `stock_${i}`)).toMatchObject({ x: 386 + 24 * i, y: 36, w: 24, h: 24 });
    }
    expect(L.pRect(0, 'role_logo')).toMatchObject({ x: 120, y: 34, w: 160, h: 64 });
    expect(L.pRect(1, 'role_logo')).toMatchObject({ x: 360, y: 34, w: 160, h: 64 });
  });

  it('描画レイヤー値が画面JSONと一致し、キャラ/役名＜帰還＜打上げ、B暗色＜通常、UI50＜背面光55＜キャラ60＜前面光65', () => {
    const zs = layoutData().layers.map((l) => l.z);
    expect(Object.values(Z).sort((a, b) => a - b)).toEqual([...zs].sort((a, b) => a - b));
    expect(Z.character < Z.returning && Z.roleName < Z.returning && Z.returning < Z.launching).toBe(true);
    expect(Z.darkPiece < Z.piece).toBe(true);
    expect(Z.ui < Z.glowBack && Z.glowBack < Z.character && Z.character < Z.glowFront).toBe(true);
  });
});

describe('攻撃アイコン表示 0〜29（左5・右4、大2・小9）', () => {
  const L = layout();
  const rules = L.attackRules();

  it('全30状態の個数・配置・下端', () => {
    for (const p of [0, 1] as const) {
      const [ox, oy] = L.attackOrigin(p);
      expect([ox, oy]).toEqual(p === 0 ? [256, 128] : [352, 128]);
      for (let n = 0; n <= 29; n++) {
        const r = layoutAttackIcons(n, [ox, oy], rules);
        expect(r.big).toHaveLength(Math.floor(n / 10));
        expect(r.small).toHaveLength(n % 10);
        r.big.forEach((b, i) => expect(b).toEqual({ x: ox, y: oy + 32 * i }));
        r.small.forEach((s, i) => {
          const left = i < 5;
          expect(s.x).toBe(ox + (left ? 0 : 16));
          expect(s.y).toBe(oy + 32 * r.big.length + 16 * (left ? i : i - 5));
        });
        const bottom = Math.max(oy, ...r.big.map((b) => b.y + 24), ...r.small.map((s) => s.y + 16));
        expect(bottom).toBeLessThanOrEqual(272);
        // 盤面と重ならない（1P盤面右端256以上、2P盤面左端384以下）
        const right = Math.max(...r.big.map((b) => b.x + 24), ...r.small.map((s) => s.x + 16), ox);
        expect(ox >= 256 && right <= 384).toBe(true);
      }
    }
  });

  it('15ラインは大1＋左列小5、29ラインは大2＋小9で下端272', () => {
    const r15 = layoutAttackIcons(15, [256, 128], rules);
    expect(r15.big).toHaveLength(1);
    expect(r15.small.map((s) => s.x)).toEqual([256, 256, 256, 256, 256]);
    const r29 = layoutAttackIcons(29, [256, 128], rules);
    expect(r29.big).toHaveLength(2);
    expect(r29.small).toHaveLength(9);
    expect(Math.max(...r29.small.map((s) => s.y + 16))).toBe(272);
  });
});
