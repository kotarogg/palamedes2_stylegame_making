// MODE1（役・攻撃あり）の固定ステップロジック。対戦（2人）とシングル（1人：ひたすら／ステージクリア）。
// 描画FPS・補間コールバック・音声には一切依存しない。両プレイヤーは独立して進行する（ターン制ではない）。
// 1tick内の処理順：
//   1. 基準到達（到達tick昇順、同一tickは1P優先）  2. 帰還完了
//   3. 役処理フェーズの進行（攻撃送信は双方の相殺計算後にまとめて反映）  3b. シングルのステージクリア確定
//   4. 入力（1P→2P。移動終了時の保持入力を先に処理）  5. 連続取得・役連鎖タイマー
//   6. 攻撃ピンチ猶予の期限・解除  7. 受攻撃ブロックの開始  8. 攻撃段の適用・ピンチ判定（波内400ms周期、波間450ms）
//   9. 自然上昇・危険猶予  10. 敗北判定（同一tickの両者敗北は引分け）
// 攻撃の解決順（第3版 第9章）：両者の役処理で攻撃力を収集→各自の相殺（その時点の nextPending）→相殺後の送信を相手へ受信（上限29）
//   →期限到達の敗北判定→ブロック開始→段の適用→自然上昇。同tickに相手から届いた分は、そのtickの自分の相殺対象に含めない。
import { computeAttack, resolveCounter, streakAttackBonus, type AttackBreakdown, type CounterResult } from './attack';
import { addLevelProgress, applyMultiplier, levelDef, MODE1_BALANCE, scoreMultiplier, STAGE_COUNT, stageDef, type Mode1Balance } from './balance';
import { Board } from './board';
import { DEFAULT_CONFIG, msToTicks, type GameConfig } from './config';
import { cancelPending, createIncoming, receive, totalIncoming, tryEndBlock, tryStartBlock, tryStartWave, type IncomingState } from './incoming';
import { isLaunchSuccess, PieceFactory } from './pieces';
import { evaluateStock, roleLogoIndices, type RoleResult } from './roles';
import { clear as clearHeld, MOVE_ACTIONS, offer, release, resolveTick, take, type InputLogEntry } from './inputBuffer';
import { createSeededRng, type Rng } from './rng';
import { pushRoleStock } from './stock';
import type { Piece, PlayerId } from './types';

export type Action = 'left' | 'right' | 'launch' | 'rotate' | 'declare' | 'manualRise';

/** 左右移動中に1回分だけ保持する入力（確定：最後の入力で上書き） */
const BUFFERABLE: ReadonlySet<Action> = new Set<Action>(['left', 'right', 'launch', 'rotate', 'declare']);

export type Command =
  /** repeat＝キーリピート・パッドの自動反復（新しい押下と区別する。v3.2.0 先行入力） */
  | { player: PlayerId; type: Action; repeat?: boolean }
  /** v3.2.0 左右キー・方向を離した：自動反復でできた移動予約を捨てる */
  | { player: PlayerId; type: 'cancelRepeat' }
  /** 検証用イベント注入（待機攻撃ストックへの直接加算。開発ビルドのみ） */
  | { player: PlayerId; type: 'debugAttack'; lines: number };

export type RiseKind = 'natural' | 'manual' | 'attack';

export type LockKind = 'launch' | 'pack' | 'rotate' | 'declareFail';

export type RoundOutcome = 'win' | 'draw' | 'stageClear' | 'allStagesClear' | 'gameOver' | 'clear';

export type ScoreCause = 'launch' | 'line' | 'allClear' | 'stageClear';

export type GameEvent =
  | { type: 'move'; tick: number; player: PlayerId; from: number; to: number; endTick: number }
  | { type: 'launch'; tick: number; player: PlayerId; col: number; piece: Piece; arriveTick: number }
  | {
      type: 'arrive';
      tick: number;
      player: PlayerId;
      col: number;
      piece: Piece;
      success: boolean;
      baseBefore: Piece;
      /** 成功時：上詰めされる列の残りピースID（上から）と終了tick */
      packedIds: number[];
      packEndTick: number;
      heightBefore: number;
      heightAfter: number;
      /** 失敗時：山なり開始・終了・下降終了tick */
      arcStartTick: number;
      arcEndTick: number;
      returnEndTick: number;
      discarded: Piece | null;
      /** 成功時の連続取得数 */
      streak: number;
    }
  /** instant：役成立による瞬間帰還 */
  | { type: 'returned'; tick: number; player: PlayerId; col: number; piece: Piece; instant: boolean }
  | { type: 'rotate'; tick: number; player: PlayerId; col: number; movedId: number; otherIds: number[]; endTick: number }
  | {
      type: 'rise';
      tick: number;
      player: PlayerId;
      kind: RiseKind;
      rows: number;
      heightBefore: number;
      heightAfter: number;
      endTick: number;
    }
  | {
      type: 'declare';
      tick: number;
      player: PlayerId;
      result: RoleResult;
      logos: number[];
      consumed: Piece[];
      chainCount: number;
      streak: number;
      /** V320-FIX-06：宣言時点の打上連鎖の攻撃加算（0／1／2） */
      streakBonus: number;
      introEndTick: number;
    }
  | { type: 'declareFail'; tick: number; player: PlayerId; reason: 'too_few' | 'no_role'; lockEnd: number }
  /** 役ストックが「宣言可能な成立状態」へ変化した（非成立→成立の時だけ） */
  | { type: 'roleAvailable'; tick: number; player: PlayerId }
  | {
      type: 'lineClear';
      tick: number;
      player: PlayerId;
      /** 何ライン目か（1始まり）と予定ライン数 */
      index: number;
      planned: number;
      removed: Array<{ col: number; piece: Piece }>;
      heightBefore: number;
      heightAfter: number;
      clearEnd: number;
      shiftEnd: number;
    }
  | { type: 'attack'; tick: number; player: PlayerId; breakdown: AttackBreakdown; counter: CounterResult; linesCleared: number }
  | { type: 'roleEnd'; tick: number; player: PlayerId }
  /** 受信：accepted を nextPending へ。overflow は上限29の超過で破棄（相殺・ピンチ破棄とは別統計） */
  | { type: 'attackReceive'; tick: number; player: PlayerId; accepted: number; overflow: number; total: number; cause: 'receive' | 'debug' }
  /** 相殺：nextPending から canceled を消した（XD顔・小爆発の対象） */
  | { type: 'attackCancel'; tick: number; player: PlayerId; canceled: number; total: number; /** 相殺後の nextPending（表示用） */ pending: number }
  /** 受攻撃ブロックの開始：nextPending 全量を現ブロックへ確定（表示ストック数は減らない） */
  | { type: 'blockStart'; tick: number; player: PlayerId; blockId: number; lines: number }
  /** 攻撃波の開始：現ブロックから最大3段を割当（内部移動。表示ストック数は減らない） */
  | { type: 'waveStart'; tick: number; player: PlayerId; blockId: number; waveId: number; lines: number }
  /**
   * 攻撃1段の実適用（6列へ1ライン）。表示ストック数を1減らす。
   * firstOfWave＝その波で最初の実適用（被攻撃ボイス）。rowIds＝追加した6個のピースID（接着表示用）
   */
  | { type: 'attackRow'; tick: number; player: PlayerId; blockId: number; waveId: number; step: number; firstOfWave: boolean; heightBefore: number; heightAfter: number; rowIds: number[]; total: number }
  /** ピンチライン到達で、同じ波の未適用分を破棄（相殺とは別の消失表現） */
  | { type: 'attackDiscard'; tick: number; player: PlayerId; waveId: number; lines: number; reason: 'pinch'; total: number; /** 破棄後の現ブロック残量（表示用） */ block: number }
  /** 現ブロックの終了。pending＝その時点の nextPending（表示用） */
  | { type: 'blockEnd'; tick: number; player: PlayerId; blockId: number; pending: number }
  /** 攻撃ピンチ猶予（2000ms）：grace＝開始、release＝6段以下へ下がり解除、defeat＝期限時も7段 */
  | { type: 'attackPinch'; tick: number; player: PlayerId; state: 'grace' | 'release' | 'defeat'; graceEnd: number }
  | { type: 'danger'; tick: number; player: PlayerId; state: 'grace' | 'release' | 'defeat'; graceEnd: number }
  /**
   * v3.1.0 ピンチ警告（自然上昇の危険猶予と攻撃ピンチ猶予をまとめた、プレイヤーごとの警告状態）。
   * start＝警告開始（どちらかの猶予が始まり、それまで警告なし）、count＝有効な残り猶予が 3000/2000/1000ms 以下になった
   * （value＝3/2/1）、end＝どちらの猶予も無くなった（解除・敗北）。残り猶予は両猶予の早い方（役処理中は止まる）
   */
  | { type: 'pinchWarn'; tick: number; player: PlayerId; state: 'start' | 'count' | 'end'; value: 3 | 2 | 1 | null; remainingMs: number | null }
  /**
   * v3.1.0 打ち上げ成功連鎖（連続取得）の連鎖切り。reserved＝有効な連鎖中の最初のミスで予約（成功数・倍率は維持）、
   * ended＝予約中の再ミス（reason miss）で終了（成功数0・予約解除）。reason timeout は受付時間を設定した場合だけ（V320-FIX-05 の既定は時間制限なし）
   */
  | { type: 'streakCut'; tick: number; player: PlayerId; state: 'reserved' | 'ended'; reason: 'miss' | 'timeout'; count: number }
  | { type: 'score'; tick: number; player: PlayerId; delta: number; total: number; cause: ScoreCause }
  | { type: 'progress'; tick: number; player: PlayerId; units: number; total: number }
  | { type: 'levelUp'; tick: number; player: PlayerId; level: number; max: boolean }
  /** 全消し。stageClearPending＝同じクリア処理でステージ達成が確定している（音量調整用。ゲーム処理は不変） */
  | { type: 'allClear'; tick: number; player: PlayerId; bonus: number; stageClearPending: boolean }
  | { type: 'quotaReached'; tick: number; player: PlayerId; stage: number }
  | { type: 'stageClear'; tick: number; player: PlayerId; stage: number; bonus: number; final: boolean }
  | { type: 'roundEnd'; tick: number; winner: PlayerId | null; outcome: RoundOutcome };

