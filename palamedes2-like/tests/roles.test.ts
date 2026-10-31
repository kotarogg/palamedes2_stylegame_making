import { describe, expect, it } from 'vitest';
import { compareCandidates, evaluateStock, evaluateSubset, fourSubsets, glowSegments, roleLogoIndices, type StockEvaluation } from '../src/core/roles';
import { pushRoleStock, ROLE_STOCK_MAX } from '../src/core/stock';
import type { Piece } from '../src/core/types';
import { kind } from './helpers';

// V320-FIX-06：旧「翻数＝消去数」を廃止し、消去数（clear）・基本攻撃数（baseAttack）は数値表（src/core/roleTable.ts）の値。
// 旧期待値（翻数）は新しい表の値へ置換した。成立条件・最強1種・同一部分集合評価・6個全体優先の検査は維持

let id = 1;
const ps = (...codes: string[]): Piece[] => codes.map((c) => ({ id: id++, ...kind(c) }));

const ok = (e: StockEvaluation) => {
  if (e.kind !== 'ok') throw new Error(`expected ok, got ${e.kind}`);
  return e.result;
};

describe('役ストック', () => {
  it('最大6個、7個目で最古を破棄して左詰め・右端へ追加', () => {
    let stock: Piece[] = [];
    const all = ps('1s', '2s', '3s', '4s', '5s', '6s', '1h');
    for (const p of all.slice(0, 6)) stock = pushRoleStock(stock, p).stock;
    expect(stock).toHaveLength(ROLE_STOCK_MAX);
    const r = pushRoleStock(stock, all[6]);
    expect(r.discarded).toBe(all[0]);
    expect(r.stock.map((p) => p.id)).toEqual(all.slice(1).map((p) => p.id));
  });
});

describe('数字役', () => {
  it.each([
    [['3s', '3d', '3s', '3d'], 'four_card', 2, 2],
    [['2s', '2d', '5s', '5d'], 'nikoniko', 2, 2],
    [['1s', '2d', '3s', '4d'], 'straight', 2, 2],
    [['3s', '4d', '5s', '6d'], 'straight', 2, 2],
    [['2s', '3d', '4s', '5d'], 'high_straight', 3, 3],
  ])('%j → %s (消去%i／基本攻撃%i)', (codes, role, clear, attack) => {
    const r = evaluateSubset(ps(...codes));
    expect(r.numberRole).toBe(role);
    expect(r.suitRole).toBeNull();
    expect([r.clear, r.baseAttack]).toEqual([clear, attack]);
  });

  it.each([
    [['4s', '4d', '4s', '4d', '4s', '4d'], 'full_card'],
    [['1s', '1d', '1s', '6d', '6s', '6d'], 'nikoniko_niko'],
    [['1s', '2d', '3s', '4d', '5s', '6d'], 'super_straight'],
  ])('6個役 %j → %s (消去4／基本攻撃5)', (codes, role) => {
    const r = evaluateSubset(ps(...codes));
    expect(r.numberRole).toBe(role);
    expect([r.clear, r.baseAttack]).toEqual([4, 5]);
  });

  it('役判定に1↔6の循環連番を追加しない（5612 等は不成立）', () => {
    expect(evaluateSubset(ps('5s', '6d', '1c', '2h')).numberRole).toBeNull();
    expect(evaluateSubset(ps('6s', '1d', '2c', '3h')).numberRole).toBeNull();
  });

  it('同数字3個＋1個やペア1組は不成立', () => {
    expect(evaluateSubset(ps('2s', '2d', '2c', '5h')).numberRole).toBeNull();
    expect(evaluateSubset(ps('2s', '2d', '4c', '5h')).numberRole).toBeNull();
  });
});

describe('属性役', () => {
  it('同色統一（赤♦♥/黒♠♣）：4個＝消去2／攻撃1、6個＝消去3／攻撃2', () => {
    expect(evaluateSubset(ps('1d', '3h', '5d', '6h'))).toMatchObject({ suitRole: 'same_color', color: 'red', clear: 2, baseAttack: 1 });
    expect(evaluateSubset(ps('1s', '3c', '5s', '1c', '2s', '4c'))).toMatchObject({ suitRole: 'same_color', color: 'black', clear: 3, baseAttack: 2 });
  });
  it('オールマーク4個2／2・フラッシュ4個3／2、複数成立時は最強1種のみ', () => {
    expect(evaluateSubset(ps('1s', '3d', '5c', '6h'))).toMatchObject({ suitRole: 'all_mark', clear: 2, baseAttack: 2 });
    // フラッシュは同色統一も満たすが、最強のフラッシュ1種だけ採用（同色統一を重ねない）
    expect(evaluateSubset(ps('1h', '3h', '5h', '6h'))).toMatchObject({ suitRole: 'flush', color: null, clear: 3, baseAttack: 2 });
  });
  it('属性役単独でも有効', () => {
    expect(ok(evaluateStock(ps('1s', '3d', '5c', '6h'))).clear).toBe(2);
  });
});

