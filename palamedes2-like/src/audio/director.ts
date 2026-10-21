// ロジックのイベント列から効果音・ボイスを鳴らす（描画フレームやボタン押下ではなく、成立した論理イベントから1回だけ）。
// 音はゲーム進行に影響しない。勝敗確定後は新しいプレイ音を鳴らさない（結果の音は演出側が鳴らす）。
import type { GameEvent } from '../core/game';
import type { AnyGame } from '../core/match';
import type { Mode2Event } from '../core/mode2';
import type { PlayerId } from '../core/types';
import type { AudioBus } from './audioBus';
import { launchSuccessSfx, roleDeclareSfx, VOICE_PRIORITY, type Character } from './audioMap';

export interface DirectorOptions {
  /** 接着音の遅延（攻撃ピースの飛来時間＝最初のピースが接着する時刻）ms */
  attachDelayMs: number;
}

export const DEFAULT_DIRECTOR_OPTIONS: DirectorOptions = { attachDelayMs: 120 };

export class SoundDirector {
  private cursor = 0;
  private ended = false;

  constructor(
    private readonly bus: AudioBus,
    private game: AnyGame,
    /** プレイヤー番号→キャラクター（ボイスの話者） */
    private characters: readonly Character[],
    private readonly opts: DirectorOptions = DEFAULT_DIRECTOR_OPTIONS,
  ) {}

  setCharacters(c: readonly Character[]): void {
    this.characters = c;
  }

  reset(game: AnyGame): void {
    this.game = game;
    this.cursor = 0;
    this.ended = false;
  }

  private char(p: PlayerId): Character {
    return this.characters[p];
  }

  /** 新しいイベントを処理する（毎フレーム、描画前に呼ぶ） */
  sync(): void {
    const ev = this.game.events as ReadonlyArray<GameEvent | Mode2Event>;
    while (this.cursor < ev.length) this.onEvent(ev[this.cursor++]);
    this.updateDanger();
  }

  private onEvent(e: GameEvent | Mode2Event): void {
    if (this.ended) return;
    const b = this.bus;
    switch (e.type) {
      case 'launch':
        b.playSfx('piece_launch');
        return;
      case 'arrive':
        // 成功：連続取得の回数1〜5（6以上は5）の段階SE（第3版）。MODE2は連続取得がないため段階1
        if (e.success) b.playSfx(launchSuccessSfx('streak' in e && e.streak > 0 ? e.streak : 1));
        else b.playSfx('piece_reject');
        return;
      case 'returned':
        if (!e.instant) b.playSfx('piece_return'); // 役成立による一括SNAP帰還では鳴らさない
        return;
      case 'rotate':
        b.playSfx('column_swap');
        return;
      case 'rise':
        if (e.kind !== 'attack') b.playSfx('field_rise'); // 攻撃による段は attackRow で1段ずつ
        return;
      case 'roleAvailable':
        b.playSfx('role_available');
        return;
      case 'declare': {
        // 役連鎖の回数1〜5（6以上は5）の段階SE（第3版。旧成立音・連鎖音は重ねない）。
        // 代表役のボイスは役名表示の予定（presentation.RoleNameSchedule）が先頭ロゴの表示開始と同時に鳴らす
        b.playSfx(roleDeclareSfx(e.chainCount));
        return;
      }
      case 'declareFail':
        b.playSfx('role_fail');
        b.playVoice(this.char(e.player), 'role_fail', VOICE_PRIORITY.fail);
        return;
      case 'lineClear':
        b.playSfx('line_clear');
        return;
      case 'attack':
        if (e.counter.canceled > 0) b.playSfx('counter');
        if (e.counter.sent > 0) {
          b.playSfx('attack_send');
          b.playVoice(this.char(e.player), 'attack', VOICE_PRIORITY.attack);
        }
        return;
      case 'attackRow':
        // 実適用された1ラインにつき接着音1回（破棄・未適用の段は attackRow を出さない）。被攻撃ボイスは波の最初の実適用だけ
        b.playSfx('attack_row', this.opts.attachDelayMs);
        if (e.firstOfWave) b.playVoice(this.char(e.player), 'damage', VOICE_PRIORITY.attack);
        return;
      case 'danger':
      case 'attackPinch':
        // 自然上昇の危険猶予・攻撃ピンチ猶予とも同じ警告音（ピンチ時の未適用段の破棄そのものは無音）
        if (e.state === 'grace') b.playSfx('danger');
        return;
      case 'levelUp':
        b.playSfx('level_up');
        return;
      case 'allClear':
        b.playSfx('all_clear');
        return;
      case 'stageClear':
        b.playSfx(e.final ? 'all_stages_clear' : 'stage_clear');
        return;
      case 'countdown':
        b.playSfx('countdown'); // 数字の切替ごとに1回（上下移動では鳴らさない）
        return;
      case 'cardRefresh':
        b.playSfx('card_refresh');
        return;
      case 'roundEnd':
        this.ended = true;
        b.stopPlaySounds();
        return;
      default:
        return;
    }
  }

  /** 危険猶予中（自然上昇・攻撃ピンチ）は警告音を最短1000ms間隔で繰り返す（解除・終了で停止） */
  private updateDanger(): void {
    if (this.ended || this.game.mode !== 'mode1' || !this.game.playing) return;
    if (this.game.players.some((p) => (p.graceRemaining !== null || p.incoming.pinchRemaining !== null) && !p.defeated)) this.bus.playSfx('danger');
  }
}
