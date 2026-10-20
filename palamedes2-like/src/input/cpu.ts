// CPU／NPC（確定：初級・中級・上級。反応時間と判断精度で差を付ける）。
// 判断に使うのはプレイヤーに見える情報だけ：共通基準（場のカード）、自分の盤面・役ストック・待機攻撃・危険状態。
// 未来の生成ピース（乱数・生成器）や相手の入力は参照しない。MODE2では役・B・上昇を使わない。
import type { Difficulty } from '../core/config';
import type { Command, Game, PlayerState } from '../core/game';
import type { AnyGame } from '../core/match';
import type { Mode2Game, Mode2Player } from '../core/mode2';
import { isLaunchSuccess } from '../core/pieces';
import { createSeededRng, randomInt, type Rng } from '../core/rng';
import { evaluateStock } from '../core/roles';
import type { Piece, PlayerId } from '../core/types';
import type { Controller } from './controller';

export interface CpuProfile {
  /** 判断までの反応時間 */
  reactionMs: number;
  /** 列移動1歩ごとの間隔 */
  stepMs: number;
  /** 正しい列を選ぶ確率（残りは見当違いの列を選ぶ） */
  accuracy: number;
  /** この翻数以上なら宣言（ストック6個・危険時は1翻でも宣言） */
  minHan: number;
}

/** 調整用初期値（実測評価は docs/TEST_REPORT を参照） */
export const CPU_PROFILES: Record<Difficulty, CpuProfile> = {
  easy: { reactionMs: 700, stepMs: 220, accuracy: 0.6, minHan: 1 },
  normal: { reactionMs: 400, stepMs: 130, accuracy: 0.85, minHan: 2 },
  hard: { reactionMs: 180, stepMs: 70, accuracy: 0.97, minHan: 3 },
};

interface Plan {
  col: number;
  action: 'launch' | 'rotate';
}

type AnyPlayer = PlayerState | Mode2Player;

export class CpuController implements Controller {
  private nextTick = 0;
  private plan: Plan | null = null;
  private readonly rng: Rng;

  constructor(
    readonly player: PlayerId,
    readonly level: Difficulty,
    seed = 1,
    private readonly profile: CpuProfile = CPU_PROFILES[level],
  ) {
    this.rng = createSeededRng((seed * 7919 + player * 104729) >>> 0);
  }

  poll(game: AnyGame): Command[] {
    const p = game.players[this.player];
    if (!p || !game.playing || game.tick + 1 < this.nextTick) return [];
    if (game.mode === 'mode1' && (p as PlayerState).defeated) return [];
    if (game.mode === 'mode1' ? game.isLocked(p as PlayerState) || game.isMoving(p as PlayerState) : game.isLocked(p as Mode2Player) || game.isMoving(p as Mode2Player)) return [];
    const ticks = (ms: number) => game.ticks(ms);
    const cmd = (type: Command['type']): Command[] => [{ player: this.player, type } as Command];

    if (game.mode === 'mode1') {
      const mp = p as PlayerState;
      // 役宣言：成立している場合のみ（不成立宣言はしない）
      const ev = evaluateStock(mp.roleStock);
      const danger = mp.board.height() >= game.config.dangerHeight - 1;
      if (ev.kind === 'ok' && (ev.result.han >= this.profile.minHan || mp.roleStock.length === 6 || danger)) {
        this.plan = null;
        this.nextTick = game.tick + 1 + ticks(this.profile.reactionMs);
        return cmd('declare');
      }
    }

    if (!this.plan || !this.valid(p, this.plan)) this.plan = game.mode === 'mode1' ? this.choose(game, p as PlayerState) : this.chooseMode2(game, p as Mode2Player);
    if (!this.plan) {
      this.nextTick = game.tick + 1 + ticks(this.profile.reactionMs);
      return [];
    }
    if (this.plan.col !== p.selectedCol) {
      this.nextTick = game.tick + 1 + ticks(this.profile.stepMs);
      return cmd(this.plan.col < p.selectedCol ? 'left' : 'right');
    }
    const action = this.plan.action;
    this.plan = null;
    this.nextTick = game.tick + 1 + ticks(this.profile.reactionMs);
    return cmd(action);
  }

  private launchable(p: AnyPlayer, col: number): boolean {
    const top = p.board.top(col);
    return !!top && top.kind === 'piece';
  }

  private valid(p: AnyPlayer, plan: Plan): boolean {
    if (!this.launchable(p, plan.col)) return false;
    if (plan.action === 'rotate') return p.board.cols[plan.col].length >= 2;
    return true;
  }

  private top(p: AnyPlayer, c: number): Piece | null {
    const s = p.board.cols[c][0];
    return s && s.kind === 'piece' ? s.piece : null;
  }

  private choose(game: Game, p: PlayerState): Plan | null {
    const cols = [0, 1, 2, 3, 4, 5].filter((c) => this.launchable(p, c));
    if (cols.length === 0) return null;
    const near = (a: number, b: number) => Math.abs(a - p.selectedCol) - Math.abs(b - p.selectedCol);
    const hits = cols.filter((c) => isLaunchSuccess(this.top(p, c)!, game.base)).sort(near);
    const accurate = this.rng.next() < this.profile.accuracy;
    if (hits.length && accurate) return { col: hits[0], action: 'launch' };
    if (!accurate) return { col: cols[randomInt(this.rng, cols.length)], action: 'launch' };
    // 最上段に当たりが無い：2段目が当たる列をBで出す
    const second = cols
      .filter((c) => {
        const s = p.board.cols[c][1];
        return s && s.kind === 'piece' && isLaunchSuccess(s.piece, game.base);
      })
      .sort(near);
    if (second.length) return { col: second[0], action: 'rotate' };
    // 見える範囲に当たりが無い：B入替で最上段を入れ替えて探す
    const deep = cols.filter((c) => p.board.cols[c].length >= 3).sort(near);
    return deep.length ? { col: deep[0], action: 'rotate' } : null;
  }

  /** MODE2：場のカードへ出せる列だけを狙う（出せる列が無ければ待つ。誤判断時は見当違いの列を打つ） */
  private chooseMode2(game: Mode2Game, p: Mode2Player): Plan | null {
    const cols = [0, 1, 2, 3, 4, 5].filter((c) => this.launchable(p, c));
    if (cols.length === 0) return null;
    const near = (a: number, b: number) => Math.abs(a - p.selectedCol) - Math.abs(b - p.selectedCol);
    const hits = cols.filter((c) => isLaunchSuccess(this.top(p, c)!, game.base)).sort(near);
    if (hits.length === 0) return null;
    const accurate = this.rng.next() < this.profile.accuracy;
    if (accurate) return { col: hits[0], action: 'launch' };
    return { col: cols[randomInt(this.rng, cols.length)], action: 'launch' };
  }
}