describe('複合役（複合表の値・二重加算禁止）', () => {
  it.each([
    [['1h', '2h', '3h', '4h'], 4, 4, [13]],
    [['2s', '3s', '4s', '5s'], 5, 5, [14]],
    [['1d', '2d', '3d', '4d', '5d', '6d'], 6, 8, [15]],
  ])('%j → 消去%i／基本攻撃%i 表示R%j', (codes, clear, attack, logos) => {
    const r = ok(evaluateStock(ps(...codes)));
    expect([r.clear, r.baseAttack]).toEqual([clear, attack]);
    expect(roleLogoIndices(r)).toEqual(logos);
  });

  it('専用ロゴのない複合は数字役→属性役の順で表示（確定）', () => {
    const r = ok(evaluateStock(ps('3s', '3c', '3s', '3c')));
    expect(r).toMatchObject({ numberRole: 'four_card', suitRole: 'same_color', color: 'black', clear: 3, baseAttack: 3 });
    expect(roleLogoIndices(r)).toEqual([0, 7]);
  });

  it('同色統一の表示名は4個/6個・赤/黒で R08〜R11', () => {
    expect(roleLogoIndices(evaluateSubset(ps('1s', '3c', '5s', '1c')))).toEqual([7]);
    expect(roleLogoIndices(evaluateSubset(ps('1d', '3h', '5d', '1h')))).toEqual([8]);
    expect(roleLogoIndices(evaluateSubset(ps('1s', '3c', '5s', '1c', '2s', '4c')))).toEqual([9]);
    expect(roleLogoIndices(evaluateSubset(ps('1d', '3h', '5d', '1h', '2d', '4h')))).toEqual([10]);
    expect(roleLogoIndices(evaluateSubset(ps('1s', '3d', '5c', '6h')))).toEqual([11]);
    expect(roleLogoIndices(evaluateSubset(ps('1s', '3s', '5s', '6s')))).toEqual([12]);
  });
});

