// 開始（READY→GO）・役名表示・結果（勝敗・引分け・シングルの結果）の演出。ゲーム結果は変えず、ロジックのtickを時計にする。
// 勝敗あり（第3版 第14章）：勝敗確定→勝利数加算→WIN/LOSE・結果SE→敗者 lose_fall モーション＋敗北ボイス→モーションを最後まで再生
//   →最終姿勢のまま画面外まで落下（落下開始で se_character_fall）→完全に画面外へ出てから200ms→勝者 win＋勝利ボイス
//   →同時にネコタローが勝者へクラッカー1回（se_result_cracker）→結果入力。敗者ボイスの終了は待たない。
// 引分け：2人同時に敗北モーション、落下なし、勝敗ボイス・引分けSE・クラッカーなし。
// 役名表示（第13章 B4・B5）：宣言時に表示リスト・代表役・開始時刻を確定し、先頭ロゴと代表役ボイスを同時開始。
// 時間はすべて設定値（PM指定初期値）。
import type { AudioBus } from '../audio/audioBus';
import { ROLE_ALT_ATTACK_VOICE_PCT, roleVoiceLine, VOICE_PRIORITY, voiceFile, type Character } from '../audio/audioMap';
import { createSeededRng, type Rng } from '../core/rng';
import type { GameEvent } from '../core/game';
import type { AnyGame } from '../core/match';
import type { Mode2Event } from '../core/mode2';
import type { PlayerId } from '../core/types';

/** 役宣言の代表ボイス：role＝代表役名ボイス、attack＝代替の攻撃ボイス（v3.1.0） */
export type RoleVoiceKind = 'role' | 'attack';

export interface PresentationConfig {
  /** 敗者 lose_fall モーション（納品4コマ×160ms＝640ms）。落下はこの後から */
  loserMotionMs: number;
  /** 落下（モーション終了から、キャラの画像矩形全体が画面外へ出るまで。PM初期値700ms） */
  fallMs: number;
  /** 画面外へ出てから勝者モーション・勝者ボイスまで（PM初期値200ms） */
  winnerDelayMs: number;
  /** 勝者演出の開始から決定入力を受け付けるまで */
  acceptAfterWinnerMs: number;
  /** 引分けの受付開始 */
  drawAcceptMs: number;
  /** シングル成功結果の受付開始 */
  singleAcceptMs: number;
  /** ネコタローのクラッカー1コマ（納品 220ms×4） */
  crackerFrameMs: number;
}

export const DEFAULT_PRESENTATION: PresentationConfig = {
  loserMotionMs: 640,
  fallMs: 700,
  winnerDelayMs: 200,
  acceptAfterWinnerMs: 300,
  drawAcceptMs: 900,
  singleAcceptMs: 1000,
  crackerFrameMs: 220,
};

export const CRACKER_FRAMES = 4;

export type ResultKind = 'versus' | 'draw' | 'gameOver' | 'stageClear' | 'allStagesClear' | 'clear';

export interface ResultPlan {
  kind: ResultKind;
  winner: PlayerId | null;
  loser: PlayerId | null;
  startTick: number;
  /** 敗者モーション終了＝落下開始tick（落下なしなら startTick） */
  fallStartTick: number;
  /** 敗者の落下が終わる（画面外）tick（落下なしなら startTick） */
  fallEndTick: number;
  /** 勝者モーション・ボイスの開始tick（勝者なしなら null） */
  winnerTick: number | null;
  /** ネコタローのクラッカー開始tick（なしなら null）と向く側 */
  crackerTick: number | null;
  crackerToward: PlayerId | null;
  /** 決定入力の受付開始tick */
  acceptTick: number;
}

