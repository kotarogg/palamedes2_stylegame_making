// 起動：素材（第3版 画像49枚・フォント・音声）を読み込み、タイトル画面へ。
// 表示（第17章 B6）：論理640×360を実画素の整数倍で表示（描画バッファ 640N×360N、CSS 640N/DPR）。画像補間なし。
// 収まらない固定倍率は使わず、収まる最大へ明示的に切り替えて通知する。1倍も収まらない場合だけ緊急縮小（通知あり）。ブラウザ全画面に対応。
import { App, GameScene, H, W } from './app';
import { AudioBus } from './audio/audioBus';
import { allAudioFiles } from './audio/audioMap';
import { DEFAULT_VIEW_CONFIG } from './core/config';
import { browserPads } from './input/controller';
import { loadSettings, type AppSettings } from './input/settings';
import { loadAssets } from './view/assets';
import { resolveScale, type ScaleResult } from './view/scale';
import { AssetViewer } from './view/viewer';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const DEV = import.meta.env.DEV;

let display: AppSettings['display'] = { scale: 0, fullscreen: false };
let current: ScaleResult = resolveScale(0, W, H, 1);
let lastDpr = window.devicePixelRatio || 1;
/** 倍率の切替・緊急縮小の通知（App 起動前に起きたものは起動後に表示） */
let notify: (msg: string) => void = () => undefined;
let pendingNotice: string | null = null;
let onSwitchedToFit: () => void = () => undefined;

function fit(): void {
  const dpr = window.devicePixelRatio || 1;
  lastDpr = dpr;
  const r = resolveScale(display.scale, window.innerWidth, window.innerHeight, dpr);
  if (canvas.width !== r.bufferW || canvas.height !== r.bufferH) {
    canvas.width = r.bufferW;
    canvas.height = r.bufferH;
  }
  canvas.style.width = `${r.cssW}px`;
  canvas.style.height = `${r.cssH}px`;
  canvas.dataset.scale = String(r.n);
  canvas.dataset.scaleMode = r.mode;
  canvas.dataset.dpr = String(dpr);
  const prev = current;
  current = r;
  if (r.switchedToFit) {
    const want = display.scale;
    display.scale = 0;
    onSwitchedToFit();
    const msg = `画面表示倍率 ×${want} はこの画面に収まらないため「収まる最大」へ切り替えました`;
    pendingNotice = msg;
    notify(msg);
  }
  if (r.mode === 'emergency' && prev.mode !== 'emergency') {
    const msg = '画面が小さく実画素1倍も収まらないため、縮小して表示しています（ドットが不均等になります）';
    pendingNotice = msg;
    notify(msg);
  }
}

function requestFullscreen(on: boolean): void {
  try {
    if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
    if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  } catch {
    /* 全画面に対応しない環境 */
  }
}

window.addEventListener('resize', fit);
document.addEventListener('fullscreenchange', fit);

function showError(msg: string): void {
  ctx.fillStyle = '#200000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ff8080';
  ctx.font = '12px sans-serif';
  msg.split('\n').forEach((l, i) => ctx.fillText(l, 12, 24 + i * 16));
}

async function boot(): Promise<void> {
  ctx.fillStyle = '#0b0b1c';
  ctx.fillRect(0, 0, W, H);
  const settings = loadSettings();
  display = settings.display;
  fit();
  const bus = new AudioBus('./');
  const [assets] = await Promise.all([loadAssets('./', DEFAULT_VIEW_CONFIG.darkAlpha), bus.preload(allAudioFiles())]);
  const app = new App({
    assets,
    bus,
    pads: browserPads,
    settings,
    applyDisplay: (d) => {
      display = d;
      fit();
    },
    requestFullscreen,
    viewport: () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
    openUrl: (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    dev: DEV,
  });
  notify = (msg) => app.showNotice(msg, 6000);
  onSwitchedToFit = () => {
    app.settings.display.scale = 0;
    app.saveSettings();
  };
  if (pendingNotice) notify(pendingNotice);
  if (display.scale !== app.settings.display.scale) onSwitchedToFit();
  const viewer = DEV ? new AssetViewer(assets) : null;
  let viewerOn = false;
  let firstInput = true;
  const onFirstInput = () => {
    void bus.unlock();
    if (firstInput && app.settings.display.fullscreen) requestFullscreen(true);
    firstInput = false;
  };
  window.addEventListener('keydown', (e) => {
    onFirstInput();
    if (DEV && e.code === 'F8') {
      // 開発版だけ：人間のプレイの計測記録（第21章）をJSONで保存。製品版には無い
      const blob = new Blob([JSON.stringify(app.devMetrics, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `kotaro_puzzle_metrics_${Date.now()}.json`;
      a.click();
      e.preventDefault();
      return;
    }
    if (viewer && e.code === 'F9') {
      viewerOn = !viewerOn;
      e.preventDefault();
      return;
    }
    if (viewer && viewerOn) {
      if (e.code === 'ArrowLeft') viewer.next(-1);
      else if (e.code === 'ArrowRight') viewer.next(1);
      e.preventDefault();
      return;
    }
    if (app.onKey(e.code, e.repeat)) e.preventDefault();
    else if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
  });
  window.addEventListener('pointerdown', onFirstInput);
  window.addEventListener('gamepadconnected', () => fit());

  // 自動検証用のフック（通常の操作経路やメニューには出さない）
  (window as unknown as { __p2like: unknown }).__p2like = {
    app,
    bus,
    scene: () => app.scene,
    game: () => (app.scene instanceof GameScene ? app.scene.game : null),
    gameScene: () => (app.scene instanceof GameScene ? app.scene : null),
    ...(DEV ? { metrics: () => app.devMetrics } : {}),
  };

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(250, now - last);
    last = now;
    // 別の画面へ移動した等で devicePixelRatio が変わったら倍率を選び直す
    if ((window.devicePixelRatio || 1) !== lastDpr) fit();
    // 論理座標640×360で描き、描画バッファの実画素倍率で拡大（補間なし）
    ctx.setTransform(current.n, 0, 0, current.n, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (viewer && viewerOn) viewer.render(ctx, now);
    else app.frame(dt, now, ctx);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.body.dataset.ready = '1';
}

boot().catch((err: unknown) => {
  console.error(err);
  showError(`起動に失敗しました。\n${err instanceof Error ? err.message : String(err)}\nstart-windows.bat から起動するか、README の手順でローカルHTTPサーバー経由で開いてください。`);
  document.body.dataset.ready = 'error';
});
