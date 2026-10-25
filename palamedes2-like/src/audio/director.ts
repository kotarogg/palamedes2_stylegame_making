// ロジックのイベント列から効果音・ボイスを鳴らす（描画フレームやボタン押下ではなく、成立した論理イベントから1回だけ）。
// 音はゲーム進行に影響しない。勝敗確定後は新しいプレイ音を鳴らさない（結果の音は演出側が鳴らす）。
import type { GameEvent } from '../core/game';
import type { AnyGame } from '../core/match';
import type { Mode2Event } from '../core/mode2';
import type { PlayerId } from '../core/types';
import type { AudioBus } from './audioBus';
import { createSeededRng, type Rng } from '../core/rng';
import { EVENT_GAIN_DB, launchSuccessSfx, PINCH_VOICE, PINCH_VOICE_REGISTERED, roleDeclareSfx, VOICE_PRIORITY, type Character } from './audioMap';

export interface DirectorOptions {
  /** 接着音の遅延（攻撃ピースの飛来時間＝最初のピースが接着する時刻）ms */
  attachDelayMs: number;
  /** v3.1.0 宣言SEと同時に代表ボイス（役名／代替攻撃）が鳴るか。役名表示の予定（RoleNameDirector）が答える。未接続なら鳴るとみなす */
  voiceWithDeclare?: (player: PlayerId, tick: number) => boolean;
  /** v3.1.0 ピンチボイスの抽選用乱数の seed（ゲームの乱数列へ影響させない） */
  seed?: number;
  /** v3.1.0 ピンチボイスの抽選用乱数（テストで差し替え。指定時は seed より優先） */
  rng?: Rng;
  /**
   * v3.1.0 これから始まる代表ボイス（役名／代替の攻撃ボイス）が予定されているか。
   * 予定があればピンチボイスは鳴らさない（後から切られる重なりを作らない）。未接続なら予定なしとみなす
   */
  roleVoiceImminent?: () => boolean;
}

export const DEFAULT_DIRECTOR_OPTIONS: DirectorOptions = { attachDelayMs: 120 };

export class SoundDirector {
  private cursor = 0;
  private ended = false;
  private readonly rng: Rng;
  /** v3.1.0 同じピンチ中のピンチボイスの抽選回数（プレイヤー別。外れ・再生不可でも数える。ピンチ終了・新ラウンドで0） */
  private pinchRolls: number[] = [0, 0];
  /** v3.1.0 ピンチボイスの抽選記録（自動検証用）。result：played／miss（外れ）／busy（他の声と競合して捨てた） */
  readonly pinchLog: { player: PlayerId; tick: number; result: 'played' | 'miss' | 'busy' }[] = [];

  constructor(
    private readonly bus: AudioBus,
    private game: AnyGame,
    /** プレイヤー番号→キャラクター（ボイスの話者） */
    private characters: readonly Character[],
    private readonly opts: DirectorOptions = DEFAULT_DIRECTOR_OPTIONS,
  ) {
    this.rng = opts.rng ?? createSeededRng((opts.seed ?? 1) >>> 0);
  }

  setCharacters(c: readonly Character[]): void {
    this.characters = c;
  }

  reset(game: AnyGame): void {
    this.game = game;
    this.cursor = 0;
    this.ended = false;
    this.pinchRolls = [0, 0];
  }

  private char(p: PlayerId): Character {
    return this.characters[p];
  }

