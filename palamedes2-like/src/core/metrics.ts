// バランス計測（第3版 第21章）：1ラウンドのイベント列と受攻撃の推移から、決着・宣言・連鎖・攻撃・受攻撃の記録を作る。
// CPU同士の計測（tools/cpu-balance）と、開発版だけの人間プレイ記録（main.ts の開発用フック）で同じ集計を使う。
// ゲーム結果には影響しない（読むだけ）。
import type { Game, GameEvent } from './game';
import type { PlayerId } from './types';

export interface PlayerMetrics {
  declares: number;
  /** 宣言間隔（秒）の平均。宣言2回未満は null */
  declareIntervalSec: number | null;
  /** V320-FIX-06：予定消去数の平均（旧 hanAvg） */
  clearAvg: number | null;
  /** 役連鎖：2連鎖以上に続いた連鎖の数・最大連鎖・途切れ理由（受付時間切れ／ラウンド終了） */
  chains: { continued: number; max: number; brokenByTimeout: number; endedByRound: number };
  attack: { base: number; streakBonus: number; chainBonus: number; power: number; sent: number; zeroPowerDeclares: number };
  /** 受けた側の集計 */
  incoming: { received: number; overflow: number; canceled: number; applied: number; pinchDiscarded: number; blocks: number; waves: number };
  reached7: number;
  attackPinchGraces: number;
  /** 受攻撃の推移（1秒ごとの標本）：現ブロック残量／nextPending の最大・平均 */
  stock: { blockMax: number; blockAvg: number; pendingMax: number; pendingAvg: number };
}

export type DefeatCause = 'natural_danger' | 'attack_pinch' | 'other';

export interface RoundMetrics {
  seconds: number;
  decided: boolean;
  outcome: string | null;
  winner: PlayerId | null;
  /** 敗者ごとの原因（引分けは2件） */
  causes: DefeatCause[];
  players: PlayerMetrics[];
}

/** 受攻撃の推移を1秒ごとに記録し、ラウンド終了時に集計する */
export class RoundRecorder {
  private samples: { block: number; pending: number }[][] = [];
  private next = 0;

  constructor(private readonly game: Game) {
    this.samples = game.players.map(() => []);
  }

  /** 毎tick呼んでよい（1秒ごとに標本） */
  sample(): void {
    const g = this.game;
    if (g.tick < this.next) return;
    this.next = g.tick + g.config.tickRate;
    g.players.forEach((p, i) => this.samples[i].push({ block: p.incoming.blockRemaining + p.incoming.waveRemaining, pending: p.incoming.nextPending }));
  }

