import { DEFAULT_VIEW_CONFIG, DIFFICULTY_LABEL, PROVISIONAL_HANDLING } from './core/config';
import { FixedStepDriver } from './core/driver';
import type { Command } from './core/game';
import { Match } from './core/match';
import type { PlayerId } from './core/types';
import {
  ACTION_LABEL,
  ACTIONS,
  browserPads,
  GamepadController,
  KeyboardController,
  keyName,
  padInputName,
  type Controller,
} from './input/controller';
import { CpuController } from './input/cpu';
import { deviceLabel, isHuman, loadSettings, saveSettings, type AppSettings } from './input/settings';
import { loadAssets, type Assets } from './view/assets';
import { GameView } from './view/gameView';
import { SettingsView } from './view/settingsView';
import { SoundBus } from './view/sound';
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
  settings: AppSettings;
  match: Match;
  driver: FixedStepDriver;
  view: GameView;
  viewer: AssetViewer;
  settingsView: SettingsView;
  sound: SoundBus;
  mode: 'game' | 'viewer' | 'settings';
  paused: boolean;
  help: boolean;
  controllers: Controller[];
  keyboards: (KeyboardController | null)[];
  pads: (GamepadController | null)[];
  debugQueue: Command[];
  confirmQueued: boolean;
  fps: number;
}

function buildControllers(app: App): void {
  app.controllers = [];
  app.keyboards = [null, null];
  app.pads = [null, null];
  for (const p of [0, 1] as PlayerId[]) {
    const d = app.settings.devices[p];
    if (d.kind === 'keyboard') {
      const k = new KeyboardController(p, app.settings.keys[p]);
      app.keyboards[p] = k;
      app.controllers.push(k);
    } else if (d.kind === 'gamepad') {
      const g = new GamepadController(p, d.index, app.settings.pads[p]);
      app.pads[p] = g;
      app.controllers.push(g);
    } else {
      app.controllers.push(new CpuController(p, d.level, app.match.settings.seed + p));
    }
  }
}

function newMatch(app: Pick<App, 'settings'>): Match {
  return new Match({ firstTo: app.settings.firstTo, difficulty: app.settings.difficulty, seed: newSeed() });
}

