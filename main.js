/* =========================================================
 * main.js — 起動・画面遷移・ゲームループ・セーブデータ
 * Game（エンジン）と UI（表示）をつなぐ司令塔。
 * ========================================================= */

(function () {
  'use strict';

  const SAVE_KEY = 'airport45_v1';
  const REAL_SEC_PER_GAME_MIN = 8;   // 1倍速: ゲーム内1分 = 実時間8秒（45分 = 実時間6分）

  const App = {
    save: { sound: true, tutorialSeen: false, best: {} },
    speed: 0,
    prevSpeed: 1,
    begun: false,
    currentStageId: null,
    rafId: null,
    lastTs: null,
    ending: false,

    /* ---------------- セーブ ---------------- */
    loadSave() {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (raw) {
          const d = JSON.parse(raw);
          this.save = Object.assign({ sound: true, tutorialSeen: false, best: {} }, d);
        }
      } catch (e) { /* 壊れたデータは初期値で続行 */ }
      UI.sfx.enabled = this.save.sound !== false;
    },
    persist() {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.save)); } catch (e) { /* 保存できない環境でも動作継続 */ }
    },

    /* ---------------- 起動 ---------------- */
    boot() {
      this.loadSave();
      this.debug = /[?&]debug=1/.test(location.search);

      Game.init({
        emit: (type, payload) => {
          UI.handleEmit(type, payload);
          if (type === 'stage-end') this.onStageEnd(payload);
        },
      });

      UI.init({
        onSpeed: (n) => this.setSpeed(n),
        onSettings: () => this.openSettings(),
        onBegin: () => this.begin(),
        onStartTask: (id) => this.onStartTask(id),
        onCancelTask: (id) => {
          const r = Game.cancelTask(id);
          if (r && !r.ok && r.reason) UI.toast(r.reason, 'warn');
        },
        onAssignEntity: (entityId, taskId) => {
          if (!this.begun) { UI.toast('まずは「▶ スタート」を押してはじめよう', 'info'); return; }
          if (this.cinematic) { UI.toast('✈ とうちゃく中… 駐機したら作業スタート！', 'info'); return; }
          const r = Game.assignEntity(entityId, taskId);
          if (!r.ok) UI.toast(r.reason, 'warn');
        },
        onFlowMap: () => this.openFlowMap(),
        onSetPace: (taskId, pace) => {
          Game.setPace(taskId, pace);
        },
        onSafetyChoice: (careful) => Game.chooseSafety(careful),
        onEventChoice: (i) => Game.resolveEvent(i, false),
        onSelectStage: (id) => this.startStage(id),
        onNextStage: (id) => this.startStage(id),
        onRetry: () => this.startStage(this.currentStageId),
        onGotoSelect: () => this.gotoSelect(),
        onGotoTitle: () => this.gotoTitle(),
        onSoundToggle: (on) => {
          this.save.sound = on;
          UI.sfx.enabled = on;
          this.persist();
          if (on) UI.sfx.play('click');
        },
        onResetData: () => {
          this.save = { sound: this.save.sound, tutorialSeen: false, best: {} };
          this.persist();
          UI.toast('セーブデータを初期化しました', 'info');
        },
        onModalClosed: (kind) => {
          /* 設定・ながれマップを閉じたら速度を元にもどす（ゲーム中のみ） */
          if ((kind === 'settings' || kind === 'flow') && this.inGame() && this.begun && !this.ending && !Game.state.ended) {
            this.setSpeed(this.prevSpeed || 1);
          }
        },
      });

      /* キーボード操作（PC向け）: スペース=一時停止/再開, 1/2=速度 */
      document.addEventListener('keydown', (ev) => {
        if (!this.inGame() || !this.begun || (Game.state && Game.state.ended)) return;
        if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
        if (ev.code === 'Space') {
          ev.preventDefault();
          this.setSpeed(this.speed === 0 ? (this.prevSpeed || 1) : 0);
        } else if (ev.key === '1') this.setSpeed(1);
        else if (ev.key === '2') this.setSpeed(2);
      });

      /* デバッグ用フック（?debug=1 のときだけ有効） */
      if (/[?&]debug=1/.test(location.search)) {
        window.__test = {
          G: Game,
          UI,
          app: this,
          adv(min) {           // ゲーム内時間を min 分だけ進める
            const step = 0.05;
            for (let t = 0; t < min && Game.state && !Game.state.ended; t += step) Game.tick(step);
          },
          start(id) { return Game.startTask(id); },
          cancel(id) { return Game.cancelTask(id); },
          safety(c) { Game.chooseSafety(c); },
          event(i) { Game.resolveEvent(i, false); },
          state() { return Game.state; },
        };
      }

      this.gotoTitle();
    },

    inGame() {
      return document.getElementById('screen-game').classList.contains('active');
    },

    /* ---------------- 画面遷移 ---------------- */
    gotoTitle() {
      this.stopLoop();
      UI.showScreen('title');
    },
    gotoSelect() {
      this.stopLoop();
      UI.renderStageSelect(this.save, (id) => this.isUnlocked(id));
      UI.showScreen('select');
    },

    /* ステージ解放判定: 前のステージをクリアしていること（?debug=1 なら全解放） */
    isUnlocked(id) {
      if (id === 1 || this.debug) return true;
      const prev = this.save.best[id - 1];
      return !!(prev && prev.cleared);
    },

    startStage(id) {
      const stage = window.STAGE_MAP[id];
      if (!stage || !this.isUnlocked(id)) return;
      this.currentStageId = id;
      this.begun = false;
      this.ending = false;
      this.cinematic = false;
      this.speed = 0;
      this.prevSpeed = 1;
      Game.newRun(id);
      UI.bindRun(Game.state);
      UI.setSpeedUI(0);
      UI.showScreen('game');
      this.startLoop();
      if (!this.save.tutorialSeen) {
        UI.openTutorial(() => {
          this.save.tutorialSeen = true;
          this.persist();
        });
      }
    },

    begin() {
      if (this.begun) return;
      this.begun = true;
      UI.hideStartOverlay();
      if (this.debug) {
        /* デバッグ時は到着シネマティックを省略（自動テストを決定的にする） */
        this.setSpeed(1);
        UI.coachBegin();
        return;
      }
      this.cinematic = true;
      UI.scene.playArrival(() => {
        this.cinematic = false;
        this.setSpeed(1);
        UI.coachBegin();
      });
    },

    setSpeed(n) {
      if (!this.inGame()) return;
      if (this.cinematic) return;
      if (Game.state && Game.state.ended) n = 0;
      if (!this.begun && n > 0) { this.begin(); return; }
      if (n > 0) this.prevSpeed = n;
      this.speed = n;
      UI.setSpeedUI(n);
      UI.setPausedIndicator(this.begun && n === 0 && !this.ending && Game.state && !Game.state.ended);
    },

    onStartTask(id) {
      if (!this.begun) {
        UI.toast('まずは「▶ スタート」を押してはじめよう', 'info');
        return;
      }
      if (this.cinematic) {
        UI.toast('✈ とうちゃく中… 駐機したら作業スタート！', 'info');
        return;
      }
      const r = Game.startTask(id);
      if (!r.ok) {
        UI.toast(r.reason, 'warn');
        UI.shakeCard(id);
        UI.sfx.play('click');
      }
    },

    openSettings() {
      if (this.inGame() && this.begun && !this.ending) {
        this.prevSpeed = this.speed > 0 ? this.speed : this.prevSpeed;
        this.setSpeed(0);
      }
      UI.openSettings({ sound: this.save.sound, inGame: this.inGame() && !this.ending });
    },

    openFlowMap() {
      if (this.inGame() && this.begun && !this.ending && !this.cinematic) {
        this.prevSpeed = this.speed > 0 ? this.speed : this.prevSpeed;
        this.setSpeed(0);
      }
      UI.openFlowMap();
    },

    /* ---------------- ループ ---------------- */
    startLoop() {
      this.stopLoop();
      this.lastTs = null;
      const loop = (ts) => {
        this.rafId = requestAnimationFrame(loop);
        const dtReal = this.lastTs == null ? 0 : Math.min((ts - this.lastTs) / 1000, 0.25);
        this.lastTs = ts;
        if (this.begun && this.speed > 0 && Game.state && !Game.state.ended) {
          Game.tick((dtReal / REAL_SEC_PER_GAME_MIN) * this.speed);
        }
        UI.frame(dtReal);
      };
      this.rafId = requestAnimationFrame(loop);
    },
    stopLoop() {
      if (this.rafId != null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    },

    /* ---------------- ステージ終了 ---------------- */
    onStageEnd(result) {
      if (this.ending) return;
      this.ending = true;
      this.speed = 0;
      UI.setSpeedUI(0);

      /* ベスト更新はクリア時のみ記録 */
      let isBest = false;
      const prevBest = this.save.best[result.stageId] ? this.save.best[result.stageId].score : null;
      if (result.cleared) {
        const prev = this.save.best[result.stageId];
        if (!prev || result.score > prev.score) {
          this.save.best[result.stageId] = { score: result.score, rank: result.rank, cleared: true };
          this.persist();
          isBest = true;
        }
      }

      /* 出発アニメの余韻を見せてから結果画面へ */
      const nextId = result.cleared && window.STAGE_MAP[result.stageId + 1] ? result.stageId + 1 : null;
      setTimeout(() => {
        this.stopLoop();
        UI.renderResult(result, isBest, nextId, prevBest);
        UI.showScreen('result');
      }, result.departed ? 1600 : 800);
    },
  };

  document.addEventListener('DOMContentLoaded', () => App.boot());
})();
