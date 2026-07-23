/* =========================================================
 * game.js — ゲームエンジン（DOMを触らない）
 * 時間進行・作業の状態管理・リソース割当・指標・スコアを担当。
 * UIへの通知は hooks.emit(type, payload) 経由でのみ行う。
 * ========================================================= */

(function () {
  'use strict';

  const MOVE_DUR = { staff: 0.9, vehicle: 0.6 }; // 移動にかかるゲーム内分
  const SKILL_FACTOR = { vet: 1.15, norm: 1, rookie: 0.85 }; // ⭐ベテラン/ふつう/🔰新人の作業速度
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* 分（絶対値: 600=10:00）→ "10:05" */
  function fmtClock(min) {
    const m = Math.floor(min);
    const h = Math.floor(m / 60) % 24;
    const mm = m % 60;
    return `${h}:${String(mm).padStart(2, '0')}`;
  }

  const Game = {
    state: null,
    hooks: { emit: function () {} },

    init(hooks) {
      this.hooks = hooks || this.hooks;
    },

    emit(type, payload) {
      try { this.hooks.emit(type, payload); } catch (e) { console.error('emit error', type, e); }
    },

    /* ============ 新しいラン ============ */
    newRun(stageId) {
      const stage = window.STAGE_MAP[stageId];
      if (!stage) throw new Error('unknown stage ' + stageId);

      const tasks = {};
      window.TASK_DEFS.forEach((def) => {
        tasks[def.id] = {
          id: def.id,
          def,
          status: (def.deps && def.deps.length) ? 'locked' : 'ready',
          progress: 0,
          dur: def.dur,      // 基本の必要時間（イベントで増減）
          pace: 'normal',    // 采配レバー: careful / normal / rush
          startedAt: null,
          activeAt: null,
          doneAt: null,
          assigned: [],
          extra: '',       // イベント等による補足表示
        };
      });

      const entities = [];
      let eid = 0;
      const skillCfg = stage.resources.staffSkills || {};
      Object.entries(stage.resources.staff).forEach(([type, n]) => {
        for (let i = 0; i < n; i++) {
          entities.push({
            id: 'S' + (eid++), kind: 'staff', type, idx: i,
            label: window.RES_META.staff[type].short + String.fromCharCode(65 + i),
            skill: (skillCfg[type] && skillCfg[type][i]) || 'norm',
            status: 'idle', moveProgress: 0, moveDur: MOVE_DUR.staff, taskId: null,
          });
        }
      });
      Object.entries(stage.resources.vehicles).forEach(([type, n]) => {
        for (let i = 0; i < n; i++) {
          entities.push({
            id: 'V' + (eid++), kind: 'vehicle', type, idx: i,
            label: window.RES_META.vehicles[type].short + (n > 1 ? String(i + 1) : ''),
            status: 'idle', moveProgress: 0, moveDur: MOVE_DUR.vehicle, taskId: null,
          });
        }
      });

      this.state = {
        stage,
        clock: stage.arrival,
        tasks,
        taskList: window.TASK_DEFS.map((d) => tasks[d.id]),
        entities,
        metrics: { safety: 100, punct: 100, sat: 100, cost: 100 },
        /* ステージ定義を汚さないよう、イベント項目は複製して持つ */
        eventQueue: (stage.events || []).map((e) => Object.assign({}, e)),
        activeEvent: null,
        outdoorPauseUntil: null,  // 天候による屋外作業停止の解除時刻
        weatherNow: null,         // イベントで天気が変わったとき用
        resolvedEvents: [],
        log: [],
        flags: { critical: false, safetySkipped: false, safetyChoiceDone: false },
        stats: { blockOff: null, delay: 0, firstStarts: {}, satNotes: [], rushCount: 0, carefulCount: 0, warned: [] },
        pendingSafety: false,
        ended: false,
        endResult: null,
      };
      this.log(`あおぞら航空123便が到着しました（出発予定 ${fmtClock(stage.std)}）`, 'info');
      return this.state;
    },

    /* ============ 毎フレームの進行 ============ */
    tick(dt) {
      const s = this.state;
      if (!s || s.ended || dt <= 0) return;
      s.clock += dt;

      /* --- 天候による屋外停止の解除 --- */
      if (s.outdoorPauseUntil != null && s.clock >= s.outdoorPauseUntil) {
        s.outdoorPauseUntil = null;
        s.weatherNow = { icon: '🌥', label: 'くもり' };
        this.emit('weather');
        this.log('雷雲が遠ざかりました。屋外作業を再開します', 'ok');
        this.emit('toast', { msg: '☀ 屋外作業を再開しました', type: 'info' });
        this.emit('sfx', 'select');
        s.taskList.forEach((t) => {
          if (t.def.outdoor && (t.status === 'active' || t.status === 'moving')) this.emit('task', { id: t.id });
        });
      }
      const outPaused = this.outdoorPaused();

      /* --- 移動中・帰還中のリソース --- */
      let resChanged = false;
      s.entities.forEach((e) => {
        if (e.status === 'moving') {
          const t = e.taskId ? s.tasks[e.taskId] : null;
          if (!(outPaused && t && t.def.outdoor)) {
            e.moveProgress = Math.min(1, e.moveProgress + dt / e.moveDur);
          }
        } else if (e.status === 'returning') {
          e.moveProgress = Math.min(1, e.moveProgress + dt / e.moveDur);
          if (e.moveProgress >= 1) { e.status = 'idle'; e.moveProgress = 0; resChanged = true; }
        }
      });

      /* --- 集合完了（必要な人・車両がそろって到着）→ 作業開始 --- */
      s.taskList.forEach((t) => {
        if (t.status !== 'gathering') return;
        if (!this.reqsFilled(t)) return;
        const all = t.assigned.every((id) => {
          const e = this.entityById(id);
          return e && e.moveProgress >= 1;
        });
        if (all) this._tryActivate(t);
      });

      /* --- 進行中の作業（天候停止中の屋外作業は進まない） --- */
      s.taskList.forEach((t) => {
        if (t.status !== 'active') return;
        if (outPaused && t.def.outdoor) return;
        t.progress += dt;
        if (t.progress >= this.effDur(t)) this._completeTask(t);
      });

      /* --- イベントの発火判定 ---
       * at: 経過分 / when: 対象作業の進捗率。条件を満たしたら _armed。
       * when型は、条件を満たす前に対象作業が終わってしまったら取り下げる。 */
      s.eventQueue.forEach((en) => { if (!en._armed && this._eventEligible(en)) en._armed = true; });
      for (let i = s.eventQueue.length - 1; i >= 0; i--) {
        const en = s.eventQueue[i];
        if (!en._armed && en.when) {
          const t = s.tasks[en.when.task];
          if (t && t.status === 'done') s.eventQueue.splice(i, 1);
        }
      }
      if (!s.activeEvent) {
        const idx = s.eventQueue.findIndex((en) => en._armed);
        if (idx >= 0) {
          const next = s.eventQueue.splice(idx, 1)[0];
          const def = window.EVENT_DEFS[next.id];
          if (def) {
            s.activeEvent = { def, firedAt: s.clock };
            if (def.id === 'weather') {
              s.weatherNow = { icon: '⛈', label: 'かみなり！' };
              this.emit('weather');
            }
            this.log(`⚠ ${def.title}が発生！対応を選んでください`, 'warn');
            this.emit('event-armed', { def });
            this.emit('sfx', 'event');
          }
        }
      }
      /* --- イベント期限（対象作業の完了 or 制限時間で自動対応） --- */
      if (s.activeEvent) {
        const d = s.activeEvent.def;
        if (d.deadlineTask && s.tasks[d.deadlineTask] && s.tasks[d.deadlineTask].status === 'done') {
          this.resolveEvent(d.defaultChoice, true);
        } else if (d.deadlineAfter != null && s.clock - s.activeEvent.firedAt >= d.deadlineAfter) {
          this.resolveEvent(d.defaultChoice, true);
        }
      }

      /* --- 遅延と指標のライブ更新 --- */
      if (!s.stats.blockOff) {
        s.stats.delay = Math.max(0, s.clock - s.stage.std);
        s.metrics.punct = clamp(100 - s.stats.delay * (100 / 15), 0, 100);
        if (s.stats.delay > 0) {
          s.metrics.cost = clamp(s.metrics.cost - dt * 2, 0, 100);
          if (s.tasks.doorclose.status !== 'done') {
            s.metrics.sat = clamp(s.metrics.sat - dt * 0.5, 0, 100);
          }
        }
      }

      /* --- 出発が近づいたら知らせる（遅れ気味のときだけ: 15/10/5分前） --- */
      if (!s.stats.blockOff && s.tasks.doorclose.status !== 'done') {
        const remain = s.stage.std - s.clock;
        const NEED = { 15: 6, 10: 5, 5: 2 };  // のこり作業がこれ以上のときだけ警告
        [15, 10, 5].forEach((th) => {
          if (remain <= th && remain > 0 && !s.stats.warned.includes(th)) {
            s.stats.warned.push(th);
            const n = s.taskList.filter((t) => t.status !== 'done').length;
            if (n < NEED[th]) return;  // 順調なら鳴らさない
            this.log(`⏰ 出発予定まであと${th}分（のこりの作業 ${n}件）`, 'warn');
            this.emit('toast', { msg: `⏰ 出発予定まであと${th}分！のこりの作業 ${n}件`, type: 'warn' });
            this.emit('sfx', th === 5 ? 'warn' : 'event');
          }
        });
      }

      /* --- 大幅遅延による強制終了 --- */
      if (!s.stats.blockOff && s.clock > s.stage.std + s.stage.maxOvertime) {
        this._endStage(false);
        return;
      }

      if (resChanged) this.emit('resources');
      this.emit('clock');
      this.emit('metrics');
    },

    entityById(id) { return this.state.entities.find((e) => e.id === id); },

    /* 天候により屋外作業が停止中か */
    outdoorPaused() {
      const s = this.state;
      return !!(s && s.outdoorPauseUntil != null && s.clock < s.outdoorPauseUntil);
    },

    _eventEligible(en) {
      const s = this.state;
      if (en.at != null) return s.clock - s.stage.arrival >= en.at;
      if (en.when) {
        const t = s.tasks[en.when.task];
        return !!t && t.status === 'active' && t.progress / this.effDur(t) >= en.when.pct;
      }
      return false;
    },

    /* ペースと担当スタッフの熟練度を反映した実際の必要時間 */
    effDur(t) {
      return t.dur * (window.PACE[t.pace] ? window.PACE[t.pace].f : 1) * (t.crewFactor || 1);
    },

    /* 必要リソースがすべて割り当て済みか */
    reqsFilled(t) {
      const s = this.state;
      const counts = {};
      t.assigned.forEach((id) => {
        const e = this.entityById(id);
        if (e) counts[e.kind + ':' + e.type] = (counts[e.kind + ':' + e.type] || 0) + 1;
      });
      const need = (kind, req) => Object.entries(req || {}).every(([type, n]) => (counts[kind + ':' + type] || 0) >= n);
      return need('staff', t.def.staff) && need('vehicle', t.def.vehicles);
    },

    /* あと何が足りないかの表示用テキスト（集合中カード・スポット用） */
    missingSummary(taskId) {
      const s = this.state;
      const t = s.tasks[taskId];
      if (!t) return '';
      const counts = {};
      t.assigned.forEach((id) => {
        const e = this.entityById(id);
        if (e) counts[e.kind + ':' + e.type] = (counts[e.kind + ':' + e.type] || 0) + 1;
      });
      const out = [];
      Object.entries(t.def.staff || {}).forEach(([type, n]) => {
        const rest = n - (counts['staff:' + type] || 0);
        if (rest > 0) out.push(`${window.RES_META.staff[type].icon}${window.RES_META.staff[type].short}×${rest}`);
      });
      Object.entries(t.def.vehicles || {}).forEach(([type, n]) => {
        const rest = n - (counts['vehicle:' + type] || 0);
        if (rest > 0) out.push(`${window.RES_META.vehicles[type].icon}${window.RES_META.vehicles[type].short}×${rest}`);
      });
      return out.join('・');
    },

    /* あと何が足りないか（アイコンだけ・Canvasバッジ用。ルビが振れないため） */
    missingIcons(taskId) {
      const s = this.state;
      const t = s.tasks[taskId];
      if (!t) return '';
      const counts = {};
      t.assigned.forEach((id) => {
        const e = this.entityById(id);
        if (e) counts[e.kind + ':' + e.type] = (counts[e.kind + ':' + e.type] || 0) + 1;
      });
      const out = [];
      Object.entries(t.def.staff || {}).forEach(([type, n]) => {
        const rest = n - (counts['staff:' + type] || 0);
        if (rest > 0) out.push(`${window.RES_META.staff[type].icon}×${rest}`);
      });
      Object.entries(t.def.vehicles || {}).forEach(([type, n]) => {
        const rest = n - (counts['vehicle:' + type] || 0);
        if (rest > 0) out.push(`${window.RES_META.vehicles[type].icon}×${rest}`);
      });
      return out.join(' ');
    },

    /* このエンティティを受け入れられる作業か（タップ配置のハイライト用） */
    canAccept(taskId, entityId) {
      const s = this.state;
      const t = s.tasks[taskId];
      const e = this.entityById(entityId);
      if (!t || !e || s.ended) return false;
      if (t.status !== 'ready' && t.status !== 'gathering') return false;
      if ((t.def.deps || []).some((d) => s.tasks[d].status !== 'done')) return false;
      if (t.def.outdoor && this.outdoorPaused()) return false;
      if (e.taskId !== null || (e.status !== 'idle' && e.status !== 'returning')) return false;
      const req = e.kind === 'staff' ? (t.def.staff || {})[e.type] : (t.def.vehicles || {})[e.type];
      if (!req) return false;
      const cur = t.assigned.filter((id) => {
        const x = this.entityById(id);
        return x && x.kind === e.kind && x.type === e.type;
      }).length;
      return cur < req;
    },

    /* ============ 1人（1台）ずつの割り当て（タップ配置） ============ */
    assignEntity(entityId, taskId) {
      const s = this.state;
      if (!s || s.ended) return { ok: false, reason: 'ステージは終了しています。' };
      const t = s.tasks[taskId];
      const e = this.entityById(entityId);
      if (!t || !e) return { ok: false, reason: '対象が見つかりません。' };
      if (t.status === 'done' || t.status === 'active') return { ok: false, reason: 'この作業には今は追加できません。' };
      const unmet = (t.def.deps || []).filter((d) => s.tasks[d].status !== 'done');
      if (unmet.length) {
        const names = unmet.map((d) => `「${s.tasks[d].def.name}」`).join('と');
        return { ok: false, reason: `まだ開始できません。${names}の完了待ちです。` };
      }
      if (t.def.outdoor && this.outdoorPaused()) {
        const rest = Math.max(1, Math.ceil(s.outdoorPauseUntil - s.clock));
        return { ok: false, reason: `⛈ 天候回復（あと約${rest}分）までお待ちください。` };
      }
      if (!this.canAccept(taskId, entityId)) {
        return { ok: false, reason: `${e.label}はこの作業には入れません（種類が違うか、もう足りています）。` };
      }
      e.taskId = t.id;
      e.status = 'moving';
      e.moveProgress = 0;
      t.assigned.push(e.id);
      if (t.status === 'ready') {
        t.status = 'gathering';
        t.startedAt = s.clock;
        if (!(t.id in s.stats.firstStarts)) s.stats.firstStarts[t.id] = s.clock;
      }
      this.emit('task', { id: t.id });
      this.emit('resources');
      this.emit('sfx', 'click');
      return { ok: true, filled: this.reqsFilled(t) };
    },

    /* ============ 作業ペース（采配レバー） ============ */
    setPace(taskId, pace) {
      const s = this.state;
      if (!s || s.ended || !window.PACE[pace]) return { ok: false };
      const t = s.tasks[taskId];
      if (!t || t.status === 'done' || !window.PACE_ALLOWED.has(taskId)) return { ok: false };
      if (t.pace === pace) return { ok: true };
      t.pace = pace;
      if (pace === 'rush') this.log(`「${t.def.name}」を急がせる（速いが満足度${window.SAFETY_SENSITIVE.has(t.id) ? '・安全性' : ''}に注意）`, 'warn');
      else if (pace === 'careful') this.log(`「${t.def.name}」をていねいに進める`, 'info');
      this.emit('task', { id: t.id });
      return { ok: true };
    },

    /* ============ 作業の開始（おまかせ割当: 足りない分をまとめて割り当てる） ============ */
    /* 戻り値 {ok, reason?} */
    startTask(taskId) {
      const s = this.state;
      if (!s || s.ended) return { ok: false, reason: 'ステージは終了しています。' };
      const t = s.tasks[taskId];
      if (!t) return { ok: false, reason: '不明な作業です。' };
      if (t.status === 'done') return { ok: false, reason: 'この作業はすでに完了しています。' };
      if (t.status === 'active') {
        return { ok: false, reason: 'この作業はすでに進行中です。' };
      }
      if (t.status === 'gathering' && this.reqsFilled(t)) {
        return { ok: false, reason: 'メンバーはそろっています。到着を待ちましょう。' };
      }

      /* 開始条件（依存関係） */
      const unmet = (t.def.deps || []).filter((d) => s.tasks[d].status !== 'done');
      if (unmet.length) {
        const names = unmet.map((d) => `「${s.tasks[d].def.name}」`).join('と');
        return { ok: false, reason: `まだ開始できません。${names}が完了していないためです。※${t.def.depNote}` };
      }

      /* 天候による屋外作業停止中は屋外作業を始められない */
      if (t.def.outdoor && this.outdoorPaused()) {
        const rest = Math.max(1, Math.ceil(s.outdoorPauseUntil - s.clock));
        return { ok: false, reason: `⛈ かみなりのため屋外作業は一時停止中です（再開まで約${rest}分）。屋内の作業を進めましょう。` };
      }

      /* すでに割り当て済みの数を差し引いて、足りない分だけ選ぶ */
      const assignedCount = {};
      t.assigned.forEach((id) => {
        const e = this.entityById(id);
        if (e) assignedCount[e.kind + ':' + e.type] = (assignedCount[e.kind + ':' + e.type] || 0) + 1;
      });
      const picks = [];
      const missing = [];
      const pickFrom = (kind, type, totalNeed) => {
        const need = totalNeed - (assignedCount[kind + ':' + type] || 0);
        if (need <= 0) return;
        const meta = kind === 'staff' ? window.RES_META.staff[type] : window.RES_META.vehicles[type];
        const free = s.entities.filter((e) =>
          e.kind === kind && e.type === type && e.taskId === null &&
          (e.status === 'idle' || e.status === 'returning'));
        if (free.length < need) {
          missing.push(`${meta.label}があと${need - free.length}${kind === 'staff' ? '人' : '台'}`);
        } else {
          /* 待機中を優先して選ぶ */
          free.sort((a, b) => (a.status === 'idle' ? 0 : 1) - (b.status === 'idle' ? 0 : 1));
          picks.push(...free.slice(0, need));
        }
      };
      Object.entries(t.def.staff || {}).forEach(([type, n]) => pickFrom('staff', type, n));
      Object.entries(t.def.vehicles || {}).forEach(([type, n]) => pickFrom('vehicle', type, n));
      if (missing.length) {
        return { ok: false, reason: `リソースが足りません（${missing.join('、')}必要）。他の作業が終わるのを待つか、作業を中断して呼び戻しましょう。` };
      }

      /* 割当実行 */
      picks.forEach((e) => {
        e.taskId = t.id;
        e.status = 'moving';
        e.moveProgress = 0;
        t.assigned.push(e.id);
      });
      if (t.status === 'ready') {
        t.status = 'gathering';
        t.startedAt = s.clock;
        if (!(t.id in s.stats.firstStarts)) s.stats.firstStarts[t.id] = s.clock;
      }

      /* リソース不要の作業（出発）は即開始 */
      if (t.assigned.length === 0 && this.reqsFilled(t)) this._tryActivate(t);

      this.emit('task', { id: t.id });
      this.emit('resources');
      this.emit('sfx', 'start');
      return { ok: true };
    },

    /* ============ 作業の中断 ============ */
    cancelTask(taskId) {
      const s = this.state;
      if (!s || s.ended) return { ok: false };
      const t = s.tasks[taskId];
      if (!t || (t.status !== 'gathering' && t.status !== 'active')) return { ok: false };
      if (t.id === 'pushback' || t.id === 'depart') {
        return { ok: false, reason: '安全のため、この作業は途中でやめられません。' };
      }
      this._releaseEntities(t);
      t.status = 'ready';
      t.activeAt = null;
      this.log(`「${t.def.name}」を中断しました（進み具合は保存されます）`, 'info');
      this.emit('task', { id: t.id });
      this.emit('resources');
      return { ok: true };
    },

    _releaseEntities(t) {
      t.assigned.forEach((id) => {
        const e = this.entityById(id);
        if (e) { e.taskId = null; e.status = 'returning'; e.moveProgress = 0; }
      });
      t.assigned = [];
    },

    /* 集合完了後の起動判定。プッシュバックだけは直前に安全確認を挟む */
    _tryActivate(t) {
      const s = this.state;
      if (t.def.safetyGate && !s.flags.safetyChoiceDone) {
        if (!s.pendingSafety) {
          s.pendingSafety = true;
          this.emit('safety-ask');
        }
        return;
      }
      this._activateTask(t);
    },

    _activateTask(t) {
      const s = this.state;
      t.status = 'active';
      t.activeAt = s.clock;
      t.assigned.forEach((id) => {
        const e = this.entityById(id);
        if (e) e.status = 'working';
      });

      /* 担当スタッフの熟練度 → 作業速度（⭐ベテラン15%速い / 🔰新人15%ゆっくり） */
      const crew = t.assigned.map((id) => this.entityById(id)).filter((e) => e && e.kind === 'staff');
      if (crew.length) {
        const mean = crew.reduce((sum, e) => sum + (SKILL_FACTOR[e.skill] || 1), 0) / crew.length;
        t.crewFactor = 1 / mean;
        if (crew.some((e) => e.skill === 'vet')) this.log(`⭐ベテランが「${t.def.name}」を担当。手ぎわがいい！`, 'info');
      } else {
        t.crewFactor = 1;
      }

      if (t.id === 'deboard') {
        /* 降機開始が遅いと乗客満足度が下がる */
        const gap = s.clock - s.stage.arrival;
        if (gap > 4) {
          const hit = Math.min(10, (gap - 4) * 2);
          s.metrics.sat = clamp(s.metrics.sat - hit, 0, 100);
          s.stats.satNotes.push('deboard_late');
          this.log('乗客を待たせてしまい、機内から不満の声が…', 'warn');
        }
      }
      if (t.id === 'pushback') {
        /* ブロックアウト（＝出発時刻）はプッシュバック開始時点 */
        s.stats.blockOff = s.clock;
        s.stats.delay = Math.max(0, s.clock - s.stage.std);
        s.metrics.punct = clamp(100 - s.stats.delay * (100 / 15), 0, 100);
        const d = s.stats.delay;
        this.log(d > 0
          ? `プッシュバック開始（出発 ${fmtClock(s.clock)}・${Math.ceil(d)}分遅れ）`
          : `プッシュバック開始（出発 ${fmtClock(s.clock)}・定刻どおり！）`, d > 0 ? 'warn' : 'ok');
      } else if (t.id === 'depart') {
        this.log('✈ 出発！滑走路へ向かいます', 'ok');
      } else {
        this.log(`「${t.def.name}」を開始`, 'info');
      }
      this.emit('task', { id: t.id });
      this.emit('resources');
    },

    _completeTask(t) {
      const s = this.state;
      t.progress = this.effDur(t);
      t.status = 'done';
      t.doneAt = s.clock;
      this._releaseEntities(t);
      if (t.id !== 'depart') this.log(`「${t.def.name}」が完了`, 'ok');

      /* 采配レバーの効果（完了時に一度だけ） */
      if (window.PACE_ALLOWED.has(t.id)) {
        if (t.pace === 'rush') {
          s.stats.rushCount++;
          s.metrics.sat = clamp(s.metrics.sat - 3, 0, 100);
          if (window.SAFETY_SENSITIVE.has(t.id)) {
            s.metrics.safety = clamp(s.metrics.safety - 5, 0, 100);
            this.log(`急いだぶん「${t.def.name}」の確認が少し甘くなった…（安全性−5）`, 'warn');
          }
          this.emit('metrics');
        } else if (t.pace === 'careful') {
          s.stats.carefulCount++;
          s.metrics.sat = clamp(s.metrics.sat + 2, 0, 100);
          this.emit('metrics');
        }
      }
      this.emit('celebrate', { taskId: t.id });

      /* ロック解除の再計算 */
      s.taskList.forEach((o) => {
        if (o.status === 'locked') {
          const ok = (o.def.deps || []).every((d) => s.tasks[d].status === 'done');
          if (ok) { o.status = 'ready'; this.emit('task', { id: o.id }); }
        }
      });

      this.emit('task', { id: t.id });
      this.emit('resources');
      this.emit('sfx', t.id === 'depart' ? 'clear' : 'done');

      if (t.id === 'pushback') {
        this.startTask('depart');
      } else if (t.id === 'depart') {
        this._endStage(true);
      }
    },

    /* ============ 安全確認の選択（プッシュバック直前・トーイングカー到着時） ============ */
    chooseSafety(careful) {
      const s = this.state;
      if (!s || !s.pendingSafety || s.ended) return;
      s.pendingSafety = false;
      s.flags.safetyChoiceDone = true;
      const t = s.tasks.pushback;
      if (careful) {
        t.dur = t.def.dur + 1; // 確認のぶん1分だけ長くなる
        this.log('機体周辺の安全確認を実施。人も車両も残っていない、よし！', 'ok');
      } else {
        s.metrics.safety = clamp(s.metrics.safety - 60, 0, 100);
        s.flags.critical = true;
        s.flags.safetySkipped = true;
        this.log('⚠ 周辺の安全確認を省略してしまった…（重大な安全問題）', 'bad');
        this.emit('toast', { msg: '安全確認の省略は重大なペナルティです！', type: 'bad' });
        this.emit('sfx', 'warn');
      }
      this.emit('metrics');
      /* そろって到着済みならすぐ開始 */
      if (t.status === 'gathering' && this.reqsFilled(t) &&
          t.assigned.every((id) => { const e = this.entityById(id); return e && e.moveProgress >= 1; })) {
        this._activateTask(t);
      }
    },

    /* ============ イベント対応 ============ */
    resolveEvent(choiceIdx, auto) {
      const s = this.state;
      const ev = s.activeEvent;
      if (!ev) return;
      const ch = ev.def.choices[choiceIdx];
      if (!ch) return;

      Object.entries(ch.effects || {}).forEach(([k, v]) => {
        if (k in s.metrics) s.metrics[k] = clamp(s.metrics[k] + v, 0, 100);
      });
      Object.entries(ch.taskDelta || {}).forEach(([taskId, delta]) => {
        const t = s.tasks[taskId];
        if (t && t.status !== 'done') {
          t.dur = Math.max(0.5, t.dur + delta);
          t.extra = delta > 0 ? `イベント対応で+${delta}分` : `イベント対応で${delta}分`;
          this.emit('task', { id: taskId });
        }
      });
      if (ch.critical) s.flags.critical = true;

      /* 天候: 屋外作業の一時停止 */
      if (ch.pauseOutdoor) {
        s.outdoorPauseUntil = s.clock + ch.pauseOutdoor;
        s.taskList.forEach((t) => {
          if (t.def.outdoor && (t.status === 'active' || t.status === 'moving')) this.emit('task', { id: t.id });
        });
      }

      s.resolvedEvents.push({ id: ev.def.id, choiceIdx, auto: !!auto });
      s.activeEvent = null;
      this.log((auto ? '（自動対応）' : '') + ch.log, ch.critical ? 'bad' : 'info');
      this.emit('event-resolved');
      this.emit('metrics');
      this.emit('sfx', ch.critical ? 'warn' : 'select');
    },

    /* ============ ステージ終了 ============ */
    _endStage(departed) {
      const s = this.state;
      if (s.ended) return;
      s.ended = true;
      if (s.activeEvent) {
        /* 未対応イベントはデフォルト選択で処理してから集計 */
        s.ended = false;
        this.resolveEvent(s.activeEvent.def.defaultChoice, true);
        s.ended = true;
      }
      if (!departed) {
        s.metrics.punct = 0;
        s.stats.delay = s.stage.maxOvertime;
      }

      const m = s.metrics;
      const breakdown = {
        safety: { label: '🛡 安全', got: Math.round(m.safety * 0.4), max: 40 },
        punct:  { label: '⏱ 時間どおり', got: Math.round(m.punct * 0.3), max: 30 },
        sat:    { label: '😊 お客さんのまんぞく', got: Math.round(m.sat * 0.2), max: 20 },
        cost:   { label: '💰 コスト（おかね）', got: Math.round(m.cost * 0.1), max: 10 },
      };
      const score = breakdown.safety.got + breakdown.punct.got + breakdown.sat.got + breakdown.cost.got;
      const cleared = departed && !s.flags.critical;
      let rank = 'D';
      if (score >= 90) rank = 'S';
      else if (score >= 80) rank = 'A';
      else if (score >= 65) rank = 'B';
      else if (score >= 50) rank = 'C';
      if (!cleared) rank = '×';

      s.endResult = {
        departed, cleared, score, rank, breakdown,
        critical: s.flags.critical,
        blockOff: s.stats.blockOff,
        std: s.stage.std,
        arrival: s.stage.arrival,
        delay: s.stats.blockOff ? Math.max(0, s.stats.blockOff - s.stage.std) : null,
        advice: this._buildAdvice(departed),
        stageId: s.stage.id,
        /* 結果画面のタイムライン表示用 */
        timeline: s.taskList.map((t) => ({
          id: t.id, name: t.def.name, icon: t.def.icon,
          startedAt: t.startedAt, activeAt: t.activeAt, doneAt: t.doneAt,
        })),
      };
      this.emit('stage-end', s.endResult);
      this.emit('sfx', cleared ? 'clear' : 'fail');
    },

    _buildAdvice(departed) {
      const s = this.state;
      const out = [];
      const fs = s.stats.firstStarts;
      const t = s.tasks;
      const delay = s.stats.blockOff ? Math.max(0, s.stats.blockOff - s.stage.std) : null;

      if (s.flags.safetySkipped) {
        out.push('安全確認を省略したため、安全性が大きく減点され、クリアになりませんでした。プッシュバック前の周辺確認は、どんなに急いでいても必ず行いましょう。');
      } else if (s.flags.critical) {
        out.push('安全にかかわる確認を省略する選択をしたため、クリアになりませんでした。安全はすべてに優先します。');
      } else {
        out.push('安全な運航を実現しました。');
      }

      if (!departed) {
        out.push(`時間内に出発できませんでした。到着直後から「降機」「取り降ろし」「給油」「点検」の4つを並行で始めるのがコツです。`);
      } else if (delay !== null && delay > 0.5) {
        out.push(`一方で、出発が${Math.ceil(delay)}分遅れました。`);
        /* いちばん大きな「待ち時間」を探して助言する */
        const gaps = [];
        const gap = (name, val, msg) => { if (val != null && val > 2) gaps.push({ val, msg }); };
        gap('deboard', fs.deboard != null ? fs.deboard - s.stage.arrival : null,
          '到着してすぐ「乗客の降機」を始めると改善できます。');
        gap('unload', fs.unload != null ? fs.unload - s.stage.arrival : null,
          '到着直後に「手荷物の取り降ろし」を開始すると改善できます。');
        gap('clean', fs.clean != null && t.deboard.doneAt != null ? fs.clean - t.deboard.doneAt : null,
          '降機が終わったらすぐ「機内清掃」を始めると改善できます。');
        gap('board', fs.board != null && t.clean.doneAt != null ? fs.board - t.clean.doneAt : null,
          '清掃が終わったらすぐ「乗客の搭乗」を始めると改善できます。');
        gap('load', fs.load != null && t.unload.doneAt != null ? fs.load - t.unload.doneAt : null,
          '取り降ろしが終わったらすぐ「積み込み」を始めると改善できます。');
        gaps.sort((a, b) => b.val - a.val);
        if (gaps.length) out.push(gaps[0].msg);
        else if ((fs.refuel != null && fs.refuel - s.stage.arrival > 12) || (fs.inspect != null && fs.inspect - s.stage.arrival > 15)) {
          out.push('給油や機体点検は到着直後から始められます。早めに始めると余裕が生まれます。');
        } else {
          out.push('作業どうしのすき間を小さくして、並行作業を増やすとさらに良くなります。');
        }
      } else if (departed) {
        out.push('定刻どおりの出発、みごとな段取りです！');
      }

      /* イベント対応へのひとこと（プレイヤーが自分で選んだものだけ・最大2件） */
      const evAdvice = {
        'late_pax:0': '遅れた乗客への対応もうまく調整できました。',
        'late_pax:1': '呼び出し放送のひと工夫で、遅れを小さくおさえられました。',
        'late_pax:2': '搭乗をしめきる判断は定時性を守りましたが、乗客満足度が下がりました。状況によって使い分けましょう。',
        'cleaning_delay:1': '応援を呼んで清掃の遅れを取りもどしたのは良い判断でした。',
        'cleaning_delay:2': '簡易清掃は時間をかせげますが、機内の快適さ（満足度）が下がる点に注意です。',
        'minor_defect:0': '点検で見つけた異常を基準どおり確認できました。安全第一の良い対応です。',
        'minor_defect:1': '応援整備士の手配で、安全と時間を両立できました。',
        'lost_bag:0': '見つからない手荷物をあきらめず捜索する、ていねいな対応でした。',
        'lost_bag:1': '手荷物を次の便で送る判断は出発を守りましたが、持ち主の満足度は下がります。',
        'weather:0': '雷のときに屋外作業を止めるのは正しい判断です。安全はすべてに優先します。',
      };
      s.resolvedEvents.filter((e) => !e.auto).slice(0, 2).forEach((e) => {
        const a = evAdvice[`${e.id}:${e.choiceIdx}`];
        if (a) out.push(a);
      });
      if (s.stats.rushCount >= 4 && s.metrics.sat < 78) {
        out.push('「急がせる」の使いすぎで満足度が下がりました。ここぞという作業だけに使うのがコツです。');
      } else if (s.metrics.sat < 80 && !s.stats.satNotes.includes('advised')) {
        out.push('乗客の待ち時間をへらすと満足度が上がります。');
      }
      return out.join(' ');
    },

    /* ============ ヒント（初級のみ） ============ */
    getHint() {
      const s = this.state;
      if (!s || !s.stage.hints || s.ended) return null;
      /* 中級: ヒントは序盤(8分)のみ */
      if (s.stage.hints === 'limited' && s.clock - s.stage.arrival > 8) return null;
      const ready = s.taskList.filter((t) => t.status === 'ready');
      if (!ready.length) {
        const running = s.taskList.filter((t) => t.status === 'moving' || t.status === 'active');
        return running.length ? '進行中の作業の完了を待ちましょう。次の作業の準備はOK？' : null;
      }
      const prio = { high: 0, mid: 1 };
      ready.sort((a, b) => (prio[a.def.priority] - prio[b.def.priority]) || (a.def.order - b.def.order));
      const names = ready.slice(0, 2).map((t) => `${t.def.icon}${t.def.name}`).join('、');
      return `次のおすすめ: ${names}`;
    },

    /* ============ ロック理由（UI表示用） ============ */
    lockReason(taskId) {
      const s = this.state;
      const t = s.tasks[taskId];
      const unmet = (t.def.deps || []).filter((d) => s.tasks[d].status !== 'done');
      if (!unmet.length) return '';
      return unmet.map((d) => `「${s.tasks[d].def.name}」`).join('と') + 'の完了待ち';
    },

    log(msg, cls) {
      const s = this.state;
      const entry = { t: s ? s.clock : 0, msg, cls: cls || 'info' };
      if (s) s.log.push(entry);
      this.emit('log', entry);
    },
  };

  window.Game = Game;
  window.fmtClock = fmtClock;
})();
