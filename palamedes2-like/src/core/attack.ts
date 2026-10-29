// 攻撃量・相殺（統合仕様 第9〜10章＋2026-10-18確定事項）。受攻撃の段階処理は incoming.ts（第3版）。
// V320-FIX-04 第8章：採択された数字役に基本攻撃ボーナス（4ピース役+1、6ピース役+2）を1回加える。属性役のみは+0。得点には加えない。
import type { NumberRole } from './roles';

/** 数字役の基本攻撃ボーナス（採択された数字役1つにつき1回） */
export const NUMBER_ROLE_ATTACK_BONUS: Record<NumberRole, number> = {
  four_card: 1,
  nikoniko: 1,
  straight: 1,
  high_straight: 1,
  full_card: 2,
  nikoniko_niko: 2,
  super_straight: 2,
};

export const numberRoleAttackBonus = (nr: NumberRole | null): number => (nr ? NUMBER_ROLE_ATTACK_BONUS[nr] : 0);

export interface AttackBreakdown {
  /** 基本攻撃量＝max(合計翻数−1, 0) */
  base: number;
  /** 数字役の基本攻撃ボーナス（0／1／2。倍率の前に加える） */
  numberBonus: number;
  /** 連続取得の攻撃倍率×100 */
  streakPercent: number;
  /** （基本攻撃量＋数字役ボーナス）×倍率の小数点以下切捨て */
  multiplied: number;
  /** 役連鎖の追加分（倍率を掛けない） */
  chainBonus: number;
  /** 通常攻撃力（相殺前） */
  power: number;
}

/**
 * 攻撃量（V320-FIX-04）：（基本攻撃量＋数字役ボーナス）×打上連鎖の攻撃倍率 → 切捨て → 役連鎖加算（倍率を掛けない）。
 * 消去ライン数が予定に届かなくても基本攻撃量は減らさない（呼出し側で消去数を渡さない）。
 */
export function computeAttack(han: number, streakPct: number, chainCount: number, chainBonusMax = 4, numberRole: NumberRole | null = null): AttackBreakdown {
  const base = Math.max(han - 1, 0);
  const numberBonus = numberRoleAttackBonus(numberRole);
  const multiplied = Math.floor(((base + numberBonus) * streakPct) / 100);
  const chainBonus = Math.min(Math.max(chainCount - 1, 0), chainBonusMax);
  return { base, numberBonus, streakPercent: streakPct, multiplied, chainBonus, power: multiplied + chainBonus };
}

export interface CounterResult {
  /** 相殺に使った通常攻撃力 */
  usedPower: number;
  /** 相殺した待機攻撃ライン数 */
  canceled: number;
  /** 相殺に使わず相手へ送る通常攻撃力 */
  sent: number;
  /** 使用した1ライン分の余剰相殺力（破棄。攻撃へ転用しない） */
  discarded: number;
}

/**
 * 相殺（確定）：通常攻撃力1ライン分で待機攻撃を最大 perLine（2）ライン相殺。
 * 相殺に使わなかった攻撃力は送信。使用した分の余剰相殺力は破棄。
 * 例：攻撃力3・待機1 → 1を使って待機1を相殺し、2を送信（余剰1は破棄）。
 */
export function resolveCounter(power: number, waiting: number, perLine = 2): CounterResult {
  if (power < 0 || waiting < 0) throw new Error('negative value');
  const usedPower = Math.min(power, Math.ceil(waiting / perLine));
  const canceled = Math.min(waiting, usedPower * perLine);
  return { usedPower, canceled, sent: power - usedPower, discarded: usedPower * perLine - canceled };
}
