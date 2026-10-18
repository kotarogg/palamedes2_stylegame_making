// 可変フレーム時間から固定ステップでロジックを進める。描画側はalphaで補間するだけ。
import type { Command, Game } from './game';

export type CommandSource = (game: Game) => Command[];

export class FixedStepDriver {
  private acc = 0;
  /** 1フレームで進める最大tick（タブ復帰時の暴走防止） */
  maxStepsPerAdvance = 30;

  constructor(
    readonly game: Game,
    private readonly source: CommandSource,
  ) {}

  /** dtMs だけ時間を進め、実行したtick数を返す */
  advance(dtMs: number): number {
    this.acc += Math.max(0, dtMs);
    const tickMs = this.game.tickMs;
    let steps = 0;
    while (this.acc >= tickMs && steps < this.maxStepsPerAdvance) {
      this.acc -= tickMs;
      this.game.step(this.source(this.game));
      steps++;
    }
    if (steps === this.maxStepsPerAdvance) this.acc = Math.min(this.acc, tickMs);
    return steps;
  }

  /** 次tickまでの進捗 [0,1) */
  get alpha(): number {
    return this.acc / this.game.tickMs;
  }

  /** 補間込みの論理時刻（tick単位の実数） */
  get time(): number {
    return this.game.tick + this.alpha;
  }
}
