// V320-MEASURE-01 実プレイ計測の記録器（計測用ビルドだけが生成する。通常ビルドでは使わない）。
// 方針：
// - 既存の入力取得（PadSource・キーイベント・各 Controller.poll）と既存のゲーム処理をそのまま使い、その前後で読むだけ。
//   取得ループ・入力処理を別に作らず、コマンドの順番・回数・予約の挙動を変えない。
// - 1件の記録＝1行の JSON 文字列（共通キー：s 連番／t セッション経過ms（performance.now 基準）／f 描画フレーム連番／
//   m 試合ID／r ラウンドID／k ラウンド内ゲームtick／e 種類／d 内容）。ラウンドが変わって k が 0 へ戻っても s・t で全体の順序が分かる。
// - 状態は「ラウンド開始の全体スナップショット＋変化した項目だけの差分＋10秒ごとの確認用スナップショット」。
// - 上限に近づいたら通知し、上限で計測を停止する（古い記録を黙って捨てない）。外部へは送信しない。
import type { Command, Game, GameEvent, InputTraceEntry, PlayerState } from '../core/game';
import { evaluateStock, roleLogoIndices } from '../core/roles';
import type { StepInfo } from '../core/driver';
import type { PadSource, PadState } from '../input/controller';
import type { PlayerId } from '../core/types';
import { DEFAULT_LAUNCH_PROFILE, profileReport, type LaunchProfileId } from './profile';

export const MEASURE_FORMAT = 'kotaro-puzzle-measure';
export const MEASURE_FORMAT_VERSION = 1;
export const MEASURE_WORK_ID = 'V320-MEASURE-01';
export const MEASURE_BASE_COMMIT = '028ddb7084527646c6f31be5b95c17441165cbbd';

export type MeasureState = 'idle' | 'recording' | 'stopped';

/** パッドの記録の間引き（取得値は変えない。記録だけを変化判定で間引く） */
export const PAD_RECORD = {
  /** ボタンの value（アナログ）：pressed の変化は常に記録。value は0.01に丸め、前回記録から0.05以上の変化だけ記録 */
  buttonValueStep: 0.05,
  /** スティック：0.001に丸め、前回記録から0.02以上の変化と、0への復帰だけ記録 */
  axisStep: 0.02,
  /** 方向判定：ゲーム操作（GamepadController）・メニュー操作（MenuInput）と同じ閾値 0.5（絶対値が超えたら入力） */
  axisThreshold: 0.5,
} as const;

/**
 * 記録の上限。開発環境の測定（ゲーム時間20分・乱数入力約3.6操作/秒）で約3.7万件・約6.2MB（上限の約9％）。
 * 上限はメモリ（文字列で約100MB）を抑えつつ20分の約8倍の余裕。上限の80％で通知、上限で停止（古い記録は消さない）
 */
export const RECORD_LIMIT = { maxRecords: 300_000, maxChars: 50_000_000, warnRatio: 0.8 } as const;

/** 確認用スナップショットの間隔（tick） */
export const SNAPSHOT_EVERY_TICKS = 600;

/** 処理遅延として記録するフレーム間隔（ms） */
export const FRAME_GAP_MS = 50;

export interface MeasureMatchInfo {
  mode: string;
  kind: string;
  singleMode?: string;
  characters: readonly string[];
  devices: readonly unknown[];
  humans: readonly number[];
  difficulty?: string;
  firstTo?: number;
  seed: number;
  profile: LaunchProfileId | 'none';
}

export type CmdSource = 'pad' | 'keyboard' | 'cpu' | 'other';

interface PadCache {
  id: string;
  mapping: string;
  bp: boolean[];
  bv: number[];
  av: number[];
  ad: number[];
}