export function planResult(game: AnyGame, cfg: PresentationConfig = DEFAULT_PRESENTATION): ResultPlan | null {
  const r = game.result;
  if (!r) return null;
  const t = r.tick;
  const ms = (x: number) => game.ticks(x);
  switch (r.outcome) {
    case 'win': {
      const winner = r.winner!;
      const fallStart = t + ms(cfg.loserMotionMs);
      const fallEnd = fallStart + ms(cfg.fallMs);
      const winnerTick = fallEnd + ms(cfg.winnerDelayMs);
      return {
        kind: 'versus',
        winner,
        loser: (1 - winner) as PlayerId,
        startTick: t,
        fallStartTick: fallStart,
        fallEndTick: fallEnd,
        winnerTick,
        crackerTick: winnerTick,
        crackerToward: winner,
        acceptTick: winnerTick + ms(cfg.acceptAfterWinnerMs),
      };
    }
    case 'draw':
      return { kind: 'draw', winner: null, loser: null, startTick: t, fallStartTick: t, fallEndTick: t, winnerTick: null, crackerTick: null, crackerToward: null, acceptTick: t + ms(cfg.drawAcceptMs) };
    case 'gameOver': {
      const fallStart = t + ms(cfg.loserMotionMs);
      const fallEnd = fallStart + ms(cfg.fallMs);
      return {
        kind: 'gameOver',
        winner: null,
        loser: 0,
        startTick: t,
        fallStartTick: fallStart,
        fallEndTick: fallEnd,
        winnerTick: null,
        crackerTick: null,
        crackerToward: null,
        acceptTick: fallEnd + ms(cfg.winnerDelayMs + cfg.acceptAfterWinnerMs),
      };
    }
    case 'stageClear':
    case 'allStagesClear':
    case 'clear':
      return { kind: r.outcome, winner: 0, loser: null, startTick: t, fallStartTick: t, fallEndTick: t, winnerTick: t, crackerTick: t, crackerToward: 0, acceptTick: t + ms(cfg.singleAcceptMs) };
  }
}

export interface CharacterPose {
  anim: 'lose_fall' | 'win' | null;
  /** lose_fall の経過（tick）。モーションは最後まで再生し、最終姿勢を維持 */
  motionTicks: number;
  /** 0〜1：落下の進み（0＝足場、1＝画面外） */
  fall: number;
  /** 画面外まで落ちて描画しない */
  gone: boolean;
}

/** 結果中のキャラクターの見た目（勝者は勝者演出の開始まで通常のまま） */
export function characterPose(plan: ResultPlan | null, p: PlayerId, tick: number): CharacterPose {
  const none: CharacterPose = { anim: null, motionTicks: 0, fall: 0, gone: false };
  if (!plan || tick < plan.startTick) return none;
  if (plan.kind === 'draw') return { anim: 'lose_fall', motionTicks: tick - plan.startTick, fall: 0, gone: false };
  if (plan.loser === p) {
    const span = Math.max(1, plan.fallEndTick - plan.fallStartTick);
    const u = tick < plan.fallStartTick ? 0 : Math.min(1, (tick - plan.fallStartTick) / span);
    return { anim: 'lose_fall', motionTicks: tick - plan.startTick, fall: u, gone: u >= 1 };
  }
  if (plan.winner === p && plan.winnerTick !== null && tick >= plan.winnerTick) return { anim: 'win', motionTicks: tick - plan.winnerTick, fall: 0, gone: false };
  return none;
}

/** ネコタローのクラッカー：開始から4コマ×220msを1回。向き（勝者側）と経過を返す。範囲外は null */
export function crackerPose(plan: ResultPlan | null, tick: number, tickMs: number, cfg: PresentationConfig = DEFAULT_PRESENTATION): { frame: number; toward: PlayerId } | null {
  if (!plan || plan.crackerTick === null || plan.crackerToward === null || tick < plan.crackerTick) return null;
  const frame = Math.floor(((tick - plan.crackerTick) * tickMs) / cfg.crackerFrameMs);
  return frame < CRACKER_FRAMES ? { frame, toward: plan.crackerToward } : null;
}

// ---------------------------------------------------------------- 役名表示（B4・B5）

export interface RoleNameConfig {
  /** 先頭ロゴの表示時間＝既存固定設定の先頭600ms＋追加待機150ms（出入りを含む。ボイス尺では延長しない） */
  headMinMs: number;
  headWaitMs: number;
  /** 後続ロゴ1件の表示時間（出入りを含む） */
  followMs: number;
  /** V320-FIX-05 横スライドの出入り（ms）と移動量（論理px） */
  slideInMs: number;
  slideOutMs: number;
  slidePx: number;
}

