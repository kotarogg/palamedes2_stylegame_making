// 調整値の集約。ここにある時間値はすべて「テスト用初期値」であり正式ゲームルールではない。
// 攻撃式・消去・勝敗などゲーム結果を決める未確定事項（G01〜G06）はここで補完しない。
import { WAVE_RULES, type WaveRules } from './attack';

export interface TimingConfig {
  charMoveMs: number;
  /** 直線打ち上げの所要時間（距離・列によらず同一） */
  launchMs: number;
  /** 成功後の列上詰め */
  packMs: number;
  /** B列入れ替え */
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
  /** 役宣言演出（宣言者の操作ロック時間） */
  declareMs: number;
  readyMs: number;
  goMs: number;
}

export interface GameConfig {
  tickRate: number;
  timing: TimingConfig;
  /** 自然上昇の間隔（試合設定。検証用初期値）。null で自然上昇なし */
  naturalRiseIntervalMs: number | null;
  /** 攻撃波の間隔（統合仕様10.1の暫定値 約2秒） */
  waveIntervalMs: number;
  /** ストック発生から最初の波までの待ち（未確定のため検証用に波間隔と同値） */
  firstWaveDelayMs: number;
  /** MATCH初期配置の段数（確定：下側3段＝18個） */
  initialRows: number;
  /** 手動上昇の上限段数（確定：7段を超えない） */
  manualRiseMaxHeight: number;
  /** 危険状態の段数（確定：7段） */
  dangerHeight: number;
  waveRules: WaveRules;
}

export const DEFAULT_CONFIG: GameConfig = {
  tickRate: 60,
  timing: {
    charMoveMs: 90,
    launchMs: 400,
    packMs: 120,
    rotateMs: 220,
    bounceMs: 120,
    arcMs: 260,
    descendMs: 700,
    riseMs: 250,
    bPoseMs: 150,
    declareMs: 2000,
    readyMs: 1200,
    goMs: 700,
  },
  naturalRiseIntervalMs: 12000,
  waveIntervalMs: 2000,
  firstWaveDelayMs: 2000,
  initialRows: 3,
  manualRiseMaxHeight: 7,
  dangerHeight: 7,
  waveRules: WAVE_RULES,
};

/** 表示側の調整値（ゲーム結果に影響しない） */
export interface ViewConfig {
  arcEndY: number; // 山なり到達点Y（画面設計の暫定値 76）
  arcHeight: number;
  darkAlpha: number; // B暗色の濃さ
  rotateCurveX: number; // B暗色ピースの背面曲線の横振れ
  charFrameMs: { idle: number; walk: number; launch: number; attack: number };
  roleFrameMs: number; // 役名A/B/C色替え
  launchPoseMs: number;
  bPoseSlotId: string; // S1/S2 attack_00〜03 のどれを使うか
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  arcEndY: 76,
  arcHeight: 36,
  darkAlpha: 0.55,
  rotateCurveX: 10,
  charFrameMs: { idle: 220, walk: 90, launch: 70, attack: 110 },
  roleFrameMs: 90,
  launchPoseMs: 280,
  bPoseSlotId: 'attack_01',
};

/**
 * 未確定事項（G03/G04/G06）に対して、検証版が採っている暫定的な扱い。
 * 「何もしない／受け付けない」側に倒し、ゲーム結果を推測で決めない。画面・READMEに明示する。
 */
export const PROVISIONAL_HANDLING = [
  ['G04 同一プレイヤーの複数発射', '自分の打ち上げ中ピースが基準へ到達するまで次の発射を受け付けない（許可しない側）'],
  ['G04 空列への操作', '発射・Bを受け付けない'],
  ['G04 列移動中の追加入力', 'キャラ移動TWEEN中の入力を受け付けない（検証用設定）'],
  ['G04 列アニメ中の再入力', '上詰め・B入替TWEEN中のその列の発射・Bを受け付けない（検証用設定）'],
  ['G04 無役・同点役の宣言', '宣言を実行せずストックを保持し、画面に通知'],
  ['G01/G02 役宣言の効果', 'ストック全消費・役名演出・宣言者ロックのみ。攻撃量・消去は行わない'],
  ['G03 8段到達・敗北', '7段で自然上昇を保留して表示のみ。敗北判定・ラウンド終了は行わない'],
  ['G06 勝敗・先取・CPU', '未実装（入力窓口のみ用意）'],
] as const;

export const msToTicks = (ms: number, tickRate: number): number => Math.max(1, Math.round((ms * tickRate) / 1000));