function drawHelp(app: App): void {
  ctx.save();
  ctx.fillStyle = 'rgba(8,8,24,0.94)';
  ctx.fillRect(16, 12, 608, 336);
  ctx.font = '10px "Noto Sans CJK JP", "Yu Gothic", "Meiryo", sans-serif';
  ctx.textBaseline = 'top';
  let y = 18;
  const line = (s: string, color = '#ffffff') => {
    ctx.fillStyle = color;
    ctx.fillText(s, 24, y);
    y += 12;
  };
  line('操作説明（割当は F2 の設定で変更できます）', '#ffd060');
  for (const p of [0, 1] as PlayerId[]) {
    const d = app.settings.devices[p];
    let desc = '';
    if (d.kind === 'keyboard') desc = ACTIONS.map((a) => `${ACTION_LABEL[a]}=${app.settings.keys[p][a].map(keyName).join('/')}`).join('  ');
    else if (d.kind === 'gamepad') desc = ACTIONS.map((a) => `${ACTION_LABEL[a]}=${app.settings.pads[p][a].map(padInputName).join('/')}`).join('  ');
    else desc = '（CPUが操作）';
    line(`${p + 1}P [${deviceLabel(d)}]：${desc}`);
  }
  line('共通：Esc/START=一時停止  F1=この説明  F2=設定  Enter/Space/発射/Ⓐ=勝敗表示後の決定');
  line('　　　R=新しい試合  M=消音  V=素材確認');
  line('検証用：1/2＝1Pへ攻撃+1/+10、9/0＝2Pへ攻撃+10/+1（待機攻撃ストックへの直接加算）  ※割当済みのキーは割当が優先');
  const m = app.match;
  line(`${m.settings.firstTo}本先取・自然上昇${DIFFICULTY_LABEL[m.settings.difficulty]}  seed=${m.settings.seed}（URLに ?seed=数値 で再現）  tick=${m.game.tick}  描画FPS≒${app.fps.toFixed(0)}  音=${app.sound.muted ? 'OFF' : 'ON'}`, '#9aa4c0');
  y += 4;
  line('ルール（2026-10-18 確定事項を実装）', '#ffd060');
  line('・役宣言：消去ライン数＝合計翻数（上側から1ラインずつ）', '#d0d8f0');
  line('・攻撃＝max(合計翻数−1,0)×連続取得の攻撃倍率→切捨て→役連鎖加算→相殺→残りを送信', '#d0d8f0');
  line('・相殺：攻撃力1で待機2まで。不成立宣言は約0.5秒の硬直', '#d0d8f0');
  line('・7段のまま自然上昇時刻を迎えると3秒の危険猶予。解消できなければ8段目の直前で敗北（同時は引分け）', '#d0d8f0');
  y += 4;
  line('仕様に記載が無く、検証版で暫定的に決めている扱い（要確認）', '#ffd060');
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
  const settings = loadSettings();
  const sound = new SoundBus();
  const match = newMatch({ settings });
  const app: App = {
    assets,
    settings,
    match,
    driver: null as unknown as FixedStepDriver,
    view: new GameView(match.game, assets, DEFAULT_VIEW_CONFIG, sound),
    viewer: new AssetViewer(assets),
    settingsView: new SettingsView(settings, browserPads),
    sound,
    mode: 'game',
    paused: false,
    help: false,
    controllers: [],
    keyboards: [null, null],
    pads: [null, null],
    debugQueue: [],
    confirmQueued: false,
    fps: 60,
  };
  buildControllers(app);

  let resultSince = -1;
  const step = () => {
    const m = app.match;
    const game = m.game;
    let cmds = app.controllers.flatMap((c) => c.poll(game));
    cmds.push(...app.debugQueue.splice(0));
    let confirm = app.confirmQueued;
    app.confirmQueued = false;
    for (const pad of app.pads) {
      if (!pad?.confirmPressed) continue;
      pad.confirmPressed = false;
      if (m.state !== 'round') confirm = true;
    }
    if (m.state !== 'round') {
      // 勝敗表示中：人が操作するプレイヤーの発射入力も決定として扱う。全員CPUなら一定時間後に自動で進む
      if (cmds.some((c) => c.type === 'launch' && isHuman(app.settings.devices[c.player]))) confirm = true;
      if (resultSince < 0) resultSince = game.tick;
      if (!app.settings.devices.some(isHuman) && game.tick - resultSince > game.ticks(3000)) confirm = true;
      cmds = [];
    } else resultSince = -1;
    m.step(cmds, confirm);
    if (m.game !== game) app.view.reset(m.game);
  };
  app.driver = new FixedStepDriver({ tickMs: 1000 / 60, step });

  const restart = () => {
    app.match = newMatch(app);
    buildControllers(app);
    app.view.reset(app.match.game);
    app.paused = false;
  };

  const applySettings = (startMatch: boolean) => {
    app.settings = app.settingsView.settings;
    saveSettings(app.settings);
    if (startMatch) restart();
    else buildControllers(app);
  };

  window.addEventListener('keydown', (e) => {
    const code = e.code;
    app.sound.unlock();
    if (app.mode === 'settings') {
      const r = app.settingsView.handleKey(code);
      if (r !== 'none') {
        applySettings(r === 'startMatch');
        app.mode = 'game';
      }
      e.preventDefault();
      return;
    }
    if (code === 'F1') {
      app.help = !app.help;
    } else if (code === 'F2') {
      app.settingsView.open(structuredClone(app.settings));
      app.mode = 'settings';
      app.paused = true;
    } else if (app.mode === 'viewer') {
      if (code === 'ArrowLeft') app.viewer.next(-1);
      else if (code === 'ArrowRight') app.viewer.next(1);
      else if (code === 'KeyV' || code === 'Escape') app.mode = 'game';
      else return;
    } else if (code === 'Escape') {
      app.paused = !app.paused;
    } else if ((code === 'Enter' || code === 'NumpadEnter' || code === 'Space') && app.match.state !== 'round') {
      app.confirmQueued = true;
    } else if (!app.paused && app.keyboards.some((k) => k?.handleKey(code, e.repeat))) {
      // プレイヤー操作として処理済み（割当済みのキーは共通ショートカットより優先）
    } else if (app.keyboards.some((k) => k?.actionOf(code))) {
      // 一時停止中のプレイヤー操作キーは無視
    } else if (code === 'KeyV') {
      app.mode = 'viewer';
    } else if (code === 'KeyR') {
      restart();
    } else if (code === 'KeyM') {
      app.sound.muted = !app.sound.muted;
    } else if (code === 'Digit1' || code === 'Digit2' || code === 'Digit9' || code === 'Digit0') {
      const player: PlayerId = code === 'Digit1' || code === 'Digit2' ? 0 : 1;
      app.debugQueue.push({ player, type: 'debugAttack', lines: code === 'Digit2' || code === 'Digit9' ? 10 : 1 });
    } else {
      return;
    }
    e.preventDefault();
  });

  // 自動検証用の窓口（ゲームロジックの状態は読み取り専用で使う）
  (window as unknown as { __p2like: unknown }).__p2like = {
    app,
    restart,
    inject: (cmd: Command) => app.debugQueue.push(cmd),
    applySettings: (s: AppSettings) => {
      app.settingsView.settings = s;
      applySettings(true);
    },
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
    // ゲームパッドの START（一時停止）。停止中も押下を検出するため毎フレーム確認
    for (const pad of app.pads) {
      if (!pad) continue;
      if (app.paused || app.mode !== 'game') pad.poll();
      if (pad.startPressed) {
        pad.startPressed = false;
        if (app.mode === 'game') app.paused = !app.paused;
      }
    }
    if (app.mode === 'viewer') app.viewer.render(ctx, now);
    else {
      if (!app.paused && app.mode === 'game') app.driver.advance(dt);
      const m = app.match;
      app.view.match = {
        wins: m.wins,
        firstTo: m.settings.firstTo,
        state: m.state,
        canConfirm: m.canConfirm,
        round: m.round,
        paused: app.paused && app.mode === 'game',
        labels: [deviceLabel(app.settings.devices[0]), deviceLabel(app.settings.devices[1])],
      };
      app.view.render(ctx, m.game.tick + app.driver.alpha);
      if (app.mode === 'settings') {
        app.settingsView.pollPad();
        app.settingsView.render(ctx, (i) => browserPads(i) !== null);
      }
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
