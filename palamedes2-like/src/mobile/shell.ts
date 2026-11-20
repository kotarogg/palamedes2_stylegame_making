import { App, GameScene, MenuScene, TitleScene } from '../app';
import type { Action } from '../core/game';
import { BUILD_INFO, RELEASE_LABEL } from '../measure/build';
import { FlickGesture } from './gesture';
import { readMovementMode, writeMovementMode, type MovementMode } from './preferences';
import './mobile.css';

export const mobileEnabled = () => new URLSearchParams(location.search).get('touch') === '1' || matchMedia('(pointer: coarse)').matches;

export class MobileShell {
  readonly stage: HTMLDivElement;
  private shell = document.createElement('main');
  private left = document.createElement('div');
  private right = document.createElement('div');
  private menu = document.createElement('div');
  private resume = document.createElement('div');
  private settingsPanel = document.createElement('div');
  private settingsButton = document.createElement('button');
  private exitButton = document.createElement('button');
  private hint = document.createElement('span');
  private app: App | null = null;
  private signature = '';
  private scene: unknown;
  private game: unknown;
  private gesture: FlickGesture | null = null;
  private interrupted = false;
  private settingsOpen = false;
  private mode: MovementMode = 'buttons';
  get paused(): boolean { return this.interrupted || this.settingsOpen; }

