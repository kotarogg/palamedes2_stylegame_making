// 開始（READY→GO）・役名表示・結果（勝敗・引分け・シングルの結果）の演出。ゲーム結果は変えず、ロジックのtickを時計にする。
// 勝敗あり（第3版 第14章）：勝敗確定→勝利数加算→WIN/LOSE・結果SE→敗者 lose_fall モーション＋敗北ボイス→モーションを最後まで再生
//   →最終姿勢のまま画面外まで落下（落下開始で se_character_fall）→完全に画面外へ出てから200ms→勝者 win＋勝利ボイス
//   →同時にネコタローが勝者へクラッカー1回（se_result_cracker）→結果入力。敗者ボイスの終了は待たない。
// 引分け：2人同時に敗北モーション、落下なし、勝敗ボイス・引分けSE・クラッカーなし。
// 役名表示（第13章 B4・B5）：宣言時に表示リスト・代表役・開始時刻を確定し、先頭ロゴと代表役ボイスを同時開始。
// 時間はすべて設定値（PM指定初期値）。
import type { AudioBus } from '../audio/audioBus';
import { ROLE_ALT_ATTACK_VOICE_PCT, roleVoiceLine, VOICE_PRIORITY, type Character } from '../audio/audioMap';
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
  /** 先頭ロゴの保持時間の下限（実際は max(600ms, 代表役ボイスのファイル尺)） */
  headMinMs: number;
  /** 先頭ロゴを表示したままの追加待機 */
  headWaitMs: number;
  /** 後続ロゴ1件の表示時間 */
  followMs: number;
}

export const DEFAULT_ROLE_NAME: RoleNameConfig = { headMinMs: 600, headWaitMs: 150, followMs: 600 };

export interface RoleShow {
  logos: number[];
  /** 先頭ロゴ（代表役）の開始tick＝代表役ボイスの開始 */
  headStart: number;
  /** 先頭ロゴ＋追加待機の終了tick（ここから後続ロゴ） */
  waitEnd: number;
  /** 全ロゴの終了tick */
  end: number;
}

/**
 * 1プレイヤーの役名表示の予定。未確定の攻撃時刻から比率を毎フレーム再計算しない。
 * - 後続ロゴ表示中の新宣言：古い後続を即中止し、新宣言の先頭ロゴと代表役ボイスを開始（古い表示は再開しない）
 * - 先頭ロゴ保持中（＋追加待機）の新宣言：最新1件だけを表示待ちにし、先頭＋待機の終了で古い後続より優先して開始
 */
export class RoleNameSchedule {
  current: RoleShow | null = null;
  private pending: { logos: number[]; holdTicks: number; voice: RoleVoiceKind } | null = null;

  constructor(
    private readonly ticks: (ms: number) => number,
    private readonly cfg: RoleNameConfig = DEFAULT_ROLE_NAME,
    private readonly onHeadStart: (logo: number, tick: number, voice: RoleVoiceKind) => void = () => undefined,
  ) {}

  private start(logos: number[], holdTicks: number, tick: number, voice: RoleVoiceKind): void {
    const waitEnd = tick + holdTicks + this.ticks(this.cfg.headWaitMs);
    this.current = { logos, headStart: tick, waitEnd, end: waitEnd + this.ticks(this.cfg.followMs) * Math.max(0, logos.length - 1) };
    this.onHeadStart(logos[0], tick, voice);
  }

  /** この tick に宣言したら先頭ロゴ（と代表ボイス）がすぐ始まるか（前の表示の待ち中なら後になる） */
  startsNow(tick: number): boolean {
    return !(this.current && tick < this.current.waitEnd);
  }

  /** 宣言（logos は既存の表示順。voiceMs は代表ボイスの取得済みファイル尺。音量0・ミュートでも同じ。voice＝役名／代替の攻撃ボイス） */
  declare(logos: number[], voiceMs: number | null, tick: number, voice: RoleVoiceKind = 'role'): void {
    if (logos.length === 0) return;
    const holdTicks = this.ticks(Math.max(this.cfg.headMinMs, voiceMs ?? 0));
    if (this.current && tick < this.current.waitEnd) {
      this.pending = { logos, holdTicks, voice };
      return;
    }
    this.pending = null;
    this.start(logos, holdTicks, tick, voice);
  }

  update(tick: number): void {
    const c = this.current;
    if (!c) return;
    if (this.pending && tick >= c.waitEnd) {
      const p = this.pending;
      this.pending = null;
      this.start(p.logos, p.holdTicks, c.waitEnd, p.voice);
      return;
    }
    if (tick >= c.end) this.current = null;
  }

  /** 表示中のロゴと、その表示開始tick（A/B/C の色替えの起点）。なければ null */
  logoAt(tick: number): { logo: number; since: number } | null {
    const c = this.current;
    if (!c || tick < c.headStart) return null;
    if (tick < c.waitEnd) return { logo: c.logos[0], since: c.headStart };
    const i = 1 + Math.floor((tick - c.waitEnd) / Math.max(1, this.ticks(this.cfg.followMs)));
    if (i >= c.logos.length) return null;
    return { logo: c.logos[i], since: c.waitEnd + (i - 1) * this.ticks(this.cfg.followMs) };
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  stop(): void {
    this.current = null;
    this.pending = null;
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
      } else if (e.type === 'roundEnd') for (const s of this.schedules) s.stop();
    }
    if (this.game.result) return;
    for (const s of this.schedules) s.update(this.game.tick);
  }

  logoAt(p: PlayerId, tick: number): { logo: number; since: number } | null {
    return this.game.result ? null : (this.schedules[p]?.logoAt(tick) ?? null);
  }
}

// ---------------------------------------------------------------- 開始・結果の音声

export interface StagingOptions {
  /** READY／GOの担当：シングル＝コタロー、CPU対戦＝相手キャラ、2P対戦＝両者から等確率（ラウンドごとに1回） */
  announcer: Character;
  characters: readonly Character[];
  /** 人が操作するプレイヤー（結果SEの勝敗の選択に使う） */
  humans: readonly PlayerId[];
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
