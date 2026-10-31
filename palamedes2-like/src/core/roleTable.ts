// V320-FIX-06 役の数値表（実装依頼書 第2章の確定値）。役の成立条件・採択集合（roles.ts）と、消去数・基本攻撃数を分離して管理する。
// 実処理（game.ts）・CPU（input/cpu*.ts）・役一覧（demo/scenes.ts）・説明実演はすべてこの表を参照する。
// 「消去」＝自フィールドの予定消去ライン数、「基本攻撃」＝打上連鎖・役連鎖の加算と相殺の前の攻撃ライン数。
// 複合役は表の値をそのまま使う（単独役の再合算・「大きい方＋1」・旧数字役ボーナスの追加はしない）。
import type { NumberRole } from './roles';

/** 属性役の表上の区分（黒・赤統一は4個ならフォーブラック／フォーレッド、6個ならオールブラック／オールレッド） */
export type SuitKey = 'black' | 'red' | 'all_mark' | 'flush';

export interface RoleValue {
  /** 予定消去ライン数 */
  clear: number;
  /** 基本攻撃数（両連鎖加算・相殺前） */
  attack: number;
}

const v = (clear: number, attack: number): RoleValue => ({ clear, attack });

/** 2.1 単独役：数字役だけが成立（必要ピース数は役で決まる） */
export const NUMBER_ONLY: Record<NumberRole, RoleValue> = {
  four_card: v(2, 2),
  nikoniko: v(2, 2),
  straight: v(2, 2),
  high_straight: v(3, 3),
  full_card: v(4, 5),
  nikoniko_niko: v(4, 5),
  super_straight: v(4, 5),
};

/** 2.1 単独役：属性役だけが成立（4個／6個で値が異なる） */
export const SUIT_ONLY: Record<4 | 6, Record<SuitKey, RoleValue>> = {
  4: { black: v(2, 1), red: v(2, 1), all_mark: v(2, 2), flush: v(3, 2) },
  6: { black: v(3, 2), red: v(3, 2), all_mark: v(3, 3), flush: v(4, 3) },
};

const combo = (b: RoleValue, a: RoleValue, f: RoleValue): Record<SuitKey, RoleValue> => ({ black: b, red: b, all_mark: a, flush: f });

/** 2.2 複合役：数字役＋属性役（28組。表の値が最終値） */
export const COMBO: Record<NumberRole, Record<SuitKey, RoleValue>> = {
  four_card: combo(v(3, 3), v(3, 4), v(4, 4)),
  nikoniko: combo(v(3, 3), v(3, 4), v(4, 4)),
  straight: combo(v(3, 3), v(3, 4), v(4, 4)),
  high_straight: combo(v(4, 4), v(4, 5), v(5, 5)),
  full_card: combo(v(5, 6), v(5, 7), v(6, 8)),
  nikoniko_niko: combo(v(5, 6), v(5, 7), v(6, 8)),
  super_straight: combo(v(5, 6), v(5, 7), v(6, 8)),
};

/** 役の値（不成立は 0／0） */
export function roleValue(size: 4 | 6, numberRole: NumberRole | null, suit: SuitKey | null): RoleValue {
  if (numberRole && suit) return COMBO[numberRole][suit];
  if (numberRole) return NUMBER_ONLY[numberRole];
  if (suit) return SUIT_ONLY[size][suit];
  return v(0, 0);
}

/**
 * 数字役の従来の強さ（自動採択の第4順位「数字役の従来の強さ」専用）。
 * v3.1.0〜V320-FIX-05 の数字役の翻数と同じ並び。消去数・攻撃数の計算には使わない
 */
export const LEGACY_NUMBER_STRENGTH: Record<NumberRole, number> = {
  four_card: 1,
  nikoniko: 1,
  straight: 1,
  high_straight: 2,
  full_card: 3,
  nikoniko_niko: 3,
  super_straight: 3,
};

/** 理論上の最大基本攻撃（フルカード系＋フラッシュ） */
export const MAX_BASE_ATTACK = 8;