export interface Flight {
  piece: Piece;
  player: PlayerId;
  col: number;
  launchTick: number;
  arriveTick: number;
  state: 'outbound' | 'returning';
  returnEndTick: number;
}

/** 成立役の処理（宣言者ごとに独立したフェーズ） */
export interface RoleProcess {
  result: RoleResult;
  logos: number[];
  startTick: number;
  stage: 'intro' | 'clear' | 'shift' | 'outro';
  stageEnd: number;
  linesPlanned: number;
  linesCleared: number;
  chainCount: number;
  /** V320-FIX-06：宣言時点の打上連鎖数（攻撃加算の計算に使うスナップショット） */
  streakCount: number;
  /** シングル：宣言成立時の得点倍率スナップショット（1ライン100点に掛ける） */
  scoreMul: { num: number; den: number };
}

export interface PlayerState {
  id: PlayerId;
  board: Board;
  roleStock: Piece[];
  /** 役ストックが宣言可能な成立状態か（音の「非成立→成立」判定用） */
  roleReady: boolean;
  /** 受攻撃（nextPending・blockRemaining・waveRemaining とブロック・波・ピンチ猶予の状態） */
  incoming: IncomingState;
  selectedCol: number;
  charMoveEndTick: number;
  /** 左右移動中に保持している入力（1回分） */
  buffered: Action | null;
  /** v3.2.0 保持の受付tick（左右移動は moveBufferTicks で期限切れ） */
  bufferedTick: number;
  /** v3.2.0 自動反復でできた保持か（離したら捨てる） */
  bufferedRepeat: boolean;
  /** 操作硬直の終了tick（発射・上詰め・B入替・不成立） */
  lockUntil: number;
  lockKind: LockKind | null;
  role: RoleProcess | null;
  /** 自然上昇の通常周期（tick）。null＝自然上昇なし。シングルはステージ・Lvで変わる */
  riseIntervalTicks: number | null;
  /** 次の自然上昇までの残りtick（役処理中は停止） */
  riseCountdown: number;
  /** 自然上昇を危険状態で保留中 */
  riseHeld: boolean;
  manualRiseEndTick: number;
  /** 危険猶予の残りtick（null＝猶予中でない） */
  graceRemaining: number | null;
  streakCount: number;
  /**
   * 打上連鎖の受付残りtick。null＝時間制限なし（V320-FIX-05 の既定）。連鎖の有効条件には使わない（有効＝streakCount>0）。
   * 受付時間を設定した場合だけ、成功で更新・自分の成立役の処理中は停止・0で時間切れ
   */
  streakRemaining: number | null;
  /** v3.1.0 連鎖切り予約（有効な連鎖中の最初のミスで true。成功・役の宣言では解除しない） */
  streakCutReserved: boolean;
  /** v3.1.0 ピンチ警告の状態（表示・音へ伝えた最後の値） */
  pinchWarn: { active: boolean; value: 3 | 2 | 1 | null };
  chainCount: number;
  /** 役連鎖の受付残りtick（自分の成立役の処理中は停止） */
  chainRemaining: number;
  defeated: boolean;
  rng: Rng;
}

export type SingleKind = 'endless' | 'stage';

/** ステージ間の引継ぎ（得点・連続取得数・役連鎖数。受付残時間は最大へ戻す） */
export interface SingleCarry {
  score: number;
  streakCount: number;
  /** v3.1.0：引き継ぐ連鎖の連鎖切り予約（連鎖を引き継がない場合は false） */
  streakCutReserved?: boolean;
  chainCount: number;
}

