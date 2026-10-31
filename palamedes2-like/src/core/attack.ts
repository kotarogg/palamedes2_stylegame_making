// 攻撃量・相殺。受攻撃の段階処理は incoming.ts（第3版）。
// V320-FIX-06：通常攻撃力＝基本攻撃数（数値表）＋打上連鎖加算（5〜9連鎖+1、10〜99連鎖+2）＋役連鎖加算（2連鎖+1〜5連鎖以上+4）。
// 旧仕様（翻数−1＋数字役ボーナス、打上連鎖の攻撃倍率）は廃止。最大は 8＋2＋4＝14 ライン。相殺は1対1。

/** 打上連鎖の攻撃加算の段（この連鎖数以上で bonus） */
export interface StreakBonusStep {
  minCount: number;
  bonus: number;
}

/** V320-FIX-06 第4.1節：0〜4連鎖＋0、5〜9連鎖＋1、10〜99連鎖＋2 */
export const STREAK_ATTACK_BONUS: readonly StreakBonusStep[] = [
  { minCount: 5, bonus: 1 },
  { minCount: 10, bonus: 2 },
];

/** 打上連鎖数に対応する攻撃加算 */
export function streakAttackBonus(count: number, table: readonly StreakBonusStep[] = STREAK_ATTACK_BONUS): number {
  let b = 0;
  for (const s of table) if (count >= s.minCount) b = s.bonus;
  return b;
}

/** 役連鎖数に対応する攻撃加算（1連鎖＋0、2連鎖＋1 … 上限 chainBonusMax） */
export const chainAttackBonus = (chainCount: number, chainBonusMax = 4): number => Math.min(Math.max(chainCount - 1, 0), chainBonusMax);

export interface AttackBreakdown {
  /** 基本攻撃数（採択役の数値表の値） */
  base: number;
  /** 宣言時点の打上連鎖数（0＝連鎖なし） */
  streakCount: number;
  /** 打上連鎖の攻撃加算（0／1／2） */
  streakBonus: number;
  /** 役連鎖の攻撃加算（0〜4） */
  chainBonus: number;
  /** 通常攻撃力（相殺前）＝base＋streakBonus＋chainBonus */
  power: number;
}

/**
 * 攻撃量（V320-FIX-06）。採択役・両連鎖数は宣言時点のスナップショットを渡す（処理途中で再計算しない）。
 * 消去ライン数が予定に届かなくても基本攻撃数は減らさない（呼出し側で消去数を渡さない）。
 */
export function computeAttack(baseAttack: number, streakCount: number, chainCount: number, chainBonusMax = 4, table: readonly StreakBonusStep[] = STREAK_ATTACK_BONUS): AttackBreakdown {
  const streakBonus = streakAttackBonus(streakCount, table);
  const chainBonus = chainAttackBonus(chainCount, chainBonusMax);
  return { base: baseAttack, streakCount, streakBonus, chainBonus, power: baseAttack + streakBonus + chainBonus };
}

export interface CounterResult {
  /** 相殺に使った通常攻撃力 */
  usedPower: number;
  /** 相殺した待機攻撃ライン数 */
  canceled: number;
  /** 相殺に使わず相手へ送る通常攻撃力 */
  sent: number;
  /** 使用した相殺力のうち余った分（perLine＞1 の場合だけ発生。V320-FIX-06 の1対1では常に0） */
  discarded: number;
}

/**
 * 相殺：通常攻撃力1で次ブロック待機分を perLine ライン相殺（V320-FIX-06：perLine＝1）。相殺に使わなかった攻撃力は送信。
 * 例（1対1）：攻撃3・待機1 → 相殺1・送信2。攻撃3・待機5 → 相殺3・送信0・待機残2。
 */
export function resolveCounter(power: number, waiting: number, perLine = 1): CounterResult {
  if (power < 0 || waiting < 0) throw new Error('negative value');
  const usedPower = Math.min(power, Math.ceil(waiting / perLine));
  const canceled = Math.min(waiting, usedPower * perLine);
  return { usedPower, canceled, sent: power - usedPower, discarded: usedPower * perLine - canceled };
}
