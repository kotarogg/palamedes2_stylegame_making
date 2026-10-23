// 調整値の集約。ルールとして確定した値と、テスト用初期値（調整用）を区別してコメントする。
// 確定値の出典：2026-10-18 仕様確認への回答（docs/SPEC_DECISIONS_20261018.md）。
import { DEFAULT_INCOMING_CONFIG, type IncomingConfig } from './incoming';

export interface TimingConfig {
  charMoveMs: number;
  /** 発射モーション＝操作硬直＝行きの飛行時間（確定：同一時間。値はテスト用初期値） */
  launchMs: number;
  /** 成功後の列上詰め（この間はプレイヤー全体の操作を制限） */
  packMs: number;
  /** B列入れ替え（この間はプレイヤー全体の操作を制限） */
  rotateMs: number;
  /** 失敗時の接触・反発 */
  bounceMs: number;
  /** 高速山なり曲線（基準→元列X） */
  arcMs: number;
  /** 低速垂直下降（盤面が上昇しても不変） */
  descendMs: number;
  /** 自然・手動上昇32pxのTWEEN */
  riseMs: number;
  /** B押下時のキャラ一瞬ポーズ */
  bPoseMs: number;
  /** 役処理：役判定→成立効果音→役名表示→キャラモーション切替 から最初のライン消去まで */
  roleIntroMs: number;
  /** 役処理：1ライン消去〜処理効果音 */
  lineClearMs: number;
  /** 役処理：足場・キャラの段数推移TWEEN（1ライン分） */
  lineShiftMs: number;
  /** 役処理：攻撃処理後のキャラモーション戻し〜終了処理 */
  roleOutroMs: number;
  /** 不成立宣言の操作硬直（確定：約0.5秒。テスト用初期値） */
  declareFailLockMs: number;
  readyMs: number;
  goMs: number;
}

export interface StreakStep {
  /** この連続取得数以上で適用 */
  minCount: number;
  /** 倍率×100（浮動小数の誤差を避けるため整数で保持） */
  percent: number;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

/** 自然上昇の通常周期（確定） */
export const NATURAL_RISE_MS: Record<Difficulty, number> = { easy: 7000, normal: 5000, hard: 3000 };
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '初級', normal: '中級', hard: '上級' };

/** 打ち上げ成功連鎖（連続取得）の攻撃倍率（v3.1.0 確定：1〜6回×1、7〜12回×1.25、13〜18回×1.5、19回以上×1.75）。得点倍率とは別表 */
export const STREAK_ATTACK_TABLE: readonly StreakStep[] = [
  { minCount: 1, percent: 100 },
  { minCount: 7, percent: 125 },
  { minCount: 13, percent: 150 },
  { minCount: 19, percent: 175 },
];

/** 連続取得の得点倍率（確定）。MATCH画面には得点表示が無いため、現時点では保持のみ */
export const STREAK_SCORE_TABLE: readonly StreakStep[] = [
  { minCount: 1, percent: 100 },
  { minCount: 3, percent: 150 },
  { minCount: 5, percent: 200 },
  { minCount: 7, percent: 250 },
];

export interface GameConfig {
  tickRate: number;
  timing: TimingConfig;
  /** 自然上昇の通常周期。null で自然上昇なし（テスト用） */
  naturalRiseIntervalMs: number | null;
  /** 手動上昇完了後、自然上昇までに確保する最低間隔（確定：ゲーム内0.2秒。調整用初期値） */
  riseMinGapMs: number;
  /** 受攻撃（第3版：受攻撃ブロック・攻撃波・上限29・ピンチ猶予）。src/core/incoming.ts */
  incoming: IncomingConfig;
  /** MATCH初期配置の段数（確定：下側3段＝18個） */
  initialRows: number;
  /** 手動上昇の上限段数（確定：7段を超えない） */
  manualRiseMaxHeight: number;
  /** 危険状態の段数（確定：7段） */
  dangerHeight: number;
  /** 危険猶予（確定：3秒） */
  dangerGraceMs: number;
  /** 連続取得の受付時間（確定：成功取得から次の成功取得まで2秒。自分の成立役の処理中は停止＝共有ノート17） */
  streakWindowMs: number;
  streakAttackTable: readonly StreakStep[];
  streakScoreTable: readonly StreakStep[];
  /** 役連鎖の受付時間（第3版 PM指定：8000ms→12000ms。ステージクリア時の最大復帰もこの値） */
  chainWindowMs: number;
  /** 役連鎖の追加攻撃の上限（確定：+4） */
  chainBonusMax: number;
  /** 通常攻撃力1ライン分で相殺できる待機攻撃ライン数（確定：2） */
  counterPerLine: number;
  /**
   * 要確認：ストック4個未満での宣言も「不成立」として扱う（硬直あり）か。
   * true＝不成立扱い（既定）、false＝入力を無視。
   */
  declareBelowMinIsFailure: boolean;
  /**
   * 要確認：危険猶予中に6段以下へ戻った場合、保留していた自然上昇を実行するか。
   * true＝保留分を実行（既定）、false＝保留分を破棄し通常周期を再開。
   */
  releaseExecutesHeldRise: boolean;
}