export interface SingleOptions {
  kind: SingleKind;
  /** ステージクリアの面番号（1〜10） */
  stage?: number;
  carry?: SingleCarry;
  balance?: Mode1Balance;
}

export interface SingleState {
  kind: SingleKind;
  stage: number;
  quota: number;
  /** この面のノルマ進捗（表示はノルマでクランプする） */
  progress: number;
  level: number;
  levelProgress: number;
  /** 実際の成功・消去の累計（統計。ノルマ表示とは別） */
  totalClears: number;
  score: number;
  clearPending: boolean;
  /** 盤面が非空だったか（全消しは「非空→空」の変化で1回だけ） */
  wasNonEmpty: boolean;
}

export interface GameOptions {
  seed?: number;
  config?: GameConfig;
  /** シングル（1人）。省略時は2人対戦 */
  single?: SingleOptions;
  /** テスト用：盤面・基準の初期状態を差し替える */
  setup?: (g: Game) => void;
  /** 乱数源の差し替え（既定は seed からの mulberry32） */
  rngFactory?: (stream: 'base' | 'p1' | 'p2') => Rng;
  /**
   * 上昇で追加する1行の供給（遊び方の教材の補充日程用）。null を返したら既定どおり乱数で生成する。
   * 追加の処理（高さ・上限・タイマー・イベント）は通常の上昇と同じ
   */
  rowSource?: (player: PlayerId, kind: RiseKind) => ReadonlyArray<{ n: number; suit: Piece['suit'] }> | null;
}

export interface RoundResult {
  /** null＝引分け（シングルでは勝者なし） */
  winner: PlayerId | null;
  tick: number;
  outcome: RoundOutcome;
}

export class Game {
  readonly mode = 'mode1' as const;
  readonly config: GameConfig;
  readonly seed: number;
  readonly factory = new PieceFactory();
  readonly players: PlayerState[];
  readonly flights: Flight[] = [];
  readonly events: GameEvent[] = [];
  readonly single: SingleState | null;
  base: Piece;
  tick = 0;
  result: RoundResult | null = null;
  readonly playStartTick: number;
  private readonly baseRng: Rng;
  private readonly t: Record<keyof GameConfig['timing'], number>;
  private readonly balance: Mode1Balance;
  private pendingSends: Array<{ to: PlayerId; lines: number }> = [];
  private readonly rowSource: GameOptions['rowSource'];

  constructor(opts: GameOptions = {}) {
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.seed = opts.seed ?? 1;
    this.balance = opts.single?.balance ?? MODE1_BALANCE;
    this.rowSource = opts.rowSource;
    const mk =
      opts.rngFactory ??
      ((s: 'base' | 'p1' | 'p2') => createSeededRng((this.seed * 2654435761 + { base: 0, p1: 1, p2: 2 }[s] * 97) >>> 0));
    this.baseRng = mk('base');
    const tk = {} as Record<keyof GameConfig['timing'], number>;
    for (const [k, v] of Object.entries(this.config.timing)) tk[k as keyof GameConfig['timing']] = this.ticks(v);
    this.t = tk;
    this.playStartTick = this.t.readyMs;
    this.single = opts.single ? this.makeSingle(opts.single) : null;
    this.players = this.single ? [this.makePlayer(0, mk('p1'))] : [this.makePlayer(0, mk('p1')), this.makePlayer(1, mk('p2'))];
    this.base = this.factory.create(this.baseRng);
    const initialRows = this.single ? Math.round(this.initialPieces() / 6) : this.config.initialRows;
    for (const p of this.players) for (let r = 0; r < initialRows; r++) p.board.appendRow(this.newRow(p));
    const carry = opts.single?.carry;
    if (carry && this.single) {
      const p = this.players[0];
      const tr = this.balance.stage_transition;
      this.single.score = carry.score;
      p.streakCount = carry.streakCount;
      // V320-FIX-05：打上連鎖は時間制限なし。成功数・切り予約をそのまま引き継ぐ（時間による復帰・別理由のヒビ解除はしない）
      p.streakRemaining = carry.streakCount > 0 ? this.streakWindowTicks() : 0;
      p.streakCutReserved = carry.streakCount > 0 && !!carry.streakCutReserved;
      p.chainCount = carry.chainCount;
      // 役連鎖の最大復帰は chainWindowMs（V320-FIX-05：10000ms。数値正本JSONの restore_chain_remaining_ms も同値）
      void tr;
      p.chainRemaining = carry.chainCount > 0 ? this.ticks(this.config.chainWindowMs) : 0;
    }
    opts.setup?.(this);
    for (const p of this.players) p.roleReady = evaluateStock(p.roleStock).kind === 'ok';
  }

  get kind(): 'versus' | 'single' {
    return this.single ? 'single' : 'versus';
  }

  ticks(ms: number): number {
    return msToTicks(ms, this.config.tickRate);
  }

  get tickMs(): number {
    return 1000 / this.config.tickRate;
  }

  /** 入力受付中（READY後・勝敗確定前） */
  get playing(): boolean {
    return this.tick >= this.playStartTick && !this.result;
  }

  private makeSingle(o: SingleOptions): SingleState {
    const stage = o.kind === 'stage' ? (o.stage ?? 1) : 0;
    return {
      kind: o.kind,
      stage,
      quota: o.kind === 'stage' ? stageDef(stage, this.balance).quota : 0,
      progress: 0,
      level: 1,
      levelProgress: 0,
      totalClears: 0,
      score: 0,
      clearPending: false,
      wasNonEmpty: true,
    };
  }

  private initialPieces(): number {
    const s = this.single;
    if (!s) return this.config.initialRows * 6;
    return s.kind === 'stage' ? stageDef(s.stage, this.balance).initial_pieces : this.balance.mode1_initial_pieces;
  }

  /** 自然上昇の通常周期（ms）。シングルはステージ・Lvの表、対戦は難易度。テスト設定で null なら無効 */
  private naturalIntervalMs(): number | null {
    if (this.config.naturalRiseIntervalMs === null) return null;
    const s = this.single;
    if (!s) return this.config.naturalRiseIntervalMs;
    return s.kind === 'stage' ? stageDef(s.stage, this.balance).natural_rise_ms : levelDef(s.level, this.balance).natural_rise_ms;
  }

  private makePlayer(id: PlayerId, rng: Rng): PlayerState {
    const ms = this.naturalIntervalMs();
    const interval = ms === null ? null : this.ticks(ms);
    return {
      id,
      board: new Board(),
      roleStock: [],
      roleReady: false,
      incoming: createIncoming(),
      selectedCol: 2,
      charMoveEndTick: 0,
      buffered: null,
      bufferedTick: -1,
      bufferedRepeat: false,
      lockUntil: 0,
      lockKind: null,
      role: null,
      riseIntervalTicks: interval,
      riseCountdown: interval === null ? Number.POSITIVE_INFINITY : interval,
      riseHeld: false,
      manualRiseEndTick: 0,
      graceRemaining: null,
      streakCount: 0,
      streakRemaining: 0,
      streakCutReserved: false,
      pinchWarn: { active: false, value: null },
      chainCount: 0,
      chainRemaining: 0,
      defeated: false,
      rng,
    };
  }

