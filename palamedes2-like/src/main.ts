import { DEFAULT_VIEW_CONFIG, PROVISIONAL_HANDLING } from './core/config';
import { FixedStepDriver } from './core/driver';
import { Game, type Command } from './core/game';
import type { PlayerId } from './core/types';
import { DEFAULT_BINDINGS, KeyboardController, type Controller } from './input/controller';
import { loadAssets, type Assets } from './view/assets';
import { GameView } from './view/gameView';
import { AssetViewer } from './view/viewer';

const W = 640;
const H = 360;

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

/** 整数倍で拡大（ドットを滲ませない）。画面が640px未満なら縮小のみ許可 */
function fit(): void {
  const s = Math.min(window.innerWidth / W, window.innerHeight / H);
  const scale = s >= 1 ? Math.floor(s) : s;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
}
window.addEventListener('resize', fit);
fit();

const params = new URLSearchParams(location.search);
const seedParam = params.get('seed');

function newSeed(): number {
  return seedParam !== null ? Number(seedParam) >>> 0 : (Math.random() * 0xffffffff) >>> 0;
}

interface App {
  assets: Assets;
  game: Game;
  driver: FixedStepDriver;
  view: GameView;
  viewer: AssetViewer;
  mode: 'game' | 'viewer';
  paused: boolean;
  help: boolean;
  debugQueue: Command[];
  controllers: Controller[];
  keyboards: KeyboardController[];
  fps: number;
}

function createGame(app: Pick<App, 'controllers' | 'debugQueue'>): { game: Game; driver: FixedStepDriver } {
  const game = new Game({ seed: newSeed() });
  const driver = new FixedStepDriver(game, (g) => {
    const cmds = app.controllers.flatMap((c) => c.poll(g));
    cmds.push(...app.debugQueue.splice(0));
    return cmds;
  });
  return { game, driver };
}

const KEY_LABEL: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Slash: '/',
  Period: '.',
  NumpadEnter: 'テンキーEnter',
  Numpad0: 'テンキー0',
};
const keyName = (c: string) => KEY_LABEL[c] ?? c.replace(/^Key/, '');

function drawHelp(app: App): void {
  ctx.save();
  ctx.fillStyle = 'rgba(8,8,24,0.92)';
  ctx.fillRect(20, 16, 600, 328);
  ctx.font = '10px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif';
  ctx.textBaseline = 'top';
  let y = 22;
  const line = (s: string, color = '#ffffff') => {
    ctx.fillStyle = color;
    ctx.fillText(s, 28, y);
    y += 12;
  };
  line('操作説明（キー割当は検証用のテスト設定。正式割当は未確定 G06）', '#ffd060');
  const names: Record<string, string> = { left: '左', right: '右', launch: '打ち上げ', rotate: 'B入替', declare: '役宣言', manualRise: '手動上昇' };
  for (const p of [0, 1] as PlayerId[]) {
    const b = DEFAULT_BINDINGS[p];
    line(`${p + 1}P： ` + Object.entries(b).map(([a, keys]) => `${names[a]}=${keys.map(keyName).join('/')}`).join('  '));
  }
  line('共通： F1/H=この説明  R=最初から  P=一時停止  V=素材確認画面  1/2=1Pへ攻撃+1/+10  9/0=2Pへ攻撃+10/+1（検証用注入）');
  line(`seed=${app.game.seed}（URLに ?seed=数値 で再現）  tick=${app.game.tick}  描画FPS≒${app.fps.toFixed(0)}`, '#9aa4c0');
  y += 4;
  line('未確定事項に対する検証版の暫定的な扱い（正式仕様ではない）', '#ffd060');
  for (const [k, v] of PROVISIONAL_HANDLING) line(`・${k}：${v}`, '#d0d8f0');
  ctx.restore();
}

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
  const assets = await loadAssets(import.meta.env.BASE_URL, DEFAULT_VIEW_CONFIG.darkAlpha);
  const keyboards = [new KeyboardController(0), new KeyboardController(1)];
  const shell = { controllers: keyboards as Controller[], debugQueue: [] as Command[] };
  const { game, driver } = createGame(shell);
  const app: App = {
    ...shell,
    assets,
    game,
    driver,
    view: new GameView(game, assets),
    viewer: new AssetViewer(assets),
    mode: 'game',
    paused: false,
    help: false,
    keyboards,
    fps: 60,
  };

  const restart = () => {
    const g = createGame(app);
    app.game = g.game;
    app.driver = g.driver;
    app.view.reset(g.game);
  };

  window.addEventListener('keydown', (e) => {
    const code = e.code;
    if (code === 'F1' || code === 'KeyH') {
      app.help = !app.help;
    } else if (code === 'KeyV') {
      app.mode = app.mode === 'game' ? 'viewer' : 'game';
    } else if (app.mode === 'viewer') {
      if (code === 'ArrowLeft') app.viewer.next(-1);
      else if (code === 'ArrowRight') app.viewer.next(1);
      else return;
    } else if (code === 'KeyR') {
      restart();
    } else if (code === 'KeyP') {
      app.paused = !app.paused;
    } else if (code === 'Digit1' || code === 'Digit2' || code === 'Digit9' || code === 'Digit0') {
      const player: PlayerId = code === 'Digit1' || code === 'Digit2' ? 0 : 1;
      app.debugQueue.push({ player, type: 'debugAttack', lines: code === 'Digit2' || code === 'Digit9' ? 10 : 1 });
    } else if (!app.paused && !app.keyboards.some((k) => k.handleKey(code, e.repeat))) {
      return;
    }
    e.preventDefault();
  });

  // 自動検証用の窓口（ゲームロジックの状態は読み取り専用で使う）
  (window as unknown as { __p2like: unknown }).__p2like = {
    app,
    restart,
    inject: (cmd: Command) => app.debugQueue.push(cmd),
  };

  let last = performance.now();
  let fpsAcc = 0;
  let fpsFrames = 0;
  const frame = (now: number) => {
    const dt = Math.min(250, now - last);
    last = now;
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc >= 500) {
      app.fps = (fpsFrames * 1000) / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;
    }
    if (app.mode === 'viewer') app.viewer.render(ctx, now);
    else {
      if (!app.paused) app.driver.advance(dt);
      app.view.render(ctx, app.driver.time);
    }
    if (app.help) drawHelp(app);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.body.dataset.ready = '1';
}

boot().catch((err: unknown) => {
  console.error(err);
  showError(`起動に失敗しました。\n${err instanceof Error ? err.message : String(err)}\nローカルHTTPサーバー経由で開いてください（READMEを参照）。`);
  document.body.dataset.ready = 'error';
});
