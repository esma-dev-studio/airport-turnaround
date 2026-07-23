/* =========================================================
 * ui.js — 画面表示（DOM）と駐機場ビュー（Canvas）と効果音
 * ゲームの判断ロジックは持たない。Game の状態を描画し、
 * 操作は main.js から渡されたコールバックへ渡すだけ。
 * 駐機場ビューはカメラ（ズーム/パン）とタップ操作を持つ。
 * ========================================================= */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const TAU = Math.PI * 2;
  const rad = (deg) => (deg * Math.PI) / 180;

  /* ============================================================
   * 効果音（WebAudioで生成。外部ファイルなし）
   * ============================================================ */
  const Sfx = {
    ctx: null, enabled: true,
    ensure() {
      if (!this.ctx) {
        try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* 音なし環境 */ }
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, dur, delay, type, gain) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + (delay || 0);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain || 0.09, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    },
    play(name) {
      if (!this.enabled) return;
      this.ensure();
      if (!this.ctx) return;
      switch (name) {
        case 'click':  this.tone(740, 0.06, 0, 'square', 0.04); break;
        case 'start':  this.tone(523, 0.09); this.tone(659, 0.12, 0.09); break;
        case 'done':   this.tone(659, 0.1); this.tone(784, 0.16, 0.1); break;
        case 'select': this.tone(660, 0.08); this.tone(880, 0.1, 0.08); break;
        case 'warn':   this.tone(233, 0.18, 0, 'sawtooth', 0.06); this.tone(220, 0.22, 0.2, 'sawtooth', 0.06); break;
        case 'event':  this.tone(587, 0.12, 0, 'triangle'); this.tone(494, 0.12, 0.14, 'triangle'); this.tone(587, 0.12, 0.28, 'triangle'); break;
        case 'clear':  [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.16, i * 0.13, 'triangle', 0.1)); break;
        case 'fail':   [392, 330, 262].forEach((f, i) => this.tone(f, 0.2, i * 0.16, 'triangle', 0.08)); break;
      }
    },
  };

  /* ============================================================
   * 駐機場シーン（Canvas 2.5D風）
   * 論理座標 1200x640。カメラで拡大・移動して描く。
   * ============================================================ */
  const SCENE_W = 1200, SCENE_H = 640;

  /* 作業ごとの持ち場（x, y, [車両の向きdeg]） */
  const SLOTS = {
    deboard:   { staff: [[378, 252]] },
    board:     { staff: [[378, 252]] },
    doorclose: { staff: [[392, 262]] },
    clean:     { staff: [[350, 222], [368, 240]] },
    unload:    { staff: [[468, 420], [552, 420]], vehicles: { beltloader: [[505, 398, -90]], cart: [[505, 458, 0]] } },
    load:      { staff: [[718, 420], [800, 420]], vehicles: { beltloader: [[755, 398, -90]], cart: [[755, 458, 0]] } },
    bagmatch:  { staff: [[762, 432]] },
    refuel:    { staff: [[602, 448]], vehicles: { fuel: [[646, 472, 0]] } },
    catering:  { staff: [[832, 416]], vehicles: { catering: [[864, 396, -90]] } },
    inspect:   { staff: [[298, 392]] },
    pushback:  { staff: [[252, 392]], vehicles: { pushback: [[233, 321, 0]] } },
    depart:    {},
  };
  /* 点検スタッフが機体を一周する経路 */
  const INSPECT_LOOP = [
    [295, 385], [268, 322], [320, 270], [600, 250], [860, 268], [958, 300],
    [958, 342], [860, 374], [600, 392], [320, 374],
  ];
  const VEHICLE_HOME = {
    beltloader: [[500, 516, 0]],
    cart: [[600, 516, 0], [688, 516, 0]],
    fuel: [[790, 516, 0]],
    catering: [[892, 516, 0]],
    pushback: [[996, 516, 0]],
  };
  const BRIDGE_PATH = [[402, 284], [347, 207], [340, 150]];
  const PAX_COLORS = ['#e5867c', '#7ca3d8', '#d8c07c', '#8fc98f', '#b493cf', '#7cc2c9'];
  const PAX_TOTAL = 112;

  const Scene = {
    canvas: null, ctx: null,
    cw: 0, ch: 0, dpr: 1,
    cam: { zoom: 1, cx: 600, cy: 330 },
    time: 0,
    ent: {},          // entityId -> {pos, path, len, lastStatus, angle}
    paxDots: [],
    lastPaxSpawn: 0,
    bridge: 1,        // 1=装着 0=格納
    fx: { parts: [], floats: [] },

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
    },
    reset() {
      this.ent = {};
      this.paxDots = [];
      this.lastPaxSpawn = 0;
      this.bridge = 1;
      this.time = 0;
      this.fx = { parts: [], floats: [] };
      this.cam = { zoom: 1, cx: 600, cy: 330 };
    },

    resize() {
      const parent = this.canvas.parentElement;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      this.cw = w; this.ch = h; this.dpr = dpr;
      this.clampCam();
    },

    /* ---- カメラ ---- */
    baseScale() { return this.cw / SCENE_W; },
    scale() { return this.baseScale() * this.cam.zoom; },
    minZoom() {
      /* 縦もぜんぶ入るところまで引ける（最低0.55倍） */
      const fitH = (this.ch / SCENE_H) / this.baseScale();
      return Math.max(0.55, Math.min(1, fitH));
    },
    clampCam() {
      const c = this.cam;
      c.zoom = clamp(c.zoom, this.minZoom(), 2.6);
      const S = this.scale();
      const visW = this.cw / S, visH = this.ch / S;
      c.cx = visW >= SCENE_W ? SCENE_W / 2 : clamp(c.cx, visW / 2, SCENE_W - visW / 2);
      c.cy = visH >= SCENE_H ? SCENE_H / 2 : clamp(c.cy, visH / 2, SCENE_H - visH / 2);
    },
    sceneToScreen(x, y) {
      const S = this.scale();
      return { x: (x - this.cam.cx) * S + this.cw / 2, y: (y - this.cam.cy) * S + this.ch / 2 };
    },
    screenToScene(x, y) {
      const S = this.scale();
      return { x: (x - this.cw / 2) / S + this.cam.cx, y: (y - this.ch / 2) / S + this.cam.cy };
    },
    zoomAt(factor, px, py) {
      const pivot = (px != null) ? { x: px, y: py } : { x: this.cw / 2, y: this.ch / 2 };
      const before = this.screenToScene(pivot.x, pivot.y);
      this.cam.zoom = clamp(this.cam.zoom * factor, this.minZoom(), 2.6);
      const S = this.scale();
      this.cam.cx = before.x - (pivot.x - this.cw / 2) / S;
      this.cam.cy = before.y - (pivot.y - this.ch / 2) / S;
      this.clampCam();
    },
    panBy(dxScreen, dyScreen) {
      const S = this.scale();
      this.cam.cx -= dxScreen / S;
      this.cam.cy -= dyScreen / S;
      this.clampCam();
    },
    resetCam() {
      this.cam.zoom = this.minZoom() < 1 ? this.minZoom() : 1;
      this.cam.cx = 600; this.cam.cy = 330;
      this.clampCam();
    },

    /* ---- ホーム位置（待機所は左ドロワーに隠れない位置に置く） ---- */
    staffHome(state, entity) {
      const staff = state.entities.filter((e) => e.kind === 'staff');
      const i = staff.indexOf(entity);
      return [272 + (i % 5) * 30, 498 + Math.floor(i / 5) * 26];
    },
    homeOf(state, e) {
      if (e.kind === 'staff') return this.staffHome(state, e);
      const arr = VEHICLE_HOME[e.type] || [[1100, 516, 0]];
      return arr[Math.min(e.idx, arr.length - 1)];
    },
    slotOf(state, e) {
      const t = state.tasks[e.taskId];
      if (!t) return null;
      const slots = SLOTS[t.id] || {};
      if (e.kind === 'staff') {
        const mates = t.assigned.map((id) => state.entities.find((x) => x.id === id))
          .filter((x) => x && x.kind === 'staff');
        const i = mates.indexOf(e);
        const arr = slots.staff || [[600, 430]];
        return arr[Math.min(Math.max(i, 0), arr.length - 1)];
      }
      const mates = t.assigned.map((id) => state.entities.find((x) => x.id === id))
        .filter((x) => x && x.kind === 'vehicle' && x.type === e.type);
      const i = mates.indexOf(e);
      const arr = (slots.vehicles && slots.vehicles[e.type]) || [[600, 470, 0]];
      return arr[Math.min(Math.max(i, 0), arr.length - 1)];
    },
    /* 作業スポットの代表点（リング・バッジ・タップ判定に使う） */
    anchorOf(taskId) {
      const slots = SLOTS[taskId] || {};
      if (slots.staff && slots.staff[0]) return slots.staff[0];
      if (slots.vehicles) {
        const first = Object.values(slots.vehicles)[0];
        if (first && first[0]) return first[0];
      }
      return null;
    },

    /* 機体エリアを避けるL字経路をつくる */
    route(from, to) {
      const pts = [from.slice(0, 2)];
      const CORR = 472;      // 横移動用の通路
      const SIDE = 207;      // 機首を回りこむ縦通路
      const topSide = (p) => p[1] < 300;
      const a = from, b = to;
      if (topSide(a) && topSide(b)) {
        pts.push([SIDE, a[1]], [SIDE, b[1]]);
      } else if (topSide(b)) {
        pts.push([a[0], CORR], [SIDE, CORR], [SIDE, b[1]]);
      } else if (topSide(a)) {
        pts.push([SIDE, a[1]], [SIDE, CORR], [b[0], CORR]);
      } else if (Math.abs(a[1] - b[1]) > 30) {
        pts.push([a[0], CORR], [b[0], CORR]);
      }
      pts.push(b.slice(0, 2));
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      return { pts, len: Math.max(len, 1) };
    },
    pathPos(path, t01) {
      const target = path.len * clamp(t01, 0, 1);
      let acc = 0;
      const pts = path.pts;
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc + seg >= target && seg > 0) {
          const k = (target - acc) / seg;
          return {
            x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k,
            y: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k,
            ang: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]),
          };
        }
        acc += seg;
      }
      const last = pts[pts.length - 1];
      return { x: last[0], y: last[1], ang: 0 };
    },

    /* エンティティの現在位置を状態から解決する */
    resolveEntity(state, e) {
      let rec = this.ent[e.id];
      if (!rec) {
        const home = this.homeOf(state, e);
        rec = this.ent[e.id] = { pos: { x: home[0], y: home[1] }, path: null, lastStatus: 'idle', angle: home[2] ? rad(home[2]) : 0, lastTask: null };
      }
      if (e.status !== rec.lastStatus || (e.taskId && e.taskId !== rec.lastTask)) {
        if (e.status === 'moving') {
          const slot = this.slotOf(state, e) || [600, 430, 0];
          rec.path = this.route([rec.pos.x, rec.pos.y], slot);
          rec.slotAngle = slot[2] != null ? rad(slot[2]) : null;
        } else if (e.status === 'returning') {
          const home = this.homeOf(state, e);
          rec.path = this.route([rec.pos.x, rec.pos.y], home);
          rec.slotAngle = home[2] != null ? rad(home[2]) : 0;
        }
        rec.lastStatus = e.status;
        rec.lastTask = e.taskId;
      }
      if ((e.status === 'moving' || e.status === 'returning') && rec.path) {
        const p = this.pathPos(rec.path, e.moveProgress);
        rec.pos.x = p.x; rec.pos.y = p.y;
        if (e.moveProgress >= 0.999 && rec.slotAngle != null) rec.angle = rec.slotAngle;
        else rec.angle = p.ang;
      } else if (e.status === 'working') {
        const slot = this.slotOf(state, e);
        if (slot) {
          rec.pos.x = slot[0]; rec.pos.y = slot[1];
          rec.angle = slot[2] != null ? rad(slot[2]) : rec.angle;
        }
      } else if (e.status === 'idle') {
        const home = this.homeOf(state, e);
        rec.pos.x = home[0]; rec.pos.y = home[1];
        rec.angle = home[2] != null ? rad(home[2]) : 0;
      }
      return rec;
    },

    /* タップ判定: エンティティ → 作業スポットの順に探す */
    hitTest(state, sceneP) {
      let best = null, bestD = 1e9;
      state.entities.forEach((e) => {
        const rec = this.ent[e.id];
        if (!rec) return;
        const r = e.kind === 'staff' ? 17 : 40;
        const d = Math.hypot(rec.pos.x - sceneP.x, rec.pos.y - sceneP.y);
        if (d < r && d < bestD) { best = { type: 'entity', id: e.id }; bestD = d; }
      });
      if (best) return best;
      let spot = null; bestD = 1e9;
      state.taskList.forEach((t) => {
        if (t.status !== 'ready' && t.status !== 'gathering' && t.status !== 'active') return;
        const a = this.anchorOf(t.id);
        if (!a) return;
        const d = Math.hypot(a[0] - sceneP.x, a[1] - sceneP.y);
        if (d < 34 && d < bestD) { spot = { type: 'spot', id: t.id }; bestD = d; }
      });
      return spot;
    },

    /* ---------- 演出（パーティクル・浮き文字） ---------- */
    burst(x, y, n, colors) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const sp = 40 + Math.random() * 90;
        this.fx.parts.push({
          x, y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 50,
          life: 0.9 + Math.random() * 0.5,
          age: 0,
          size: 2.5 + Math.random() * 3,
          color: colors[i % colors.length],
        });
      }
    },
    float(x, y, text, color) {
      this.fx.floats.push({ x, y, text, color: color || '#1e3a5f', life: 1.6, age: 0 });
    },
    celebrate(state, taskId) {
      const colors = ['#ffd166', '#57c98a', '#3bb0f2', '#f2544a', '#b07fe6'];
      if (taskId === 'depart') {
        for (let i = 0; i < 5; i++) this.burst(350 + i * 130, 320, 12, colors);
        this.float(615, 250, '✈ いってらっしゃい！', '#0e6f8c');
        return;
      }
      let a = this.anchorOf(taskId);
      if (taskId === 'pushback') a = [280, 300];
      if (!a) a = [615, 320];
      this.burst(a[0], a[1] - 14, 14, colors);
      const def = window.TASK_MAP[taskId];
      this.float(a[0], a[1] - 30, `${def.icon} 完了!`, '#2e9e5b');
    },
    drawFx(dtReal) {
      const c = this.ctx;
      this.fx.parts = this.fx.parts.filter((p) => (p.age += dtReal) < p.life);
      this.fx.parts.forEach((p) => {
        p.x += p.vx * dtReal;
        p.y += p.vy * dtReal;
        p.vy += 160 * dtReal;
        c.globalAlpha = clamp(1 - p.age / p.life, 0, 1);
        c.fillStyle = p.color;
        c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      });
      c.globalAlpha = 1;
      this.fx.floats = this.fx.floats.filter((f) => (f.age += dtReal) < f.life);
      c.textAlign = 'center'; c.textBaseline = 'middle';
      this.fx.floats.forEach((f) => {
        const k = f.age / f.life;
        c.globalAlpha = clamp(1 - k * k, 0, 1);
        c.font = 'bold 17px "Segoe UI", "Hiragino Sans", Meiryo, sans-serif';
        c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 4;
        c.strokeText(f.text, f.x, f.y - k * 30);
        c.fillStyle = f.color;
        c.fillText(f.text, f.x, f.y - k * 30);
      });
      c.globalAlpha = 1;
    },

    /* ---------- 描画ヘルパー ---------- */
    rr(x, y, w, h, r) {
      const c = this.ctx;
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    },

    draw(state, dtReal, ui) {
      if (!this.ctx) return;
      this.resize();
      const c = this.ctx;
      this.time += dtReal;
      const gt = state ? state.clock : 0;

      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.cw, this.ch);
      c.fillStyle = '#8f99a3';
      c.fillRect(0, 0, this.cw, this.ch);

      c.save();
      c.translate(this.cw / 2, this.ch / 2);
      const S = this.scale();
      c.scale(S, S);
      c.translate(-this.cam.cx, -this.cam.cy);

      this.drawBackground(state);
      if (state) {
        this.updateBridge(state, dtReal);
        this.drawPlane(state);
        this.drawBridge(state);
        this.drawEffectsUnder(state, gt);
        this.drawSpots(state, ui);
        this.drawEntities(state, gt, ui);
        this.drawPax(state, gt);
        this.drawRings(state);
        this.drawPaxCounter(state);
        this.drawFx(dtReal);
        this.drawRain(state);
      }
      c.restore();
    },

    drawBackground(state) {
      const c = this.ctx;
      /* 空 */
      c.fillStyle = '#cde5f4';
      c.fillRect(0, 0, SCENE_W, 30);
      c.fillStyle = '#ffd77a';
      c.beginPath(); c.arc(66, 13, 9, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,255,255,.85)';
      const cl = (x, y, s) => { this.rr(x, y, 54 * s, 11 * s, 5.5 * s); c.fill(); this.rr(x + 12 * s, y - 6 * s, 30 * s, 9 * s, 4.5 * s); c.fill(); };
      cl(220 + Math.sin(this.time * 0.08) * 24, 9, 0.9);
      cl(760 + Math.cos(this.time * 0.06) * 30, 11, 0.75);

      /* ターミナルビル */
      c.fillStyle = '#c3d0dd';
      c.fillRect(0, 30, SCENE_W, 8);
      c.fillStyle = '#e3e9f0';
      c.fillRect(0, 38, SCENE_W, 88);
      for (let x = 48; x < SCENE_W - 60; x += 46) {
        c.fillStyle = (x / 46) % 2 ? '#b6c8d8' : '#aabfd1';
        c.fillRect(x, 52, 28, 54);
      }
      c.fillStyle = '#cbd5e0';
      c.fillRect(0, 126, SCENE_W, 12);
      c.fillStyle = '#51667e';
      c.font = 'bold 15px "Segoe UI", "Hiragino Sans", Meiryo, sans-serif';
      c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText('そらみなと国際空港', 16, 45);
      /* ゲート表示 */
      c.fillStyle = '#27496d';
      this.rr(292, 104, 92, 24, 6); c.fill();
      c.fillStyle = '#fff';
      c.font = 'bold 13px "Segoe UI", Meiryo, sans-serif';
      c.textAlign = 'center';
      c.fillText('GATE 7', 338, 117);
      /* 管制塔 */
      c.fillStyle = '#d6dee6'; c.fillRect(1082, 48, 24, 78);
      c.fillStyle = '#6f8598'; this.rr(1068, 30, 52, 26, 8); c.fill();
      c.fillStyle = '#b7e0ef'; this.rr(1073, 36, 42, 10, 4); c.fill();
      c.strokeStyle = '#6f8598'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(1094, 30); c.lineTo(1094, 18); c.stroke();

      /* エプロン（駐機場） */
      c.fillStyle = '#b8bfc7';
      c.fillRect(0, 138, SCENE_W, SCENE_H - 138);
      c.strokeStyle = 'rgba(255,255,255,.16)';
      c.lineWidth = 1.5;
      for (let x = 120; x < SCENE_W; x += 150) {
        c.beginPath(); c.moveTo(x, 138); c.lineTo(x, SCENE_H); c.stroke();
      }
      for (let y = 230; y < SCENE_H; y += 130) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(SCENE_W, y); c.stroke();
      }

      /* 誘導路（タキシーウェイ） */
      c.fillStyle = '#9aa2ab';
      c.fillRect(0, 574, SCENE_W, 56);
      c.strokeStyle = '#e8c84a'; c.lineWidth = 3;
      c.setLineDash([26, 18]);
      c.beginPath(); c.moveTo(0, 602); c.lineTo(SCENE_W, 602); c.stroke();
      c.setLineDash([]);

      /* スタンド導入線とスポット番号 */
      c.strokeStyle = '#e8c84a'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(615, 574); c.lineTo(615, 330); c.stroke();
      c.fillStyle = '#7c858e';
      c.font = 'bold 20px "Segoe UI", Meiryo, sans-serif';
      c.textAlign = 'center';
      c.fillText('S7', 592, 566);

      /* 制限区域ライン（赤の点線） */
      c.strokeStyle = 'rgba(214,69,69,.5)'; c.lineWidth = 2.5;
      c.setLineDash([14, 10]);
      this.rr(225, 195, 790, 275, 30); c.stroke();
      c.setLineDash([]);

      /* スタッフ待機所 */
      c.fillStyle = '#a9b3ba';
      this.rr(250, 484, 172, 58, 8); c.fill();
      c.strokeStyle = '#8b959c'; c.lineWidth = 2; this.rr(250, 484, 172, 58, 8); c.stroke();
      c.fillStyle = '#616d78';
      c.font = '11px "Segoe UI", Meiryo, sans-serif';
      c.textAlign = 'left';
      c.fillText('スタッフ待機所', 256, 478);

      /* 車両置き場 */
      c.fillStyle = '#616d78';
      c.fillText('車両置き場（GSE）', 452, 478);
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2;
      [450, 552, 648, 742, 844, 948, 1046].forEach((x) => {
        c.beginPath(); c.moveTo(x, 486); c.lineTo(x, 548); c.stroke();
      });

      /* 吹き流し */
      const wx = 1128, wy = 188;
      c.strokeStyle = '#7c858e'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(wx, wy); c.lineTo(wx, wy - 34); c.stroke();
      const flap = Math.sin(this.time * 2.2) * 4;
      c.fillStyle = '#e2711d';
      c.beginPath();
      c.moveTo(wx, wy - 34); c.lineTo(wx + 26, wy - 30 + flap); c.lineTo(wx + 26, wy - 26 + flap); c.lineTo(wx, wy - 24);
      c.closePath(); c.fill();
    },

    planeTransform(state) {
      const push = state.tasks.pushback;
      const dep = state.tasks.depart;
      const G = window.Game;
      let x = 0, y = 0, rot = 0, alpha = 1;
      const ease = (t) => t * t * (3 - 2 * t);
      if (push.status === 'active' || push.status === 'done') {
        const p = push.status === 'done' ? 1 : ease(clamp(push.progress / G.effDur(push), 0, 1));
        y = p * 85; rot = p * rad(16);
      }
      if (dep.status === 'active' || dep.status === 'done') {
        const p = dep.status === 'done' ? 1 : ease(clamp(dep.progress / G.effDur(dep), 0, 1));
        x = p * 470; y = 85 + p * 210; rot = rad(16) + p * rad(30);
        alpha = p > 0.75 ? clamp(1 - (p - 0.75) / 0.22, 0, 1) : 1;
      }
      return { x, y, rot, alpha };
    },

    drawPlane(state) {
      const c = this.ctx;
      const tr = this.planeTransform(state);
      if (tr.alpha <= 0) return;
      c.save();
      c.globalAlpha = tr.alpha;
      c.translate(615 + tr.x, 320 + tr.y);
      c.rotate(tr.rot);
      c.translate(-615, -320);

      /* 影 */
      c.fillStyle = 'rgba(40,50,60,.13)';
      c.beginPath(); c.ellipse(620, 336, 360, 56, 0, 0, TAU); c.fill();

      const ACC = '#1793b8', ACC_D = '#0e6f8c';
      /* 主翼（上側） */
      c.fillStyle = '#e7ebef'; c.strokeStyle = '#9aa6b1'; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(520, 300); c.lineTo(742, 182); c.lineTo(788, 182); c.lineTo(668, 300);
      c.closePath(); c.fill(); c.stroke();
      c.fillStyle = ACC; c.fillRect(742, 178, 46, 7);
      /* 主翼（下側） */
      c.beginPath();
      c.fillStyle = '#dfe4e9';
      c.moveTo(520, 340); c.lineTo(742, 458); c.lineTo(788, 458); c.lineTo(668, 340);
      c.closePath(); c.fill(); c.stroke();
      c.fillStyle = ACC; c.fillRect(742, 455, 46, 7);
      /* 水平尾翼 */
      c.fillStyle = '#e7ebef';
      c.beginPath(); c.moveTo(898, 305); c.lineTo(962, 258); c.lineTo(988, 258); c.lineTo(944, 305); c.closePath(); c.fill(); c.stroke();
      c.beginPath(); c.moveTo(898, 335); c.lineTo(962, 382); c.lineTo(988, 382); c.lineTo(944, 335); c.closePath(); c.fill(); c.stroke();
      /* エンジン */
      const eng = (y) => {
        c.fillStyle = '#c7ced5';
        this.rr(536, y, 58, 26, 12); c.fill();
        c.strokeStyle = '#8d99a5'; this.rr(536, y, 58, 26, 12); c.stroke();
        c.fillStyle = '#3d4854';
        c.beginPath(); c.ellipse(538, y + 13, 5, 11, 0, 0, TAU); c.fill();
        c.fillStyle = ACC; c.fillRect(560, y, 10, 4);
      };
      eng(244); eng(370);
      /* 胴体 */
      c.fillStyle = '#f6f8fa'; c.strokeStyle = '#8d99a5'; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(340, 292);
      c.lineTo(856, 292);
      c.quadraticCurveTo(946, 297, 990, 317);
      c.lineTo(990, 323);
      c.quadraticCurveTo(946, 343, 856, 348);
      c.lineTo(340, 348);
      c.quadraticCurveTo(283, 344, 271, 320);
      c.quadraticCurveTo(283, 296, 340, 292);
      c.closePath(); c.fill(); c.stroke();
      c.fillStyle = 'rgba(255,255,255,.65)';
      c.beginPath();
      c.moveTo(340, 310); c.lineTo(900, 310); c.lineTo(900, 316); c.lineTo(340, 316);
      c.closePath(); c.fill();
      /* コックピット窓 */
      c.fillStyle = '#33414f';
      c.beginPath();
      c.moveTo(292, 308); c.quadraticCurveTo(310, 300, 330, 300);
      c.lineTo(330, 306); c.quadraticCurveTo(310, 306, 296, 312);
      c.closePath(); c.fill();
      c.beginPath();
      c.moveTo(292, 332); c.quadraticCurveTo(310, 340, 330, 340);
      c.lineTo(330, 334); c.quadraticCurveTo(310, 334, 296, 328);
      c.closePath(); c.fill();
      /* 垂直尾翼（上から見た形） */
      c.fillStyle = ACC;
      c.beginPath();
      c.moveTo(890, 317); c.lineTo(980, 312); c.lineTo(996, 320); c.lineTo(980, 328); c.lineTo(890, 323);
      c.closePath(); c.fill();
      c.strokeStyle = ACC_D; c.lineWidth = 1.5; c.stroke();
      c.strokeStyle = '#fff'; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(950, 320); c.quadraticCurveTo(960, 314, 972, 318); c.stroke();

      /* ドア・ハッチ */
      const t = state.tasks;
      const doorOpen = this.bridge > 0.9;
      c.fillStyle = doorOpen ? '#33414f' : '#c3ccd4';
      this.rr(394, 290, 20, 7, 2); c.fill();
      const fwdOpen = t.unload.status === 'active';
      const aftOpen = t.load.status === 'active';
      c.fillStyle = fwdOpen ? '#33414f' : '#c3ccd4';
      this.rr(486, 342, 30, 7, 2); c.fill();
      c.fillStyle = aftOpen ? '#33414f' : '#c3ccd4';
      this.rr(738, 342, 30, 7, 2); c.fill();
      const catOpen = t.catering.status === 'active';
      c.fillStyle = catOpen ? '#33414f' : '#c3ccd4';
      this.rr(846, 342, 18, 7, 2); c.fill();

      /* 機体名 */
      c.fillStyle = ACC_D;
      c.font = 'bold 13px "Segoe UI", Meiryo, sans-serif';
      c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText('AOZORA', 356, 302);

      c.restore();
    },

    updateBridge(state, dtReal) {
      const closed = state.tasks.doorclose.status === 'done';
      const target = closed ? 0 : 1;
      if (this.bridge !== target) {
        const dir = target > this.bridge ? 1 : -1;
        this.bridge = clamp(this.bridge + dir * dtReal * 0.55, 0, 1);
      }
    },

    drawBridge(state) {
      const c = this.ctx;
      const k = this.bridge;
      const rot = [347, 205];
      const end = [352 + (402 - 352) * k, 216 + (284 - 216) * k];
      c.strokeStyle = '#8fa3b5'; c.lineWidth = 26; c.lineCap = 'round';
      c.beginPath(); c.moveTo(347, 146); c.lineTo(rot[0], rot[1]); c.stroke();
      c.strokeStyle = '#b9c9d8'; c.lineWidth = 18;
      c.beginPath(); c.moveTo(347, 146); c.lineTo(rot[0], rot[1]); c.stroke();
      c.strokeStyle = '#8fa3b5'; c.lineWidth = 24;
      c.beginPath(); c.moveTo(rot[0], rot[1]); c.lineTo(end[0], end[1]); c.stroke();
      c.strokeStyle = '#cddae5'; c.lineWidth = 16;
      c.beginPath(); c.moveTo(rot[0], rot[1]); c.lineTo(end[0], end[1]); c.stroke();
      c.fillStyle = '#7d92a6';
      c.beginPath(); c.arc(rot[0], rot[1], 13, 0, TAU); c.fill();
      c.fillStyle = '#a5b8c9';
      c.beginPath(); c.arc(rot[0], rot[1], 8, 0, TAU); c.fill();
      c.strokeStyle = '#6d8093'; c.lineWidth = 4; c.lineCap = 'butt';
      c.beginPath(); c.moveTo(end[0] - 6, end[1] + 10); c.lineTo(end[0] - 6, end[1] + 24); c.stroke();
      c.fillStyle = '#4b5866';
      c.beginPath(); c.arc(end[0] - 6, end[1] + 26, 4, 0, TAU); c.fill();
    },

    drawEffectsUnder(state, gt) {
      const c = this.ctx;
      const t = state.tasks;
      if (t.refuel.status === 'active') {
        c.strokeStyle = '#414b58'; c.lineWidth = 3.5;
        c.beginPath();
        c.moveTo(628, 466);
        c.quadraticCurveTo(648, 436, 664, 424);
        c.stroke();
        c.fillStyle = '#e2711d';
        [[600, 452], [692, 452]].forEach(([x, y]) => {
          c.beginPath(); c.moveTo(x, y); c.lineTo(x - 5, y + 9); c.lineTo(x + 5, y + 9); c.closePath(); c.fill();
        });
      }
      if (t.clean.status === 'active') {
        c.save();
        c.font = '14px sans-serif'; c.textAlign = 'center';
        for (let i = 0; i < 3; i++) {
          const a = 0.35 + 0.6 * Math.abs(Math.sin(gt * 3 + i * 1.3));
          c.globalAlpha = a;
          c.fillStyle = '#7fd1e8';
          c.fillText('✦', 470 + i * 150 + (i % 2) * 40, 308 + (i % 2) * 18);
        }
        c.restore();
      }
    },

    /* 作業スポットのバッジ（未開始=点線サークル、選択中は受け入れ可能スポットが光る） */
    drawSpots(state, ui) {
      const c = this.ctx;
      const G = window.Game;
      const selected = ui ? ui.selected : null;
      state.taskList.forEach((t) => {
        if (t.status !== 'ready' && t.status !== 'gathering') return;
        const a = this.anchorOf(t.id);
        if (!a) return;
        const acceptable = selected && G.canAccept(t.id, selected);
        const pulse = 0.5 + 0.5 * Math.sin(this.time * (acceptable ? 9 : 3.5));
        const r = 22 + pulse * 3;
        c.save();
        if (acceptable) {
          c.strokeStyle = `rgba(46, 158, 91, ${0.65 + pulse * 0.3})`;
          c.fillStyle = 'rgba(46, 158, 91, 0.16)';
          c.lineWidth = 3.5;
        } else if (selected) {
          c.strokeStyle = 'rgba(120, 130, 140, 0.4)';
          c.fillStyle = 'rgba(120, 130, 140, 0.08)';
          c.lineWidth = 2;
        } else {
          c.strokeStyle = t.status === 'gathering' ? 'rgba(226, 164, 0, 0.8)' : 'rgba(15, 143, 176, 0.7)';
          c.fillStyle = 'rgba(255, 255, 255, 0.25)';
          c.lineWidth = 2.5;
        }
        c.setLineDash([7, 5]);
        c.beginPath(); c.arc(a[0], a[1], r, 0, TAU);
        c.fill(); c.stroke();
        c.setLineDash([]);
        c.font = '15px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.globalAlpha = 0.95;
        c.fillStyle = '#fff';
        c.beginPath(); c.arc(a[0], a[1], 11, 0, TAU); c.fill();
        c.fillStyle = '#1e3a5f';
        c.fillText(t.def.icon, a[0], a[1] + 0.5);
        /* あと何人・何台 */
        if (t.status === 'gathering') {
          const missing = G.missingSummary(t.id);
          if (missing) {
            c.font = 'bold 10px "Segoe UI", Meiryo, sans-serif';
            const w = c.measureText('あと ' + missing).width + 10;
            c.fillStyle = 'rgba(255, 253, 244, 0.95)';
            this.rr(a[0] - w / 2, a[1] + 26, w, 15, 7); c.fill();
            c.strokeStyle = '#e2a400'; c.lineWidth = 1; this.rr(a[0] - w / 2, a[1] + 26, w, 15, 7); c.stroke();
            c.fillStyle = '#7a5b12';
            c.fillText('あと ' + missing, a[0], a[1] + 34);
          }
        }
        c.restore();
      });
    },

    vehicleBody(type, active, gt, reverse) {
      const c = this.ctx;
      switch (type) {
        case 'beltloader': {
          c.fillStyle = '#67727f'; this.rr(-48, -13, 62, 26, 4); c.fill();
          c.strokeStyle = '#49525c'; c.lineWidth = 1.5; this.rr(-48, -13, 62, 26, 4); c.stroke();
          c.fillStyle = '#4d5866'; this.rr(-48, -13, 18, 26, 4); c.fill();
          c.fillStyle = '#9fb4c4'; this.rr(-45, -9, 10, 18, 2); c.fill();
          c.save();
          c.translate(6, 0);
          if (active) c.rotate(rad(-14));
          c.fillStyle = '#cfd6dd'; this.rr(0, -6, 88, 12, 3); c.fill();
          c.strokeStyle = '#8d99a5'; this.rr(0, -6, 88, 12, 3); c.stroke();
          c.strokeStyle = '#aab6c0';
          c.beginPath(); c.moveTo(4, 0); c.lineTo(84, 0); c.stroke();
          if (active) {
            const cols = ['#c96f5c', '#5c88c9', '#c9b25c'];
            for (let i = 0; i < 3; i++) {
              let p = (gt * 0.7 + i / 3) % 1;
              if (reverse) p = 1 - p;
              c.fillStyle = cols[i];
              this.rr(6 + p * 72, -4, 9, 8, 2); c.fill();
            }
          }
          c.restore();
          break;
        }
        case 'cart': {
          c.fillStyle = '#7c6a4f'; this.rr(-45, -10, 22, 20, 3); c.fill();
          c.strokeStyle = '#5d4f3a'; c.lineWidth = 1.5; this.rr(-45, -10, 22, 20, 3); c.stroke();
          c.fillStyle = '#9fb4c4'; this.rr(-42, -6, 8, 12, 2); c.fill();
          c.strokeStyle = '#5d4f3a';
          c.beginPath(); c.moveTo(-23, 0); c.lineTo(-16, 0); c.stroke();
          const trailer = (x) => {
            c.fillStyle = '#94826a'; this.rr(x, -9, 27, 18, 3); c.fill();
            c.strokeStyle = '#6e5f4c'; this.rr(x, -9, 27, 18, 3); c.stroke();
            const cols = ['#c96f5c', '#5c88c9', '#6fae7c'];
            cols.forEach((col, i) => {
              c.fillStyle = col;
              c.fillRect(x + 3 + i * 8, -5, 6, 10);
            });
          };
          trailer(-16); trailer(15);
          break;
        }
        case 'fuel': {
          c.fillStyle = '#a8323f'; this.rr(-48, -11, 20, 22, 3); c.fill();
          c.strokeStyle = '#7c202b'; c.lineWidth = 1.5; this.rr(-48, -11, 20, 22, 3); c.stroke();
          c.fillStyle = '#9fb4c4'; this.rr(-45, -7, 8, 14, 2); c.fill();
          c.fillStyle = '#d7dce2'; this.rr(-26, -13, 74, 26, 13); c.fill();
          c.strokeStyle = '#9aa4ad'; this.rr(-26, -13, 74, 26, 13); c.stroke();
          c.fillStyle = '#b8434e'; c.fillRect(-22, -2, 66, 4);
          c.fillStyle = '#55606a';
          c.font = 'bold 9px "Segoe UI", Meiryo, sans-serif';
          c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText('燃料', 11, -7);
          break;
        }
        case 'catering': {
          c.fillStyle = '#3a7e96'; this.rr(-42, -11, 18, 22, 3); c.fill();
          c.strokeStyle = '#2a5d70'; c.lineWidth = 1.5; this.rr(-42, -11, 18, 22, 3); c.stroke();
          c.fillStyle = '#9fd4e4'; this.rr(-39, -7, 7, 14, 2); c.fill();
          if (active) {
            c.strokeStyle = 'rgba(42,93,112,.45)'; c.lineWidth = 2;
            this.rr(-25, -17, 68, 34, 4); c.stroke();
          }
          c.fillStyle = '#f4f7f9'; this.rr(-22, -14, 62, 28, 3); c.fill();
          c.strokeStyle = '#9aa4ad'; this.rr(-22, -14, 62, 28, 3); c.stroke();
          c.fillStyle = '#3f9bb8'; c.fillRect(-22, -14, 62, 6);
          break;
        }
        case 'pushback': {
          c.fillStyle = '#414b58'; this.rr(-26, -15, 52, 30, 7); c.fill();
          c.strokeStyle = '#2d343d'; c.lineWidth = 1.5; this.rr(-26, -15, 52, 30, 7); c.stroke();
          c.fillStyle = '#e8c84a';
          c.beginPath(); c.moveTo(-14, -15); c.lineTo(-4, -15); c.lineTo(-14, 15); c.lineTo(-24, 15); c.closePath(); c.fill();
          c.beginPath(); c.moveTo(6, -15); c.lineTo(16, -15); c.lineTo(6, 15); c.lineTo(-4, 15); c.closePath(); c.fill();
          c.fillStyle = '#2d343d'; this.rr(24, -5, 8, 10, 2); c.fill();
          break;
        }
      }
    },

    drawEntities(state, gt, ui) {
      const c = this.ctx;
      const push = state.tasks.pushback;
      const tr = this.planeTransform(state);
      const selected = ui ? ui.selected : null;

      /* 車両 */
      state.entities.filter((e) => e.kind === 'vehicle').forEach((e) => {
        const rec = this.resolveEntity(state, e);
        let x = rec.pos.x, y = rec.pos.y, ang = rec.angle;
        if (e.type === 'pushback' && e.status === 'working' && (push.status === 'active' || push.status === 'done')) {
          const nose = this.transformPoint(233, 321, tr);
          x = nose.x; y = nose.y; ang = tr.rot;
        }
        const active = e.status === 'working' && e.taskId && state.tasks[e.taskId] && state.tasks[e.taskId].status === 'active';
        const reverse = e.taskId === 'unload';
        c.save();
        c.translate(x, y);
        if (e.id === selected) {
          c.strokeStyle = '#fff'; c.lineWidth = 3.5;
          c.beginPath(); c.arc(0, 0, 56, 0, TAU); c.stroke();
          c.strokeStyle = '#0f8fb0'; c.lineWidth = 2;
          c.beginPath(); c.arc(0, 0, 60 + Math.sin(this.time * 6) * 3, 0, TAU); c.stroke();
        }
        c.save();
        c.rotate(ang);
        c.fillStyle = 'rgba(40,50,60,.16)';
        c.beginPath(); c.ellipse(2, 5, 50, 16, 0, 0, TAU); c.fill();
        c.restore();
        c.rotate(ang);
        this.vehicleBody(e.type, active, gt, reverse);
        c.restore();
      });

      /* スタッフ */
      state.entities.filter((e) => e.kind === 'staff').forEach((e) => {
        const rec = this.resolveEntity(state, e);
        let { x, y } = rec.pos;
        if (e.status === 'working' && e.taskId === 'inspect') {
          const t = state.tasks.inspect;
          const total = INSPECT_LOOP.length;
          const p = (t.progress / window.Game.effDur(t)) * 1.6 % 1;
          const fi = p * total;
          const i0 = Math.floor(fi) % total, i1 = (i0 + 1) % total;
          const k = fi - Math.floor(fi);
          x = INSPECT_LOOP[i0][0] + (INSPECT_LOOP[i1][0] - INSPECT_LOOP[i0][0]) * k;
          y = INSPECT_LOOP[i0][1] + (INSPECT_LOOP[i1][1] - INSPECT_LOOP[i0][1]) * k;
        }
        const meta = window.RES_META.staff[e.type];
        const moving = e.status === 'moving' || e.status === 'returning' ||
          (e.status === 'working' && e.taskId === 'inspect');
        const bob = moving ? Math.sin(gt * 40 + x) * 1.3 : 0;
        if (e.id === selected) {
          c.strokeStyle = '#fff'; c.lineWidth = 3;
          c.beginPath(); c.arc(x, y, 13, 0, TAU); c.stroke();
          c.strokeStyle = '#0f8fb0'; c.lineWidth = 2;
          c.beginPath(); c.arc(x, y, 16 + Math.sin(this.time * 6) * 2, 0, TAU); c.stroke();
        }
        c.fillStyle = 'rgba(40,50,60,.2)';
        c.beginPath(); c.ellipse(x, y + 4, 6, 2.6, 0, 0, TAU); c.fill();
        c.fillStyle = meta.color;
        c.strokeStyle = 'rgba(30,40,50,.4)'; c.lineWidth = 1.2;
        c.beginPath(); c.ellipse(x, y + bob * 0.3, 6.2, 4.8, 0, 0, TAU); c.fill(); c.stroke();
        c.fillStyle = '#f2c99f';
        c.beginPath(); c.arc(x, y - 1 + bob * 0.3, 3, 0, TAU); c.fill();
        c.fillStyle = 'rgba(255,255,255,.85)';
        c.beginPath(); c.arc(x, y - 1 + bob * 0.3, 1.3, 0, TAU); c.fill();
      });

      /* 選択中エンティティのラベル */
      if (selected) {
        const e = state.entities.find((x) => x.id === selected);
        const rec = e && this.ent[e.id];
        if (e && rec) {
          const meta = e.kind === 'staff' ? window.RES_META.staff[e.type] : window.RES_META.vehicles[e.type];
          const label = `${meta.icon}${e.label} — 行き先をタップ`;
          c.font = 'bold 11px "Segoe UI", Meiryo, sans-serif';
          const w = c.measureText(label).width + 14;
          const lx = rec.pos.x, ly = rec.pos.y - (e.kind === 'staff' ? 26 : 42);
          c.fillStyle = 'rgba(30,58,95,0.92)';
          this.rr(lx - w / 2, ly - 10, w, 20, 10); c.fill();
          c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(label, lx, ly + 0.5);
        }
      }
    },

    transformPoint(px, py, tr) {
      const cx = 615, cy = 320;
      const dx = px - cx, dy = py - cy;
      const cos = Math.cos(tr.rot), sin = Math.sin(tr.rot);
      return { x: cx + tr.x + dx * cos - dy * sin, y: cy + tr.y + dx * sin + dy * cos };
    },

    drawPax(state, gt) {
      const c = this.ctx;
      const deb = state.tasks.deboard, brd = state.tasks.board;
      const active = deb.status === 'active' ? 'out' : (brd.status === 'active' ? 'in' : null);
      if (active && this.bridge > 0.9 && gt - this.lastPaxSpawn > 0.22) {
        this.lastPaxSpawn = gt;
        if (this.paxDots.length < 14) {
          this.paxDots.push({
            dir: active, p: 0,
            color: PAX_COLORS[Math.floor(Math.abs(Math.sin(gt * 999)) * PAX_COLORS.length) % PAX_COLORS.length],
            speed: 1 / 0.55,
          });
        }
      }
      this.paxDots.forEach((d) => { d.p += (gt - (d.lastGt != null ? d.lastGt : gt)) * d.speed; d.lastGt = gt; });
      this.paxDots = this.paxDots.filter((d) => d.p < 1);
      this.paxDots.forEach((d) => {
        const t01 = d.dir === 'out' ? d.p : 1 - d.p;
        const pts = BRIDGE_PATH;
        const seg = t01 < 0.5 ? 0 : 1;
        const k = (t01 - seg * 0.5) / 0.5;
        const x = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * k;
        const y = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * k;
        c.fillStyle = d.color;
        c.beginPath(); c.arc(x, y, 3.4, 0, TAU); c.fill();
      });
    },

    /* 降機・搭乗の人数カウンター */
    drawPaxCounter(state) {
      const c = this.ctx;
      const G = window.Game;
      const deb = state.tasks.deboard, brd = state.tasks.board;
      let text = null;
      if (deb.status === 'active') {
        const n = PAX_TOTAL - Math.floor(clamp(deb.progress / G.effDur(deb), 0, 1) * PAX_TOTAL);
        text = `🚶 降機中 のこり${n}人`;
      } else if (brd.status === 'active') {
        const n = Math.floor(clamp(brd.progress / G.effDur(brd), 0, 1) * PAX_TOTAL);
        text = `🧑‍🤝‍🧑 搭乗中 ${n}/${PAX_TOTAL}人`;
      }
      if (!text) return;
      c.font = 'bold 12px "Segoe UI", Meiryo, sans-serif';
      const w = c.measureText(text).width + 16;
      c.fillStyle = 'rgba(255,255,255,0.92)';
      this.rr(402 - w / 2, 158, w, 22, 11); c.fill();
      c.strokeStyle = '#b9c9d8'; c.lineWidth = 1.5; this.rr(402 - w / 2, 158, w, 22, 11); c.stroke();
      c.fillStyle = '#27496d'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(text, 402, 169.5);
    },

    drawRings(state) {
      const c = this.ctx;
      const G = window.Game;
      state.taskList.forEach((t) => {
        if (t.status !== 'active' || t.id === 'depart') return;
        let anchor = this.anchorOf(t.id);
        if (!anchor) return;
        let [x, y] = anchor;
        if (t.id === 'pushback') {
          const p = this.transformPoint(233, 300, this.planeTransform(state));
          x = p.x; y = p.y;
        }
        y -= 26;
        const pct = clamp(t.progress / G.effDur(t), 0, 1);
        c.fillStyle = 'rgba(255,255,255,.92)';
        c.beginPath(); c.arc(x, y, 12, 0, TAU); c.fill();
        c.strokeStyle = '#d5dbe1'; c.lineWidth = 2;
        c.beginPath(); c.arc(x, y, 12, 0, TAU); c.stroke();
        c.strokeStyle = '#1793b8'; c.lineWidth = 3;
        c.beginPath(); c.arc(x, y, 12, -Math.PI / 2, -Math.PI / 2 + pct * TAU); c.stroke();
        c.font = '11px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(t.def.icon, x, y + 0.5);
      });
    },

    /* 天候イベント中の雨（屋外作業停止の間だけ降る） */
    drawRain(state) {
      if (!(state.outdoorPauseUntil != null && state.clock < state.outdoorPauseUntil)) return;
      const c = this.ctx;
      c.fillStyle = 'rgba(45, 62, 88, 0.13)';
      c.fillRect(0, 0, SCENE_W, SCENE_H);
      c.strokeStyle = 'rgba(210, 228, 246, 0.75)';
      c.lineWidth = 2.2;
      c.lineCap = 'round';
      c.beginPath();
      for (let i = 0; i < 80; i++) {
        const x = ((i * 149 + this.time * 340) % (SCENE_W + 120)) - 60;
        const y = (i * 97 + this.time * 700) % SCENE_H;
        c.moveTo(x, y);
        c.lineTo(x - 7, y + 20);
      }
      c.stroke();
      c.lineCap = 'butt';
    },
  };

  /* ============================================================
   * UI（DOM）
   * ============================================================ */
  const UI = {
    cb: {},
    els: {},
    state: null,
    lastClockText: '',
    lastRemainText: '',
    cardEls: {},
    chipEls: {},
    domThrottle: 0,
    hintThrottle: 0,
    sfx: Sfx,
    scene: Scene,
    selected: null,       // タップ選択中のエンティティid
    spotPopTask: null,    // ポップオーバー表示中の作業id
    issueTask: null,

    init(cb) {
      this.cb = cb;
      const ids = ['screen-title', 'screen-select', 'screen-game', 'screen-result',
        'hud-stage-name', 'hud-weather', 'hud-clock', 'hud-std', 'hud-remain',
        'btn-settings', 'hint-banner', 'task-list', 'apron', 'event-banner',
        'toast-area', 'start-overlay', 'start-overlay-title', 'start-overlay-text', 'btn-begin',
        'val-safety', 'val-punct', 'val-sat', 'val-cost',
        'bar-safety', 'bar-punct', 'bar-sat', 'bar-cost',
        'unfinished-count', 'game-log', 'staff-strip', 'vehicle-strip',
        'stage-list', 'modal-backdrop', 'modal', 'panel-tasks', 'panel-status',
        'btn-drawer-tasks', 'btn-log-toggle', 'spot-pop', 'apron-wrap',
        'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-reset',
        'result-flag', 'result-rank', 'result-score', 'result-breakdown', 'result-times', 'result-advice'];
      ids.forEach((id) => { this.els[id] = document.getElementById(id); });

      Scene.init(this.els['apron']);

      document.querySelectorAll('.speed-btn').forEach((b) => {
        b.addEventListener('click', () => { Sfx.play('click'); cb.onSpeed(Number(b.dataset.speed)); });
      });
      this.els['btn-settings'].addEventListener('click', () => { Sfx.play('click'); cb.onSettings(); });
      this.els['btn-begin'].addEventListener('click', () => { Sfx.play('select'); cb.onBegin(); });
      this.els['event-banner'].addEventListener('click', () => { Sfx.play('click'); this.openEventModal(); });

      $('#btn-title-start').addEventListener('click', () => { Sfx.play('select'); cb.onGotoSelect(); });
      $('#btn-title-howto').addEventListener('click', () => { Sfx.play('click'); this.openTutorial(null); });
      $('#btn-title-settings').addEventListener('click', () => { Sfx.play('click'); cb.onSettings(); });
      $('#btn-select-back').addEventListener('click', () => { Sfx.play('click'); cb.onGotoTitle(); });
      $('#btn-retry').addEventListener('click', () => { Sfx.play('select'); cb.onRetry(); });
      $('#btn-result-select').addEventListener('click', () => { Sfx.play('click'); cb.onGotoSelect(); });
      $('#btn-next-stage').addEventListener('click', (ev) => {
        const id = Number(ev.currentTarget.dataset.stage);
        if (id) { Sfx.play('select'); cb.onNextStage(id); }
      });

      /* ドロワー・ログ開閉 */
      this.els['btn-drawer-tasks'].addEventListener('click', () => {
        Sfx.play('click');
        this.els['panel-tasks'].classList.toggle('closed');
      });
      this.els['btn-log-toggle'].addEventListener('click', () => {
        const open = this.els['panel-status'].classList.toggle('log-open');
        this.els['btn-log-toggle'].textContent = open ? '📜 記録をとじる ▴' : '📜 記録を見る ▾';
      });

      /* ズーム */
      this.els['btn-zoom-in'].addEventListener('click', () => { Sfx.play('click'); Scene.zoomAt(1.3); });
      this.els['btn-zoom-out'].addEventListener('click', () => { Sfx.play('click'); Scene.zoomAt(1 / 1.3); });
      this.els['btn-zoom-reset'].addEventListener('click', () => { Sfx.play('click'); Scene.resetCam(); });

      this.bindCanvasInput();

      this.els['modal-backdrop'].addEventListener('click', (ev) => {
        if (ev.target === this.els['modal-backdrop'] && this.modalDismissible) this.closeModal();
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && this.modalDismissible) this.closeModal();
      });
      document.addEventListener('pointerdown', () => Sfx.ensure(), { once: true });
    },

    /* ---------------- キャンバス入力（タップ/ドラッグ/ズーム） ---------------- */
    bindCanvasInput() {
      const cv = this.els['apron'];
      const pointers = new Map();
      let dragMoved = false;
      let pinchDist = null;

      const pos = (ev) => {
        const r = cv.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
      };

      cv.addEventListener('pointerdown', (ev) => {
        try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* すでに離れたポインタ等は無視 */ }
        pointers.set(ev.pointerId, pos(ev));
        dragMoved = false;
        pinchDist = null;
      });
      cv.addEventListener('pointermove', (ev) => {
        if (!pointers.has(ev.pointerId)) return;
        const p = pos(ev);
        if (pointers.size === 2) {
          /* ピンチズーム */
          pointers.set(ev.pointerId, p);
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinchDist != null && d > 0) {
            Scene.zoomAt(d / pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
          }
          pinchDist = d;
          dragMoved = true;
          return;
        }
        const prev = pointers.get(ev.pointerId);
        const dx = p.x - prev.x, dy = p.y - prev.y;
        if (dragMoved || Math.hypot(dx, dy) > 6) {
          dragMoved = true;
          Scene.panBy(dx, dy);
          pointers.set(ev.pointerId, p);
          cv.classList.add('dragging');
          this.closeSpotPop();
        }
      });
      const up = (ev) => {
        const wasTap = pointers.has(ev.pointerId) && !dragMoved && pointers.size === 1;
        const p = pointers.get(ev.pointerId);
        pointers.delete(ev.pointerId);
        cv.classList.remove('dragging');
        if (wasTap && p) this.handleTap(p.x, p.y);
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', (ev) => { pointers.delete(ev.pointerId); cv.classList.remove('dragging'); });
      cv.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const p = pos(ev);
        Scene.zoomAt(ev.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
      }, { passive: false });
    },

    handleTap(sx, sy) {
      const s = this.state;
      if (!s || s.ended) return;
      const sceneP = Scene.screenToScene(sx, sy);
      const hit = Scene.hitTest(s, sceneP);

      if (hit && hit.type === 'entity') {
        const e = s.entities.find((x) => x.id === hit.id);
        this.closeSpotPop();
        if (e.taskId === null && (e.status === 'idle' || e.status === 'returning')) {
          this.selected = (this.selected === e.id) ? null : e.id;
          Sfx.play('click');
        } else {
          const task = e.taskId ? s.tasks[e.taskId] : null;
          this.toast(`${e.label}は${task ? `「${task.def.name}」の担当中` : 'いま手が離せません'}`, 'info');
        }
        return;
      }
      if (hit && hit.type === 'spot') {
        const t = s.tasks[hit.id];
        if (this.selected && window.Game.canAccept(t.id, this.selected)) {
          this.cb.onAssignEntity(this.selected, t.id);
          this.selected = null;
          return;
        }
        this.openSpotPop(t.id);
        return;
      }
      this.selected = null;
      this.closeSpotPop();
    },

    /* ---------------- 作業スポットのポップオーバー ---------------- */
    openSpotPop(taskId) {
      const s = this.state;
      const t = s.tasks[taskId];
      if (!t) return;
      this.spotPopTask = taskId;
      const pop = this.els['spot-pop'];
      const G = window.Game;

      let info = '';
      const btns = [];
      if (t.status === 'ready' || t.status === 'gathering') {
        const missing = G.missingSummary(t.id);
        info = missing
          ? `あと <strong>${missing}</strong> が必要です。<br>待機所のスタッフ・車両をタップで送るか、おまかせで開始。`
          : 'メンバー集合中です。到着を待ちましょう。';
        if (missing) btns.push({ label: '▶ おまかせで開始', cls: 'btn-primary btn-sm', act: () => this.cb.onStartTask(t.id) });
        if (t.status === 'gathering') btns.push({ label: '中断', cls: 'btn-warnghost btn-sm', act: () => this.cb.onCancelTask(t.id) });
      } else if (t.status === 'active') {
        info = `のこり約${Math.max(1, Math.ceil(G.effDur(t) - t.progress))}分`;
        if (t.id !== 'pushback' && t.id !== 'depart') {
          btns.push({ label: '中断', cls: 'btn-warnghost btn-sm', act: () => this.cb.onCancelTask(t.id) });
        }
      }
      btns.push({ label: 'くわしく', cls: 'btn-ghost btn-sm', act: () => this.openTaskDetail(t.id) });

      const paceHtml = window.PACE_ALLOWED.has(t.id) && t.status !== 'done'
        ? `<div class="pace-ctrl">${['careful', 'normal', 'rush'].map((p) =>
            `<button class="pace-btn pace-${p} ${t.pace === p ? 'on' : ''}" data-pace="${p}">${window.PACE[p].icon}${window.PACE[p].label}</button>`).join('')}</div>`
        : '';

      pop.innerHTML = `
        <div class="sp-title">${t.def.icon} ${t.def.name}</div>
        <div class="sp-info">${info}</div>
        ${paceHtml}
        <div class="sp-btns" style="margin-top:6px;"></div>`;
      const btnWrap = pop.querySelector('.sp-btns');
      btns.forEach((b) => {
        const el = document.createElement('button');
        el.className = 'btn ' + b.cls;
        el.textContent = b.label;
        el.addEventListener('click', () => { Sfx.play('click'); this.closeSpotPop(); b.act(); });
        btnWrap.appendChild(el);
      });
      pop.querySelectorAll('.pace-btn').forEach((el) => {
        el.addEventListener('click', () => {
          Sfx.play('click');
          this.cb.onSetPace(t.id, el.dataset.pace);
          this.openSpotPop(taskId); // 表示更新
        });
      });

      /* スポットの近くに配置（画面外にはみ出さないように） */
      const a = Scene.anchorOf(t.id) || [615, 320];
      const sp = Scene.sceneToScreen(a[0], a[1]);
      pop.classList.remove('hidden');
      const wrap = this.els['apron-wrap'];
      const px = clamp(sp.x + 20, 8, wrap.clientWidth - 240);
      const py = clamp(sp.y - 40, 8, wrap.clientHeight - pop.offsetHeight - 8);
      pop.style.left = px + 'px';
      pop.style.top = py + 'px';
    },
    closeSpotPop() {
      this.spotPopTask = null;
      this.els['spot-pop'].classList.add('hidden');
    },

    showScreen(name) {
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      $('#screen-' + name).classList.add('active');
    },

    /* ---------------- ステージ選択 ---------------- */
    renderStageSelect(save, isUnlocked) {
      const wrap = this.els['stage-list'];
      wrap.innerHTML = '';
      window.STAGES.forEach((st) => {
        const best = save.best && save.best[st.id];
        const unlocked = isUnlocked(st.id);
        const card = document.createElement('button');
        card.className = 'stage-card' + (unlocked ? '' : ' locked');
        card.innerHTML = `
          <div class="sc-row1">
            <span class="sc-name">${st.name}</span>
            <span class="sc-diff">${st.difficulty}</span>
          </div>
          <div class="sc-sub">${st.subtitle}</div>
          <div class="sc-row2">
            <span>${st.weather.icon} ${st.weather.label}</span>
            ${!unlocked
              ? `<span class="sc-soon">🔒 ステージ${st.id - 1}をクリアすると遊べます</span>`
              : (best ? `<span class="sc-best">★ ベスト ${best.score}点（${best.rank}）</span>` : '<span class="sc-best sc-best-none">未クリア</span>')}
          </div>`;
        if (unlocked) {
          card.addEventListener('click', () => { Sfx.play('select'); this.cb.onSelectStage(st.id); });
        } else {
          card.addEventListener('click', () => this.toast(`まずはステージ${st.id - 1}をクリアしよう！`, 'info'));
        }
        wrap.appendChild(card);
      });
    },

    /* ---------------- ゲーム画面のバインド ---------------- */
    bindRun(state) {
      this.state = state;
      Scene.reset();
      this.cardEls = {};
      this.chipEls = {};
      this.lastClockText = '';
      this.lastRemainText = '';
      this.selected = null;
      this.issueTask = null;
      this.closeSpotPop();

      this.els['hud-stage-name'].textContent = state.stage.shortName;
      this.updateWeatherHud();
      this.els['hud-std'].textContent = window.fmtClock(state.stage.std);
      this.els['game-log'].innerHTML = '';
      this.els['event-banner'].classList.add('hidden');
      this.els['toast-area'].innerHTML = '';

      /* ドロワーの初期状態: 広い画面ではひらく */
      this.els['panel-tasks'].classList.toggle('closed', window.innerWidth < 1100);
      this.els['panel-status'].classList.remove('log-open');
      this.els['btn-log-toggle'].textContent = '📜 記録を見る ▾';

      this.els['start-overlay'].classList.remove('hidden');
      this.els['start-overlay-title'].textContent = state.stage.name;
      this.els['start-overlay-text'].textContent = state.stage.intro;

      const list = this.els['task-list'];
      list.innerHTML = '';
      state.taskList.forEach((t) => {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.id = 'card-' + t.id;
        const reqs = window.taskReqList(t.def).map((r) =>
          `<span class="req-chip" style="--c:${r.color}">${r.icon}${r.label}×${r.n}</span>`).join('');
        const paceHtml = window.PACE_ALLOWED.has(t.id)
          ? `<div class="pace-ctrl">${['careful', 'normal', 'rush'].map((p) =>
              `<button class="pace-btn pace-${p}" data-pace="${p}" title="${p === 'rush' ? '速いが満足度(安全)が下がる' : p === 'careful' ? 'ゆっくりだが満足度が上がる' : '標準の速さ'}">${window.PACE[p].icon}${window.PACE[p].label}</button>`).join('')}</div>`
          : '';
        card.innerHTML = `
          <div class="tc-head">
            <span class="tc-icon">${t.def.icon}</span>
            <span class="tc-name">${t.def.name}${t.def.ruby ? `<small class="tc-ruby">（${t.def.ruby}）</small>` : ''}</span>
            <span class="tc-state"></span>
          </div>
          <div class="tc-reqs">${reqs || '<span class="req-chip req-none">リソース不要</span>'}</div>
          <div class="tc-bar"><div class="tc-fill"></div></div>
          <div class="tc-foot">
            <span class="tc-time"></span>
            <span class="tc-extra"></span>
            <span class="tc-prio ${t.def.priority === 'high' ? 'prio-high' : ''}">優先度${t.def.priority === 'high' ? '高' : '中'}</span>
          </div>
          ${paceHtml}
          <div class="tc-lockmsg"></div>
          <div class="tc-btns">
            <button class="btn btn-sm btn-primary tc-start">開始</button>
            <button class="btn btn-sm btn-ghost tc-info">くわしく</button>
            <button class="btn btn-sm btn-warnghost tc-cancel hidden">中断</button>
          </div>`;
        card.querySelector('.tc-start').addEventListener('click', () => this.cb.onStartTask(t.id));
        card.querySelector('.tc-info').addEventListener('click', () => { Sfx.play('click'); this.openTaskDetail(t.id); });
        card.querySelector('.tc-cancel').addEventListener('click', () => { Sfx.play('click'); this.cb.onCancelTask(t.id); });
        card.querySelectorAll('.pace-btn').forEach((el) => {
          el.addEventListener('click', () => { Sfx.play('click'); this.cb.onSetPace(t.id, el.dataset.pace); });
        });
        list.appendChild(card);
        this.cardEls[t.id] = card;
        this.updateCard(t.id);
      });

      const sStrip = this.els['staff-strip'];
      const vStrip = this.els['vehicle-strip'];
      sStrip.innerHTML = ''; vStrip.innerHTML = '';
      state.entities.forEach((e) => {
        const meta = e.kind === 'staff' ? window.RES_META.staff[e.type] : window.RES_META.vehicles[e.type];
        const chip = document.createElement('span');
        chip.className = 'res-chip';
        chip.style.setProperty('--c', meta.color);
        chip.innerHTML = `<span class="rc-ico">${meta.icon}</span><span class="rc-name">${e.label}</span><span class="rc-st"></span>`;
        (e.kind === 'staff' ? sStrip : vStrip).appendChild(chip);
        this.chipEls[e.id] = chip;
      });
      this.updateResources();
      this.updateMetrics();
      this.updateUnfinished();
      this.updateHint(true);
      this.updateClock(true);
    },

    hideStartOverlay() {
      this.els['start-overlay'].classList.add('hidden');
    },

    /* ---------------- カード更新 ---------------- */
    updateCard(id) {
      const s = this.state;
      if (!s) return;
      const t = s.tasks[id];
      const card = this.cardEls[id];
      if (!card) return;
      card.classList.remove('st-locked', 'st-ready', 'st-gathering', 'st-moving', 'st-active', 'st-done', 'st-paused', 'st-issue');
      card.classList.add('st-' + t.status);
      const paused = window.Game.outdoorPaused() && t.def.outdoor &&
        (t.status === 'active' || t.status === 'gathering');
      const issue = this.issueTask === id && t.status !== 'done';
      if (paused) card.classList.add('st-paused');
      if (issue) card.classList.add('st-issue');
      const stEl = card.querySelector('.tc-state');
      const stMap = {
        locked: '🔒 未開始', ready: '未開始（開始できます）', gathering: '🚶 集合中',
        active: '⚙ 作業中', done: '✅ 完了',
      };
      stEl.textContent = issue ? '⚠ 問題発生' : (paused ? '⏸ 停止中（天候）' : (stMap[t.status] || t.status));

      const G = window.Game;
      const timeEl = card.querySelector('.tc-time');
      if (t.status === 'done') {
        timeEl.textContent = `完了 ${window.fmtClock(t.doneAt)}`;
      } else if (t.status === 'active') {
        timeEl.textContent = (paused ? '⏸ ' : '') + `のこり約${Math.max(1, Math.ceil(G.effDur(t) - t.progress))}分`;
      } else if (t.status === 'gathering') {
        const missing = G.missingSummary(id);
        timeEl.textContent = paused ? '⏸ 天候の回復待ち…' : (missing ? `あと ${missing}` : 'メンバー移動中…');
      } else {
        timeEl.textContent = `必要時間 約${Math.ceil(G.effDur(t) - t.progress)}分`;
      }
      card.querySelector('.tc-extra').textContent = t.extra || '';

      const fill = card.querySelector('.tc-fill');
      fill.style.width = `${clamp((t.progress / G.effDur(t)) * 100, 0, 100)}%`;

      const lockEl = card.querySelector('.tc-lockmsg');
      if (t.status === 'locked') {
        lockEl.textContent = '🔒 ' + window.Game.lockReason(id);
        lockEl.classList.add('show');
      } else {
        lockEl.textContent = '';
        lockEl.classList.remove('show');
      }

      /* ペースの選択状態 */
      card.querySelectorAll('.pace-btn').forEach((el) => {
        el.classList.toggle('on', el.dataset.pace === t.pace);
      });

      const btnStart = card.querySelector('.tc-start');
      const btnCancel = card.querySelector('.tc-cancel');
      const gatherFilled = t.status === 'gathering' && !G.missingSummary(id);
      btnStart.classList.toggle('hidden', t.status === 'active' || t.status === 'done' || gatherFilled);
      btnStart.textContent = t.status === 'gathering' ? 'おまかせでそろえる' : '開始';
      btnStart.disabled = false;
      const cancellable = (t.status === 'active' || t.status === 'gathering') && id !== 'pushback' && id !== 'depart';
      btnCancel.classList.toggle('hidden', !cancellable);
    },

    shakeCard(id) {
      const card = this.cardEls[id];
      if (!card) return;
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    },

    openTaskDetail(id) {
      const t = this.state.tasks[id];
      const reqs = window.taskReqList(t.def).map((r) =>
        `<span class="req-chip" style="--c:${r.color}">${r.icon}${r.label}×${r.n}</span>`).join('') || 'なし';
      this.openModal({
        title: `${t.def.icon} ${t.def.name}`,
        body: `
          <p>${t.def.desc}</p>
          <p class="modal-kv"><strong>必要時間:</strong> 約${Math.ceil(t.def.dur)}分　<strong>必要リソース:</strong> ${reqs}</p>
          <p class="modal-kv"><strong>開始条件:</strong> ${t.def.depNote}</p>
          ${t.def.note ? `<p class="modal-note">🦺 <strong>安全メモ:</strong> ${t.def.note}</p>` : ''}`,
        buttons: [{ label: 'とじる', cls: 'btn-ghost' }],
        dismissible: true,
      });
    },

    /* ---------------- リソース・指標・ログ ---------------- */
    updateWeatherHud() {
      const s = this.state;
      if (!s) return;
      const w = s.weatherNow || s.stage.weather;
      this.els['hud-weather'].textContent = `${w.icon} ${w.label}`;
    },

    updateResources() {
      const s = this.state;
      if (!s) return;
      const stMap = { idle: '待機中', moving: '移動中', working: '作業中', returning: 'もどり中' };
      s.entities.forEach((e) => {
        const chip = this.chipEls[e.id];
        if (!chip) return;
        chip.classList.remove('rs-idle', 'rs-moving', 'rs-working', 'rs-returning');
        chip.classList.add('rs-' + e.status);
        const task = e.taskId ? s.tasks[e.taskId] : null;
        chip.querySelector('.rc-st').textContent = stMap[e.status] + (task ? ` ${task.def.icon}` : '');
      });
      /* 選択中のエンティティが使われたら選択解除 */
      if (this.selected) {
        const e = s.entities.find((x) => x.id === this.selected);
        if (!e || e.taskId !== null) this.selected = null;
      }
      /* ポップオーバーの内容も更新 */
      if (this.spotPopTask) {
        const t = s.tasks[this.spotPopTask];
        if (!t || t.status === 'done') this.closeSpotPop();
      }
    },

    updateMetrics() {
      const s = this.state;
      if (!s) return;
      const m = s.metrics;
      const upd = (key, val) => {
        const v = Math.round(val);
        const bar = this.els['bar-' + key];
        const num = this.els['val-' + key];
        if (num.textContent !== String(v)) num.textContent = String(v);
        bar.style.width = v + '%';
        bar.classList.toggle('low', v < 40);
      };
      upd('safety', m.safety); upd('punct', m.punct); upd('sat', m.sat); upd('cost', m.cost);
    },

    updateUnfinished() {
      const s = this.state;
      if (!s) return;
      const n = s.taskList.filter((t) => t.status !== 'done').length;
      this.els['unfinished-count'].textContent = String(n);
    },

    updateHint(force) {
      if (!this.state) return;
      const now = performance.now();
      if (!force && now - this.hintThrottle < 800) return;
      this.hintThrottle = now;
      const el = this.els['hint-banner'];
      const hint = window.Game.getHint();
      if (hint) {
        if (el.textContent !== '💡 ' + hint) el.textContent = '💡 ' + hint;
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    },

    addLog(entry) {
      const li = document.createElement('li');
      li.className = 'lg-' + entry.cls;
      li.innerHTML = `<span class="lg-t">${window.fmtClock(entry.t)}</span>${entry.msg}`;
      const ul = this.els['game-log'];
      ul.prepend(li);
      while (ul.children.length > 40) ul.removeChild(ul.lastChild);
    },

    toast(msg, type) {
      const div = document.createElement('div');
      div.className = 'toast toast-' + (type || 'info');
      div.textContent = msg;
      this.els['toast-area'].appendChild(div);
      setTimeout(() => { div.classList.add('out'); }, 3400);
      setTimeout(() => { div.remove(); }, 3900);
    },

    /* ---------------- 時計まわり ---------------- */
    updateClock(force) {
      const s = this.state;
      if (!s) return;
      const text = window.fmtClock(s.clock);
      if (force || text !== this.lastClockText) {
        this.lastClockText = text;
        this.els['hud-clock'].textContent = text;
      }
      let remainText, late = false;
      if (s.stats.blockOff != null) {
        remainText = '出発済み';
      } else {
        const rem = s.stage.std - s.clock;
        if (rem >= 0) remainText = `${Math.ceil(rem)}分`;
        else { remainText = `+${Math.ceil(-rem)}分遅れ`; late = true; }
      }
      if (force || remainText !== this.lastRemainText) {
        this.lastRemainText = remainText;
        const el = this.els['hud-remain'];
        el.textContent = remainText;
        el.classList.toggle('late', late);
        const rem = s.stage.std - s.clock;
        el.classList.toggle('soon', !late && s.stats.blockOff == null && rem <= 10);
      }
    },

    setSpeedUI(n) {
      document.querySelectorAll('.speed-btn').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.speed) === n);
      });
    },

    /* ---------------- イベントUI ---------------- */
    showEventBanner(def) {
      const b = this.els['event-banner'];
      b.innerHTML = `${def.icon} <strong>${def.title}</strong> — タップして対応を選ぶ`;
      b.classList.remove('hidden');
    },
    hideEventBanner() {
      this.els['event-banner'].classList.add('hidden');
      if (this.modalKind === 'event') this.closeModal();
    },
    openEventModal() {
      const s = this.state;
      if (!s || !s.activeEvent) return;
      const def = s.activeEvent.def;
      const choicesHtml = def.choices.map((ch, i) => `
        <button class="event-choice" data-i="${i}">
          <span class="ec-label">${ch.label}</span>
          <span class="ec-hint">${ch.hint}</span>
          <span class="ec-tags">${(ch.tags || []).map((t) => `<em>${t}</em>`).join('')}</span>
        </button>`).join('');
      this.openModal({
        kind: 'event',
        title: `${def.icon} ${def.title}`,
        body: `<p>${def.desc}</p><div class="event-choices">${choicesHtml}</div>
               <p class="modal-note">⏳ ${def.deadlineHint}</p>`,
        buttons: [{ label: 'あとで決める', cls: 'btn-ghost' }],
        dismissible: true,
      });
      this.els['modal'].querySelectorAll('.event-choice').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.closeModal();
          this.cb.onEventChoice(Number(btn.dataset.i));
        });
      });
    },

    openSafetyModal() {
      this.openModal({
        kind: 'safety',
        title: '🦺 プッシュバック前の安全確認',
        body: `<p>トーイングカーが機首に到着しました。飛行機を動かす前に、機体のまわりに<strong>人・車両・置きわすれた機材</strong>が残っていないか確認します。どうしますか？</p>`,
        buttons: [
          { label: '✅ しっかり確認する（+1分）', cls: 'btn-primary', onClick: () => this.cb.onSafetyChoice(true) },
          { label: '⚠ 確認を省略して急ぐ（大きなペナルティ）', cls: 'btn-danger', onClick: () => this.cb.onSafetyChoice(false) },
        ],
        dismissible: false,
      });
    },

    /* ---------------- モーダル共通 ---------------- */
    openModal({ kind, title, body, buttons, dismissible }) {
      this.modalKind = kind || 'generic';
      this.modalDismissible = dismissible !== false;
      const btns = (buttons || []).map((b, i) =>
        `<button class="btn ${b.cls || 'btn-ghost'}" data-mb="${i}">${b.label}</button>`).join('');
      this.els['modal'].innerHTML = `
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-btns">${btns}</div>`;
      (buttons || []).forEach((b, i) => {
        this.els['modal'].querySelector(`[data-mb="${i}"]`).addEventListener('click', () => {
          this.closeModal();
          if (b.onClick) b.onClick();
        });
      });
      this.els['modal-backdrop'].classList.remove('hidden');
    },
    closeModal() {
      this.els['modal-backdrop'].classList.add('hidden');
      this.els['modal'].innerHTML = '';
      const k = this.modalKind;
      this.modalKind = null;
      if (this.cb.onModalClosed) this.cb.onModalClosed(k);
    },

    /* ---------------- チュートリアル ---------------- */
    openTutorial(onDone) {
      const steps = [
        {
          title: '✈ ようこそ、地上作業リーダー！',
          body: `<p>飛行機が空港に着いてから次に出発するまでの作業を<strong>ターンアラウンド</strong>といいます。</p>
                 <p>あなたの仕事は、たくさんの作業をスタッフと車両にわりあてて、<strong>45分後の出発</strong>に間に合わせること！</p>`,
        },
        {
          title: '🗺 画面の見方',
          body: `<ul class="tut-list">
                 <li><strong>画面ぜんたい：</strong>駐機場のようす（ドラッグで移動、ホイールやピンチ、右下の＋−でズーム）</li>
                 <li><strong>左の📋タブ：</strong>作業カードのひらけ・とじ</li>
                 <li><strong>右上：</strong>安全性などの管理指標</li>
                 <li><strong>下：</strong>スタッフと車両の状態</li></ul>`,
        },
        {
          title: '🛠 作業のすすめ方（2つのやり方）',
          body: `<p><strong>① おまかせ：</strong>作業カードの「開始」を押すと、必要なメンバーが自動で移動します。</p>
                 <p><strong>② 自分で配置：</strong>駐機場の<strong>スタッフや車両をタップ</strong>して選び、<strong>緑に光る持ち場</strong>をタップして送りこみます。必要な人数がそろうと作業開始！</p>
                 <p>🔒がついた作業は順番の条件があります（例：清掃はお客さんが降りてから）。</p>`,
        },
        {
          title: '⏱ 時間と采配レバー',
          body: `<p>画面上の <strong>⏸／▶／⏩</strong>で時間の速さを変えられます。まよったら⏸で作戦タイム。</p>
                 <p>各作業は<strong>🐢ていねい／ふつう／🚀急ぐ</strong>を選べます。急ぐと速いけれど、満足度や安全性が下がることも…。使いどころが腕の見せどころ！</p>`,
        },
        {
          title: '🦺 安全がいちばん！',
          body: `<p>とちゅうで<strong>突発イベント</strong>が起きたら、黄色い通知をタップして対応を選ぼう。</p>
                 <p>急いでいても、<strong>安全確認は絶対に省略しないこと</strong>。それがプロの仕事です。</p>
                 <p>それでは、よいフライトを！</p>`,
        },
      ];
      let idx = 0;
      const render = () => {
        const st = steps[idx];
        const dots = steps.map((_, i) => `<span class="tut-dot ${i === idx ? 'on' : ''}"></span>`).join('');
        this.openModal({
          kind: 'tutorial',
          title: st.title,
          body: st.body + `<div class="tut-dots">${dots}</div>`,
          buttons: [
            ...(idx > 0 ? [{ label: '← 前へ', cls: 'btn-ghost', onClick: () => { idx--; render(); } }] : []),
            idx < steps.length - 1
              ? { label: '次へ →', cls: 'btn-primary', onClick: () => { idx++; render(); } }
              : { label: 'とじる', cls: 'btn-primary', onClick: () => { if (onDone) onDone(); } },
            ...(idx < steps.length - 1 ? [{ label: 'とばす', cls: 'btn-ghost', onClick: () => { if (onDone) onDone(); } }] : []),
          ],
          dismissible: false,
        });
      };
      render();
    },

    /* ---------------- 設定 ---------------- */
    openSettings(opts) {
      const { sound, inGame } = opts;
      this.openModal({
        kind: 'settings',
        title: '⚙ 設定',
        body: `
          <label class="set-row">
            <span>🔊 効果音</span>
            <input type="checkbox" id="set-sound" ${sound ? 'checked' : ''}>
          </label>
          <div class="set-row">
            <span>📖 あそびかたをもう一度見る</span>
            <button class="btn btn-sm btn-ghost" id="set-tutorial">ひらく</button>
          </div>
          ${inGame ? `
          <div class="set-row">
            <span>🏳 このステージをやめる</span>
            <button class="btn btn-sm btn-warnghost" id="set-quit">ステージ選択へ</button>
          </div>` : `
          <div class="set-row">
            <span>🗑 セーブデータをけす</span>
            <button class="btn btn-sm btn-warnghost" id="set-reset">初期化</button>
          </div>`}`,
        buttons: [{ label: 'とじる', cls: 'btn-primary' }],
        dismissible: true,
      });
      $('#set-sound').addEventListener('change', (ev) => this.cb.onSoundToggle(ev.target.checked));
      $('#set-tutorial').addEventListener('click', () => { this.closeModal(); this.openTutorial(null); });
      const quit = $('#set-quit');
      if (quit) quit.addEventListener('click', () => {
        this.closeModal();
        this.openModal({
          title: '確認', body: '<p>このステージをやめてステージ選択にもどりますか？<br>進み具合は保存されません。</p>',
          buttons: [
            { label: 'やめて選択画面へ', cls: 'btn-danger', onClick: () => this.cb.onGotoSelect() },
            { label: 'つづける', cls: 'btn-primary' },
          ],
          dismissible: true,
        });
      });
      const reset = $('#set-reset');
      if (reset) reset.addEventListener('click', () => {
        this.closeModal();
        this.openModal({
          title: '確認', body: '<p>クリア記録とベストスコアをすべてけしますか？</p>',
          buttons: [
            { label: 'けす', cls: 'btn-danger', onClick: () => this.cb.onResetData() },
            { label: 'やめる', cls: 'btn-primary' },
          ],
          dismissible: true,
        });
      });
    },

    /* ---------------- 結果画面 ---------------- */
    renderResult(res, isBest, nextStageId) {
      const nextBtn = document.getElementById('btn-next-stage');
      const retryBtn = document.getElementById('btn-retry');
      nextBtn.classList.toggle('hidden', !nextStageId);
      nextBtn.dataset.stage = nextStageId || '';
      retryBtn.classList.toggle('btn-primary', !nextStageId);
      retryBtn.classList.toggle('btn-ghost', !!nextStageId);

      const flag = this.els['result-flag'];
      if (!res.departed) {
        flag.textContent = '⏰ 時間内に出発できませんでした…';
        flag.className = 'result-flag bad';
      } else if (res.critical) {
        flag.textContent = '⚠ 出発はしましたが、安全上の重大な問題がありクリアになりません';
        flag.className = 'result-flag bad';
      } else if (res.delay != null && res.delay > 0.5) {
        flag.textContent = `✈ 出発しました（${Math.ceil(res.delay)}分遅れ）— クリア！`;
        flag.className = 'result-flag ok';
      } else {
        flag.textContent = '🎉 定刻出発、おみごと！— クリア！';
        flag.className = 'result-flag great';
      }

      const rankEl = this.els['result-rank'];
      rankEl.textContent = res.rank;
      rankEl.className = 'result-rank rank-' + (res.rank === '×' ? 'X' : res.rank);
      this.els['result-score'].textContent = String(res.score);

      const bd = this.els['result-breakdown'];
      bd.innerHTML = '';
      Object.values(res.breakdown).forEach((b) => {
        const li = document.createElement('li');
        const pct = (b.got / b.max) * 100;
        li.innerHTML = `<span class="rb-label">${b.label}</span>
          <span class="rb-bar"><span class="rb-fill" style="width:${pct}%"></span></span>
          <span class="rb-num">${b.got} / ${b.max}点</span>`;
        bd.appendChild(li);
      });

      const times = this.els['result-times'];
      if (res.blockOff != null) {
        const d = Math.ceil(Math.max(0, res.blockOff - res.std));
        times.textContent = `出発予定 ${window.fmtClock(res.std)} → 実際の出発 ${window.fmtClock(res.blockOff)}` +
          (d > 0 ? `（${d}分遅れ）` : '（定刻）') + (isBest ? '　★ 自己ベスト更新！' : '');
      } else {
        times.textContent = `出発予定 ${window.fmtClock(res.std)} → 出発できず` + (isBest ? '　★ 自己ベスト更新！' : '');
      }
      this.els['result-advice'].textContent = res.advice;
    },

    /* ---------------- 毎フレーム ---------------- */
    frame(dtReal) {
      const s = this.state;
      Scene.draw(s, dtReal, this);
      if (!s) return;
      this.updateClock();
      const now = performance.now();
      if (now - this.domThrottle > 250) {
        this.domThrottle = now;
        const G = window.Game;
        const outPaused = G.outdoorPaused();
        s.taskList.forEach((t) => {
          if (t.status === 'active') {
            const card = this.cardEls[t.id];
            if (!card) return;
            card.querySelector('.tc-fill').style.width = `${clamp((t.progress / G.effDur(t)) * 100, 0, 100)}%`;
            const timeEl = card.querySelector('.tc-time');
            const txt = (outPaused && t.def.outdoor ? '⏸ ' : '') +
              `のこり約${Math.max(1, Math.ceil(G.effDur(t) - t.progress))}分`;
            if (timeEl.textContent !== txt) timeEl.textContent = txt;
          }
        });
        this.updateHint();
      }
    },

    /* ---------------- Game からの通知 ---------------- */
    handleEmit(type, payload) {
      switch (type) {
        case 'task':
          this.updateCard(payload.id);
          this.updateUnfinished();
          this.updateHint(true);
          if (this.spotPopTask === payload.id) {
            const t = this.state.tasks[payload.id];
            if (!t || t.status === 'done' || t.status === 'active') this.closeSpotPop();
          }
          break;
        case 'resources': this.updateResources(); break;
        case 'metrics': this.updateMetrics(); break;
        case 'clock': this.updateClock(); break;
        case 'log': this.addLog(payload); break;
        case 'toast': this.toast(payload.msg, payload.type); break;
        case 'sfx': Sfx.play(payload); break;
        case 'weather': this.updateWeatherHud(); break;
        case 'celebrate': if (this.state) Scene.celebrate(this.state, payload.taskId); break;
        case 'safety-ask': this.openSafetyModal(); break;
        case 'event-armed':
          this.issueTask = payload.def.affectedTask || null;
          this.showEventBanner(payload.def);
          if (this.issueTask) this.updateCard(this.issueTask);
          break;
        case 'event-resolved': {
          const prev = this.issueTask;
          this.issueTask = null;
          this.hideEventBanner();
          if (prev) this.updateCard(prev);
          break;
        }
        case 'stage-end':
          this.selected = null;
          this.closeSpotPop();
          this.hideEventBanner();
          if (this.modalKind && this.modalKind !== 'tutorial') this.closeModal();
          break;
      }
    },
  };

  window.UI = UI;
})();
