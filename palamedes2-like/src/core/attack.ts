// 攻撃ストックの確定部分（統合仕様 第9〜10章）。
// 翻数→攻撃量換算・相殺端数・送信順は未確定（G01）のため、ここでは扱わない。

/** 内部ロジック上の上限も29。30以上は29へ飽和 */
export const ATTACK_MAX = 29;

export function addAttackLines(stock: number, lines: number): number {
  if (!Number.isInteger(lines) || lines < 0) throw new Error(`invalid attack lines: ${lines}`);
  return Math.min(ATTACK_MAX, stock + lines);
}

export interface WaveRules {
  /** 1波で適用する最大ライン数（確定：3） */
  maxPerWave: number;
  /** 攻撃による盤面増加の上限段数（確定：6。7段目へ押し込まない） */
  maxHeightByAttack: number;
}

export const WAVE_RULES: WaveRules = { maxPerWave: 3, maxHeightByAttack: 6 };

/**
 * 今回の波で適用できるライン数。入りきらない分は保持（呼び出し側でストックに残す）。
 * height は予約空白を含む最長列の段数。
 */
export function waveLines(stock: number, height: number, rules: WaveRules = WAVE_RULES): number {
  return Math.max(0, Math.min(rules.maxPerWave, stock, rules.maxHeightByAttack - height));
}

/**
 * 相殺の確定部分：防御側の相殺力は通常攻撃力の2倍。余剰相殺力は攻撃へ転用しない。
 * 通常攻撃力の算出（G01）と、一部相殺時の送信扱いは未確定のため呼び出し側へ返すだけ。
 * 現在の対戦フローには接続していない（G01確定後に接続）。
 */
export function offsetIncoming(incoming: number, normalAttackPower: number): {
  remaining: number;
  canceled: number;
  /** 余剰の相殺力。攻撃へは転用しない（破棄扱い） */
  unusedCounterPower: number;
} {
  if (normalAttackPower < 0 || incoming < 0) throw new Error('negative value');
  const counterPower = normalAttackPower * 2;
  const canceled = Math.min(incoming, counterPower);
  return { remaining: incoming - canceled, canceled, unusedCounterPower: counterPower - canceled };
}

export interface AttackIconLayoutRules {
  bigLines: number; // 10
  bigMax: number; // 2
  bigPitchY: number; // 32
  smallMax: number; // 9
  smallOffsets: ReadonlyArray<readonly [number, number]>; // 左5→右4
}

export interface AttackIconPlacement {
  big: Array<{ x: number; y: number }>;
  small: Array<{ x: number; y: number }>;
}

/** 攻撃アイコン配置（画面JSONの attack_stock 定義から規則を与える） */
export function layoutAttackIcons(
  lines: number,
  origin: readonly [number, number],
  rules: AttackIconLayoutRules,
): AttackIconPlacement {
  const clamped = Math.max(0, Math.min(ATTACK_MAX, lines));
  const bigCount = Math.min(rules.bigMax, Math.floor(clamped / rules.bigLines));
  const smallCount = Math.min(rules.smallMax, clamped - bigCount * rules.bigLines);
  const [ox, oy] = origin;
  const big = Array.from({ length: bigCount }, (_, i) => ({ x: ox, y: oy + rules.bigPitchY * i }));
  const smallStartY = oy + rules.bigPitchY * bigCount;
  const small = Array.from({ length: smallCount }, (_, i) => ({
    x: ox + rules.smallOffsets[i][0],
    y: smallStartY + rules.smallOffsets[i][1],
  }));
  return { big, small };
}