/** 画面表示用の直近の状態（記録していないときも更新する） */
export interface MeasureLive {
  lastExecuted: { player: number; action: string; tick: number; at: number } | null;
  lastDiscard: { player: number; action: string; reason: string; tick: number; at: number } | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

const isPiece = (v: Record<string, unknown>) => typeof v.id === 'number' && typeof v.n === 'number' && typeof v.suit === 'string' && Object.keys(v).length <= 3;
const pieceStr = (v: { id: number; n: number; suit: string }) => `${v.n}${v.suit[0]}#${v.id}`;

/** 記録用に値を小さくする（ピース→「4s#12」、役判定結果→要点だけ）。関数は捨てる */
export function compact(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.map((x) => compact(x, depth + 1));
  const o = v as Record<string, unknown>;
  if (isPiece(o)) return pieceStr(o as { id: number; n: number; suit: string });
  if ('subset' in o && 'indices' in o && 'clear' in o) {
    return { nr: o.numberRole, sr: o.suitRole, color: o.color, clear: o.clear, attack: o.baseAttack, size: o.size, idx: o.indices, pieces: compact(o.subset, depth + 1) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === 'type') continue;
    const c = compact(x, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

const boardStr = (p: PlayerState): string =>
  p.board.cols.map((c) => c.map((s) => (s.kind === 'piece' ? pieceStr(s.piece as { id: number; n: number; suit: string }) : `R#${s.pieceId}`)).join(',')).join('/');

export class MeasureRecorder {
  state: MeasureState = 'idle';
  sessionId: string | null = null;
  /** セッション開始の performance.now（記録の t の基準） */
  private startPerf = 0;
  private readonly lines: string[] = [];
  private chars = 0;
  private seq = 0;
  frameSeq = 0;
  private segment = 0;
  readonly segments: { start: number; stop: number | null }[] = [];
  saved = false;
  savedFile: string | null = null;
  warned = false;
  /** 上限で停止した */
  limitStopped = false;

  /** 開始前設定（次の新しいゲームから適用） */
  profile: LaunchProfileId = DEFAULT_LAUNCH_PROFILE;
  showInput = true;
  showSession = true;

  private matchId = 0;
  private roundId = 0;
  private game: Game | null = null;
  private matchInfo: MeasureMatchInfo | null = null;
  private eventCursor = 0;
  private lastSnapshotTick = 0;
  private prevState = new Map<string, string>();
  private readonly cmdIds = new WeakMap<object, number>();
  private cmdSeq = 0;
  private readonly padCache = new Map<number, PadCache>();
  /** 最後に読んだパッドの状態（表示用。記録の有無に関係なく参照を保持するだけ） */
  readonly padLive = new Map<number, PadState | null>();
  readonly live: MeasureLive = { lastExecuted: null, lastDiscard: null };
  /** 人間のプレイヤー（表示の対象） */
  humans: readonly number[] = [];
  /** 通知（画面上部の一時通知へ渡す） */
  onNotice: (msg: string) => void = () => undefined;
  /** 未保存の記録があるか */
  get unsaved(): boolean {
    return this.lines.length > 0 && !this.saved;
  }

  constructor(
    readonly build: { commit: string; builtAt: string; mode: string } = { commit: 'unknown', builtAt: 'unknown', mode: 'measure' },
    private readonly now: () => number = () => performance.now(),
    readonly limits: { maxRecords: number; maxChars: number; warnRatio: number } = RECORD_LIMIT,
  ) {}

  get recording(): boolean {
    return this.state === 'recording';
  }

  get count(): number {
    return this.lines.length;
  }

  get sizeChars(): number {
    return this.chars;
  }

  /** セッション経過（ms）。記録が無ければ0 */
  elapsedMs(): number {
    return this.sessionId === null ? 0 : this.now() - this.startPerf;
  }

  // ---------------------------------------------------------------- 記録の基本

  private write(e: string, d: unknown, k: number | null = this.game ? this.game.tick : null): void {
    if (this.state !== 'recording') return;
    const rec = { s: this.seq++, t: r1(this.now() - this.startPerf), f: this.frameSeq, m: this.matchId, r: this.roundId, k, e, d };
    const line = JSON.stringify(rec);
    this.lines.push(line);
    this.chars += line.length + 2;
    this.saved = false;
    const ratio = Math.max(this.lines.length / this.limits.maxRecords, this.chars / this.limits.maxChars);
    if (!this.warned && ratio >= this.limits.warnRatio) {
      this.warned = true;
      this.onNotice(`計測記録が上限の${Math.round(this.limits.warnRatio * 100)}％に達しました。区切りで計測を停止して保存してください`);
    }
    if (ratio >= 1 && !this.limitStopped) {
      this.limitStopped = true;
      this.stop('limit');
      this.onNotice('計測記録が上限に達したため計測を停止しました（記録は保持しています）。計測メニューから保存してください');
    }
  }

  /** 計測開始（停止中なら同じセッションへ追記して再開） */
  start(env: Record<string, unknown> = {}): void {
    if (this.state === 'recording' || this.limitStopped) return;
    if (this.sessionId === null) {
      this.sessionId = makeSessionId(new Date());
      this.startPerf = this.now();
      this.seq = 0;
    }
    this.state = 'recording';
    this.segment++;
    this.segments.push({ start: r1(this.now() - this.startPerf), stop: null });
    this.padCache.clear(); // 開始時点のパッドの全状態を記録し直す
    this.write('measureStart', { segment: this.segment, profile: this.profile, profiles: { A: profileReport('A'), B: profileReport('B') }, env, wallClock: new Date().toISOString() }, null);
    // 試合の途中から開始・再開した場合は、試合情報とラウンドの全体（設定・tick換算・盤面）を記録し直す（IDは変えない）
    if (this.matchInfo) this.write('matchStart', this.matchData(this.matchInfo, 'measureStart'), null);
    if (this.game) {
      this.prevState.clear();
      this.eventCursor = this.game.events.length;
      this.write('roundStart', { why: 'measureStart', ...this.roundData(this.game) });
      this.lastSnapshotTick = this.game.tick;
    }
  }

  stop(reason: 'user' | 'limit' = 'user'): void {
    if (this.state !== 'recording') return;
    this.write('measureStop', { segment: this.segment, reason }, null);
    this.state = 'stopped';
    const seg = this.segments[this.segments.length - 1];
    if (seg) seg.stop = r1(this.now() - this.startPerf);
  }

  /** 明示的な初期化（未保存の確認は呼出し側の画面で行う） */
  clear(): void {
    this.state = 'idle';
    this.sessionId = null;
    this.lines.length = 0;
    this.chars = 0;
    this.seq = 0;
    this.segment = 0;
    this.segments.length = 0;
    this.saved = false;
    this.savedFile = null;
    this.warned = false;
    this.limitStopped = false;
    this.padCache.clear();
  }

  // ---------------------------------------------------------------- 環境・フレーム

  beginFrame(dtMs: number): void {
    this.frameSeq++;
    if (dtMs > FRAME_GAP_MS) this.write('frameGap', { dtMs: r1(dtMs) });
  }

  visibility(hidden: boolean, focused: boolean, cause: string): void {
    this.write('visibility', { hidden, focused, cause });
  }

  scene(name: string, inGame: boolean): void {
    this.write('scene', { name });
    if (!inGame) this.matchLeave();
  }

  note(kind: string, d: Record<string, unknown> = {}): void {
    this.write(kind, d);
  }

  padConnection(connected: boolean, index: number, id: string, mapping: string): void {
    this.write(connected ? 'padConnected' : 'padDisconnected', { i: index, id, mapping });
  }

  key(down: boolean, code: string, repeat: boolean, at: number | null): void {
    this.write(down ? 'keyDown' : 'keyUp', { code, repeat, at: at === null ? null : r1(at - this.startPerf) });
  }

  // ---------------------------------------------------------------- パッド（既存の取得を包む）

  /** 既存の PadSource を包む：同じ値を返し、記録中だけ前回記録からの変化を記録する（取得回数・値は変えない） */
  wrapPadSource(src: PadSource): PadSource {
    return (index) => {
      const s = src(index);
      this.padLive.set(index, s);
      if (this.state === 'recording') this.observePad(index, s);
      return s;
    };
  }

  observePad(index: number, s: PadState | null): void {
    const c = this.padCache.get(index);
    if (!s) {
      if (c) {
        this.write('padGone', { i: index });
        this.padCache.delete(index);
      }
      return;
    }
    const g = s as unknown as { id?: string; mapping?: string; timestamp?: number; buttons: ReadonlyArray<{ pressed: boolean; value?: number }>; axes: ReadonlyArray<number> };
    const id = g.id ?? '';
    const ts = typeof g.timestamp === 'number' && g.timestamp > 0 ? r1(g.timestamp - this.startPerf) : null; // Gamepad.timestamp（実装差あり。参考の生値）
    let cache = c;
    if (!cache || cache.id !== id) {
      cache = { id, mapping: g.mapping ?? '', bp: [], bv: [], av: [], ad: [] };
      this.padCache.set(index, cache);
      this.write('padInfo', { i: index, id, mapping: g.mapping ?? '', buttons: g.buttons.length, axes: g.axes.length, ts });
    }
    g.buttons.forEach((b, i) => {
      const pressed = !!b?.pressed;
      const v = Math.round((typeof b?.value === 'number' ? b.value : pressed ? 1 : 0) * 100) / 100;
      const pp = cache.bp[i];
      if (pp === undefined || pp !== pressed || Math.abs(v - cache.bv[i]) >= PAD_RECORD.buttonValueStep) {
        // 初回観測で離しているボタンは記録しない（押しているものだけ。以後は変化ごと）
        if (pp !== undefined || pressed || v > 0) this.write('padBtn', { i: index, b: i, p: pressed ? 1 : 0, v, ts });
        cache.bp[i] = pressed;
        cache.bv[i] = v;
      }
    });
    g.axes.forEach((raw, j) => {
      const v = Math.round((raw ?? 0) * 1000) / 1000;
      const pv = cache.av[j];
      if (pv === undefined || Math.abs(v - pv) >= PAD_RECORD.axisStep || (v === 0 && pv !== 0)) {
        this.write('padAxis', { i: index, a: j, v, ts });
        cache.av[j] = v;
      }
      const d = v > PAD_RECORD.axisThreshold ? 1 : v < -PAD_RECORD.axisThreshold ? -1 : 0;
      if (cache.ad[j] === undefined ? d !== 0 : cache.ad[j] !== d) this.write('padDir', { i: index, a: j, dir: d, raw: v, ts });
      cache.ad[j] = d;
    });
  }

  // ---------------------------------------------------------------- 試合・ラウンド・コマンド

  matchStart(info: MeasureMatchInfo): void {
    this.matchId++;
    this.roundId = 0;
    this.game = null;
    this.humans = info.humans;
    this.matchInfo = info;
    this.write('matchStart', this.matchData(info, 'new'), null);
  }

  private matchData(info: MeasureMatchInfo, why: 'new' | 'measureStart'): Record<string, unknown> {
    return { why, ...info, profileReport: info.profile === 'none' ? null : profileReport(info.profile) };
  }

  /** ゲーム画面を離れた（試合の終わり）。以後の開始で古い試合情報を書かない */
  private matchLeave(): void {
    if (!this.matchInfo && !this.game) return;
    this.write('matchLeave', {}, null);
    this.matchInfo = null;
    this.game = null;
  }

  /** 各tickの前（GameScene.step）：新しいラウンドの検出と観測の接続 */
  beforeTick(game: Game): void {
    if (game !== this.game) this.roundStart(game);
    if (game.trace !== this.traceFn) game.trace = this.traceFn;
  }

  private roundStart(game: Game): void {
    this.game = game;
    this.roundId++;
    this.eventCursor = game.events.length;
    this.prevState.clear();
    this.lastSnapshotTick = game.tick;
    this.write('roundStart', { why: 'new', ...this.roundData(game) });
  }

  private roundData(game: Game): Record<string, unknown> {
    return {
      seed: game.seed,
      single: game.single ? { kind: game.single.kind, stage: game.single.stage, level: game.single.level } : null,
      config: { timing: game.config.timing, naturalRiseIntervalMs: game.config.naturalRiseIntervalMs, moveBufferTicks: game.config.moveBufferTicks, chainWindowMs: game.config.chainWindowMs, counterPerLine: game.config.counterPerLine, dangerGraceMs: game.config.dangerGraceMs },
      timingTicks: { ...(game as unknown as { t: Record<string, number> }).t },
      playStartTick: game.playStartTick,
      ...this.snapshot(game),
    };
  }

  /** コントローラーから受けたコマンド（ゲームへ渡す前）。id を付けて記録 */
  command(cmd: Command, src: CmdSource, info?: StepInfo, extra: Record<string, unknown> = {}): number {
    const id = ++this.cmdSeq;
    this.cmdIds.set(cmd, id);
    this.write('cmd', { id, p: cmd.player, a: cmd.type, rep: 'repeat' in cmd && cmd.repeat ? 1 : 0, src, at: info?.at == null ? null : r1(info.at - this.startPerf), last: info ? info.last : null, ...extra });
    return id;
  }

  /** ゲームへ渡さずに捨てたコマンド（確認ダイアログ中・結果表示中・開始前待機・フォーカス喪失） */
  dropCommand(cmd: Command, reason: string): void {
    this.write('cmdDrop', { id: this.cmdIds.get(cmd) ?? null, p: cmd.player, a: cmd.type, reason });
  }

  readonly traceFn = (e: InputTraceEntry): void => {
    const id = e.cmd ? (this.cmdIds.get(e.cmd) ?? null) : null;
    if (e.kind === 'execute') this.live.lastExecuted = { player: e.player, action: e.action, tick: e.tick, at: this.now() };
    if (e.kind === 'reject' || e.kind === 'discard' || e.kind === 'drop') this.live.lastDiscard = { player: e.player, action: e.action, reason: e.reason ?? '', tick: e.tick, at: this.now() };
    if (this.state !== 'recording') return;
    this.write('in', { id, p: e.player, kind: e.kind, a: e.action, reason: e.reason ?? null, ...(e.detail ? { d: e.detail } : {}) }, e.tick);
  };

  /** 各tickの後：ゲームイベントと状態の差分 */
  afterTick(game: Game): void {
    if (game !== this.game) this.roundStart(game);
    if (this.state !== 'recording') {
      this.eventCursor = game.events.length;
      return;
    }
    const ev = game.events as GameEvent[];
    for (; this.eventCursor < ev.length; this.eventCursor++) {
      const x = ev[this.eventCursor];
      this.write('ev', { type: x.type, ...(compact(x) as Record<string, unknown>) }, x.tick);
    }
    this.diffState(game);
    if (game.tick - this.lastSnapshotTick >= SNAPSHOT_EVERY_TICKS) {
      this.lastSnapshotTick = game.tick;
      this.write('snapshot', { why: 'periodic', ...this.snapshot(game) });
    }
  }

  // ---------------------------------------------------------------- 状態

  private playerFields(game: Game, p: PlayerState): Record<string, unknown> {
    const ev = evaluateStock(p.roleStock);
    return {
      col: p.selectedCol,
      lock: game.lockReason(p),
      lockUntil: game.lockReason(p) === 'none' ? null : p.lockUntil,
      moving: game.isMoving(p) ? p.charMoveEndTick : null,
      buf: p.buffered ? `${p.buffered}@${p.bufferedTick}${p.bufferedRepeat ? 'r' : ''}` : null,
      stock: p.roleStock.map((x) => pieceStr(x as { id: number; n: number; suit: string })).join(','),
      avail: ev.kind === 'ok' ? { logos: roleLogoIndices(ev.result), clear: ev.result.clear, attack: ev.result.baseAttack, idx: ev.result.indices } : ev.kind,
      roleStage: p.role ? p.role.stage : null,
      streak: game.streakActive(p) ? p.streakCount : 0,
      crack: p.streakCutReserved,
      chain: p.chainRemaining > 0 ? p.chainCount : 0,
      grace: p.graceRemaining,
      pinch: p.incoming.pinchRemaining,
      inc: `${p.incoming.blockActive ? 1 : 0}/${p.incoming.blockRemaining}/${p.incoming.waveRemaining}/${p.incoming.nextPending}`,
      board: boardStr(p),
      defeated: p.defeated,
    };
  }

  /** 毎tick値が変わる残り時間（chainRemaining など）は差分に入れず、変化時に値を添える */
  private diffState(game: Game): void {
    const base = `${pieceStr(game.base as { id: number; n: number; suit: string })}`;
    if (this.prevState.get('base') !== base) {
      this.prevState.set('base', base);
      this.write('st', { base });
    }
    for (const p of game.players) {
      const f = this.playerFields(game, p);
      const changed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f)) {
        const key = `${p.id}.${k}`;
        // 残り時間（grace・pinch）は有無の変化だけを差分にする（値は変化時に添える）
        const sig = k === 'grace' || k === 'pinch' ? String(v !== null) : JSON.stringify(v);
        if (this.prevState.get(key) !== sig) {
          this.prevState.set(key, sig);
          changed[k] = v;
        }
      }
      if (Object.keys(changed).length) {
        if ('chain' in changed) changed.chainRemaining = p.chainRemaining;
        this.write('st', { p: p.id, ...changed });
      }
    }
    if (game.single) {
      const s = game.single;
      const sig = `${s.score}/${s.level}/${s.progress}/${s.stage}`;
      if (this.prevState.get('single') !== sig) {
        this.prevState.set('single', sig);
        this.write('st', { single: { score: s.score, level: s.level, progress: s.progress, stage: s.stage, totalClears: s.totalClears } });
      }
    }
  }

  snapshot(game: Game): Record<string, unknown> {
    return {
      tick: game.tick,
      playing: game.playing,
      result: game.result ? compact(game.result) : null,
      base: pieceStr(game.base as { id: number; n: number; suit: string }),
      players: game.players.map((p) => ({ id: p.id, ...this.playerFields(game, p), chainRemaining: p.chainRemaining, streakRemaining: p.streakRemaining, riseCountdown: p.riseCountdown, manualRiseEndTick: p.manualRiseEndTick, incoming: compact({ ...p.incoming, stats: undefined }) })),
      flights: game.flights.map((f) => compact(f)),
    };
  }

  // ---------------------------------------------------------------- 保存

  /** 保存するファイルの中身（ヘッダー＋記録）。文字列の配列で返す（巨大な1文字列を作らない） */
  exportParts(extraHeader: Record<string, unknown> = {}): string[] {
    const header = {
      format: MEASURE_FORMAT,
      formatVersion: MEASURE_FORMAT_VERSION,
      workId: MEASURE_WORK_ID,
      app: { version: '3.2.0', base: 'V320-FIX-06-R2', baseCommit: MEASURE_BASE_COMMIT },
      build: this.build,
      session: { id: this.sessionId, segments: this.segments, records: this.lines.length, state: this.state, limitStopped: this.limitStopped },
      settings: { selectedProfile: this.profile, profiles: { A: profileReport('A'), B: profileReport('B') }, padRecord: PAD_RECORD, limits: this.limits, snapshotEveryTicks: SNAPSHOT_EVERY_TICKS, frameGapMs: FRAME_GAP_MS },
      timeBase: 't＝セッション開始からの経過ms（performance.now 基準）。k＝ラウンド内ゲームtick（60tick/秒）。s＝全記録の連番（順序の正）。f＝描画フレーム連番',
      ...extraHeader,
    };
    const parts = [`{"header":${JSON.stringify(header)},\n"records":[\n`];
    this.lines.forEach((l, i) => parts.push(i + 1 < this.lines.length ? `${l},\n` : `${l}\n`));
    parts.push(']}\n');
    return parts;
  }

  fileName(): string {
    return `kotaro_measure_${this.sessionId ?? 'nosession'}.json`;
  }

  markSaved(): void {
    this.saved = true;
    this.savedFile = this.fileName();
  }
}

export function makeSessionId(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `M01-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
}

export type { PlayerId };