  private newRow(p: PlayerState, kind?: RiseKind): Piece[] {
    const fixed = kind ? this.rowSource?.(p.id, kind) : null;
    if (fixed) return fixed.map((k) => this.factory.make(k.n, k.suit));
    return Array.from({ length: 6 }, () => this.factory.create(p.rng));
  }

  /** 操作硬直中か（役処理中を含む） */
  isLocked(p: PlayerState): boolean {
    return this.tick < p.lockUntil || p.role !== null;
  }

  isMoving(p: PlayerState): boolean {
    return this.tick < p.charMoveEndTick;
  }

  /** 打上連鎖が有効か（V320-FIX-05：成功数で判定。受付残り時間は使わない） */
  streakActive(p: PlayerState): boolean {
    return p.streakCount > 0;
  }

  /** 成功時に設定する受付残り（tick）。null＝時間制限なし */
  private streakWindowTicks(): number | null {
    return this.config.streakWindowMs === null ? null : this.ticks(this.config.streakWindowMs);
  }

  /** 現在の打上連鎖の攻撃加算（V320-FIX-06。連鎖が無ければ0） */
  currentStreakBonus(p: PlayerState): number {
    return this.streakActive(p) ? streakAttackBonus(p.streakCount, this.config.streakAttackBonus) : 0;
  }

  /** 現在の得点倍率（シングル表示用。連鎖が無ければ×1） */
  currentScoreMultiplier(p: PlayerState): { num: number; den: number } {
    return scoreMultiplier(this.streakActive(p) ? p.streakCount : 0, this.balance);
  }

  /** 1tick進める。commands はこのtickに適用する入力 */
  step(commands: readonly Command[] = []): void {
    this.tick++;
    if (this.result) return; // 勝敗確定後はロジックを止める（表示のみ進む）
    this.processArrivals();
    this.processReturns();
    for (const p of this.players) this.advanceRole(p);
    this.flushSends();
    this.finalizeStageClear();
    if (this.result || !this.playing) return;
    for (const p of this.players) {
      const mine = commands.filter((c) => c.player === p.id);
      this.processInputs(p, mine);
    }
    // 連続取得・役連鎖の受付時間：自分の成立役の処理中は停止（不成立ペナルティ中は継続）
    if (!this.single?.clearPending) {
      for (const p of this.players) {
        if (p.role) continue;
        if (p.chainRemaining > 0) p.chainRemaining--;
        // 受付時間を設定した場合だけ時間切れがある（既定 null＝時間では切らない）
        if (p.streakRemaining !== null && p.streakRemaining > 0 && --p.streakRemaining === 0) this.endStreak(p, 'timeout');
      }
    }
    if (!this.single) {
      for (const p of this.players) this.processAttackPinch(p);
      for (const p of this.players) this.startIncomingBlock(p);
      for (const p of this.players) this.processAttackSteps(p);
    }
    for (const p of this.players) this.processRise(p);
    for (const p of this.players) this.updatePinchWarn(p);
    if (this.single && !this.players[0].board.isEmpty()) this.single.wasNonEmpty = true;
    this.resolveDefeat();
  }

  private emit(e: GameEvent): void {
    this.events.push(e);
  }

  // ---- 入力 ----

  /** v3.2.0 入力の予約・消費・破棄の記録（開発時の検査用。最新500件。ゲーム結果には影響しない） */
  readonly inputLog: InputLogEntry[] = [];

  private inputLogger(p: PlayerState) {
    return (e: Omit<InputLogEntry, 'tick' | 'player'>) => {
      this.inputLog.push({ tick: this.tick, player: p.id, ...e });
      if (this.inputLog.length > 500) this.inputLog.splice(0, this.inputLog.length - 500);
    };
  }

  /** 予約の破棄（ラウンド終了・画面遷移・フォーカス喪失など。呼出し側が理由を渡す） */
  clearInputBuffers(): void {
    for (const p of this.players) {
      if (p.buffered) this.inputLogger(p)({ event: 'discard', action: p.buffered, reason: 'state' });
      clearHeld(p);
    }
  }

  private processInputs(p: PlayerState, cmds: readonly Command[]): void {
    if (this.single?.clearPending) return; // ノルマ達成後は新たな操作を受け付けない
    const log = this.inputLogger(p);
    // v3.2.0 r：当該tickの解除・新規方向・同時押しを、旧予約の実行より先に反映する
    const now = resolveTick(p, cmds, !this.isMoving(p), log);
    if (p.buffered && !this.isMoving(p)) {
      // 次に移動できる最初のtick：有効な予約を1回だけ実行・消費（左右は受付から moveBufferTicks 以内）
      const a = take(p, this.tick, this.config.moveBufferTicks, log);
      // 保持規則は移動中だけ。移動終了時に別の操作禁止状態なら破棄する（長い硬直を横断して残さない）
      if (a) {
        if (this.isLocked(p) || p.defeated) log({ event: 'discard', action: a, reason: p.defeated ? 'state' : 'locked' });
        else if (MOVE_ACTIONS.has(a) && this.edgeBlocked(p, a)) log({ event: 'discard', action: a, reason: 'edge' });
        else {
          log({ event: 'consume', action: a });
          this.act(p, a);
        }
      }
    }
    for (const c of now) this.apply(p, c);
  }

  private edgeBlocked(p: PlayerState, a: Action): boolean {
    return (a === 'left' && p.selectedCol === 0) || (a === 'right' && p.selectedCol === 5);
  }

  private apply(p: PlayerState, c: Command): void {
    if (c.type === 'debugAttack') {
      if (!this.single) this.receiveAttack(p, c.lines, 'debug');
      return;
    }
    if (c.type === 'cancelRepeat') return release(p, this.inputLogger(p));
    if (p.defeated || this.isLocked(p)) return; // 発射中・上詰め/B入替中・不成立硬直中・役処理中は操作不可
    if (c.type === 'manualRise') return this.manualRise(p); // 保持対象外：移動中も即時（N5：既存挙動を維持）
    if (this.isMoving(p)) {
      if (BUFFERABLE.has(c.type)) offer(p, c.type, !!c.repeat, this.tick, this.inputLogger(p));
      return;
    }
    this.act(p, c.type);
  }

  private act(p: PlayerState, a: Action): void {
    switch (a) {
      case 'left':
      case 'right': {
        const to = Math.max(0, Math.min(5, p.selectedCol + (a === 'left' ? -1 : 1)));
        if (to === p.selectedCol) return;
        p.charMoveEndTick = this.tick + this.t.charMoveMs;
        this.emit({ type: 'move', tick: this.tick, player: p.id, from: p.selectedCol, to, endTick: p.charMoveEndTick });
        p.selectedCol = to;
        return;
      }
      case 'launch':
        return this.launch(p);
      case 'rotate':
        return this.rotate(p);
      case 'declare':
        return this.declare(p);
      case 'manualRise':
        return this.manualRise(p);
    }
  }

