// 調整値の集約。ルールとして確定した値と、テスト用初期値（調整用）を区別してコメントする。
// 確定値の出典：2026-10-18 仕様確認への回答（docs/SPEC_DECISIONS_20261018.md）。
import { WAVE_RULES, type WaveRules } from './attack';

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

/** 連続取得の攻撃倍率（確定）。得点倍率とは別表 */
export const STREAK_ATTACK_TABLE: readonly StreakStep[] = [
  { minCount: 1, percent: 100 },
  { minCount: 3, percent: 125 },
  { minCount: 5, percent: 150 },
  { minCount: 7, percent: 175 },
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
  /** 攻撃波の間隔（確定：2秒） */
  waveIntervalMs: number;
  /** 最初の攻撃受信から第1波まで（確定：2秒） */
  firstWaveDelayMs: number;
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
  /** 役連鎖の受付時間（確定：8秒） */
  chainWindowMs: number;
  /** 役連鎖の追加攻撃の上限（確定：+4） */
  chainBonusMax: number;
  /** 通常攻撃力1ライン分で相殺できる待機攻撃ライン数（確定：2） */
  counterPerLine: number;
  waveRules: WaveRules;
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
    descendMs: 700,
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
  waveIntervalMs: 2000,
  firstWaveDelayMs: 2000,
  initialRows: 3,
  manualRiseMaxHeight: 7,
  dangerHeight: 7,
  dangerGraceMs: 3000,
  streakWindowMs: 2000,
  streakAttackTable: STREAK_ATTACK_TABLE,
  streakScoreTable: STREAK_SCORE_TABLE,
  chainWindowMs: 8000,
  chainBonusMax: 4,
  counterPerLine: 2,
  waveRules: WAVE_RULES,
  declareBelowMinIsFailure: true,
  releaseExecutesHeldRise: true,
};

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
  /** 不成立モーション（専用素材が無いため暫定：待機枠を左右に揺らす量px） */
  failShakePx: number;
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
  failShakePx: 2,
};

/**
 * まだ仕様が無い・解釈が分かれる箇所に対して、検証版が採っている扱い（画面のF1とREADMEに明示）。
 */
export const PROVISIONAL_HANDLING = [
  ['得点', '得点倍率表は保持のみ（MATCH画面に得点表示が無いため計算・表示しない）'],
  ['4個未満の宣言', '不成立として扱う（硬直0.5秒）。要確認'],
  ['猶予解除時の保留上昇', '保留していた自然上昇を解除時に実行。要確認'],
  ['移動中の手動上昇', '保持対象外のため即時実行（移動を妨げない）。要確認'],
  ['取得倍率パネル', '連続取得の「攻撃倍率」を表示（得点倍率は表示しない）。要確認'],
  ['難易度・機器の初期値', '自然上昇は中級（5秒）、1P/2Pともキーボード。初期値の指定なし'],
  ['役ストックの描画層', '成立光の「背面→ピース→前面」を守るため、ストックのピースを背面光55とキャラ60の間（56）に描画。要確認'],
  ['効果音', '音素材が未納品のため、仮の電子音で代用（Mで消音）'],
  ['不成立モーション', '専用素材が無いため、待機枠を短く揺らして代用'],
] as const;

export const msToTicks = (ms: number, tickRate: number): number => Math.max(1, Math.round((ms * tickRate) / 1000));

/** 連続取得数に対応する倍率×100 */
export function streakPercent(table: readonly StreakStep[], count: number): number {
  let p = 100;
  for (const s of table) if (count >= s.minCount) p = s.percent;
  return p;
}
