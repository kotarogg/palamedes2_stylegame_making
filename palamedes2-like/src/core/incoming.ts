// 受攻撃（第3版 統合実装開始指示 第7〜10章）：受攻撃ブロックと攻撃波の状態遷移。
// 盤面・役処理・時刻は呼出し側（Game）が渡す。ここは数量と時刻だけを扱う純粋な状態機械。
//
// 状態は3つに分ける：
//   nextPending    … 次ブロック待機分（唯一の相殺対象）
//   blockRemaining … 現ブロックに確定済みで、まだ波へ割り当てていない量（相殺対象外）
//   waveRemaining  … 現在の波へ割当済みで、まだ適用していない量（最大3。相殺対象外）
// 表示ストック数＝3つの合計。ブロック開始・波開始は内部移動なので合計は減らない。
// 合計が減るのは、段の実適用・相殺・ピンチ時の破棄だけ。受信時の上限超過は受け取らない（別統計）。

export interface IncomingConfig {
  /** 受ストック全体の実残量上限（確定：29） */
  stockMax: number;
  /** 1波の最大段数（確定：3） */
  maxPerWave: number;
  /** 最初の受信からブロック開始まで（確定：2000ms） */
  firstBlockDelayMs: number;
  /** ブロック終了から次ブロック開始までの最短（確定：2000ms） */
  blockGapMs: number;
  /** 波内の段の周期（PM指定：0／400／800ms） */
  stepIntervalMs: number;
  /** 前波の最後の実適用から次波の最初の実適用まで（PM指定初期値：450ms。400ms以下にしない） */
  waveGapMs: number;
  /** 攻撃で到達できる上限段数＝ピンチライン（確定：7） */
  pinchHeight: number;
  /** 攻撃によるピンチ猶予（PM補完：2000ms） */
  pinchGraceMs: number;
}

export const DEFAULT_INCOMING_CONFIG: IncomingConfig = {
  stockMax: 29,
  maxPerWave: 3,
  firstBlockDelayMs: 2000,
  blockGapMs: 2000,
  stepIntervalMs: 400,
  waveGapMs: 450,
  pinchHeight: 7,
  pinchGraceMs: 4000, // v3.1.0：攻撃ピンチ猶予 4000ms（1000/2000/3000ms で 3/2/1、4000ms で期限判定）
};

export interface IncomingStats {
  received: number;
  overflow: number;
  canceled: number;
  applied: number;
  pinchDiscarded: number;
  pinchReached: number;
  blocks: number;
  waves: number;
}

export interface IncomingState {
  nextPending: number;
  blockRemaining: number;
  waveRemaining: number;
  /** 現ブロックが進行中（開始〜blockRemaining・waveRemaining がともに0になるまで） */
  blockActive: boolean;
  blockId: number;
  waveId: number;
  /** 現ブロックの表示予約（開始時の量。終了まで縮めない） */
  blockReserved: number;
  /** 次ブロックの開始可能tick（null＝待機分なし・期限未設定） */
  nextBlockTick: number | null;
  /** 直前ブロックの終了から blockGapMs 後（これより前には開始しない） */
  cooldownUntil: number;
  /** 次の段を適用できる最短tick */
  nextStepTick: number;
  /** 現在の波の段番号（0始まり） */
  waveStep: number;
  /** 攻撃ピンチ猶予の残りtick（null＝猶予なし）。進行・停止は既存の危険猶予と同じ扱い（自分の役処理中は停止） */
  pinchRemaining: number | null;
  stats: IncomingStats;
}

export function createIncoming(): IncomingState {
  return {
    nextPending: 0,
    blockRemaining: 0,
    waveRemaining: 0,
    blockActive: false,
    blockId: 0,
    waveId: 0,
    blockReserved: 0,
    nextBlockTick: null,
    cooldownUntil: 0,
    nextStepTick: 0,
    waveStep: 0,
    pinchRemaining: null,
    stats: { received: 0, overflow: 0, canceled: 0, applied: 0, pinchDiscarded: 0, pinchReached: 0, blocks: 0, waves: 0 },
  };
}