  private lock(p: PlayerState, ticks: number, kind: LockKind): void {
    const until = this.tick + ticks;
    if (until > p.lockUntil) {
      p.lockUntil = until;
      p.lockKind = kind;
    }
  }

  private launch(p: PlayerState): void {
    const col = p.selectedCol;
    const top = p.board.top(col);
    if (!top || top.kind !== 'piece') return; // 空列は無効入力（ペナルティなし）・帰還予約のある列は禁止
    const piece = p.board.reserveTop(col);
    const arriveTick = this.tick + this.t.launchMs;
    this.lock(p, this.t.launchMs, 'launch'); // 発射モーション＝操作硬直＝行きの飛行時間
    this.flights.push({ piece, player: p.id, col, launchTick: this.tick, arriveTick, state: 'outbound', returnEndTick: -1 });
    this.emit({ type: 'launch', tick: this.tick, player: p.id, col, piece, arriveTick });
  }

  private rotate(p: PlayerState): void {
    const col = p.selectedCol;
    const c = p.board.cols[col];
    if (c.length < 2 || p.board.hasReservation(col)) return; // 空列は無効入力・帰還予約のある列は禁止
    const ids = c.map((s) => (s.kind === 'piece' ? s.piece.id : s.pieceId));
    p.board.rotate(col);
    this.lock(p, this.t.rotateMs, 'rotate');
    this.emit({ type: 'rotate', tick: this.tick, player: p.id, col, movedId: ids[0], otherIds: ids.slice(1), endTick: this.tick + this.t.rotateMs });
  }

  private refreshRoleReady(p: PlayerState): void {
    const ready = evaluateStock(p.roleStock).kind === 'ok';
    if (ready && !p.roleReady) this.emit({ type: 'roleAvailable', tick: this.tick, player: p.id });
    p.roleReady = ready;
  }

  private declare(p: PlayerState): void {
    const ev = evaluateStock(p.roleStock);
    if (ev.kind !== 'ok') {
      if (ev.kind === 'too_few' && !this.config.declareBelowMinIsFailure) return;
      // 不成立：モーション・失敗効果音・約0.5秒の硬直。ストック維持、帰還継続、各タイマーは継続
      this.lock(p, this.t.declareFailLockMs, 'declareFail');
      this.emit({ type: 'declareFail', tick: this.tick, player: p.id, reason: ev.kind, lockEnd: p.lockUntil });
      return;
    }
    // 成立：自分の帰還中ピースをすべて瞬間帰還させてから役処理へ
    for (const f of this.flights.filter((x) => x.player === p.id && x.state === 'returning')) this.completeReturn(f, true);
    const consumed = p.roleStock;
    p.roleStock = []; // 採択外を含めストック全体を消費
    p.roleReady = false;
    p.chainCount = p.chainRemaining > 0 ? p.chainCount + 1 : 1;
    p.chainRemaining = this.ticks(this.config.chainWindowMs); // 成立ごとに受付時間を更新（処理中は停止）
    const streakNow = this.streakActive(p) ? p.streakCount : 0;
    const introEnd = this.tick + this.t.roleIntroMs;
    p.role = {
      result: ev.result,
      logos: roleLogoIndices(ev.result),
      startTick: this.tick,
      stage: 'intro',
      stageEnd: introEnd,
      linesPlanned: ev.result.clear, // V320-FIX-06：消去数は数値表の値（連鎖の影響を受けない）
      linesCleared: 0,
      chainCount: p.chainCount,
      streakCount: streakNow,
      scoreMul: this.currentScoreMultiplier(p),
    };
    clearHeld(p);
    this.emit({
      type: 'declare',
      tick: this.tick,
      player: p.id,
      result: ev.result,
      logos: p.role.logos,
      consumed,
      chainCount: p.chainCount,
      streak: streakNow,
      streakBonus: streakAttackBonus(streakNow, this.config.streakAttackBonus),
      introEndTick: introEnd,
    });
  }

  // ---- 役処理フェーズ ----

  private advanceRole(p: PlayerState): void {
    const r = p.role;
    if (!r || this.tick < r.stageEnd) return;
    switch (r.stage) {
      case 'intro':
      case 'shift':
        return this.nextLineOrAttack(p, r);
      case 'clear':
        r.stage = 'shift'; // 処理効果音 → 足場・キャラの段数推移TWEEN
        r.stageEnd = this.tick + this.t.lineShiftMs;
        return;
      case 'outro':
        p.role = null;
        this.emit({ type: 'roleEnd', tick: this.tick, player: p.id });
        return;
    }
  }

  /** 消去残数確認：残りがあり盤面が空でなければ1ライン消去、なければ攻撃処理へ */
  private nextLineOrAttack(p: PlayerState, r: RoleProcess): void {
    if (r.linesCleared < r.linesPlanned && !p.board.isEmpty()) {
      const heightBefore = p.board.height();
      const removed = p.board.removeTopRow();
      r.linesCleared++;
      r.stage = 'clear';
      r.stageEnd = this.tick + this.t.lineClearMs;
      this.emit({
        type: 'lineClear',
        tick: this.tick,
        player: p.id,
        index: r.linesCleared,
        planned: r.linesPlanned,
        removed,
        heightBefore,
        heightAfter: p.board.height(),
        clearEnd: r.stageEnd,
        shiftEnd: r.stageEnd + this.t.lineShiftMs,
      });
      if (this.single) {
        // 実行された1ライン：空マスを含め消去数6、得点は100×宣言時の得点倍率（盤面が空で実行されない分は加算しない）
        this.addScore(p, applyMultiplier(this.balance.scoring.actual_line_clear_base, r.scoreMul), 'line');
        this.addClearUnits(p, this.balance.units.actual_line_clear_event_clears);
        this.checkAllClear(p);
      }
      return;
    }
    // 攻撃計算 → 相殺 → 送信（盤面が空で予定ライン数を消せなくても基本攻撃量は減らさない）。
    // V320-FIX-06：基本攻撃数（数値表）＋打上連鎖加算＋役連鎖加算。採択役・両連鎖数は宣言時点のスナップショット
    const breakdown = computeAttack(r.result.baseAttack, r.streakCount, r.chainCount, this.config.chainBonusMax, this.config.streakAttackBonus);
    if (this.single) {
      // シングルは送り先がない（攻撃ストック・送信なし）
      this.emit({ type: 'attack', tick: this.tick, player: p.id, breakdown, counter: { usedPower: 0, canceled: 0, sent: 0, discarded: 0 }, linesCleared: r.linesCleared });
    } else {
      // 相殺の対象は次ブロック待機分（nextPending）だけ。現ブロック未消化分・進行中の波は相殺しない
      const counter = resolveCounter(breakdown.power, p.incoming.nextPending, this.config.counterPerLine);
      if (counter.canceled > 0) {
        cancelPending(p.incoming, counter.canceled);
        this.emit({ type: 'attackCancel', tick: this.tick, player: p.id, canceled: counter.canceled, total: totalIncoming(p.incoming), pending: p.incoming.nextPending });
      }
      if (counter.sent > 0) this.pendingSends.push({ to: (1 - p.id) as PlayerId, lines: counter.sent });
      this.emit({ type: 'attack', tick: this.tick, player: p.id, breakdown, counter, linesCleared: r.linesCleared });
    }
    r.stage = 'outro';
    r.stageEnd = this.tick + this.t.roleOutroMs;
  }

