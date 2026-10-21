// 攻撃量・相殺（統合仕様 第9〜10章＋2026-10-18確定事項）。受攻撃の段階処理は incoming.ts（第3版）。

export interface AttackBreakdown {
  /** 基本攻撃量＝max(合計翻数−1, 0) */
  base: number;
  /** 連続取得の攻撃倍率×100 */
  streakPercent: number;
  /** 基本攻撃量×倍率の小数点以下切捨て */
  multiplied: number;
  /** 役連鎖の追加分（倍率を掛けない） */
  chainBonus: number;
  /** 通常攻撃力（相殺前） */
  power: number;
}

/**
 * 攻撃量（確定）：基本攻撃量×連続取得の攻撃倍率 → 切捨て → 役連鎖加算。
 * 消去ライン数が予定に届かなくても基本攻撃量は減らさない（呼出し側で消去数を渡さない）。
 */
export function computeAttack(han: number, streakPct: number, chainCount: number, chainBonusMax = 4): AttackBreakdown {
  const base = Math.max(han - 1, 0);
  const multiplied = Math.floor((base * streakPct) / 100);
  const chainBonus = Math.min(Math.max(chainCount - 1, 0), chainBonusMax);
  return { base, streakPercent: streakPct, multiplied, chainBonus, power: multiplied + chainBonus };
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