export const DEFAULT_ROLE_NAME: RoleNameConfig = { headMinMs: 600, headWaitMs: 150, followMs: 600, slideInMs: 120, slideOutMs: 120, slidePx: 16 };

/** 1枚のロゴの表示区間（tick。宣言時刻からの ms を一度だけ tick へ換算した境界） */
export interface RoleLogoWindow {
  logo: number;
  start: number;
  inEnd: number;
  outStart: number;
  end: number;
}

export interface RoleShow {
  logos: number[];
  /** 宣言（先頭ロゴの表示開始＝代表ボイスの要求）tick */
  headStart: number;
  windows: RoleLogoWindow[];
  /** 全ロゴの終了tick */
  end: number;
}

/** 表示中のロゴ1枚：区間（イン／静止／アウト）と区間内の進み 0〜1 */
export interface RoleLogoView {
  logo: number;
  /** A/B/C 色替えの起点（このロゴの表示開始） */
  since: number;
  phase: 'in' | 'hold' | 'out';
  u: number;
}

/**
 * V320-FIX-05 役名ロゴの横スライド：イン＝外側 slidePx から基準位置へ減速（ease-out quadratic）・透明度0→1、
 * アウト＝基準位置から内側 slidePx へ加速（ease-in quadratic）・透明度1→0。dir：1P＝+1（左→右）、2P＝−1（右→左）。位置は整数px
 */
export function roleSlide(v: Pick<RoleLogoView, 'phase' | 'u'>, dir: 1 | -1, px = DEFAULT_ROLE_NAME.slidePx): { dx: number; alpha: number } {
  const u = Math.max(0, Math.min(1, v.u));
  if (v.phase === 'in') return { dx: Math.round(-px * (1 - u) * (1 - u) * dir) || 0, alpha: u };
  if (v.phase === 'out') return { dx: Math.round(px * u * u * dir) || 0, alpha: 1 - u };
  return { dx: 0, alpha: 1 };
}

/**
 * 1プレイヤーの役名表示の予定（V320-FIX-05）。時間は固定：先頭750ms・後続600ms、出入り120msは各表示時間に含め、
 * 先行役のアウトと後続役のインを同じ120msに重ねる（2役：0〜750ms 先頭、630〜1230ms 後続）。ボイス尺・デコード状態では変えない。
 * 各境界は宣言時刻からの ms を一度だけ tick 換算する（区間ごとの丸めを積み上げない）。
 * 新しい宣言では旧表示を打ち切り、新宣言の先頭から始める（古い後続を残さない・後から再開しない）
 */
export class RoleNameSchedule {
  current: RoleShow | null = null;

  constructor(
    private readonly ticks: (ms: number) => number,
    private readonly cfg: RoleNameConfig = DEFAULT_ROLE_NAME,
    private readonly onHeadStart: (logo: number, tick: number, voice: RoleVoiceKind) => void = () => undefined,
  ) {}

  /** 宣言からの各ロゴの区間（ms） */
  static windowsMs(n: number, cfg: RoleNameConfig = DEFAULT_ROLE_NAME): { start: number; inEnd: number; outStart: number; end: number }[] {
    const out: { start: number; inEnd: number; outStart: number; end: number }[] = [];
    let start = 0;
    for (let i = 0; i < n; i++) {
      const len = i === 0 ? cfg.headMinMs + cfg.headWaitMs : cfg.followMs;
      const end = start + len;
      out.push({ start, inEnd: start + cfg.slideInMs, outStart: end - cfg.slideOutMs, end });
      start = end - cfg.slideOutMs; // 次のロゴのインを、このロゴのアウトと重ねる
    }
    return out;
  }

  /** 宣言と同時に先頭ロゴを表示し代表ボイスを要求するため、常に true（表示待ちを作らない） */
  startsNow(_tick: number): boolean {
    return true;
  }