  /** 同一tickの送信は、双方の相殺計算が終わってから反映する（処理順で有利不利を作らない） */
  private flushSends(): void {
    const sends = this.pendingSends;
    this.pendingSends = [];
    for (const s of sends) this.receiveAttack(this.players[s.to], s.lines, 'receive');
  }

  /** 受信は役処理中でも nextPending へ即加算（上限29。超過分は上限超過として破棄）。ブロック開始の期限は延長しない */
  private receiveAttack(p: PlayerState, lines: number, cause: 'receive' | 'debug'): void {
    const r = receive(p.incoming, lines, this.tick, (ms) => this.ticks(ms), this.config.incoming);
    this.emit({ type: 'attackReceive', tick: this.tick, player: p.id, accepted: r.accepted, overflow: r.overflow, total: totalIncoming(p.incoming), cause });
  }

  // ---- シングル：消去数・得点・Lv・ステージ ----

  private addScore(p: PlayerState, delta: number, cause: ScoreCause): void {
    const s = this.single;
    if (!s || delta <= 0) return;
    s.score += delta;
    this.emit({ type: 'score', tick: this.tick, player: p.id, delta, total: s.score, cause });
  }

  /** 消去数の加算（成功1・実行された1ライン6）。ステージはノルマ、ひたすらはLv進捗 */
  private addClearUnits(p: PlayerState, units: number): void {
    const s = this.single;
    if (!s) return;
    s.totalClears += units;
    if (s.kind === 'stage') {
      s.progress += units;
      this.emit({ type: 'progress', tick: this.tick, player: p.id, units, total: s.progress });
      if (!s.clearPending && s.progress >= s.quota) {
        // ノルマ達成：クリア予約を1回だけ立てる。新たな操作・自然上昇・危険進行を止め、実行中の役は完了させる
        s.clearPending = true;
        this.emit({ type: 'quotaReached', tick: this.tick, player: p.id, stage: s.stage });
      }
      return;
    }
    const r = addLevelProgress(s.level, s.levelProgress, units, this.balance);
    s.level = r.level;
    s.levelProgress = r.progress;
    this.emit({ type: 'progress', tick: this.tick, player: p.id, units, total: s.totalClears });
    for (const lv of r.ups) this.emit({ type: 'levelUp', tick: this.tick, player: p.id, level: lv, max: lv >= this.balance.endless.max_level });
    if (r.ups.length > 0) {
      const ms = this.naturalIntervalMs();
      p.riseIntervalTicks = ms === null ? null : this.ticks(ms);
      // 昇格時は自然上昇の残時間を新Lvの全周期へ。危険猶予中・保留中はその状態を維持（延長・解除しない）
      if (p.riseIntervalTicks !== null && p.graceRemaining === null && !p.riseHeld) p.riseCountdown = p.riseIntervalTicks;
    }
  }

  /** 全消し：プレイ中の成功・実消去で盤面が非空→空へ変化した時に1回（予約・飛行の未解決時は確定させない） */
  private checkAllClear(p: PlayerState): void {
    const s = this.single;
    if (!s || !s.wasNonEmpty || !p.board.isEmpty()) return;
    if (this.flights.some((f) => f.player === p.id)) return;
    s.wasNonEmpty = false;
    const bonus = this.balance.scoring.all_clear_bonus;
    this.emit({ type: 'allClear', tick: this.tick, player: p.id, bonus, stageClearPending: s.clearPending });
    this.addScore(p, bonus, 'allClear');
  }

  /** クリア予約後、実行中の役処理が終わった時点でステージクリアを確定（ボーナス加算・結果） */
  private finalizeStageClear(): void {
    const s = this.single;
    if (!s || !s.clearPending || this.result) return;
    const p = this.players[0];
    if (p.role || p.defeated) return;
    const def = stageDef(s.stage, this.balance);
    const final = s.stage >= STAGE_COUNT;
    this.emit({ type: 'stageClear', tick: this.tick, player: p.id, stage: s.stage, bonus: def.stage_clear_bonus, final });
    this.addScore(p, def.stage_clear_bonus, 'stageClear');
    this.result = { winner: 0, tick: this.tick, outcome: final ? 'allStagesClear' : 'stageClear' };
    this.clearInputBuffers(); // v3.2.0 ラウンド終了で移動の予約を破棄
    this.emit({ type: 'roundEnd', tick: this.tick, winner: 0, outcome: this.result.outcome });
  }

  // ---- 上昇・危険・攻撃波 ----

  private addRows(p: PlayerState, rows: number, kind: RiseKind): void {
    const heightBefore = p.board.height();
    for (let i = 0; i < rows; i++) p.board.appendRow(this.newRow(p, kind));
    this.emit({
      type: 'rise',
      tick: this.tick,
      player: p.id,
      kind,
      rows,
      heightBefore,
      heightAfter: p.board.height(),
      endTick: kind === 'attack' ? this.tick : this.tick + this.t.riseMs,
    });
  }

  private manualRise(p: PlayerState): void {
    if (this.tick < p.manualRiseEndTick) return; // 手動上昇の重複は受け付けない
    if (p.board.height() + 1 > this.config.manualRiseMaxHeight) return;
    this.addRows(p, 1, 'manual');
    p.manualRiseEndTick = this.tick + this.t.riseMs;
  }

  private processRise(p: PlayerState): void {
    if (p.riseIntervalTicks === null || p.defeated) return;
    if (this.single?.clearPending) return; // ノルマ達成後は自然上昇・危険進行を止める
    const danger = this.config.dangerHeight;
    if (p.graceRemaining !== null && p.board.height() < danger) {
      // 猶予中に6段以下へ戻れば解除（成立役の消去による解除を含む）
      p.graceRemaining = null;
      if (!this.config.releaseExecutesHeldRise) {
        p.riseHeld = false;
        p.riseCountdown = p.riseIntervalTicks;
      }
      this.emit({ type: 'danger', tick: this.tick, player: p.id, state: 'release', graceEnd: this.tick });
    }
    if (p.role) return; // 成立役の処理中は自然上昇・危険猶予を停止
    if (p.graceRemaining !== null) {
      if (--p.graceRemaining <= 0) {
        // 猶予終了時も7段：8段目の追加直前に敗北（通常の上昇は実行しない）
        p.defeated = true;
        this.emit({ type: 'danger', tick: this.tick, player: p.id, state: 'defeat', graceEnd: this.tick });
      }
      return;
    }
    if (p.riseCountdown > 0) p.riseCountdown--;
    // 手動上昇完了時：残り時間を max(現在の残り時間, 最低間隔) へ補正（通常周期へはリセットしない）
    if (this.tick === p.manualRiseEndTick) p.riseCountdown = Math.max(p.riseCountdown, this.ticks(this.config.riseMinGapMs));
    if (p.riseCountdown > 0) return;
    if (this.tick < p.manualRiseEndTick) return; // 手動上昇中は自然上昇の実行を待機（重ねて実行しない）
    if (p.board.height() >= danger) {
      // 7段のまま自然上昇時刻：上昇を保留し、危険猶予（4000ms）を開始
      p.riseHeld = true;
      p.graceRemaining = this.ticks(this.config.dangerGraceMs);
      this.emit({ type: 'danger', tick: this.tick, player: p.id, state: 'grace', graceEnd: this.tick + p.graceRemaining });
      return;
    }
    p.riseHeld = false;
    this.addRows(p, 1, 'natural');
    p.riseCountdown = p.riseIntervalTicks;
  }