export const DEFAULT_CONFIG: GameConfig = {
  tickRate: 60,
  timing: {
    charMoveMs: 90,
    launchMs: 300,
    packMs: 120,
    rotateMs: 220,
    bounceMs: 120,
    arcMs: 260,
    // v3.1.0：ミス帰還の「列の縦軸へ戻った後、空いている戻り位置へ到達する区間」を現行700msの1.6倍（所要時間）。
    // 打ち上げ・反発・山なり帰還は変えない。帰還完了・描画・戻り位置の確保・操作制限はこの値で一致する
    descendMs: 1120,
    riseMs: 250,
    bPoseMs: 150,
    roleIntroMs: 700,
    lineClearMs: 200,
    lineShiftMs: 120,
    roleOutroMs: 300,
    declareFailLockMs: 500,
    readyMs: 1200,
    goMs: 700,
  },
  naturalRiseIntervalMs: NATURAL_RISE_MS.normal,
  riseMinGapMs: 200,
  incoming: DEFAULT_INCOMING_CONFIG,
  initialRows: 3,
  manualRiseMaxHeight: 7,
  dangerHeight: 7,
  dangerGraceMs: 3000,
  streakWindowMs: 2000,
  streakAttackTable: STREAK_ATTACK_TABLE,
  streakScoreTable: STREAK_SCORE_TABLE,
  chainWindowMs: 12000,
  chainBonusMax: 4,
  counterPerLine: 2,
  declareBelowMinIsFailure: true,
  releaseExecutesHeldRise: true,
};

/** MODE2の設定（初期盤面42個は数値設計JSONの mode2_initial_pieces。カウント3・2・1各1秒は設計補完の初期値） */
export interface Mode2Config {
  /** カウントダウンの開始数（3→2→1） */
  countdownFrom: number;
  /** カウント1つの長さ（音声の長さで変えない） */
  countdownStepMs: number;
}

export const DEFAULT_MODE2_CONFIG: Mode2Config = { countdownFrom: 3, countdownStepMs: 1000 };

/** 表示側の調整値（ゲーム結果に影響しない） */
export interface ViewConfig {
  arcEndY: number; // 山なり到達点Y（画面設計の暫定値 76。ピース左上）
  arcHeight: number;
  darkAlpha: number; // B暗色の濃さ
  rotateCurveX: number; // B暗色ピースの背面曲線の横振れ
  charFrameMs: { idle: number; walk: number; launch: number; attack: number; win: number; lose: number };
  roleFrameMs: number; // 役名A/B/C色替え
  /** 役成立光 A/B 各フレーム（確定：250ms、周期500ms、共有時計） */
  glowFrameMs: number;
  bPoseSlotId: string; // S1/S2 attack_00〜03 のどれを使うか
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  arcEndY: 76,
  arcHeight: 36,
  darkAlpha: 0.55,
  rotateCurveX: 10,
  charFrameMs: { idle: 220, walk: 90, launch: 70, attack: 110, win: 140, lose: 160 },
  roleFrameMs: 90,
  glowFrameMs: 250,
  bPoseSlotId: 'attack_01',
};

export const msToTicks = (ms: number, tickRate: number): number => Math.max(1, Math.round((ms * tickRate) / 1000));

/** 連続取得数に対応する倍率×100 */
export function streakPercent(table: readonly StreakStep[], count: number): number {
  let p = 100;
  for (const s of table) if (count >= s.minCount) p = s.percent;
  return p;
}