/** 表示ストック数（実残量の合計） */
export const totalIncoming = (s: IncomingState): number => s.nextPending + s.blockRemaining + s.waveRemaining;

export interface ReceiveResult {
  accepted: number;
  overflow: number;
}

/**
 * 受信：上限29までを nextPending へ加える（超過分は上限超過として破棄）。
 * 待機中の追加受信で期限を延長しない。直前ブロックの終了から2000ms経過前の受信は、その2000ms時点で開始。
 */
export function receive(s: IncomingState, lines: number, tick: number, ticks: (ms: number) => number, cfg: IncomingConfig = DEFAULT_INCOMING_CONFIG): ReceiveResult {
  if (!Number.isInteger(lines) || lines < 0) throw new Error(`invalid attack lines: ${lines}`);
  const room = Math.max(0, cfg.stockMax - totalIncoming(s));
  const accepted = Math.min(room, lines);
  const overflow = lines - accepted;
  s.nextPending += accepted;
  s.stats.received += accepted;
  s.stats.overflow += overflow;
  if (accepted > 0 && !s.blockActive && s.nextBlockTick === null) {
    s.nextBlockTick = tick < s.cooldownUntil ? s.cooldownUntil : tick + ticks(cfg.firstBlockDelayMs);
  }
  return { accepted, overflow };
}

/** 相殺：対象は nextPending のみ。消した量を返す（攻撃力の消費・端数処理は attack.resolveCounter の確定処理を使う） */
export function cancelPending(s: IncomingState, lines: number): number {
  const n = Math.max(0, Math.min(lines, s.nextPending));
  s.nextPending -= n;
  s.stats.canceled += n;
  return n;
}

/** ブロック開始の判定（第9章 手順6）。開始したら現ブロックの量を返す */
export function tryStartBlock(s: IncomingState, tick: number): number | null {
  if (s.blockActive || s.nextBlockTick === null || tick < s.nextBlockTick) return null;
  if (s.nextPending <= 0) {
    // 期限に達したが待機分なし：開始せず待機（次の受信で改めて期限を設定）
    s.nextBlockTick = null;
    return null;
  }
  s.blockRemaining = s.nextPending;
  s.nextPending = 0;
  s.blockActive = true;
  s.blockId++;
  s.blockReserved = s.blockRemaining;
  s.nextBlockTick = null;
  s.waveStep = 0;
  s.nextStepTick = tick;
  s.stats.blocks++;
  return s.blockRemaining;
}

/** 波の開始：min(3, blockRemaining) を内部で割り当てる（表示ストック数は減らない）。開始したら段数を返す */
export function tryStartWave(s: IncomingState, cfg: IncomingConfig = DEFAULT_INCOMING_CONFIG): number | null {
  if (!s.blockActive || s.waveRemaining > 0 || s.blockRemaining <= 0) return null;
  const n = Math.min(cfg.maxPerWave, s.blockRemaining);
  s.blockRemaining -= n;
  s.waveRemaining = n;
  s.waveId++;
  s.waveStep = 0;
  s.stats.waves++;
  return n;
}

/** 現ブロックが終わっていれば閉じ、次ブロックの最短開始tickを設定する */
export function tryEndBlock(s: IncomingState, tick: number, ticks: (ms: number) => number, cfg: IncomingConfig = DEFAULT_INCOMING_CONFIG): boolean {
  if (!s.blockActive || s.blockRemaining > 0 || s.waveRemaining > 0) return false;
  s.blockActive = false;
  s.blockReserved = 0;
  s.cooldownUntil = tick + ticks(cfg.blockGapMs);
  s.nextBlockTick = s.nextPending > 0 ? s.cooldownUntil : null;
  return true;
}
