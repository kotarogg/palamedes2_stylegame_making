// 開始（READY→GO）と結果（勝敗・引分け・シングルの結果）の演出。ゲーム結果は変えず、ロジックのtickを時計にする。
// 勝敗あり（確定）：勝利数加算→WIN/LOSE→結果SE→敗者モーションと敗者ボイス→画面外まで落下→微ディレイ→勝者モーションと勝者ボイス。
//   敗者ボイスの終了は待たない（短い重なりを許容）。
// 引分け（確定）：2人同時に敗北モーション、落下なし、ボイスなし（sfx_draw は未納品のため無音）。
// 時間はすべて調整用初期値（docs に記録）。
import type { AudioBus } from '../audio/audioBus';
import { VOICE_PRIORITY, type Character } from '../audio/audioMap';
import type { AnyGame } from '../core/match';
import type { PlayerId } from '../core/types';

export interface PresentationConfig {
  /** 結果効果音・敗者演出の開始から落下完了まで */
  fallMs: number;
  /** 落下完了から勝者モーション・勝者ボイスまでの微ディレイ */
  winnerDelayMs: number;
  /** 勝者演出の開始から決定入力を受け付けるまで */
  acceptAfterWinnerMs: number;
  /** 引分けの受付開始 */
  drawAcceptMs: number;
  /** シングル結果の受付開始 */
  singleAcceptMs: number;
}

export const DEFAULT_PRESENTATION: PresentationConfig = {
  fallMs: 700,
  winnerDelayMs: 200,
  acceptAfterWinnerMs: 300,
  drawAcceptMs: 900,
  singleAcceptMs: 1000,
};

export type ResultKind = 'versus' | 'draw' | 'gameOver' | 'stageClear' | 'allStagesClear' | 'clear';

export interface ResultPlan {
  kind: ResultKind;
  winner: PlayerId | null;
  loser: PlayerId | null;
  startTick: number;
  /** 敗者の落下が終わるtick（落下なしなら startTick） */
  fallEndTick: number;
  /** 勝者モーション・ボイスの開始tick（勝者なしなら null） */
  winnerTick: number | null;
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
      const fallEnd = t + ms(cfg.fallMs);
      const winnerTick = fallEnd + ms(cfg.winnerDelayMs);
      return { kind: 'versus', winner, loser: (1 - winner) as PlayerId, startTick: t, fallEndTick: fallEnd, winnerTick, acceptTick: winnerTick + ms(cfg.acceptAfterWinnerMs) };
    }
    case 'draw':
      return { kind: 'draw', winner: null, loser: null, startTick: t, fallEndTick: t, winnerTick: null, acceptTick: t + ms(cfg.drawAcceptMs) };
    case 'gameOver': {
      const fallEnd = t + ms(cfg.fallMs);
      return { kind: 'gameOver', winner: null, loser: 0, startTick: t, fallEndTick: fallEnd, winnerTick: null, acceptTick: fallEnd + ms(cfg.winnerDelayMs + cfg.acceptAfterWinnerMs) };
    }
    case 'stageClear':
    case 'allStagesClear':
    case 'clear':
      return { kind: r.outcome, winner: 0, loser: null, startTick: t, fallEndTick: t, winnerTick: t, acceptTick: t + ms(cfg.singleAcceptMs) };
  }
}

export interface CharacterPose {
  anim: 'lose_fall' | 'win' | null;
  /** 0〜1：落下の進み（0＝足場、1＝画面外） */
  fall: number;
  /** 画面外まで落ちて描画しない */
  gone: boolean;
}

/** 結果中のキャラクターの見た目（勝者は勝者演出の開始まで通常のまま） */
export function characterPose(plan: ResultPlan | null, p: PlayerId, tick: number): CharacterPose {
  if (!plan || tick < plan.startTick) return { anim: null, fall: 0, gone: false };
  if (plan.kind === 'draw') return { anim: 'lose_fall', fall: 0, gone: false };
  if (plan.loser === p) {
    const span = Math.max(1, plan.fallEndTick - plan.startTick);
    const u = Math.min(1, (tick - plan.startTick) / span);
    return { anim: 'lose_fall', fall: u, gone: u >= 1 };
  }
  if (plan.winner === p && plan.winnerTick !== null && tick >= plan.winnerTick) return { anim: 'win', fall: 0, gone: false };
  return { anim: null, fall: 0, gone: false };
}

export interface StagingOptions {
  /** READY／GOの担当：シングル＝選択キャラ、CPU対戦＝相手キャラ、2P対戦＝両者からランダム（ラウンドごとに1回） */
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
          // 勝利音は全体に1回。人がすべて負けた（CPUに敗北）場合は敗北音
          const humanLost = this.opts.humans.length > 0 && this.opts.humans.every((h) => h === plan.loser);
          b?.playSfx(humanLost ? 'lose' : 'win');
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
          return; // 引分けは無音（sfx_draw 未納品）。ステージクリアのSEはロジックのイベントで鳴る
      }
    });
    if (plan.winnerTick !== null && g.tick >= plan.winnerTick && plan.winner !== null) {
      this.once('winner', () => b?.playVoice(ch(plan.winner!), 'win', VOICE_PRIORITY.result, 'result'));
    }
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