  /** 攻撃ピンチ猶予（第8章）：6段以下へ下がれば解除。進行・停止は既存の危険猶予と同じく自分の役処理中は停止 */
  private processAttackPinch(p: PlayerState): void {
    const s = p.incoming;
    if (p.defeated || s.pinchRemaining === null) return;
    if (p.board.height() < this.config.incoming.pinchHeight) {
      s.pinchRemaining = null;
      this.emit({ type: 'attackPinch', tick: this.tick, player: p.id, state: 'release', graceEnd: this.tick });
      return;
    }
    if (p.role) return;
    if (--s.pinchRemaining <= 0) {
      p.defeated = true;
      this.emit({ type: 'attackPinch', tick: this.tick, player: p.id, state: 'defeat', graceEnd: this.tick });
    }
  }

  /** 攻撃ピンチ猶予の開始。すでに猶予中なら期限を再設定・延長しない */
  private startAttackPinch(p: PlayerState): void {
    const s = p.incoming;
    if (s.pinchRemaining !== null) return;
    s.pinchRemaining = this.ticks(this.config.incoming.pinchGraceMs);
    this.emit({ type: 'attackPinch', tick: this.tick, player: p.id, state: 'grace', graceEnd: this.tick + s.pinchRemaining });
  }

  /** 受攻撃ブロックの開始（第9章 手順6）：開始境界の nextPending 全量を現ブロックへ */
  private startIncomingBlock(p: PlayerState): void {
    if (p.defeated) return;
    const lines = tryStartBlock(p.incoming, this.tick);
    if (lines !== null) this.emit({ type: 'blockStart', tick: this.tick, player: p.id, blockId: p.incoming.blockId, lines });
  }

  /**
   * 攻撃段の適用（第7・8章）：波は最大3段、波内は400ms周期（1段目0ms）、前波の最後の実適用から次波の最初まで450ms以上。
   * 1回の呼出しで適用するのは最大1段（期限超過分を同tickにまとめない）。自分の役処理中は保留。
   * 7段（ピンチライン）の間は新しく適用せず、攻撃ピンチ猶予を開始する（未適用分は保持）。
   * 1段の適用で7段に達したら、同じ波の残りだけを破棄する（現ブロック残量・nextPending は保持）。
   */
  private processAttackSteps(p: PlayerState): void {
    const s = p.incoming;
    const cfg = this.config.incoming;
    if (p.defeated) return;
    if (s.waveRemaining === 0) {
      const n = tryStartWave(s, cfg);
      if (n !== null) this.emit({ type: 'waveStart', tick: this.tick, player: p.id, blockId: s.blockId, waveId: s.waveId, lines: n });
    }
    if (s.waveRemaining > 0 && this.tick >= s.nextStepTick && !p.role) {
      if (p.board.height() >= cfg.pinchHeight) {
        this.startAttackPinch(p);
      } else {
        const heightBefore = p.board.height();
        this.addRows(p, 1, 'attack');
        const row = p.board.cols.map((c) => {
          const last = c[c.length - 1];
          return last.kind === 'piece' ? last.piece.id : last.pieceId;
        });
        s.waveRemaining--;
        s.stats.applied++;
        const step = s.waveStep++;
        s.nextStepTick = this.tick + this.ticks(s.waveRemaining > 0 ? cfg.stepIntervalMs : cfg.waveGapMs);
        this.emit({
          type: 'attackRow',
          tick: this.tick,
          player: p.id,
          blockId: s.blockId,
          waveId: s.waveId,
          step,
          firstOfWave: step === 0,
          heightBefore,
          heightAfter: p.board.height(),
          rowIds: row,
          total: totalIncoming(s),
        });
        if (p.board.height() >= cfg.pinchHeight) {
          s.stats.pinchReached++;
          if (s.waveRemaining > 0) {
            const lines = s.waveRemaining;
            s.waveRemaining = 0;
            s.stats.pinchDiscarded += lines;
            this.emit({ type: 'attackDiscard', tick: this.tick, player: p.id, waveId: s.waveId, lines, reason: 'pinch', total: totalIncoming(s), block: s.blockRemaining + s.waveRemaining });
          }
          this.startAttackPinch(p);
        }
      }
    }
    if (tryEndBlock(s, this.tick, (ms) => this.ticks(ms), cfg)) this.emit({ type: 'blockEnd', tick: this.tick, player: p.id, blockId: s.blockId, pending: s.nextPending });
  }

  private resolveDefeat(): void {
    const lost = this.players.filter((p) => p.defeated);
    if (lost.length === 0) return;
    if (this.single) {
      this.result = { winner: null, tick: this.tick, outcome: 'gameOver' };
      this.clearInputBuffers(); // v3.2.0 ラウンド終了で移動の予約を破棄
      this.emit({ type: 'roundEnd', tick: this.tick, winner: null, outcome: 'gameOver' });
      return;
    }
    const winner = lost.length === 2 ? null : ((1 - lost[0].id) as PlayerId);
    this.result = { winner, tick: this.tick, outcome: winner === null ? 'draw' : 'win' };
    this.clearInputBuffers(); // v3.2.0 ラウンド終了で移動の予約を破棄
    this.emit({ type: 'roundEnd', tick: this.tick, winner, outcome: this.result.outcome });
  }

  /** v3.1.0：打ち上げ成功連鎖の終了（成功数0・倍率等倍・予約解除）。役成立連鎖には触れない */
  private endStreak(p: PlayerState, reason: 'miss' | 'timeout'): void {
    const count = p.streakCount;
    p.streakCount = 0;
    p.streakRemaining = 0;
    p.streakCutReserved = false;
    this.emit({ type: 'streakCut', tick: this.tick, player: p.id, state: 'ended', reason, count });
  }

