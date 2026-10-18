import { describe, expect, it } from 'vitest';
import { evaluateStock, evaluateSubset, fourSubsets, roleLogoIndices, type StockEvaluation } from '../src/core/roles';
import { pushRoleStock, ROLE_STOCK_MAX } from '../src/core/stock';
import type { Piece } from '../src/core/types';
import { kind } from './helpers';

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
    [['3s', '3d', '3s', '3d'], 'four_card', 1],
    [['2s', '2d', '5s', '5d'], 'nikoniko', 1],
    [['1s', '2d', '3s', '4d'], 'straight', 1],
    [['3s', '4d', '5s', '6d'], 'straight', 1],
    [['2s', '3d', '4s', '5d'], 'high_straight', 2],
  ])('%j → %s (%i翻)', (codes, role, han) => {
    const r = evaluateSubset(ps(...codes));
    expect(r.numberRole).toBe(role);
    expect(r.suitRole).toBeNull();
    expect(r.han).toBe(han);
  });

  it.each([
    [['4s', '4d', '4s', '4d', '4s', '4d'], 'full_card'],
    [['1s', '1d', '1s', '6d', '6s', '6d'], 'nikoniko_niko'],
    [['1s', '2d', '3s', '4d', '5s', '6d'], 'super_straight'],
  ])('6個役 %j → %s (3翻)', (codes, role) => {
    const r = evaluateSubset(ps(...codes));
    expect(r.numberRole).toBe(role);
    expect(r.han).toBe(3);
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
  it('同色統一1翻（赤♦♥/黒♠♣、4個でも6個でも1翻）', () => {
    expect(evaluateSubset(ps('1d', '3h', '5d', '6h'))).toMatchObject({ suitRole: 'same_color', color: 'red', han: 1 });
    expect(evaluateSubset(ps('1s', '3c', '5s', '1c', '2s', '4c'))).toMatchObject({ suitRole: 'same_color', color: 'black', han: 1 });
  });
  it('オールマーク2翻・フラッシュ3翻、複数成立時は最強1種のみ', () => {
    expect(evaluateSubset(ps('1s', '3d', '5c', '6h'))).toMatchObject({ suitRole: 'all_mark', han: 2 });
    // フラッシュは同色統一も満たすが、最強のフラッシュ1種だけ採用（4翻にならない）
    expect(evaluateSubset(ps('1h', '3h', '5h', '6h'))).toMatchObject({ suitRole: 'flush', han: 3 });
  });
  it('属性役単独でも有効', () => {
    expect(ok(evaluateStock(ps('1s', '3d', '5c', '6h'))).han).toBe(2);
  });
});

describe('複合役（翻数加算・二重加算禁止）', () => {
  it.each([
    [['1h', '2h', '3h', '4h'], 4, [13]],
    [['2s', '3s', '4s', '5s'], 5, [14]],
    [['1d', '2d', '3d', '4d', '5d', '6d'], 6, [15]],
  ])('%j → %i翻 表示R%j', (codes, han, logos) => {
    const r = ok(evaluateStock(ps(...codes)));
    expect(r.han).toBe(han);
    expect(roleLogoIndices(r)).toEqual(logos);
  });

  it('名称未定の複合は数字役→属性役の順で表示', () => {
    const r = ok(evaluateStock(ps('3s', '3c', '3s', '3c')));
    expect(r).toMatchObject({ numberRole: 'four_card', suitRole: 'same_color', color: 'black', han: 2 });
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
    // 2345♠ のハイストレートフラッシュ(5翻) が含まれる
    const r = ok(evaluateStock(ps('2s', '3s', '6d', '4s', '5s')));
    expect(r.han).toBe(5);
    expect(r.subset.map((p) => `${p.n}${p.suit[0]}`).sort()).toEqual(['2s', '3s', '4s', '5s']);
  });

  it('数字役と属性役は同一部分集合で評価し、別部分集合の結果を合成しない', () => {
    // {2h,3h,4h,5c}=ハイストレート2翻（属性ばらばら）、{2h,3h,4h,6h}=フラッシュ3翻（数字役なし）。
    // 合成すれば5翻だが、正しくは単一部分集合の最強＝フラッシュ3翻
    const stock = ps('2h', '3h', '4h', '5c', '6h');
    const e = evaluateStock(stock);
    const r = ok(e);
    expect(r.han).toBe(3);
    expect(r.suitRole).toBe('flush');
    expect(r.numberRole).toBeNull();
    // 合成していないことの確認：どの単一部分集合も5翻にならない
    expect(Math.max(...fourSubsets(stock).map((s) => evaluateSubset(s).han))).toBe(3);
  });

  it('6個：6個全体で成立する役を優先（解釈：4個部分集合の方が翻数が高くても6個役。要確認として報告）', () => {
    // 全体：オールブラック(同色統一1翻)。4個部分集合 {1s,1c,1s,1c} はフォーカード＋同色2翻だが6個役を優先
    const r = ok(evaluateStock(ps('1s', '1c', '1s', '1c', '1s', '2c')));
    expect(r.size).toBe(6);
    expect(r).toMatchObject({ suitRole: 'same_color', numberRole: null, han: 1 });
  });

  it('6個：6個役が無ければ15通りから最強', () => {
    const r = ok(evaluateStock(ps('2s', '3s', '4s', '5s', '1d', '1h')));
    expect(r.size).toBe(4);
    expect(r.han).toBe(5);
  });

  it('未確定(G04)：無役・同点役は ok を返さない', () => {
    expect(evaluateStock(ps('1s', '1d', '2s', '4d')).kind).toBe('no_role');
    // {1s,1s,1d,1d}=フォーカード1翻 と {1s,1s,3s,5c}=フォーブラック1翻 が同点（6個全体は役なし）
    const tie = evaluateStock(ps('1s', '1s', '1d', '1d', '3s', '5c'));
    expect(tie.kind).toBe('tie');
    if (tie.kind === 'tie') {
      expect(tie.candidates.map((c) => c.han)).toEqual([1, 1]);
      expect(tie.candidates.map((c) => c.numberRole ?? c.suitRole).sort()).toEqual(['four_card', 'same_color']);
    }
    // 同じ役が別の部分集合で並ぶだけなら同点扱いしない
    expect(evaluateStock(ps('1s', '2s', '3c', '4c', '2c')).kind).toBe('ok');
  });

  it('4個未満は宣言不可', () => {
    expect(evaluateStock(ps('1s', '2s', '3s')).kind).toBe('too_few');
  });
});
