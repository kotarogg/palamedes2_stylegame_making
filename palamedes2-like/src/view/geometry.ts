// 描画座標の純関数。ゲームロジックへは書き戻さない。

/** 描画レイヤー（screen_layout_v2.json layers と同値。テストで照合） */
export const Z = {
  background: 0,
  field: 10,
  darkPiece: 30,
  piece: 40,
  ui: 50,
  glowBack: 55,
  character: 60,
  glowFront: 65,
  roleName: 70,
  returning: 80,
  launching: 90,
  contact: 95,
  result: 100,
  banner: 110,
} as const;

export const CELL = 32;

export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 足場（キャラの足元＝最長列の上端）のY。height は予約空白を含む最長列の段数 */
export const barY = (board: BoardRect, height: number): number => board.y + board.h - CELL * height;

/** キャラ足元中央X（screen_layout dynamic.character: boardX + 16 + 32*column） */
export const columnCenterX = (board: BoardRect, col: number): number => board.x + CELL / 2 + CELL * col;

export const cellX = (board: BoardRect, col: number): number => board.x + CELL * col;

export const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);

export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

export const easeOutQuad = (u: number): number => 1 - (1 - u) * (1 - u);

export const easeInOutSine = (u: number): number => -(Math.cos(Math.PI * u) - 1) / 2;

export const progress = (t: number, start: number, end: number): number =>
  end <= start ? 1 : clamp01((t - start) / (end - start));

/**
 * 失敗帰還の低速下降。開始・終了時刻は固定し、目標Yは毎描画で最新の予約位置を取得する。
 * 盤面上昇で目標が動いても所要時間は変わらず、u=1 で必ず目標Yに一致する。
 */
export function descentY(t: number, start: number, end: number, startY: number, targetYNow: number): number {
  const u = progress(t, start, end);
  return lerp(startY, targetYNow, easeInOutSine(u));
}

/** 高速の山なり曲線（基準→元列X）。h は頂点の持ち上げ量 */
export function arcPoint(
  u: number,
  from: readonly [number, number],
  to: readonly [number, number],
  h: number,
): [number, number] {
  return [lerp(from[0], to[0], u), lerp(from[1], to[1], u) - 4 * h * u * (1 - u)];
}