describe('部分集合評価', () => {
  it('5個は5通り、6個は15通りの4個部分集合', () => {
    expect(fourSubsets([1, 2, 3, 4, 5])).toHaveLength(5);
    expect(fourSubsets([1, 2, 3, 4, 5, 6])).toHaveLength(15);
    expect(new Set(fourSubsets([1, 2, 3, 4, 5, 6]).map((s) => s.join())).size).toBe(15);
  });

  it('5個：最強の4個部分集合を採択', () => {
    // 2345♠ のハイストレートフラッシュ（消去5／攻撃5）が含まれる
    const r = ok(evaluateStock(ps('2s', '3s', '6d', '4s', '5s')));
    expect([r.clear, r.baseAttack]).toEqual([5, 5]);
    expect(r.subset.map((p) => `${p.n}${p.suit[0]}`).sort()).toEqual(['2s', '3s', '4s', '5s']);
  });

  it('数字役と属性役は同一部分集合で評価し、別部分集合の結果を合成しない', () => {
    // {2h,3h,4h,5c}=ハイストレート（属性ばらばら）消去3／攻撃3、{2h,3h,4h,6h}=フラッシュ4個（数字役なし）消去3／攻撃2。
    // 合成すればハイストレートフラッシュ（5／5）だが、正しくは単一部分集合の最強。
    // V320-FIX-06：消去数が同じ3なので基本攻撃数で比べ、ハイストレート（攻撃3）を採択（旧仕様ではフラッシュ3翻）
    const stock = ps('2h', '3h', '4h', '5c', '6h');
    const e = evaluateStock(stock);
    const r = ok(e);
    expect([r.clear, r.baseAttack]).toEqual([3, 3]);
    expect(r.numberRole).toBe('high_straight');
    expect(r.suitRole).toBeNull();
    // 合成していないことの確認：どの単一部分集合も消去5にならない
    expect(Math.max(...fourSubsets(stock).map((s) => evaluateSubset(s).clear))).toBe(3);
  });

  it('6個：6個全体で成立する役を優先（確定：4個部分集合の方が強くても6個役）', () => {
    // 全体：オールブラック（3／2）。4個部分集合 {1s,1c,1s,1c} はフォーカード＋黒統一（3／3）だが6個役を優先
    const r = ok(evaluateStock(ps('1s', '1c', '1s', '1c', '1s', '2c')));
    expect(r.size).toBe(6);
    expect(r).toMatchObject({ suitRole: 'same_color', numberRole: null, clear: 3, baseAttack: 2 });
  });

  it('6個：6個役が無ければ15通りから最強', () => {
    const r = ok(evaluateStock(ps('2s', '3s', '4s', '5s', '1d', '1h')));
    expect(r.size).toBe(4);
    expect([r.clear, r.baseAttack]).toEqual([5, 5]);
  });

  it('無役は no_role', () => {
    expect(evaluateStock(ps('1s', '1d', '2s', '4d')).kind).toBe('no_role');
  });

  it('V320-FIX-06：消去数が同じなら基本攻撃数が多い候補を採択', () => {
    // {1s,1s,1d,1d}=フォーカード（2／2） と {1s,1s,3s,5c}=フォーブラック（2／1）
    const r = ok(evaluateStock(ps('1s', '1s', '1d', '1d', '3s', '5c')));
    expect(r).toMatchObject({ numberRole: 'four_card', suitRole: null, clear: 2, baseAttack: 2 });
    expect(r.indices).toEqual([0, 1, 2, 3]);
  });

  it('V320-FIX-06：消去数・基本攻撃数も同じなら数字役の従来の強さ（フォーカード 2／2 ＞ オールマーク4個 2／2）', () => {
    const four = evaluateSubset(ps('3s', '3d', '3s', '3d'));
    const mark = evaluateSubset(ps('1s', '3d', '5c', '6h'));
    expect([four.clear, four.baseAttack]).toEqual([mark.clear, mark.baseAttack]);
    expect(compareCandidates(four, mark)).toBeLessThan(0);
    expect(compareCandidates(mark, four)).toBeGreaterThan(0);
  });

  it('同点（確定）：数字役の従来の強さも同じなら役一覧の掲載順（R01フォーカード→R02ニコニコ）', () => {
    // 6個全体は役なし。{1,1,1,1}=フォーカード（2／2） と {1,1,2,2}=ニコニコ（2／2）
    const r = ok(evaluateStock(ps('1s', '1d', '2s', '1s', '1d', '2d')));
    expect(r.numberRole).toBe('four_card');
    expect(r.indices).toEqual([0, 1, 3, 4]);
  });

  it('同点（確定）：属性役どうしは掲載順（同色統一 黒R08→赤R09→オールマーク→フラッシュ）', () => {
    const black = evaluateSubset(ps('1s', '3c', '5s', '6c'));
    const red = evaluateSubset(ps('1d', '3h', '5d', '6h'));
    expect([black.clear, black.baseAttack]).toEqual([red.clear, red.baseAttack]);
    expect(compareCandidates(black, red)).toBeLessThan(0);
    expect(compareCandidates(red, black)).toBeGreaterThan(0);
  });

  it('全組合せ評価：採択する4個はストック上で連続している必要がない', () => {
    // 1234ストレート＋同色統一（黒）を飛び飛びの位置から採択
    const r = ok(evaluateStock(ps('1s', '6d', '2c', '3s', '4c')));
    expect(r.numberRole).toBe('straight');
    expect(r.indices).toEqual([0, 2, 3, 4]);
  });

  it('成立光の区間：採択位置を連続区間に分割（12234 の位置1・2・4・5 → 開始1と4の2枠用×2）', () => {
    // 「12234」は 1始まりの位置表記。内部は0始まり [0,1,3,4]
    expect(glowSegments([0, 1, 3, 4])).toEqual([
      { start: 0, length: 2 },
      { start: 3, length: 2 },
    ]);
    expect(glowSegments([0, 1, 2, 3, 4, 5])).toEqual([{ start: 0, length: 6 }]);
    expect(glowSegments([5, 0, 2, 4])).toEqual([
      { start: 0, length: 1 },
      { start: 2, length: 1 },
      { start: 4, length: 2 },
    ]);
  });

  it('4個未満は宣言不可', () => {
    expect(evaluateStock(ps('1s', '2s', '3s')).kind).toBe('too_few');
  });
});
