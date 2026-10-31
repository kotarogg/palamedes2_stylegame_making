// V320-MEASURE-01 計測用ビルドの確認表示（既存フォント＋簡単な図形。追加画像なし）。
// 配置：画面最上段の帯（y0〜34）のうち、左右のプレイヤー名と中央の「MODE1」の間。盤面（y128〜）・手役（y36〜60）・連鎖HUD（外側の縦帯）に掛けない。
// - 左帯（x74〜288）：常時「計測用」と設定・計測状態、任意でセッションIDと経過時間（録画との照合用）
// - 右帯（x352〜532）：任意で入力表示（現在のパッド入力・最後に実行した操作・予約中の操作・操作ロックの理由と残り・最後に破棄された操作と理由）
// 表示を消しても記録は続く（記録は MeasureRecorder 側）。
import type { Game } from '../core/game';
import { ACTION_LABEL, type PadState } from '../input/controller';
import { drawText } from '../view/text';
import { LAUNCH_PROFILES } from './profile';
import { MEASURE_WORK_ID, type MeasureRecorder } from './recorder';

export const OVERLAY = { left: { x: 74, w: 214 }, right: { x: 352, w: 180 }, lineY: [2, 13, 24] as const, size: 9 } as const;

export const REASON_LABEL: Record<string, string> = {
  launch: '打上硬直',
  pack: '成功後の列詰め',
  rotate: '列入替中',
  declareFail: '不成立硬直',
  role: '役演出中',
  defeated: '敗北後',
  edge: '左右端',
  emptyColumn: '列が空',
  returningColumn: '帰還中の列',
  singlePiece: '1個の列',
  tooFew: '手役不足',
  riseInProgress: '上昇中',
  riseLimit: '上昇上限',
  notStarted: '試合開始前',
  roundEnded: '決着後',
  clearPending: 'ノルマ達成後',
  expired: '予約期限切れ',
  overwritten: '予約上書き',
  released: '離して取消',
  simultaneous: '左右同時',
  repeatIgnored: '反復は予約しない',
  locked: '移動後に操作不可',
  state: '状態変化で取消',
  dialog: '確認表示中',
  result: '結果表示中',
  prestart: '開始前待機',
  focusLost: 'フォーカス喪失',
};

const actionLabel = (a: string): string => (ACTION_LABEL as Record<string, string>)[a] ?? a;
const fmtTime = (ms: number): string => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

const BUTTON_NAME: Record<number, string> = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'BACK', 9: 'START', 10: 'LS', 11: 'RS', 12: '↑', 13: '↓', 14: '←', 15: '→' };

export function padSummary(s: PadState | null | undefined): string {
  if (!s) return '未接続';
  const b = s.buttons.map((x, i) => (x?.pressed ? (BUTTON_NAME[i] ?? `b${i}`) : null)).filter(Boolean).join(',');
  const ax = s.axes[0] ?? 0;
  const ay = s.axes[1] ?? 0;
  const dir = `${ax > 0.5 ? '→' : ax < -0.5 ? '←' : ''}${ay > 0.5 ? '↓' : ay < -0.5 ? '↑' : ''}`;
  return `${b || '—'} ｽﾃｨｯｸ(${ax.toFixed(2)},${ay.toFixed(2)})${dir}`;
}

export interface OverlayGame {
  game: Game | null;
  /** 人間のプレイヤーと使うパッド番号（キーボードは null） */
  humans: { player: number; pad: number | null }[];
}

export function drawMeasureOverlay(ctx: CanvasRenderingContext2D, rec: MeasureRecorder, g: OverlayGame | null): void {
  const L = OVERLAY.left;
  const y = OVERLAY.lineY;
  const o = { size: OVERLAY.size, box: true, maxWidth: L.w } as const;
  const state = rec.recording ? '●計測中' : rec.state === 'stopped' ? (rec.unsaved ? '■停止・未保存' : '■停止・保存済') : '未計測';
  drawText(ctx, `計測用 ${MEASURE_WORK_ID}｜打上${rec.profile}(${LAUNCH_PROFILES[rec.profile].launchMs}+${LAUNCH_PROFILES[rec.profile].packMs}ms)｜${state}`, L.x, y[0], { ...o, color: rec.recording ? '#ff9a9a' : '#c0ffd0' });
  if (rec.showSession && rec.sessionId) drawText(ctx, `${rec.sessionId}  ${fmtTime(rec.elapsedMs())}  ${rec.count}件`, L.x, y[1], { ...o, color: '#fff1d6' });
  if (!rec.showInput || !g?.game) return;
  const R = OVERLAY.right;
  const ro = { size: OVERLAY.size, box: true, maxWidth: R.w, color: '#fff1d6' } as const;
  const game = g.game;
  const h = g.humans[0];
  if (!h) return;
  const p = game.players[h.player];
  if (!p) return;
  const pad = h.pad === null ? 'キーボード' : padSummary(rec.padLive.get(h.pad));
  drawText(ctx, `${h.player + 1}P 入力:${pad}`, R.x, y[0], ro);
  const ex = rec.live.lastExecuted && rec.live.lastExecuted.player === h.player ? actionLabel(rec.live.lastExecuted.action) : '—';
  const buf = p.buffered ? actionLabel(p.buffered) : '—';
  const lock = game.lockReason(p);
  const rest = lock === 'none' || lock === 'role' || lock === 'defeated' ? '' : `${Math.max(0, ((p.lockUntil - game.tick) * 1000) / 60).toFixed(0)}ms`;
  drawText(ctx, `実行:${ex} 予約:${buf} ロック:${lock === 'none' ? '—' : `${REASON_LABEL[lock] ?? lock}${rest}`}`, R.x, y[1], ro);
  const d = rec.live.lastDiscard && rec.live.lastDiscard.player === h.player ? rec.live.lastDiscard : null;
  drawText(ctx, `破棄:${d ? `${actionLabel(d.action)}（${REASON_LABEL[d.reason] ?? d.reason}）` : '—'}`, R.x, y[2], ro);
}
