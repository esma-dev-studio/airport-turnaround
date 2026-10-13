/* =========================================================
 * main.js — 起動・画面遷移・ゲームループ・セーブデータ
 * Game（エンジン）と UI（表示）をつなぐ司令塔。
 * ========================================================= */

(function () {
  'use strict';

  const SAVE_KEY = 'airport45_v1';
  const REAL_SEC_PER_GAME_MIN = 8;   // 1倍速: ゲーム内1分 = 実時間8秒（45分 = 実時間6分）

  /* ---- バッジ（実績）の定義と判定 ----
   * check(result, app) が true になったら獲得。獲得ずみは save.badges に永続化。 */
  const BADGES = [
    { id: 'first_clear', icon: '🛫', name: 'はじめてのクリア', desc: 'どれかのステージをクリアする',
      check: (r) => r.cleared },
    { id: 'on_time', icon: '⏱', name: 'ていこくしゅっぱつ', desc: '1分もおくれずに出発する',
      check: (r) => r.cleared && (r.delay || 0) <= 0 },
    { id: 'safety_100', icon: '🛡', name: 'あんぜんパーフェクト', desc: '安全 満点でクリアする',
      check: (r) => r.cleared && r.extra.safetyFull },
    { id: 'sat_100', icon: '😊', name: 'おきゃくさまニコニコ', desc: 'お客さんのまんぞく 満点でクリアする',
      check: (r) => r.cleared && r.extra.satFull },
    { id: 'parallel_4', icon: '🤹', name: 'どうじすすめマスター', desc: '4つの作業を同時に進める',
      check: (r) => r.extra.maxParallel >= 4 },
    { id: 'all_careful', icon: '🐢', name: 'ていねいしごとにん', desc: '「ていねい」で5作業以上を終えてクリアする',
      check: (r) => r.cleared && r.extra.careful >= 5 },
    { id: 'event_hero', icon: '🚨', name: 'トラブルバスター', desc: '1回のプレイで2つのトラブルに自分で対応する',
      check: (r) => r.extra.manual >= 2 },
    { id: 'perfect_100', icon: '💯', name: 'パーフェクト100', desc: '100点満点をとる',
      check: (r) => r.score >= 100 },
    { id: 'all_clear', icon: '🏆', name: 'ぜんステージクリア', desc: 'すべてのステージをクリアする',
      check: (r, app) => window.STAGES.every((st) => {
        const b = app.save.best[st.id];
        return (b && b.cleared) || (st.id === r.stageId && r.cleared);
      }) },
    { id: 'star_15', icon: '🌟', name: 'スターコレクター', desc: '★をぜんぶで15こ集める',
      check: (r, app) => app.totalStars() >= 15 },
  ];
  /* スター: クリア=★ / 80点以上=★★ / 95点以上=★★★ */
  const starsOf = (r) => (!r.cleared ? 0 : r.score >= 95 ? 3 : r.score >= 80 ? 2 : 1);

  const App = {
    save: { sound: true, bgm: true, tutorialSeen: false, best: {}, badges: {} },
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
          this.save = Object.assign({ sound: true, bgm: true, tutorialSeen: false, best: {}, badges: {} }, d);
        }
      } catch (e) { /* 壊れたデータは初期値で続行 */ }
      UI.sfx.enabled = this.save.sound !== false;
      UI.bgm.enabled = this.save.bgm !== false;
    },

    /* これまでに集めた★の合計（旧セーブはスコアから換算） */
    totalStars() {
      return window.STAGES.reduce((sum, st) => {
        const b = this.save.best[st.id];
        if (!b || !b.cleared) return sum;
        return sum + (b.stars != null ? b.stars : starsOf({ cleared: true, score: b.score }));
      }, 0);
    },
    persist() {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.save)); } catch (e) { /* 保存できない環境でも動作継続 */ }
    },

    /* ---------------- 起動 ---------------- */
    boot() {
      this.loadSave();
      this.debug = /[?&]debug=1/.test(location.search);
      Game.debug = this.debug;  // 抽選・ゆらぎを固定して自動テストを決定的に

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
          if (!this.begun) { UI.toast('まずは「▶ はじめる」を おしてね', 'info'); return; }
          if (this.cinematic) { UI.toast('✈ いま とうちゃくしているよ。とまったら はじめよう', 'info'); return; }
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
        onBgmToggle: (on) => {
          this.save.bgm = on;
          UI.bgm.enabled = on;
          this.persist();
          if (on && this.inGame() && this.begun && !this.ending) UI.bgm.start();
          else if (!on) UI.bgm.stop();
        },
        /* ずかん・タイトル用: バッジと★の状況 */
        getProgress: () => ({
          badgeDefs: BADGES,
          earned: this.save.badges || {},
          totalStars: this.totalStars(),
          maxStars: window.STAGES.length * 3,
        }),
        onResetData: () => {
          this.save = { sound: this.save.sound, bgm: this.save.bgm, tutorialSeen: false, best: {}, badges: {} };
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
        /* モーダルを開いているときは何もしない。キーボードでボタンをえらんでいるときの Space はボタンを押す */
        const bd = document.getElementById('modal-backdrop');
        if (bd && !bd.classList.contains('hidden')) return;
        if (ev.code === 'Space' && ev.target && ev.target.matches && ev.target.matches('button:focus-visible')) return;
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
      UI.bgm.stop();
      UI.updateTitleProgress();
      UI.showScreen('title');
    },
    gotoSelect() {
      this.stopLoop();
      UI.bgm.stop();
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
      UI.bgm.start();
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
        UI.toast('まずは「▶ はじめる」を おしてね', 'info');
        return;
      }
      if (this.cinematic) {
        UI.toast('✈ いま とうちゃくしているよ。とまったら はじめよう', 'info');
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
      UI.openSettings({ sound: this.save.sound, bgm: this.save.bgm, inGame: this.inGame() && !this.ending });
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
      UI.bgm.stop();

      /* ベスト更新はクリア時のみ記録（★は過去ベストと比べて高いほうを保持） */
      let isBest = false;
      const prev = this.save.best[result.stageId];
      const prevBest = prev ? prev.score : null;
      const stars = starsOf(result);
      if (result.cleared) {
        const bestStars = Math.max(stars, (prev && prev.stars) || 0);
        if (!prev || result.score > prev.score) {
          this.save.best[result.stageId] = { score: result.score, rank: result.rank, cleared: true, stars: bestStars };
          isBest = true;
        } else {
          prev.stars = bestStars;
        }
      }

      /* バッジ判定（新しく取れたものだけ知らせる） */
      const newBadges = [];
      BADGES.forEach((b) => {
        if (this.save.badges[b.id]) return;
        let ok = false;
        try { ok = b.check(result, this); } catch (e) { /* 判定エラーは未獲得あつかい */ }
        if (ok) { this.save.badges[b.id] = true; newBadges.push(b); }
      });
      this.persist();

      /* つぎの目標（リプレイをうながす一言） */
      let nextGoal = '';
      if (!result.cleared) nextGoal = 'まずはクリアをめざそう！';
      else if (stars < 3) nextGoal = `★${stars + 1}つまで あと${(stars === 1 ? 80 : 95) - result.score}点！`;
      else if (result.score < 100) nextGoal = `パーフェクト100点まで あと${100 - result.score}点！`;
      else nextGoal = 'かんぺき！つぎのステージや、まだ取っていないバッジにちょうせんしよう！';

      /* 出発アニメの余韻を見せてから結果画面へ */
      const nextId = result.cleared && window.STAGE_MAP[result.stageId + 1] ? result.stageId + 1 : null;
      setTimeout(() => {
        this.stopLoop();
        UI.renderResult(result, isBest, nextId, prevBest, { stars, newBadges, nextGoal });
        UI.showScreen('result');
      }, result.departed ? 1600 : 800);
    },
  };

  document.addEventListener('DOMContentLoaded', () => App.boot());
})();