  finish(): RoundMetrics {
    return measureRound(this.game, this.samples);
  }
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function measureRound(g: Game, samples: { block: number; pending: number }[][] = []): RoundMetrics {
  const ev = g.events as ReadonlyArray<GameEvent>;
  const sec = (t: number) => t / g.config.tickRate;
  const of = <T extends GameEvent['type']>(type: T, p: PlayerId) => ev.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type && 'player' in e && e.player === p);
  const causes: DefeatCause[] = [];
  for (const e of ev) {
    if (e.type === 'danger' && e.state === 'defeat') causes.push('natural_danger');
    if (e.type === 'attackPinch' && e.state === 'defeat') causes.push('attack_pinch');
  }
  const players = g.players.map((p, i): PlayerMetrics => {
    const pid = i as PlayerId;
    const declares = of('declare', pid);
    const attacks = of('attack', pid);
    // 連鎖：chainCount が 1 に戻った宣言の直前までを1つの連鎖とする
    const runs: number[] = [];
    for (const d of declares) {
      if (d.chainCount <= 1 || runs.length === 0) runs.push(1);
      else runs[runs.length - 1] = d.chainCount;
    }
    const continued = runs.filter((r) => r >= 2).length;
    const lastRunOpen = p.chainRemaining > 0 && runs.length > 0;
    const s = p.incoming.stats;
    const reached7 =
      of('rise', pid).filter((e) => e.heightBefore < 7 && e.heightAfter >= 7).length;
    const smp = samples[i] ?? [];
    return {
      declares: declares.length,
      declareIntervalSec: declares.length >= 2 ? sec(declares[declares.length - 1].tick - declares[0].tick) / (declares.length - 1) : null,
      clearAvg: avg(declares.map((d) => d.result.clear)),
      chains: {
        continued,
        max: Math.max(0, ...runs),
        brokenByTimeout: Math.max(0, runs.length - (lastRunOpen ? 1 : 0)),
        endedByRound: lastRunOpen ? 1 : 0,
      },
      attack: {
        base: attacks.reduce((a, e) => a + e.breakdown.base, 0),
        streakBonus: attacks.reduce((a, e) => a + e.breakdown.streakBonus, 0),
        chainBonus: attacks.reduce((a, e) => a + e.breakdown.chainBonus, 0),
        power: attacks.reduce((a, e) => a + e.breakdown.power, 0),
        sent: attacks.reduce((a, e) => a + e.counter.sent, 0),
        zeroPowerDeclares: attacks.filter((e) => e.breakdown.power === 0).length,
      },
      incoming: { received: s.received, overflow: s.overflow, canceled: s.canceled, applied: s.applied, pinchDiscarded: s.pinchDiscarded, blocks: s.blocks, waves: s.waves },
      reached7,
      attackPinchGraces: of('attackPinch', pid).filter((e) => e.state === 'grace').length,
      stock: {
        blockMax: Math.max(0, ...smp.map((x) => x.block)),
        blockAvg: avg(smp.map((x) => x.block)) ?? 0,
        pendingMax: Math.max(0, ...smp.map((x) => x.pending)),
        pendingAvg: avg(smp.map((x) => x.pending)) ?? 0,
      },
    };
  });
  return {
    seconds: sec(g.result?.tick ?? g.tick),
    decided: !!g.result,
    outcome: g.result?.outcome ?? null,
    winner: g.result?.winner ?? null,
    causes: g.result ? (causes.length ? causes : ['other']) : [],
    players,
  };
}

/** V320-FIX-06-R1 ピンチの集計（プレイヤーごと） */
export interface PinchCounts {
  /** 有効なピンチ猶予なし→あり（自然上昇の危険猶予・攻撃ピンチ猶予のどちらか） */
  starts: number;
  /** あり→両方なし（敗北は含めない） */
  recoveries: number;
  /** ピンチ中に敗北した回数（復帰に含めない） */
  defeatedInPinch: number;
  /** 計測終了時にピンチ継続中（0／1） */
  ongoingAtEnd: number;
}

/**
 * V320-FIX-06-R1 ピンチの開始・復帰を同じ単位で数える：毎tick（step の後）に sample() を呼ぶ。
 * 有効なピンチ猶予＝Game.pinchRemainingTicks（自然の危険猶予と攻撃ピンチ猶予の早い方）が null でない状態。
 * 重複した猶予の片方だけの解除は復帰にしない。敗北した tick 以降はそのプレイヤーを数えない
 */
export class PinchTracker {
  private readonly active: boolean[];
  private readonly out: PinchCounts[];
  private readonly dead: boolean[];

  constructor(private readonly game: Game) {
    this.active = game.players.map(() => false);
    this.dead = game.players.map(() => false);
    this.out = game.players.map(() => ({ starts: 0, recoveries: 0, defeatedInPinch: 0, ongoingAtEnd: 0 }));
  }

  sample(): void {
    this.game.players.forEach((p, i) => {
      if (this.dead[i]) return;
      if (p.defeated) {
        this.dead[i] = true;
        if (this.active[i]) this.out[i].defeatedInPinch++;
        this.active[i] = false;
        return;
      }
      const on = this.game.pinchRemainingTicks(p) !== null;
      if (on && !this.active[i]) this.out[i].starts++;
      else if (!on && this.active[i]) this.out[i].recoveries++;
      this.active[i] = on;
    });
  }

  finish(): PinchCounts[] {
    return this.out.map((c, i) => ({ ...c, ongoingAtEnd: this.active[i] && !this.dead[i] ? 1 : 0 }));
  }
}
