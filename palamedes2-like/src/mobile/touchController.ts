import type { Controller } from '../input/controller';
import type { Action, Command } from '../core/game';
import type { AnyGame } from '../core/match';
import type { StepInfo } from '../core/driver';

/** Pointer IDs own buttons. Reset quarantines held fingers until their release. */
export class TouchController implements Controller {
  readonly player = 0 as const;
  private fingers = new Map<number, Action>();
  private blocked = new Set<number>();
  private queue: Command[] = [];
  private direction: 'left' | 'right' | null = null;
  private nextRepeat = 0;
  constructor(private now: () => number = () => performance.now()) {}
  press(id: number, action: Action): void {
    if (this.fingers.has(id) || this.blocked.has(id)) return;
    this.fingers.set(id, action);
    if (action === 'left' || action === 'right') this.updateDirection();
    else this.queue.push({player: 0, type: action});
  }
  release(id: number): void {
    this.blocked.delete(id);
    const action = this.fingers.get(id);
    this.fingers.delete(id);
    if (action === 'left' || action === 'right') this.updateDirection();
  }
  private updateDirection(): void {
    const held = [...this.fingers.values()];
    const left = held.includes('left'), right = held.includes('right');
    const next = left === right ? null : left ? 'left' : 'right';
    if (next === this.direction) return;
    // Opposing fingers cancel even an unconsumed movement in this frame.
    if (left && right) this.queue = this.queue.filter(c => c.type !== 'left' && c.type !== 'right');
    this.queue.push({player: 0, type: 'cancelRepeat'});
    this.direction = next;
    if (next) this.queue.push({player: 0, type: next});
    this.nextRepeat = this.now() + 250;
  }
  reset(): void {
    for (const id of this.fingers.keys()) this.blocked.add(id);
    this.fingers.clear();
    this.direction = null;
    this.queue = [];
  }
  poll(_game?: AnyGame, info?: StepInfo): Command[] {
    if (info && !info.last) return [];
    if (this.direction && this.now() >= this.nextRepeat) {
      this.queue.push({player: 0, type: this.direction, repeat: true});
      this.nextRepeat = this.now() + 100;
    }
    return this.queue.splice(0);
  }
}