  /** 宣言（logos は既存の表示順。voiceMs は記録用で表示時間には使わない。voice＝役名／代替の攻撃ボイス） */
  declare(logos: number[], _voiceMs: number | null, tick: number, voice: RoleVoiceKind = 'role'): void {
    if (logos.length === 0) return;
    // 換算は宣言時刻からの ms ごとに一度だけ（0ms は宣言 tick。ゲームの ms→tick 換算は最小1tickのため0を別扱い）
    const at = (ms: number) => (ms <= 0 ? tick : tick + this.ticks(ms));
    const windows = RoleNameSchedule.windowsMs(logos.length, this.cfg).map((w, i) => ({ logo: logos[i], start: at(w.start), inEnd: at(w.inEnd), outStart: at(w.outStart), end: at(w.end) }));
    this.current = { logos, headStart: tick, windows, end: windows[windows.length - 1].end };
    this.onHeadStart(logos[0], tick, voice);
  }

  update(tick: number): void {
    if (this.current && tick >= this.current.end) this.current = null;
  }

  /** 表示中のロゴ（描画順＝先頭→後続。重なる120msは2枚）。t は補間用に小数可 */
  logosAt(t: number): RoleLogoView[] {
    const c = this.current;
    if (!c) return [];
    const out: RoleLogoView[] = [];
    for (const w of c.windows) {
      if (t < w.start || t >= w.end) continue;
      if (t < w.inEnd) out.push({ logo: w.logo, since: w.start, phase: 'in', u: (t - w.start) / Math.max(1, w.inEnd - w.start) });
      else if (t >= w.outStart) out.push({ logo: w.logo, since: w.start, phase: 'out', u: (t - w.outStart) / Math.max(1, w.end - w.outStart) });
      else out.push({ logo: w.logo, since: w.start, phase: 'hold', u: 1 });
    }
    return out;
  }

  /** 前面のロゴ（互換用：重なり中は後続） */
  logoAt(tick: number): { logo: number; since: number } | null {
    const v = this.logosAt(tick);
    const f = v[v.length - 1];
    return f ? { logo: f.logo, since: f.since } : null;
  }

  get hasPending(): boolean {
    return false;
  }

  stop(): void {
    this.current = null;
  }
}

/**
 * 試合の役名表示：宣言イベントを読み、プレイヤーごとの予定を進め、先頭ロゴの開始と同時に代表ボイスを鳴らす。
 * v3.1.0：宣言ごとに1回だけ抽選し、20%で代表役名ボイスの代わりに攻撃ボイス（両方は鳴らさない）。
 * 前回が代替（攻撃ボイス）なら次回は役名ボイス。履歴はプレイヤー別で、新ラウンド（reset）で消す。
 * 複数役の成立でも代表ボイスは1本（既存の表示順の先頭役）
 */
export class RoleNameDirector {
  private cursor = 0;
  schedules: RoleNameSchedule[] = [];
  /** プレイヤー別：前回の宣言が代替の攻撃ボイスだったか */
  private lastAlt: boolean[] = [false, false];
  private readonly rng: Rng;
  /** 抽選の記録（自動検証用） */
  readonly voiceLog: { player: PlayerId; tick: number; voice: RoleVoiceKind; forced: boolean }[] = [];
  /** V320-FIX-05 宣言ごとの表示と代表ボイスの対応（自動検証・調査用） */
  readonly showLog: { player: PlayerId; declareTick: number; logos: string[]; windows: { logo: string; start: number; end: number }[]; voice: RoleVoiceKind; voiceFile: string; voiceMs: number | null }[] = [];

  constructor(
    private game: AnyGame,
    private readonly bus: AudioBus | null,
    private characters: readonly Character[],
    private readonly cfg: RoleNameConfig = DEFAULT_ROLE_NAME,
    seed = 1,
    private readonly altPct: number = ROLE_ALT_ATTACK_VOICE_PCT,
  ) {
    this.rng = createSeededRng(seed >>> 0);
    this.reset(game, characters);
  }

  reset(game: AnyGame, characters?: readonly Character[]): void {
    this.game = game;
    if (characters) this.characters = characters;
    this.cursor = 0;
    this.lastAlt = [false, false];
    this.schedules = game.players.map(
      (_, i) =>
        new RoleNameSchedule((ms) => game.ticks(ms), this.cfg, (logo, _tick, voice) =>
          this.bus?.playVoice(this.characters[i], voice === 'attack' ? 'attack' : roleVoiceLine(logo), VOICE_PRIORITY.role),
        ),
    );
  }

