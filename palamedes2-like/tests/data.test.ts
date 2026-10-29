import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeManifest } from '../src/view/data';
import { barY, cellX, columnCenterX, Z } from '../src/view/geometry';
import { CARGO_CHECK } from './fixtures';
import { atlas, layout, layoutData, loadingList, manifest, rawManifest, ROOT } from './helpers';

function pngSize(buf: Buffer): [number, number] {
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const gfx = (rel: string) => new URL(`public/gfx/${rel}`, ROOT);

describe('第3版 採用グラフィック（graphics_manifest_v3：14シート＋単独画像35＝49PNG）', () => {
  const raw = rawManifest();
  const list = loadingList();

  it('49枚の実PNGがマニフェストの寸法・SHA-256と一致し、明示読込一覧と過不足なく対応する', () => {
    const entries = [
      ...raw.sheets.map((s) => ({ file: s.file, w: s.w, h: s.h, sha: s.sha256 })),
      ...raw.standalone_assets.map((a) => ({ file: a.file, w: a.dimensions[0], h: a.dimensions[1], sha: (a as unknown as { sha256: string }).sha256 })),
    ];
    expect(entries).toHaveLength(49);
    for (const e of entries) {
      const buf = readFileSync(gfx(e.file));
      expect(pngSize(buf), e.file).toEqual([e.w, e.h]);
      expect(createHash('sha256').update(buf).digest('hex'), e.file).toBe(e.sha);
    }
    const pngs = list.files.filter((f) => f.endsWith('.png'));
    expect([...pngs].sort()).toEqual(entries.map((e) => e.file).sort());
    // 一覧外のPNGを同梱しない（旧版・見本を混ぜない）
    // v3.1.0 追加画像（additional_assets_v310.json の9枚）は共通マニフェストとは別定義で同梱する
    const extra = (JSON.parse(readFileSync(gfx('data/additional_assets_v310.json'), 'utf8')) as { assets: { file: string }[] }).assets.map((a) => a.file);
    const onDisk = [...readdirSync(gfx('assets')).filter((f) => f.endsWith('.png')).map((f) => `assets/${f}`), ...readdirSync(gfx('assets/legacy')).map((f) => `assets/legacy/${f}`)];
    // 遊び方・放置デモ用UI（tutorial_assets.json の3枚）も別定義で同梱する
    const tutorial = (JSON.parse(readFileSync(gfx('data/tutorial_assets.json'), 'utf8')) as { assets: { file: string }[] }).assets.map((a) => a.file);
    // V320-FIX-04 追加画像（v320_fix04_assets.json の9枚）も別定義で同梱する
    const fix04 = (JSON.parse(readFileSync(gfx('data/v320_fix04_assets.json'), 'utf8')) as { assets: { file: string }[] }).assets.map((a) => a.file);
    expect(onDisk.sort()).toEqual([...pngs, ...extra, ...tutorial, ...fix04].sort());
  });

  it('再利用の9シート（S4〜S12）は第2.3版の採用PNGとバイト同一。v3.2.0 で修正を採用した S7・S9 は採用版のハッシュ', () => {
    for (const [id, sha] of Object.entries(CARGO_CHECK.legacySha256)) expect(raw.sheets.find((s) => s.id === id)?.sha256, id).toBe(CARGO_CHECK.v320Sha256[id] ?? sha);
    // 実ファイルもマニフェストの値と一致（S7・S9 は旧版が残っていない）
    for (const id of Object.keys(CARGO_CHECK.v320Sha256)) {
      const sheet = raw.sheets.find((s) => s.id === id)!;
      expect(createHash('sha256').update(readFileSync(gfx(sheet.file))).digest('hex'), id).toBe(CARGO_CHECK.v320Sha256[id]);
    }
  });

  it('明示読込一覧：一覧外の画像は読み込まない（エラー）。フォントは一覧に含まれる', () => {
    expect(list.files).toContain('fonts/NotoSansJP-VF.ttf');
    expect(list.exclude).toEqual(expect.arrayContaining(['previews/**', '*.zip']));
    expect(() => normalizeManifest({ ...raw, sheets: [...raw.sheets, { id: 'X', file: 'assets/old.png', w: 1, h: 1, sha256: '' }] }, list)).toThrow(/loading list/);
  });

  it('全矩形がシート内に収まり、シート内で重複しない', () => {
    const m = manifest();
    for (const f of m.frames) {
      const s = m.sheets.find((x) => x.id === f.sheet)!;
      expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= s.width && f.y + f.h <= s.height, `${f.sheet}/${f.id}`).toBe(true);
    }
    for (const sheet of new Set(m.frames.map((f) => f.sheet))) {
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

  it('キャラ3人（S1 コタロー・S2 アカネ・S13 ずん子）は同じ7モーション30枠・48×56・原点(24,55)。入替ポーズ attack_01', () => {
    const A = atlas();
    const m = manifest();
    for (const sheet of ['S1', 'S2', 'S13']) {
      expect(m.frames.filter((f) => f.sheet === sheet)).toHaveLength(30);
      for (const f of m.frames.filter((x) => x.sheet === sheet)) {
        expect([f.w, f.h]).toEqual([48, 56]);
        expect(f.origin).toEqual([24, 55]);
      }
      const counts = Object.fromEntries(['idle', 'walk', 'launch', 'attack', 'win', 'lose_fall', 'fail_declare'].map((n) => [n, A.animation(sheet, n).length]));
      expect(counts).toEqual({ idle: 4, walk: 4, launch: 4, attack: 4, win: 6, lose_fall: 4, fail_declare: 4 });
      expect(() => A.frame(sheet, 'attack_01')).not.toThrow();
      // 推奨時間（マニフェスト記載）：待機220・移動90・発射70・攻撃110・勝利140・敗北160、失敗110/120/180/150
      expect(m.recommended_timing?.[`${sheet}/lose_fall`]?.durations_ms).toEqual([160, 160, 160, 160]);
      expect(m.recommended_timing?.[`${sheet}/fail_declare`]?.durations_ms).toEqual([110, 120, 180, 150]);
    }
    expect((rawManifest() as unknown as { swap_pose_alias: Record<string, string> }).swap_pose_alias).toEqual({ S1: 'attack_01', S2: 'attack_01', S13: 'attack_01' });
  });

  it('ネコタロー（S3）：8アニメーション、クラッカー4コマ×220ms', () => {
    const A = atlas();
    for (const name of ['idle', 'ready', 'start', 'cracker', 'joy', 'surprise', 'panic', 'sad']) expect(A.animation('S3', name).length).toBeGreaterThan(0);
    expect(A.animation('S3', 'cracker')).toHaveLength(4);
    expect(manifest().recommended_timing?.['S3/cracker']?.durations_ms).toEqual([220, 220, 220, 220]);
  });

  it('受攻撃ストック素材：大16×16・小8×8（XD顔あり）、処理中枠22×22、小爆発4コマ（24×24・12×12）、反射光3コマ32×32', () => {
    const A = atlas();
    for (const [id, w] of [['attack_stock_nekotaro_large', 16], ['attack_stock_nekotaro_large_xd', 16], ['attack_stock_nekotaro_small', 8], ['attack_stock_nekotaro_small_xd', 8], ['attack_stock_active_frame', 22], ['attack_stock_active_frame_bright', 22]] as const)
      expect(A.frame(id, '0')).toMatchObject({ w, h: w });
    for (let i = 0; i < 4; i++) {
      expect(A.frame('attack_stock_cancel_burst_sheet', String(i))).toMatchObject({ x: 24 * i, w: 24, h: 24 });
      expect(A.frame('attack_stock_cancel_burst_small_sheet', String(i))).toMatchObject({ x: 12 * i, w: 12, h: 12 });
    }
    for (let i = 0; i < 3; i++) expect(A.frame('role_piece_reflection_sheet', String(i))).toMatchObject({ x: 32 * i, w: 32, h: 32 });
  });

  it('描画で使う全フレームIDがマニフェストに存在する（S4〜S12の既存IDを含む）', () => {
    const A = atlas();
    let i = 0;
    for (const n of [1, 2, 3, 4, 5, 6])
      for (const suit of ['spade', 'diamond', 'club', 'heart'] as const) {
        expect(A.piece(n, suit)).toMatchObject({ x: (i % 8) * 32, y: Math.floor(i / 8) * 32, w: 32, h: 32 });
        expect(A.piece(n, suit, true)).toMatchObject({ w: 24, h: 24 });
        i++;
      }
    for (let r = 0; r < 16; r++) for (const fr of ['A', 'B', 'C'] as const) expect(A.role(r, fr)).toMatchObject({ w: 160, h: 64 });
    for (const id of ['base_piece_frame', 'win_count_frame_3', 'win_count_slot_empty', 'win_count_slot_fill', 'win_count_slot_flash']) expect(() => A.frame('S5', id)).not.toThrow();
    for (const id of ['launch_fx_1', 'hit_base_fx_1', 'bounce_fx_1', 'return_fx_1', 'line_send_fx_1', 'vanish_fx_1']) expect(() => A.frame('S6', id)).not.toThrow();
    const banners = ['ready', 'go', 'win', 'lose', 'draw', 'result', 'game_over', 'stage_clear', 'all_clear', 'level_up', 'max', 'all_stages_complete', 'countdown_3', 'countdown_2', 'countdown_1'];
    for (const b of banners) for (const ph of ['A', 'B', 'C']) expect(() => A.frame('S9', `show_${b}_${ph}`)).not.toThrow();
    for (const name of ['card_refresh', 'line_clear', 'danger_border']) expect(A.animation('S10', name).length).toBeGreaterThan(0);
    for (const id of ['timer_fill_safe', 'timer_fill_warn', 'timer_fill_danger']) expect(() => A.frame('S11', id)).not.toThrow();
    for (const ph of ['A', 'B', 'C']) for (const ch of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'times', 'dot']) expect(() => A.frame('S12', `display_${ch}_${ph}`)).not.toThrow();
    for (const id of ['arrow_left', 'arrow_right', 'slider_rail', 'slider_fill', 'slider_knob', 'keycap', 'pad_button', 'dpad', 'left_stick', 'input_waiting']) expect(() => A.frame('CTRL', id)).not.toThrow();
    const single = ['background_common', 'board_frame_mode2', 'count_panel', 'stock_frame', 'info_panel', 'player_frame_p1', 'player_frame_p2', 'reading_panel', 'dialog_panel', 'menu_item_normal', 'menu_item_selected', 'options_row_normal', 'options_row_selected', 'title_logo', 'title_kotaro_nekotaro', 'input_hint', 'cursor_1p_focus', 'cursor_2p_focus', 'selection_locked'];
    for (const c of ['kotaro', 'akane', 'zunko']) single.push(`menu_${c}`, `icon_${c}`);
    for (const id of single) expect(() => A.frame(id, id)).not.toThrow();
    expect(A.frame('menu_kotaro', 'menu_kotaro').origin).toEqual([72, 167]);
    expect(A.frame('title_kotaro_nekotaro', 'title_kotaro_nekotaro').origin).toEqual([108, 287]);
  });

  it('フォントの許諾文（OFL）とデータ（font_styles・credits_text）を同梱。フォント本体はビルド時に配置する（gitには含めない）', () => {
    expect(existsSync(gfx('fonts/OFL.txt'))).toBe(true);
    const fs = JSON.parse(readFileSync(gfx('data/font_styles.json'), 'utf8'));
    expect(fs).toMatchObject({ family: 'Noto Sans JP', file: 'fonts/NotoSansJP-VF.ttf', body: { size: 12, weight: 600 }, heading: { size: 18, weight: 700 } });
    const cr = JSON.parse(readFileSync(gfx('data/credits_text.json'), 'utf8'));
    expect(Object.keys(cr.links)).toEqual(['YouTube', 'X', 'SUNO']);
  });
});

describe('画面座標（screen_layout_v2.json：盤面・ストック・UI座標は変更しない）', () => {
  const L = layout();

  it('論理640×360、盤面6列×7段・32pxセル', () => {
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

  it('盤面枠：player_frame の内側に盤面（1P (16,8)、2P (8,8)）。MODE1役ストック／MODE2残数は (64,32)／(384,32)', () => {
    const vf1 = L.rect('p1_visual_frame');
    const vf2 = L.rect('p2_visual_frame');
    expect([L.pRect(0, 'board').x - vf1.x, L.pRect(0, 'board').y - vf1.y]).toEqual([16, 8]);
    expect([L.pRect(1, 'board').x - vf2.x, L.pRect(1, 'board').y - vf2.y]).toEqual([8, 8]);
    expect((rawManifest() as unknown as { shared_stock_count_regions: unknown }).shared_stock_count_regions).toEqual({ p1: [64, 32, 192, 32], p2: [384, 32, 192, 32] });
    expect(L.pRect(0, 'stock_background')).toMatchObject({ x: 64, y: 32, w: 192, h: 32 });
    expect(L.pRect(1, 'stock_background')).toMatchObject({ x: 384, y: 32, w: 192, h: 32 });
  });

  it('キャラ列中心X：1P 80〜240、2P 400〜560。足場Yは7段で盤面上端', () => {
    const b1 = L.pRect(0, 'board');
    const b2 = L.pRect(1, 'board');
    expect([0, 1, 2, 3, 4, 5].map((c) => columnCenterX(b1, c))).toEqual([80, 112, 144, 176, 208, 240]);
    expect([0, 1, 2, 3, 4, 5].map((c) => columnCenterX(b2, c))).toEqual([400, 432, 464, 496, 528, 560]);
    expect(barY(b1, 3)).toBe(256);
    expect(barY(b1, 7)).toBe(128);
  });

  it('主要UI座標', () => {
    expect(L.rect('base_frame')).toMatchObject({ x: 294, y: 40, w: 48, h: 48 });
    expect(L.rect('base_piece')).toMatchObject({ x: 302, y: 48, w: 32, h: 32 });
    expect(L.rect('mascot')).toMatchObject({ x: 298, y: 296 });
    expect(L.rect('ready_banner')).toMatchObject({ x: 240, y: 144, w: 160, h: 64 });
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
