// v3.2.0 移動の先行入力（MODE1・MODE2 共通）。既存の「移動中の入力保持（1件）」に受付tick・期限・消費条件を付けたもの。
// 別の無期限バッファは持たない。左右移動だけ期限（既定2tick、受付tickから期限tickを含む）を付け、発射・宣言・入替の保持は従来どおり。
// - 次に移動できる最初のtickで、有効な予約を1回だけ実行・消費する（移動時間・最短周期は変えない）
// - 新しい押下は最後の1件で上書き（反対方向の新規押下は方向を更新）。自動反復（キーリピート・パッドの反復）は予約を上書きせず、期限も延ばさない
// - 離した時（cancelRepeat）は自動反復でできた予約を捨てる。明示的な短押しは期限内だけ有効
// - 同じtickの左右の新規押下は中立（どちらも実行しない）

export interface HeldInput<A extends string> {
  buffered: A | null;
  /** 予約の受付tick（入力が適用されたtick） */
  bufferedTick: number;
  /** 自動反復でできた予約か */
  bufferedRepeat: boolean;
}

export interface InputLogEntry {
  tick: number;
  player: number;
  event: 'buffer' | 'consume' | 'discard';
  action: string;
  reason?: 'expired' | 'edge' | 'locked' | 'overwritten' | 'released' | 'simultaneous' | 'state' | 'repeatIgnored';
}

export const MOVE_ACTIONS: ReadonlySet<string> = new Set(['left', 'right']);

interface Cmd {
  type: string;
  repeat?: boolean;
}

/** 同じtickに左右の新規押下が両方ある場合は中立：両方を取り除く（記録あり） */
export function neutralizeSimultaneous<C extends Cmd>(cmds: readonly C[], log: (e: Omit<InputLogEntry, 'tick' | 'player'>) => void): C[] {
  const fresh = (t: string) => cmds.some((c) => c.type === t && !c.repeat);
  if (!(fresh('left') && fresh('right'))) return [...cmds];
  log({ event: 'discard', action: 'left+right', reason: 'simultaneous' });
  return cmds.filter((c) => !MOVE_ACTIONS.has(c.type));
}

/** 移動中に届いた入力を予約へ。戻り値：予約を変えたか */
export function offer<A extends string>(h: HeldInput<A>, action: A, repeat: boolean, tick: number, log: (e: Omit<InputLogEntry, 'tick' | 'player'>) => void): void {
  if (repeat) {
    // 自動反復：既存の予約（発射・宣言・同方向など）を上書きせず、期限も延ばさない。空のときだけ予約を作る
    if (h.buffered !== null) {
      log({ event: 'discard', action, reason: 'repeatIgnored' });
      return;
    }
  } else if (h.buffered !== null) log({ event: 'discard', action: h.buffered, reason: 'overwritten' });
  h.buffered = action;
  h.bufferedTick = tick;
  h.bufferedRepeat = repeat;
  log({ event: 'buffer', action });
}

/** 離した：自動反復でできた予約を捨てる */
export function release<A extends string>(h: HeldInput<A>, log: (e: Omit<InputLogEntry, 'tick' | 'player'>) => void): void {
  if (h.buffered !== null && h.bufferedRepeat) {
    log({ event: 'discard', action: h.buffered, reason: 'released' });
    clear(h);
  }
}

/** 移動できる状態になったtickで予約を取り出す。左右移動は期限切れなら捨てる */
export function take<A extends string>(h: HeldInput<A>, tick: number, windowTicks: number, log: (e: Omit<InputLogEntry, 'tick' | 'player'>) => void): A | null {
  const a = h.buffered;
  if (a === null) return null;
  const expired = MOVE_ACTIONS.has(a) && tick > h.bufferedTick + windowTicks;
  clear(h);
  if (expired) {
    log({ event: 'discard', action: a, reason: 'expired' });
    return null;
  }
  return a;
}

export function clear<A extends string>(h: HeldInput<A>): void {
  h.buffered = null;
  h.bufferedTick = -1;
  h.bufferedRepeat = false;
}