  /** 宣言SEと代表ボイスが同時か（SoundDirector の宣言SEのゲインに使う）。宣言を取り込む前に問い合わせる */
  voiceStartsNow(p: PlayerId, tick: number): boolean {
    return this.schedules[p]?.startsNow(tick) ?? true;
  }

  /**
   * v3.1.0 これから代表ボイスが始まる予定があるか（ピンチボイスを鳴らさない判定に使う）：
   * 表示待ちの宣言がある、またはまだ取り込んでいない宣言イベントがある（同じフレームで後から代表ボイスが始まる）
   */
  roleVoiceImminent(): boolean {
    if (this.game.result) return false;
    if (this.schedules.some((s) => s.hasPending)) return true;
    const ev = this.game.events as ReadonlyArray<GameEvent | Mode2Event>;
    for (let i = this.cursor; i < ev.length; i++) if (ev[i].type === 'declare') return true;
    return false;
  }

  /** 毎フレーム（描画前）。結果へ移行したら役名表示・表示待ちを終了する */
  update(): void {
    const ev = this.game.events as ReadonlyArray<GameEvent | Mode2Event>;
    while (this.cursor < ev.length) {
      const e = ev[this.cursor++];
      if (e.type === 'declare') {
        // 宣言イベントにつき1回だけ抽選（乱数は1つ消費）。前回が代替なら今回は役名ボイスに固定
        const hit = this.rng.next() * 100 < this.altPct;
        const forced = this.lastAlt[e.player];
        const voice: RoleVoiceKind = hit && !forced ? 'attack' : 'role';
        this.lastAlt[e.player] = voice === 'attack';
        this.voiceLog.push({ player: e.player, tick: e.tick, voice, forced: forced && hit });
        const line = voice === 'attack' ? 'attack' : roleVoiceLine(e.logos[0]);
        const voiceMs = this.bus?.voiceDurationMs(this.characters[e.player], line) ?? null;
        this.schedules[e.player].declare(e.logos, voiceMs, e.tick, voice);
        // V320-FIX-05 役名と読み上げの対応記録：ロゴR番号・表示区間・代表ボイスのファイル（自動検証・調査用）
        const show = this.schedules[e.player].current!;
        this.showLog.push({
          player: e.player,
          declareTick: e.tick,
          logos: e.logos.map((l) => `R${String(l + 1).padStart(2, '0')}`),
          windows: show.windows.map((w) => ({ logo: `R${String(w.logo + 1).padStart(2, '0')}`, start: w.start, end: w.end })),
          voice,
          voiceFile: voiceFile(this.characters[e.player], line),
          voiceMs,
        });
      } else if (e.type === 'roundEnd') for (const s of this.schedules) s.stop();
    }
    if (this.game.result) return;
    for (const s of this.schedules) s.update(this.game.tick);
  }

  logoAt(p: PlayerId, tick: number): { logo: number; since: number } | null {
    return this.game.result ? null : (this.schedules[p]?.logoAt(tick) ?? null);
  }

  /** V320-FIX-05 表示中のロゴ（最大2枚。先頭→後続の順）。勝敗確定後は無し */
  logosAt(p: PlayerId, t: number): RoleLogoView[] {
    return this.game.result ? [] : (this.schedules[p]?.logosAt(t) ?? []);
  }
}

// ---------------------------------------------------------------- 開始・結果の音声

export interface StagingOptions {
  /** READY／GOの担当：シングル＝コタロー、CPU対戦＝相手キャラ、2P対戦＝両者から等確率（ラウンドごとに1回） */
  announcer: Character;
  characters: readonly Character[];
  /** 人が操作するプレイヤー（結果SEの勝敗の選択に使う） */
  humans: readonly PlayerId[];
  /** 遊び方の教材：READY／GO の音を鳴らさない（教材は入力受付の開始から始める）。結果の音は従来どおり */
  skipStart?: boolean;
}

