// V320-MEASURE-01 計測メニュー（計測用ビルドのメインメニュー「計測（テスト）」）。パッド（十字キー・A・B）とキーボードで操作。
// 開始前設定（打上硬直 A／B）の確認・変更、表示の切替、計測の開始／停止、記録の保存、初期化（未保存なら確認）。
import type { App, Scene } from '../app';
import type { NavEvent } from '../ui/menuInput';
import { drawConfirm, drawOptionPanel, type OptionRow } from '../ui/screens';
import { drawText, TEXT_COLORS } from '../view/text';
import { LAUNCH_PROFILES, profileReport } from './profile';
import { type MeasureRecorder } from './recorder';

/** 記録をローカルへダウンロード（外部へは送信しない） */
export function downloadRecord(rec: MeasureRecorder, extraHeader: Record<string, unknown> = {}): string {
  const blob = new Blob(rec.exportParts(extraHeader), { type: 'application/json' });
  const name = rec.fileName();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  rec.markSaved();
  return name;
}

export function measureEnv(): Record<string, unknown> {
  if (typeof navigator === 'undefined') return {};
  const pads = typeof navigator.getGamepads === 'function' ? [...navigator.getGamepads()].filter(Boolean).map((g) => ({ index: g!.index, id: g!.id, mapping: g!.mapping })) : [];
  return { userAgent: navigator.userAgent, devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null, pads };
}

type Row = OptionRow & { act?: () => void; dir?: (d: -1 | 1) => void };

export class MeasureMenuScene implements Scene {
  cursor = 0;
  confirmClear: 0 | 1 | null = null;
  message = '';

  constructor(private readonly app: App) {
    app.bus.playBgm('menu');
  }

  private get rec(): MeasureRecorder {
    return this.app.measure!;
  }

  rows(): Row[] {
    const r = this.rec;
    const pr = LAUNCH_PROFILES[r.profile];
    const rep = profileReport(r.profile);
    return [
      {
        label: '打上硬直設定',
        value: `${pr.id}：${pr.launchMs}＋${pr.packMs}ms（${rep.successLockTicks}tick）`,
        arrows: true,
        note: '次に始める試合から適用（プレイヤーとCPUに共通。試合中は変えない）。A＝現行比較用、B＝250ms試験用',
        dir: () => {
          r.profile = r.profile === 'A' ? 'B' : 'A';
          this.app.bus.playSfx('ui_move');
        },
      },
      { label: '入力表示', value: r.showInput ? '表示' : '非表示', arrows: true, note: '非表示でも記録は続きます', dir: () => (r.showInput = !r.showInput) },
      { label: '時刻表示（録画照合用）', value: r.showSession ? '表示' : '非表示', arrows: true, note: 'セッションIDと経過時間を画面左上に表示', dir: () => (r.showSession = !r.showSession) },
      {
        label: r.recording ? '計測を停止' : r.state === 'stopped' ? '計測を再開（同じセッションへ追記）' : '計測を開始',
        note: r.limitStopped ? '記録が上限に達したため再開できません。保存してから初期化してください' : 'プレイ中はSTART（Esc）の確認画面からも開始・停止できます',
        disabled: r.limitStopped && !r.recording,
        act: () => {
          if (r.recording) r.stop();
          else r.start({ ...measureEnv(), from: 'menu' });
          this.message = r.recording ? '計測中です' : '計測を停止しました';
        },
      },
      {
        label: '記録を保存',
        note: '計測を停止してから保存します（JSON。ブラウザのダウンロード）',
        disabled: r.recording || r.count === 0,
        act: () => {
          if (r.recording || r.count === 0) return;
          const name = downloadRecord(r, { savedFrom: 'menu' });
          this.message = `保存しました：${name}`;
        },
      },
      {
        label: '記録を初期化',
        note: '記録を消して未計測へ戻します（未保存なら確認）',
        disabled: r.recording || r.count === 0,
        act: () => {
          if (r.recording || r.count === 0) return;
          if (r.unsaved) this.confirmClear = 0;
          else {
            r.clear();
            this.message = '初期化しました';
          }
        },
      },
      { label: '戻る', act: () => this.app.toMenu() },
    ];
  }

  onNav(ev: NavEvent): void {
    const bus = this.app.bus;
    if (this.confirmClear !== null) {
      if (ev.key === 'left' || ev.key === 'right') this.confirmClear = this.confirmClear === 0 ? 1 : 0;
      else if (ev.key === 'confirm') {
        if (this.confirmClear === 1) {
          this.rec.clear();
          this.message = '未保存の記録を初期化しました';
        }
        this.confirmClear = null;
      } else if (ev.key === 'back') this.confirmClear = null;
      bus.playSfx('ui_move');
      return;
    }
    const rows = this.rows();
    if (ev.key === 'up' || ev.key === 'down') {
      this.cursor = (this.cursor + (ev.key === 'up' ? rows.length - 1 : 1)) % rows.length;
      bus.playSfx('ui_move');
    } else if (ev.key === 'left' || ev.key === 'right') rows[this.cursor].dir?.(ev.key === 'left' ? -1 : 1);
    else if (ev.key === 'confirm') {
      const row = rows[this.cursor];
      if (row.disabled) return;
      bus.playSfx('ui_confirm');
      if (row.dir) row.dir(1);
      else row.act?.();
    } else if (ev.key === 'back') {
      bus.playSfx('ui_cancel');
      this.app.toMenu();
    }
  }

  update(): void {}

  render(ctx: CanvasRenderingContext2D): void {
    const r = this.rec;
    drawOptionPanel(ctx, this.app.assets, '計測（テスト）', this.rows(), this.cursor, this.message);
    const state = r.recording ? '計測中' : r.state === 'stopped' ? (r.unsaved ? '停止中（未保存）' : `停止中（保存済：${r.savedFile}）`) : '未計測';
    const cap = Math.round(Math.max(r.count / r.limits.maxRecords, r.sizeChars / r.limits.maxChars) * 1000) / 10;
    drawText(ctx, `状態：${state}　記録 ${r.count}件（約${(r.sizeChars / 1e6).toFixed(1)}MB・上限の${cap}％）`, 320, 266, { align: 'center', size: 10, color: TEXT_COLORS.onDark, maxWidth: 520 });
    drawText(ctx, `セッション：${r.sessionId ?? '—'}　ビルド：${r.build.mode} ${r.build.commit.slice(0, 7)}`, 320, 280, { align: 'center', size: 10, color: TEXT_COLORS.secondary, maxWidth: 520 });
    if (this.confirmClear !== null) drawConfirm(ctx, this.app.assets, '未保存の記録を初期化しますか？', ['やめる', '初期化する'], this.confirmClear, 176, 124, '保存していない記録は消えます');
  }
}
