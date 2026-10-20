// 起動：素材（画像13枚・音声）を読み込み、メインメニューへ直行する（独立したタイトル画面は無い）。
// 論理640×360を整数倍で表示（画像補間なし）。画面外にはみ出す倍率は使わない。ブラウザ全画面に対応。
import { App, GameScene, H, W } from './app';
import { AudioBus } from './audio/audioBus';
import { allAudioFiles } from './audio/audioMap';
import { DEFAULT_VIEW_CONFIG } from './core/config';
import { browserPads } from './input/controller';
import { loadSettings, type AppSettings } from './input/settings';
import { loadAssets } from './view/assets';
import { chooseScale } from './view/scale';
import { AssetViewer } from './view/viewer';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const DEV = import.meta.env.DEV;

let display: AppSettings['display'] = { scale: 0, fullscreen: false };

function fit(): void {
  const scale = chooseScale(display.scale, window.innerWidth, window.innerHeight);
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  canvas.dataset.scale = String(scale);
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
    dev: DEV,
  });
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
  };

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(250, now - last);
    last = now;
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
