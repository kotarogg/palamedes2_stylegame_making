// V320-MEASURE-01 計測用ビルドの打上硬直の比較設定（開始前に選ぶ。ラウンド途中では変えない）。
// プレイヤーと CPU は同じ Game.config.timing を使うため共通に適用される（CPU の見積りも game.config.timing を読む）。
// 変えるのは打上（飛行＝操作硬直＝行きの飛行）と成功後の列詰めだけ。跳ね返り・山なり帰還・垂直下降・先行入力の範囲は変えない。
import { DEFAULT_CONFIG, msToTicks, type GameConfig } from '../core/config';

export type LaunchProfileId = 'A' | 'B';

export interface LaunchProfile {
  id: LaunchProfileId;
  label: string;
  launchMs: number;
  packMs: number;
}

export const LAUNCH_PROFILES: Record<LaunchProfileId, LaunchProfile> = {
  A: { id: 'A', label: 'A 現行比較用（飛行300ms＋列詰め120ms）', launchMs: 300, packMs: 120 },
  B: { id: 'B', label: 'B 250ms試験用（飛行200ms＋列詰め50ms）', launchMs: 200, packMs: 50 },
};

/** 初期選択（依頼書：B） */
export const DEFAULT_LAUNCH_PROFILE: LaunchProfileId = 'B';

/** 実効値の記録（設定 ms と 60tick 換算の tick）。失敗時の総帰還時間（発射〜帰還完了）も併記 */
export function profileReport(id: LaunchProfileId, tickRate = 60) {
  const p = LAUNCH_PROFILES[id];
  const t = DEFAULT_CONFIG.timing;
  const ticks = (ms: number) => msToTicks(ms, tickRate);
  const failTotalMs = p.launchMs + t.bounceMs + t.arcMs + t.descendMs;
  return {
    id,
    label: p.label,
    launchMs: p.launchMs,
    packMs: p.packMs,
    launchTicks: ticks(p.launchMs),
    packTicks: ticks(p.packMs),
    successLockTicks: ticks(p.launchMs) + ticks(p.packMs),
    successLockMs: ((ticks(p.launchMs) + ticks(p.packMs)) * 1000) / tickRate,
    /** 変えない設定（記録用） */
    bounceMs: t.bounceMs,
    arcMs: t.arcMs,
    descendMs: t.descendMs,
    moveBufferTicks: DEFAULT_CONFIG.moveBufferTicks,
    /** 失敗時：発射から帰還完了までの合計（飛行＋跳ね返り＋山なり＋下降） */
    failTotalMs,
    failTotalTicks: ticks(p.launchMs) + ticks(t.bounceMs) + ticks(t.arcMs) + ticks(t.descendMs),
  };
}

/** Match／SingleSession へ渡す設定の差分（timing の該当2項目だけ） */
export function profileConfig(id: LaunchProfileId): Partial<GameConfig> {
  const p = LAUNCH_PROFILES[id];
  return { timing: { ...DEFAULT_CONFIG.timing, launchMs: p.launchMs, packMs: p.packMs } };
}
