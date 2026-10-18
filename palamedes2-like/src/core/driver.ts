// 可変フレーム時間から固定ステップでロジックを進める。描画側はalphaで補間するだけ。

export interface Steppable {
  readonly tickMs: number;
  step(): void;
}

export class FixedStepDriver {
  private acc = 0;
  /** 1フレームで進める最大tick（タブ復帰時の暴走防止） */
  maxStepsPerAdvance = 30;

  constructor(private readonly target: Steppable) {}

  /** dtMs だけ時間を進め、実行したtick数を返す */
  advance(dtMs: number): number {
    this.acc += Math.max(0, dtMs);
    const tickMs = this.target.tickMs;
    let steps = 0;
    while (this.acc >= tickMs && steps < this.maxStepsPerAdvance) {
      this.acc -= tickMs;
      this.target.step();
      steps++;
    }
    if (steps === this.maxStepsPerAdvance) this.acc = Math.min(this.acc, tickMs);
    return steps;
  }

  /** 次tickまでの進捗 [0,1) */
  get alpha(): number {
    return this.acc / this.target.tickMs;
  }
}
