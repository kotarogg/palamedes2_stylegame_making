// MODE1シングルの数値（正本：28_MODE1_NUMERIC_DESIGN_20261020.md／mode1_balance_v1.json）。
// JSONは共有Driveの納品物を変更せずに同梱し、そのまま読み込む。値の転記はしない。
import raw from '../data/mode1_balance_v1.json';

export interface StageDef {
  stage: number;
  quota: number;
  natural_rise_ms: number;
  initial_pieces: number;
  stage_clear_bonus: number;
}

export interface LevelDef {
  level: number;
  /** null＝Lv上限（MAX）。0を入れて毎tick昇格するような扱いをしない */
  required_clears_to_next: number | null;
  cumulative_clears_to_enter: number;
  natural_rise_ms: number;
  max_level: boolean;
}

export interface Mode1Balance {
  units: { launch_success_clears: number; actual_line_clear_event_clears: number };
  mode1_initial_pieces: number;
  stages: StageDef[];
  endless: { max_level: number; carry_excess_clear_units: boolean; restart_natural_period_on_level_up: boolean; levels: LevelDef[] };
  scoring: {
    successful_launch_base: number;
    actual_line_clear_base: number;
    streak_thresholds: number[];
    streak_multiplier_numerators: number[];
    streak_multiplier_denominator: number;
    line_score_uses_declaration_snapshot: boolean;
    stage_clear_bonus_base: number;
    stage_clear_bonus_times_stage_number: boolean;
    all_clear_bonus: number;
    bonuses_use_multiplier: boolean;
    extra_final_stage_bonus: number;
  };
  stage_transition: {
    carry_score: boolean;
    carry_streak_count: boolean;
    carry_role_chain_count: boolean;
    /** V320-FIX-05：null＝打上連鎖は時間制限なし（復帰する受付時間を持たない） */
    restore_streak_remaining_ms: number | null;
    restore_chain_remaining_ms: number;
    clear_danger_active: boolean;
    danger_grace_max_ms: number;
    carry_excess_clear_units: boolean;
    reset_stock_and_return_reservations: boolean;
    initial_pieces_next_stage: number;
    intermission_freezes_game_timers: boolean;
  };
  mode2_initial_pieces: number;
}

export const MODE1_BALANCE: Mode1Balance = raw as Mode1Balance;

export const STAGE_COUNT = MODE1_BALANCE.stages.length;
export const MAX_LEVEL = MODE1_BALANCE.endless.max_level;

export function stageDef(stage: number, b: Mode1Balance = MODE1_BALANCE): StageDef {
  const s = b.stages.find((x) => x.stage === stage);
  if (!s) throw new Error(`stage not defined: ${stage}`);
  return s;
}

export function levelDef(level: number, b: Mode1Balance = MODE1_BALANCE): LevelDef {
  const l = b.endless.levels.find((x) => x.level === level);
  if (!l) throw new Error(`level not defined: ${level}`);
  return l;
}

/** 連続取得数に対応する得点倍率（分子／分母。整数演算で扱う） */
export function scoreMultiplier(streakCount: number, b: Mode1Balance = MODE1_BALANCE): { num: number; den: number } {
  const s = b.scoring;
  let num = s.streak_multiplier_denominator; // ×1
  s.streak_thresholds.forEach((th, i) => {
    if (streakCount >= th) num = s.streak_multiplier_numerators[i];
  });
  return { num, den: s.streak_multiplier_denominator };
}

/** 基本点×倍率（得点は整数。全倍率で整数になることは数値検査済み。念のため切捨て） */
export const applyMultiplier = (base: number, m: { num: number; den: number }): number => Math.floor((base * m.num) / m.den);

/**
 * ひたすらのLv進捗加算（超過分は次Lvへ繰越し、上限で停止）。
 * 戻り値：新しいLv・進捗と、この加算で上がったLvの一覧。
 */
export function addLevelProgress(
  level: number,
  progress: number,
  units: number,
  b: Mode1Balance = MODE1_BALANCE,
): { level: number; progress: number; ups: number[] } {
  let lv = level;
  let pr = progress + units;
  const ups: number[] = [];
  for (;;) {
    const req = levelDef(lv, b).required_clears_to_next;
    if (req === null || lv >= b.endless.max_level || pr < req) break;
    pr -= req;
    lv++;
    ups.push(lv);
  }
  return { level: lv, progress: pr, ups };
}