  constructor(canvas: HTMLCanvasElement) {
    document.body.classList.add('mobile');
    try { this.mode = readMovementMode(localStorage); } catch { /* storage unavailable */ }
    this.shell.id = 'mobile-shell';
    const toolbar = document.createElement('div'); toolbar.id = 'mobile-toolbar';
    this.hint.className = 'mobile-hint'; this.hint.textContent = 'ゲームを読み込み中…';
    this.settingsButton.className = 'mobile-settings-open';
    this.settingsButton.onclick = () => this.openSettings();
    this.settingsButton.hidden = true;
    this.exitButton.textContent = '終了'; this.exitButton.hidden = true;
    this.exitButton.onclick = () => { if (!this.paused) { this.clearTouches(); this.app?.onKey('Escape',false); } };
    const fullscreen = document.createElement('button'); fullscreen.textContent = '全画面';
    fullscreen.onclick = () => {
      this.clearTouches();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else if (document.documentElement.requestFullscreen) void document.documentElement.requestFullscreen().catch(() => { this.hint.textContent = '横向きにしてお遊びください'; });
      else this.hint.textContent = '横向きにしてお遊びください';
    };
    toolbar.append(this.exitButton,this.settingsButton,this.hint,fullscreen);
    this.stage = document.createElement('div'); this.stage.id = 'mobile-stage';
    this.menu.id = 'mobile-menu'; this.left.id = 'mobile-left'; this.right.id = 'mobile-right';
    this.stage.append(canvas,this.menu); this.shell.append(toolbar,this.left,this.stage,this.right);
    this.resume.id = 'mobile-resume'; this.resume.hidden = true;
    const message = document.createElement('p'); message.textContent = 'ゲームを中断しています。';
    const button = document.createElement('button'); button.textContent = 'タップして再開';
    button.onclick = () => {
      if (document.hidden) return;
      this.clearTouches(); this.app?.menuInput.clear();
      void this.app?.bus.unlock(); this.interrupted = false; this.resume.hidden = true;
    };
    this.resume.append(message,button);
    this.settingsPanel.id = 'mobile-settings'; this.settingsPanel.hidden = true;
    this.settingsPanel.setAttribute('role','dialog'); this.settingsPanel.setAttribute('aria-modal','true');
    this.settingsPanel.setAttribute('aria-labelledby','mobile-settings-title');
    document.body.append(this.shell,this.settingsPanel,this.resume);
    // Resizing/rotating must never preserve a held button or an old gesture origin.
    window.addEventListener('resize',()=>this.clearTouches());
    window.addEventListener('orientationchange',()=>this.clearTouches());
  }
  connect(app: App): void { this.app = app; this.sync(); }
  private clearTouches(): void {
    this.gesture?.reset(); this.app?.touch.reset();
    this.shell.querySelectorAll('.held').forEach(el=>el.classList.remove('held'));
    this.shell.querySelectorAll('[data-direction]').forEach(el=>el.removeAttribute('data-direction'));
  }
  interrupt(): void {
    if (!this.app) return;
    this.clearTouches(); this.app.menuInput.clear(); this.app.onVisibility(true);
    this.interrupted = true; this.resume.hidden = false;
    void this.app.bus.ctx?.suspend().catch(() => {});
  }
  private openSettings(): void {
    if (!(this.app?.scene instanceof MenuScene || this.app?.scene instanceof TitleScene) || this.interrupted) return;
    this.clearTouches(); this.app.menuInput.clear(); this.settingsOpen = true;
    const card = document.createElement('section'); card.className = 'mobile-settings-card';
    const heading = document.createElement('h2'); heading.id = 'mobile-settings-title'; heading.textContent = 'スマホの操作方法';
    const choices = document.createElement('div'); choices.className = 'mobile-mode-choices';
    const detail = document.createElement('p'); detail.className = 'mobile-mode-detail';
    const status = document.createElement('p'); status.className = 'mobile-save-status'; status.setAttribute('role','status');
    const update = () => {
      for (const el of choices.querySelectorAll('button')) el.setAttribute('aria-pressed',String(el.dataset.mode === this.mode));
      detail.textContent = this.mode === 'buttons'
        ? '左側の左右ボタンで移動。押し続けると連続移動します。せり上げは独立したボタンです。'
        : '左側を左右になぞると移動。触れたまま保持すると連続移動し、離すと止まります。上になぞると1回せり上げます。方向を変えるときは、一度指を離してください。';
    };
    for (const [mode,label] of [['buttons','ボタン移動'],['flick','フリック移動']] as const) {
      const option = document.createElement('button'); option.textContent = label; option.dataset.mode = mode;
      option.onclick = () => {
        this.clearTouches(); this.mode = mode;
        let saved = false; try { saved = writeMovementMode(localStorage,mode); } catch { /* unavailable */ }
        status.textContent = saved ? '保存しました。次回もこの操作方法になります。' : 'この起動中に適用しました。端末への保存はできませんでした。';
        update(); this.signature = '';
      }; choices.append(option);
    }
    const shared = document.createElement('p'); shared.textContent = '打上げ・列入替・役宣言は、どちらの方式でも右側のボタンで操作します。MODE2では打上げのみ表示します。';
    const close = document.createElement('button'); close.textContent = '設定を閉じる';
    close.onclick = () => {
      this.clearTouches(); this.app?.menuInput.clear(); this.settingsOpen = false; this.settingsPanel.hidden = true;
      this.shell.inert = false; this.signature = ''; this.sync(); this.settingsButton.focus();
    };
    // v3.2.0-rc.1：版表示はビルド情報から（旧スマホ版の固定表記「V320-FIX-05・基準 9cf3911」は使わない）
    const version = document.createElement('small'); version.textContent = `${RELEASE_LABEL} · ${BUILD_INFO.commit.slice(0, 7)}`;
    card.append(heading,choices,detail,shared,status,close,version); this.settingsPanel.replaceChildren(card);
    update(); this.settingsPanel.hidden = false; this.shell.inert = true; choices.querySelector('button')?.focus();
  }
  private nav(label: string, code: string, parent: HTMLElement): void {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = () => { if (!this.paused) this.app?.onKey(code,false,performance.now()); };
    parent.append(button);
  }
  private action(label: string, action: Action, parent: HTMLElement): void {
    const button = document.createElement('button'); button.textContent = label; button.dataset.action = action;
    button.setAttribute('aria-label',action === 'left' ? '左移動' : action === 'right' ? '右移動' : label);
    button.onpointerdown = e => {
      if (this.paused || e.button !== 0) return;
      e.preventDefault(); void this.app?.bus.unlock(); button.setPointerCapture(e.pointerId);
      this.app?.touch.press(e.pointerId,action); button.classList.add('held');
    };
    const release = (e: PointerEvent) => { this.app?.touch.release(e.pointerId); button.classList.remove('held'); };
    button.onpointerup = release; button.onpointercancel = release; button.onlostpointercapture = release;
    button.oncontextmenu = e=>e.preventDefault(); parent.append(button);
  }
  private flickPad(allowRise: boolean): void {
    const pad = document.createElement('div'); pad.className = 'mobile-flick-pad';
    pad.setAttribute('aria-label','左右フリックで移動、保持で連続移動'+(allowRise?'、上フリックでせり上げ':''));
    const up = document.createElement('span'); up.className = 'flick-up'; up.textContent = allowRise ? '↑ せり上げ' : '左右に操作';
    const arrows = document.createElement('strong'); arrows.textContent = '◀　▶';
    const hint = document.createElement('span'); hint.className = 'flick-help'; hint.textContent = 'なぞって移動\n保持で連続・離して停止';
    pad.append(up,arrows,hint);
    const gesture = new FlickGesture(this.app!.touch,allowRise); this.gesture = gesture;
    pad.onpointerdown = e => {
      if (this.paused || e.button !== 0 || !gesture.start(e.pointerId,e.clientX,e.clientY)) return;
      e.preventDefault(); void this.app?.bus.unlock(); pad.setPointerCapture(e.pointerId); pad.classList.add('held');
    };
    pad.onpointermove = e => { const action = gesture.move(e.pointerId,e.clientX,e.clientY); if(action) pad.dataset.direction = action; };
    const end = (e: PointerEvent) => { gesture.end(e.pointerId); pad.classList.remove('held'); delete pad.dataset.direction; };
    pad.onpointerup = end; pad.onpointercancel = end; pad.onlostpointercapture = end;
    pad.oncontextmenu = e=>e.preventDefault(); this.left.append(pad);
  }
  sync(): void {
    const app = this.app; if (!app) return;
    const s = app.scene;
    if (s !== this.scene || (s instanceof GameScene && s.game !== this.game)) {
      this.clearTouches(); this.scene = s; this.game = s instanceof GameScene ? s.game : null; this.signature = '';
    }
    const playing = s instanceof GameScene && !s.game.result && s.quit.length === 0 && s.kind !== 'watch';
    const items = s instanceof MenuScene ? s.mobileItems() : [];
    const signature = [s.constructor.name,playing,s instanceof GameScene ? s.mode : '',this.mode,...items.map(i=>i.label)].join('|');
    if (signature === this.signature) return;
    this.clearTouches(); this.gesture = null; this.signature = signature;
    this.left.replaceChildren(); this.right.replaceChildren(); this.menu.replaceChildren();
    this.shell.dataset.playing = String(playing); this.shell.dataset.movement = this.mode;
    this.settingsButton.hidden = !(s instanceof TitleScene || s instanceof MenuScene);
    this.settingsButton.textContent = this.mode === 'flick' ? '操作：フリック' : '操作：ボタン';
    this.exitButton.hidden = !(s instanceof GameScene);
    this.hint.textContent = playing ? (this.mode === 'flick' ? '左：なぞって移動・離して停止' : '左：左右移動　右：打上げ') : `横向き推奨 · ${RELEASE_LABEL}`;
    if (playing) {
      const mode1 = s instanceof GameScene && s.mode === 'mode1';
      if (this.mode === 'flick') this.flickPad(mode1);
      else {
        if (mode1) this.action('↑ せり上げ','manualRise',this.left);
        const pair = document.createElement('div'); pair.className = 'mobile-move-pair';
        this.action('◀','left',pair); this.action('▶','right',pair); this.left.append(pair);
      }
      this.action('打上げ','launch',this.right);
      if (mode1) { this.action('列入替','rotate',this.right); this.action('役宣言','declare',this.right); }
    } else {
      const directions = document.createElement('div'); directions.className = 'mobile-nav-grid';
      this.nav('▲','ArrowUp',directions); this.nav('▼','ArrowDown',directions);
      this.nav('◀','ArrowLeft',directions); this.nav('▶','ArrowRight',directions); this.left.append(directions);
      this.nav('決定','Enter',this.right); this.nav('戻る','Escape',this.right);
      if (s instanceof TitleScene) this.nav('タップしてはじめる','Enter',this.menu);
      for (const item of items) {
        const button = document.createElement('button'); button.textContent = item.label;
        button.onclick = () => { if (this.paused) return; void app.bus.unlock(); item.activate(); this.sync(); };
        this.menu.append(button);
      }
    }
  }
}