/** 開始と結果の音声キューを1回ずつ発火する */
export class Staging {
  private fired = new Set<string>();
  plan: ResultPlan | null = null;

  constructor(
    private game: AnyGame,
    private readonly bus: AudioBus | null,
    private opts: StagingOptions,
    private readonly cfg: PresentationConfig = DEFAULT_PRESENTATION,
  ) {}

  reset(game: AnyGame, opts?: StagingOptions): void {
    this.game = game;
    this.fired.clear();
    this.plan = null;
    if (opts) this.opts = opts;
  }

  get announcer(): Character {
    return this.opts.announcer;
  }

  private once(key: string, f: () => void): void {
    if (this.fired.has(key)) return;
    this.fired.add(key);
    f();
  }

  /** 毎フレーム呼ぶ（描画前） */
  update(): void {
    const g = this.game;
    const b = this.bus;
    if (this.opts.skipStart) {
      this.fired.add('ready');
      this.fired.add('go');
    }
    this.once('ready', () => {
      b?.playSfx('ready');
      b?.playVoice(this.opts.announcer, 'ready', VOICE_PRIORITY.start, 'announce');
    });
    if (g.tick >= g.playStartTick) {
      this.once('go', () => {
        b?.playSfx('go');
        b?.playVoice(this.opts.announcer, 'go', VOICE_PRIORITY.start, 'announce');
      });
    }
    if (!g.result) return;
    if (!this.plan) this.plan = planResult(g, this.cfg);
    const plan = this.plan!;
    const ch = (p: PlayerId) => this.opts.characters[p];
    this.once('result', () => {
      switch (plan.kind) {
        case 'versus': {
          // v3.1.0：結果SEは人間側の勝敗に応じ、対応する演出の時刻で鳴らす。敗北SE＝敗者演出の開始（ここ）、勝利SE＝勝者演出の開始。
          // CPU対戦：人が負けたら敗北SEだけ、人が勝ったら勝利SEだけ。2P：敗北SE・勝利SEを各1回。人がいない場合は勝利SEだけ
          if (this.opts.humans.includes(plan.loser!)) b?.playSfx('lose');
          b?.playVoice(ch(plan.loser!), 'lose', VOICE_PRIORITY.result, 'result');
          return;
        }
        case 'gameOver':
          b?.playSfx('lose');
          b?.playVoice(ch(0), 'lose', VOICE_PRIORITY.result, 'result');
          return;
        case 'clear':
          b?.playSfx('win');
          return;
        default:
          return; // 引分けは無音（専用SEなし）。ステージクリアのSEはロジックのイベントで鳴る
      }
    });
    if (plan.loser !== null && plan.fallEndTick > plan.fallStartTick && g.tick >= plan.fallStartTick) this.once('fall', () => b?.playSfx('character_fall'));
    if (plan.kind === 'versus' && plan.winnerTick !== null && g.tick >= plan.winnerTick && plan.winner !== null) {
      this.once('winner', () => {
        // 勝者演出の開始：勝利SE＋勝利ボイス（結果開始では勝利SEを鳴らさないので二重にならない）
        if (this.opts.humans.length === 0 || this.opts.humans.includes(plan.winner!)) b?.playSfx('win');
        b?.playVoice(ch(plan.winner!), 'win', VOICE_PRIORITY.result, 'result');
      });
    }
    if (plan.crackerTick !== null && g.tick >= plan.crackerTick) this.once('cracker', () => b?.playSfx('result_cracker'));
  }

  /** 決定入力を受け付けられるか（勝者演出の開始前の入力は捨てる） */
  get acceptReady(): boolean {
    return !!this.plan && this.game.tick >= this.plan.acceptTick;
  }
}

/** READYの表示時間：担当キャラのREADY音声の実長に余裕を足す（下限1200ms）。音声が無い場合は既定値 */
export function readyDurationMs(voiceMs: number | null, fallbackMs = 1850, marginMs = 300, minMs = 1200): number {
  if (voiceMs === null) return fallbackMs;
  return Math.max(minMs, Math.ceil(voiceMs + marginMs));
}
