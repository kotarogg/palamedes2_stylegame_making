import type { Action } from '../core/game';
export interface GestureSink { press(id: number, action: Action): void; release(id: number): void }
/** One contact locks to one axis/action. Ambiguous diagonals and downward swipes do not raise. */
export class FlickGesture {
  private contact: { id: number; x: number; y: number; decided: boolean } | null = null;
  constructor(private sink: GestureSink, private allowRise = true, readonly threshold = 14, readonly dominance = 1.4) {}
  start(id: number, x: number, y: number): boolean {
    if (this.contact) return false;
    this.contact = {id, x, y, decided: false}; return true;
  }
  move(id: number, x: number, y: number): Action | null {
    const c = this.contact;
    if (!c || c.id !== id || c.decided) return null;
    const dx = x-c.x, dy = y-c.y, ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax,ay) < this.threshold) return null;
    let action: Action | null = null;
    if (ax >= ay*this.dominance) action = dx < 0 ? 'left' : 'right';
    else if (ay >= ax*this.dominance) { if (dy < 0 && this.allowRise) action = 'manualRise'; }
    else return null;
    c.decided = true;
    if (action) this.sink.press(id,action);
    return action;
  }
  end(id: number): void {
    if (this.contact?.id !== id) return;
    this.sink.release(id); this.contact = null;
  }
  reset(): void { if (this.contact) this.end(this.contact.id); }
}