  /** 有効な残り猶予（tick）：自然上昇の危険猶予と攻撃ピンチ猶予の早い方。どちらも無ければ null */
  pinchRemainingTicks(p: PlayerState): number | null {
    const xs = [p.graceRemaining, p.incoming.pinchRemaining].filter((x): x is number => x !== null);
    return xs.length ? Math.max(0, Math.min(...xs)) : null;
  }

  /**
   * v3.1.0 ピンチ警告：有効な残り猶予に同期して開始・3/2/1・終了を通知する（壁時計ではなくゲーム側の残り猶予）。
   * 通常の危険猶予から攻撃ピンチへ移っただけでは start を出し直さない。後から始まった猶予で先行する期限を延ばさない（早い方を採る）
   */
  private updatePinchWarn(p: PlayerState): void {
    const w = p.pinchWarn;
    const rest = p.defeated ? null : this.pinchRemainingTicks(p);
    if (rest === null) {
      if (w.active) {
        p.pinchWarn = { active: false, value: null };
        this.emit({ type: 'pinchWarn', tick: this.tick, player: p.id, state: 'end', value: null, remainingMs: null });
      }
      return;
    }
    if (!w.active) {
      p.pinchWarn = { active: true, value: null };
      this.emit({ type: 'pinchWarn', tick: this.tick, player: p.id, state: 'start', value: null, remainingMs: rest * this.tickMs });
    }
    // 残り 3000ms 以下で 3、2000ms 以下で 2、1000ms 以下で 1（浮動小数の誤差を避けて tick で比較）
    const step = (n: number) => rest <= this.ticks(n * 1000);
    const value = rest > 0 ? (step(1) ? 1 : step(2) ? 2 : step(3) ? 3 : null) : null;
    if (value !== null && value !== p.pinchWarn.value) {
      p.pinchWarn = { active: true, value };
      this.emit({ type: 'pinchWarn', tick: this.tick, player: p.id, state: 'count', value, remainingMs: rest * this.tickMs });
    }
  }

  // ---- 到達・帰還 ----

  private processArrivals(): void {
    const arriving = this.flights
      .filter((f) => f.state === 'outbound' && f.arriveTick === this.tick)
      .sort((a, b) => a.player - b.player || a.launchTick - b.launchTick);
    for (const f of arriving) {
      const p = this.players[f.player];
      const baseBefore = this.base;
      const success = isLaunchSuccess(f.piece, this.base); // 到達時点の（更新後の）基準で判定
      const heightBefore = p.board.height();
      let packedIds: number[] = [];
      let discarded: Piece | null = null;
      let packEndTick = this.tick;
      if (success) {
        this.base = f.piece; // 基準を即更新（SNAP）
        const r = pushRoleStock(p.roleStock, f.piece);
        p.roleStock = r.stock;
        discarded = r.discarded;
        // 打上連鎖：成功で+1（V320-FIX-05：時間では切れない。失敗では更新・リセットしない）
        // 予約中の成功も成功数を増やす（予約・ヒビは解除しない）
        // V320-FIX-06：上限99（到達後の成功は99のまま。攻撃加算は増えない）
        p.streakCount = this.streakActive(p) ? Math.min(p.streakCount + 1, this.config.streakMaxCount) : 1;
        p.streakRemaining = this.streakWindowTicks();
        p.board.releaseReservation(f.col, f.piece.id);
        packedIds = p.board.cols[f.col].map((s) => (s.kind === 'piece' ? s.piece.id : s.pieceId));
        packEndTick = this.tick + this.t.packMs;
        this.lock(p, this.t.packMs, 'pack'); // 上詰め中はプレイヤー全体の操作を短時間制限
        this.flights.splice(this.flights.indexOf(f), 1);
      } else {
        f.state = 'returning';
        f.returnEndTick = this.tick + this.t.bounceMs + this.t.arcMs + this.t.descendMs;
      }
      const streakBefore = p.streakCount;
      this.emit({
        type: 'arrive',
        tick: this.tick,
        player: p.id,
        col: f.col,
        piece: f.piece,
        success,
        baseBefore,
        packedIds,
        packEndTick,
        heightBefore,
        heightAfter: p.board.height(),
        arcStartTick: this.tick + this.t.bounceMs,
        arcEndTick: this.tick + this.t.bounceMs + this.t.arcMs,
        returnEndTick: f.returnEndTick,
        discarded,
        streak: success ? p.streakCount : 0,
      });
      // v3.1.0 連鎖切り予約：ミスの反発が確定した時点（到達時の判定）で処理。受付時間は更新しない。
      // 連鎖が有効でない状態のミスは何もしない（次の新しい連鎖へ予約を持ち越さない）
      if (!success && this.streakActive(p)) {
        if (p.streakCutReserved) this.endStreak(p, 'miss');
        else {
          p.streakCutReserved = true;
          this.emit({ type: 'streakCut', tick: this.tick, player: p.id, state: 'reserved', reason: 'miss', count: streakBefore });
        }
      }
      if (success) {
        this.refreshRoleReady(p);
        if (this.single) {
          // 成功確定で1回：10点×成功後の連続取得数に対応する得点倍率、消去数1
          this.addScore(p, applyMultiplier(this.balance.scoring.successful_launch_base, scoreMultiplier(p.streakCount, this.balance)), 'launch');
          this.addClearUnits(p, this.balance.units.launch_success_clears);
          this.checkAllClear(p);
        }
      }
    }
  }

  private completeReturn(f: Flight, instant: boolean): void {
    this.players[f.player].board.fillReservation(f.col, f.piece);
    this.flights.splice(this.flights.indexOf(f), 1);
    this.emit({ type: 'returned', tick: this.tick, player: f.player, col: f.col, piece: f.piece, instant });
  }

  private processReturns(): void {
    for (const f of this.flights.filter((x) => x.state === 'returning' && x.returnEndTick === this.tick)) this.completeReturn(f, false);
  }

  /** 決定性検証用：ゲーム結果に関わる状態の要約 */
  snapshot(): string {
    return JSON.stringify({
      tick: this.tick,
      base: this.base,
      result: this.result,
      single: this.single,
      flights: this.flights.map((f) => [f.piece.id, f.player, f.col, f.state, f.arriveTick, f.returnEndTick]),
      players: this.players.map((p) => ({
        cols: p.board.cols.map((c) => c.map((s) => (s.kind === 'piece' ? `${s.piece.id}:${s.piece.n}${s.piece.suit[0]}` : `R${s.pieceId}`))),
        stock: p.roleStock.map((x) => x.id),
        inc: [p.incoming.nextPending, p.incoming.blockRemaining, p.incoming.waveRemaining, p.incoming.blockActive, p.incoming.nextBlockTick, p.incoming.nextStepTick, p.incoming.pinchRemaining],
        sel: p.selectedCol,
        lock: p.lockUntil,
        role: p.role ? [p.role.stage, p.role.stageEnd, p.role.linesCleared] : null,
        rise: p.riseCountdown,
        grace: p.graceRemaining,
        streak: [p.streakCount, p.streakRemaining],
        chain: [p.chainCount, p.chainRemaining],
      })),
    });
  }
}