  /** 新しいイベントを処理する（毎フレーム、描画前に呼ぶ） */
  sync(): void {
    const ev = this.game.events as ReadonlyArray<GameEvent | Mode2Event>;
    while (this.cursor < ev.length) this.onEvent(ev[this.cursor++]);
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
        // 自然・手動の上昇。攻撃による段の上昇音は attackRow 側だけで鳴らす（同じ上昇で二重に鳴らさない）
        if (e.kind !== 'attack') b.playSfx('field_rise');
        return;
      case 'roleAvailable':
        b.playSfx('role_available', 0, EVENT_GAIN_DB.roleAvailable); // v3.1.0：成立可能通知 −3dB
        return;
      case 'declare': {
        // 役連鎖の回数1〜5（6以上は5）の段階SE（第3版。旧成立音・連鎖音は重ねない）。
        // 代表ボイス（役名または代替の攻撃ボイス）は役名表示の予定（presentation.RoleNameSchedule）が先頭ロゴの表示開始と同時に鳴らす。
        // v3.1.0：その代表ボイスと同時に鳴る場合だけ宣言SEを −2dB（前の役名表示の待ちで代表ボイスが後になる場合は 0dB）
        const withVoice = this.opts.voiceWithDeclare ? this.opts.voiceWithDeclare(e.player, e.tick) : true;
        b.playSfx(roleDeclareSfx(e.chainCount), 0, withVoice ? EVENT_GAIN_DB.declareWithVoice : 0);
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
        // 相殺音：論理的な相殺1回（＝攻撃1回の相殺バッチ）につき1回。attackCancel は同じ相殺の表示用イベントなので鳴らさない（二重にしない）。
        // 同一フレームの同種音は AudioBus の同音抑制で全体1回へ統合（別時刻の相殺は独立）
        if (e.counter.canceled > 0) b.playSfx('counter');
        // v3.1.0：通常の攻撃送信時の与ダメボイスは鳴らさない（攻撃ボイスは役宣言の代替としてだけ使う）
        if (e.counter.sent > 0) b.playSfx('attack_send');
        return;
      case 'attackRow':
        // 実適用された1段（attackRow は実適用のときだけ出る。破棄・未適用・保留中は出ない）につき：
        //   上昇音 se_field_rise を上昇開始（適用tick）で1回（修正R2）、接着音 sfx_attack_row を最初の接着（飛来後）で1回。
        // 被攻撃ボイスは波の最初の実適用だけ
        // v3.1.0：攻撃を受けた時の被ダメボイスは鳴らさない
        b.playSfx('field_rise');
        b.playSfx('attack_row', this.opts.attachDelayMs);
        return;
      case 'pinchWarn':
        // v3.1.0：danger はピンチ到達時に1回（通常ピンチ→攻撃ピンチへ移っただけでは start が出ないので重複しない）。
        // 3/2/1 の表示開始で countdown を各1回。解除・ラウンド終了の後は鳴らさない（イベントが出ない。結果移行後は ended）
        if (e.state === 'start') {
          b.playSfx('danger');
          this.pinchVoice(e.player, e.tick);
        } else if (e.state === 'count') b.playSfx('countdown');
        else this.pinchRolls[e.player] = 0; // 解除：次のピンチ到達は新しい機会（鳴っているピンチボイスは止めない）
        return;
      case 'levelUp':
        b.playSfx('level_up');
        return;
      case 'allClear':
        // v3.1.0：同じクリア処理でステージ達成音が続く場合だけ全消し側 −3dB（任意の時間窓は作らない）
        b.playSfx('all_clear', 0, 'stageClearPending' in e && e.stageClearPending ? EVENT_GAIN_DB.allClearWithStageClear : 0);
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

  /**
   * v3.1.0 ピンチボイス：ピンチ到達（pinchWarn start）ごとに1回だけ抽選し30%。同じ連続したピンチ中は再抽選しない
   * （外れ・競合で鳴らせなかった場合も同じ。自然上昇⇔攻撃ピンチへ原因が移っても start は出ないので上限は戻らない）。
   * 優先度は最低：他の声が鳴っている・代表ボイスが予定されているときは捨て、後からキュー再生しない
   */
  private pinchVoice(p: PlayerId, tick: number): void {
    const c = this.char(p);
    if (!PINCH_VOICE_REGISTERED[c] || this.pinchRolls[p] >= PINCH_VOICE.maxPerPinch) return;
    this.pinchRolls[p]++;
    if (this.rng.next() * 100 >= PINCH_VOICE.pct) {
      this.pinchLog.push({ player: p, tick, result: 'miss' });
      return;
    }
    const ok = !(this.opts.roleVoiceImminent?.() ?? false) && this.bus.playOptionalVoice(c, 'pinch', VOICE_PRIORITY.pinch);
    this.pinchLog.push({ player: p, tick, result: ok ? 'played' : 'busy' });
  }
}
