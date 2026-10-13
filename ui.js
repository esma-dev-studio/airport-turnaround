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
        case 'unlock': [523, 698, 880].forEach((f, i) => this.tone(f, 0.14, i * 0.075, 'triangle', 0.075)); break;
        case 'warn':   this.tone(233, 0.18, 0, 'sawtooth', 0.06); this.tone(220, 0.22, 0.2, 'sawtooth', 0.06); break;
        case 'event':  this.tone(587, 0.12, 0, 'triangle'); this.tone(494, 0.12, 0.14, 'triangle'); this.tone(587, 0.12, 0.28, 'triangle'); break;
        case 'clear':  [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.16, i * 0.13, 'triangle', 0.1)); break;
        case 'fail':   [392, 330, 262].forEach((f, i) => this.tone(f, 0.2, i * 0.16, 'triangle', 0.08)); break;
        case 'arrive': this.tone(196, 0.9, 0, 'sawtooth', 0.035); this.tone(147, 1.1, 0.5, 'sawtooth', 0.03); break;
      }
    },
  };

  /* ============================================================
   * BGM（WebAudioで生成する、ゆったりしたペンタトニックのループ）
   * 効果音とは別トグル。ゲーム中だけ流れる。
   * ============================================================ */
  const Bgm = {
    enabled: true,
    playing: false,
    timer: null,
    step: 0,
    /* ドレミソラ系のやさしい進行（2小節ぶん） */
    MELODY: [392, 440, 523, 440, 392, 330, 392, 0, 523, 587, 659, 587, 523, 440, 392, 0],
    BASS:   [131, 131, 110, 110, 98, 98, 131, 131],
    start() {
      if (!this.enabled || this.playing) return;
      Sfx.ensure();
      if (!Sfx.ctx) return;
      this.playing = true;
      this.step = 0;
      this.timer = setInterval(() => this._tick(), 620);
      this._tick();
    },
    stop() {
      this.playing = false;
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    },
    _tick() {
      if (!this.enabled || !this.playing || !Sfx.ctx) return;
      const m = this.MELODY[this.step % this.MELODY.length];
      if (m > 0) Sfx.tone(m, 0.5, 0, 'sine', 0.016);
      if (this.step % 2 === 0) {
        Sfx.tone(this.BASS[(this.step / 2) % this.BASS.length], 0.9, 0, 'triangle', 0.014);
      }
      this.step++;
    },
  };

  /* ============================================================
   * 駐機場シーン（Canvas 2.5D風）
   * 論理座標 1200x640。カメラで拡大・移動して描く。
   * ============================================================ */
  const SCENE_W = 1200, SCENE_H = 640;
  /* Canvas用フォント（Webフォント読みこみ後に適用される） */
  const CF = '"Zen Kaku Gothic New", "Segoe UI", Meiryo, sans-serif';

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

  /* 空港のまめ知識（スタート画面・結果画面にランダム表示） */
  const TRIVIA = [
    '飛行機は自分ではバックできません。だからプッシュバック車両が後ろへ押してあげるのです。',
    '持ち主が搭乗していないスーツケースは、安全のため必ず飛行機から降ろすルールになっています。',
    '給油中の機体のまわりは火気厳禁。ランプスタッフがしっかり見守っています。',
    '短い路線では、到着から出発までの準備（ターンアラウンド）を30分ほどで終えることもあります。',
    '預けた手荷物はバーコードで1個ずつ管理されていて、行き先をまちがえないようになっています。',
    '雷が近づくと、駐機場の屋外作業は安全のためすぐに中断されます。',
    '飛行機を手の合図で誘導する係は「マーシャラー」と呼ばれています。',
    'ベルトローダーのベルトは動く坂道。重いスーツケースもスイスイ運べます。',
  ];
  const pickTrivia = () => TRIVIA[Math.floor(Math.random() * TRIVIA.length)];

  /* 👨‍✈️コーチのふきだし（初級=ステージ1のみ・節目で流れを実況） */
  const COACH_RULES = [
    { id: 'afterDeboard', when: (s) => s.tasks.deboard.status === 'done',
      msg: '👨‍✈️ お客さんが降りたよ！つぎは『機内清掃』🧹と『機内食』🍱が始められる！' },
    { id: 'afterClean', when: (s) => s.tasks.clean.status === 'done',
      msg: '👨‍✈️ 機内がピカピカ！『乗客の搭乗』を始めよう。給油や積み込みは同時に続けてOK！' },
    { id: 'beforeMatch', when: (s) => s.tasks.board.status === 'done' && s.tasks.load.status === 'done' && s.tasks.bagmatch.status !== 'done',
      msg: '👨‍✈️ 仕上げの『手荷物照合』✅！乗っていない人の荷物がないか確認しよう。' },
    { id: 'afterDoor', when: (s) => s.tasks.doorclose.status === 'done',
      msg: '👨‍✈️ ドアクローズ完了🚪！点検が済んでいれば『プッシュバック』🚜で出発だ！' },
  ];

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
    spotFx: {},       // taskId -> 経過秒（ロックが開いた瞬間のリング演出）
    arrivalT: null,   // 到着シネマティックの進行(0..1)。null=なし
    arrivalCb: null,
    planeParked: true,

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
      this.spotFx = {};
      this.bgKey = '';   // ステージが変わったら背景キャッシュを作り直す
      this.cam = { zoom: 1, cx: 600, cy: 330 };
      this.arrivalT = null;
      this.arrivalCb = null;
      this.planeParked = true;
    },

    /* 到着シネマティック: 誘導路からスポットへ入ってくる */
    playArrival(cb) {
      this.arrivalT = 0;
      this.arrivalCb = cb || null;
      this.planeParked = false;
      this.bridge = 0;
      Sfx.play('arrive');
    },
    stepArrival(dtReal) {
      if (this.arrivalT == null) return;
      this.arrivalT += dtReal / 3.0;
      if (this.arrivalT >= 1) {
        this.arrivalT = null;
        this.planeParked = true;
        const cb = this.arrivalCb;
        this.arrivalCb = null;
        this.float(615, 250, '✈ とうちゃく！ じゅんびスタート！', '#0e6f8c');
        if (cb) cb();
      }
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
      /* キャンバス未サイズ時や不正値からの復帰 */
      if (!isFinite(c.zoom)) c.zoom = 1;
      if (!isFinite(c.cx)) c.cx = 600;
      if (!isFinite(c.cy)) c.cy = 330;
      if (!this.cw || !this.ch) return;
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
      if (!this.cw || !this.ch) return;   // キャンバスがまだ表示されていない
      const pivot = (px != null) ? { x: px, y: py } : { x: this.cw / 2, y: this.ch / 2 };
      const before = this.screenToScene(pivot.x, pivot.y);
      this.cam.zoom = clamp(this.cam.zoom * factor, this.minZoom(), 2.6);
      const S = this.scale();
      this.cam.cx = before.x - (pivot.x - this.cw / 2) / S;
      this.cam.cy = before.y - (pivot.y - this.ch / 2) / S;
      this.clampCam();
    },
    panBy(dxScreen, dyScreen) {
      if (!this.cw || !this.ch) return;
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
      return [272 + (i % 5) * 32, 506 + Math.floor(i / 5) * 30];
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

    /* タップ判定: エンティティ → 作業スポットの順に探す。
     * 距離は「画面上のピクセル」で比べる（ズームアウト時やスマホでも押しやすい）。 */
    hitTest(state, sx, sy) {
      let best = null, bestD = 1e9;
      state.entities.forEach((e) => {
        const rec = this.ent[e.id];
        if (!rec) return;
        /* 人物は背が高くなったので、あたり判定の中心を体の中ほどに */
        const cy = e.kind === 'staff' ? rec.pos.y - 9 : rec.pos.y;
        const sp = this.sceneToScreen(rec.pos.x, cy);
        const r = e.kind === 'staff' ? 26 : Math.max(34, 46 * this.scale() / 1.1);
        const d = Math.hypot(sp.x - sx, sp.y - sy);
        if (d < r && d < bestD) { best = { type: 'entity', id: e.id }; bestD = d; }
      });
      if (best) return best;
      let spot = null; bestD = 1e9;
      state.taskList.forEach((t) => {
        const open = t.status === 'ready' || t.status === 'gathering' || t.status === 'active';
        /* 「もうすぐできる」予告サークルも押せる（なぜまだできないかを読めるように） */
        const soon = t.status === 'locked' && window.Game.opensInMinutes(t.id) != null;
        if (!open && !soon) return;
        const a = this.anchorOf(t.id);
        if (!a) return;
        const sp = this.sceneToScreen(a[0], a[1]);
        const d = Math.hypot(sp.x - sx, sp.y - sy);
        const r = open ? 36 : 24;
        if (d < r && d < bestD) { spot = { type: 'spot', id: t.id }; bestD = d; }
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
      this.float(a[0], a[1] - 30, `${def.icon} できた！`, '#2e9e5b');
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
        c.font = 'bold 17px ' + CF + '';
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
      c.fillStyle = (state && state.stage && state.stage.rainAll) ? '#7e8792' : '#9aa1a9';
      c.fillRect(0, 0, this.cw, this.ch);

      this.stepArrival(dtReal);

      c.save();
      c.translate(this.cw / 2, this.ch / 2);
      const S = this.scale();
      c.scale(S, S);
      c.translate(-this.cam.cx, -this.cam.cy);

      this.ensureBg(state);
      c.drawImage(this.bgCanvas, 0, 0, SCENE_W, SCENE_H);
      this.drawSkyLife(state);
      if (state) {
        this.updateBridge(state, dtReal);
        this.drawPlane(state);
        this.drawBridge(state);
        this.drawEffectsUnder(state, gt);
        this.drawSoonSpots(state);
        this.drawSpots(state, ui);
        this.drawSpotPops(dtReal);
        this.drawEntities(state, gt, ui);
        this.drawPax(state, gt);
        this.drawRings(state);
        this.drawPaxCounter(state);
        this.drawFx(dtReal);
        this.drawRain(state);
      }
      c.restore();
    },

    /* ============ 背景（照明つき・静的部分はオフスクリーンに1回だけ描く） ============
     * 光源は画面左上で統一し、落ち影・面の明暗・コンクリートの質感を持たせる。
     * 静止要素は bgCanvas にキャッシュ（2倍解像度）して毎フレームは1枚絵として貼るだけ。
     * 動く要素（雲・遠くの機体・旗・管制塔ランプ・吹き流し）は drawSkyLife で毎フレーム描く。 */
    noiseTile() {
      if (this._noise) return this._noise;
      const t = document.createElement('canvas');
      t.width = t.height = 96;
      const g = t.getContext('2d');
      const img = g.createImageData(96, 96);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 100 + Math.random() * 100;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 22;
      }
      g.putImageData(img, 0, 0);
      this._noise = t;
      return t;
    },

    ensureBg(state) {
      const st = state && state.stage;
      const key = (st ? st.id : 0) + '|' + (st && st.rainAll ? 1 : 0) + '|' +
        ((state && state.weatherNow && state.weatherNow.label) || '');
      if (this.bgCanvas && this.bgKey === key) return;
      this.bgKey = key;
      if (!this.bgCanvas) {
        this.bgCanvas = document.createElement('canvas');
        this.bgCanvas.width = SCENE_W * 2;
        this.bgCanvas.height = SCENE_H * 2;
      }
      const g = this.bgCanvas.getContext('2d');
      g.setTransform(2, 0, 0, 2, 0, 0);
      g.clearRect(0, 0, SCENE_W, SCENE_H);
      const prev = this.ctx;
      this.ctx = g;   // rr()等のヘルパーを使うため一時的に差し替え
      try { this.renderBg(g, !!(st && st.rainAll)); } finally { this.ctx = prev; }
    },

    /* 静的背景。wet=trueは雨ステージ（暗く・濡れた路面） */
    renderBg(c, wet) {
      /* --- 空（グラデーション） --- */
      const sky = c.createLinearGradient(0, 0, 0, 30);
      if (wet) { sky.addColorStop(0, '#8798a8'); sky.addColorStop(1, '#b7c4cf'); }
      else { sky.addColorStop(0, '#7fbfe9'); sky.addColorStop(1, '#cfe8f8'); }
      c.fillStyle = sky;
      c.fillRect(0, 0, SCENE_W, 30);
      if (!wet) {
        const glow = c.createRadialGradient(66, 13, 2, 66, 13, 26);
        glow.addColorStop(0, 'rgba(255,225,140,.9)');
        glow.addColorStop(0.45, 'rgba(255,220,120,.35)');
        glow.addColorStop(1, 'rgba(255,220,120,0)');
        c.fillStyle = glow;
        c.beginPath(); c.arc(66, 13, 26, 0, TAU); c.fill();
        c.fillStyle = '#ffd95e';
        c.beginPath(); c.arc(66, 13, 9, 0, TAU); c.fill();
      }

      /* --- ターミナルビル（面の明暗つき） --- */
      c.fillStyle = wet ? '#9aa9b6' : '#b0c2d2';
      c.fillRect(0, 30, SCENE_W, 8);
      const fac = c.createLinearGradient(0, 38, 0, 126);
      if (wet) { fac.addColorStop(0, '#d3dae1'); fac.addColorStop(1, '#bcc6cf'); }
      else { fac.addColorStop(0, '#f2f6fa'); fac.addColorStop(1, '#dde5ec'); }
      c.fillStyle = fac;
      c.fillRect(0, 38, SCENE_W, 88);
      for (let x = 48; x < SCENE_W - 60; x += 46) {
        const win = c.createLinearGradient(0, 52, 0, 106);
        if (wet) { win.addColorStop(0, '#8b9fb2'); win.addColorStop(1, '#76899b'); }
        else { win.addColorStop(0, '#a9c6de'); win.addColorStop(1, '#87a9c6'); }
        c.fillStyle = win;
        c.fillRect(x, 52, 28, 54);
        /* 窓のななめの光 */
        c.fillStyle = wet ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.30)';
        c.beginPath();
        c.moveTo(x, 52); c.lineTo(x + 13, 52); c.lineTo(x, 74);
        c.closePath(); c.fill();
        /* 窓わく */
        c.strokeStyle = 'rgba(70,90,110,.25)'; c.lineWidth = 1;
        c.strokeRect(x + 0.5, 52.5, 27, 53);
      }
      /* 屋根のフチ（上面が明るく、下に影の線） */
      c.fillStyle = wet ? '#aeb9c3' : '#cbd5e0';
      c.fillRect(0, 126, SCENE_W, 12);
      c.fillStyle = 'rgba(255,255,255,.4)';
      c.fillRect(0, 126, SCENE_W, 2.5);
      c.fillStyle = 'rgba(30,45,65,.25)';
      c.fillRect(0, 136, SCENE_W, 2);
      /* 空港名の看板 */
      c.fillStyle = 'rgba(24,46,74,.94)';
      this.rr(10, 34, 178, 22, 11); c.fill();
      c.fillStyle = '#fff';
      c.font = 'bold 13px ' + CF;
      c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText('✈ そらみなと国際空港', 21, 46);
      /* ゲート表示 */
      c.fillStyle = '#22405f';
      this.rr(292, 104, 92, 24, 6); c.fill();
      c.fillStyle = '#ffd24a';
      c.font = 'bold 13px ' + CF;
      c.textAlign = 'center';
      c.fillText('GATE 7', 338, 117);
      /* 管制塔（右面に陰） */
      c.fillStyle = wet ? '#b8c1ca' : '#d6dee6';
      c.fillRect(1082, 48, 24, 78);
      c.fillStyle = 'rgba(255,255,255,.45)'; c.fillRect(1082, 48, 5, 78);
      c.fillStyle = 'rgba(50,65,85,.18)'; c.fillRect(1098, 48, 8, 78);
      c.fillStyle = wet ? '#5d7183' : '#6f8598';
      this.rr(1068, 30, 52, 26, 8); c.fill();
      const twin = c.createLinearGradient(0, 36, 0, 46);
      twin.addColorStop(0, wet ? '#9db3c2' : '#cdeaf6');
      twin.addColorStop(1, wet ? '#7d93a4' : '#9cc4d8');
      c.fillStyle = twin; this.rr(1073, 36, 42, 10, 4); c.fill();
      c.fillStyle = 'rgba(255,255,255,.5)'; this.rr(1073, 36, 42, 3.5, 2); c.fill();
      c.strokeStyle = '#6f8598'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(1094, 30); c.lineTo(1094, 18); c.stroke();

      /* --- エプロン（コンクリート。奥が明るく手前がわずかに暗い） --- */
      const ap = c.createLinearGradient(0, 138, 0, SCENE_H);
      if (wet) { ap.addColorStop(0, '#99a0a9'); ap.addColorStop(1, '#878e98'); }
      else { ap.addColorStop(0, '#bcc2c9'); ap.addColorStop(1, '#a9b0b8'); }
      c.fillStyle = ap;
      c.fillRect(0, 138, SCENE_W, SCENE_H - 138);
      /* コンクリートの質感（ノイズ） */
      c.save();
      c.globalAlpha = wet ? 0.5 : 0.75;
      c.fillStyle = c.createPattern(this.noiseTile(), 'repeat');
      c.fillRect(0, 138, SCENE_W, SCENE_H - 138);
      c.restore();
      /* ターミナルの落ち影（光源が左上→建物の南側に影） */
      const bsh = c.createLinearGradient(0, 138, 0, 176);
      bsh.addColorStop(0, wet ? 'rgba(20,32,48,.30)' : 'rgba(22,36,56,.22)');
      bsh.addColorStop(1, 'rgba(22,36,56,0)');
      c.fillStyle = bsh;
      c.fillRect(0, 138, SCENE_W, 38);
      /* 日ざしの色（左上からのあたたかい光） */
      if (!wet) {
        const sun = c.createRadialGradient(140, 40, 60, 140, 40, 1050);
        sun.addColorStop(0, 'rgba(255,240,205,.13)');
        sun.addColorStop(1, 'rgba(255,240,205,0)');
        c.fillStyle = sun;
        c.fillRect(0, 30, SCENE_W, SCENE_H - 30);
      } else {
        /* 雨の日は全体をひんやりした色に */
        c.fillStyle = 'rgba(70,90,115,.08)';
        c.fillRect(0, 30, SCENE_W, SCENE_H - 30);
      }
      /* コンクリートのつなぎ目（影＋ハイライトの2重線で彫りを出す） */
      for (let x = 120; x < SCENE_W; x += 150) {
        c.strokeStyle = 'rgba(55,65,75,.14)'; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(x, 138); c.lineTo(x, SCENE_H); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x + 1.5, 138); c.lineTo(x + 1.5, SCENE_H); c.stroke();
      }
      for (let y = 230; y < SCENE_H; y += 130) {
        c.strokeStyle = 'rgba(55,65,75,.14)'; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(0, y); c.lineTo(SCENE_W, y); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, y + 1.5); c.lineTo(SCENE_W, y + 1.5); c.stroke();
      }
      /* 路面のよごれ・タイヤあと */
      c.fillStyle = 'rgba(50,60,70,.07)';
      [[210, 320, 60, 20], [1030, 260, 56, 18], [400, 462, 40, 12], [980, 440, 52, 16], [700, 200, 70, 16]].forEach(([x, y, w, h]) => {
        c.beginPath(); c.ellipse(x, y, w, h, 0.3, 0, TAU); c.fill();
      });
      c.strokeStyle = 'rgba(40,50,60,.10)'; c.lineWidth = 5;
      c.beginPath(); c.moveTo(560, 574); c.quadraticCurveTo(590, 545, 610, 480); c.stroke();
      c.beginPath(); c.moveTo(664, 574); c.quadraticCurveTo(648, 542, 622, 480); c.stroke();
      /* 雨の日: 水たまりと路面の照りかえし */
      if (wet) {
        [[350, 300, 70, 14], [820, 250, 90, 16], [520, 470, 60, 12], [1000, 480, 80, 14]].forEach(([x, y, w, h]) => {
          const pud = c.createLinearGradient(0, y - h, 0, y + h);
          pud.addColorStop(0, 'rgba(175,195,215,.30)');
          pud.addColorStop(1, 'rgba(140,160,185,.16)');
          c.fillStyle = pud;
          c.beginPath(); c.ellipse(x, y, w, h, 0, 0, TAU); c.fill();
          c.fillStyle = 'rgba(235,245,252,.25)';
          c.beginPath(); c.ellipse(x - w * 0.25, y - h * 0.3, w * 0.4, h * 0.3, 0, 0, TAU); c.fill();
        });
      }
      /* エプロンのふち取り（白線） */
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(0, 143); c.lineTo(SCENE_W, 143); c.stroke();

      /* --- 誘導路（タキシーウェイ） --- */
      const tw = c.createLinearGradient(0, 574, 0, SCENE_H);
      if (wet) { tw.addColorStop(0, '#79818c'); tw.addColorStop(1, '#6e7681'); }
      else { tw.addColorStop(0, '#9aa2ab'); tw.addColorStop(1, '#8e969f'); }
      c.fillStyle = tw;
      c.fillRect(0, 574, SCENE_W, 56);
      c.fillStyle = 'rgba(30,40,52,.18)';
      c.fillRect(0, 574, SCENE_W, 4);
      c.strokeStyle = 'rgba(255,255,255,.45)'; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(0, 579); c.lineTo(SCENE_W, 579); c.stroke();
      c.strokeStyle = wet ? '#c8ae44' : '#e8c84a'; c.lineWidth = 3;
      c.setLineDash([26, 18]);
      c.beginPath(); c.moveTo(0, 602); c.lineTo(SCENE_W, 602); c.stroke();
      c.setLineDash([]);

      /* --- スタンド導入線・停止線・スポット番号の標識 --- */
      c.strokeStyle = wet ? '#c8ae44' : '#e8c84a'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(615, 574); c.lineTo(615, 330); c.stroke();
      c.beginPath(); c.moveTo(597, 330); c.lineTo(633, 330); c.stroke();
      c.fillStyle = 'rgba(30,40,52,.20)';
      this.rr(568.5, 546.5, 50, 26, 6); c.fill();
      c.fillStyle = '#fbfcfd';
      this.rr(566, 544, 50, 26, 6); c.fill();
      c.strokeStyle = '#8b959e'; c.lineWidth = 1.5; this.rr(566, 544, 50, 26, 6); c.stroke();
      c.fillStyle = '#46505b';
      c.font = 'bold 17px ' + CF;
      c.textAlign = 'center';
      c.fillText('S7', 591, 558);

      /* 制限区域ライン（赤の点線） */
      c.strokeStyle = 'rgba(214,69,69,.45)'; c.lineWidth = 2.5;
      c.setLineDash([14, 10]);
      this.rr(225, 195, 790, 275, 30); c.stroke();
      c.setLineDash([]);

      /* スタッフ待機所（うっすら影つき） */
      c.fillStyle = 'rgba(30,40,52,.16)';
      this.rr(253, 487, 172, 58, 8); c.fill();
      c.fillStyle = wet ? '#98a2ab' : '#aeb7be';
      this.rr(250, 484, 172, 58, 8); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(252, 485.5); c.lineTo(420, 485.5); c.stroke();
      c.strokeStyle = '#87919a'; c.lineWidth = 2; this.rr(250, 484, 172, 58, 8); c.stroke();
      c.fillStyle = '#57626d';
      c.font = '11px ' + CF;
      c.textAlign = 'left';
      c.fillText('スタッフのまちあい', 256, 478);

      /* 車両置き場 */
      c.fillStyle = '#57626d';
      c.fillText('はたらく車のおきば', 452, 478);
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2;
      [450, 552, 648, 742, 844, 948, 1046].forEach((x) => {
        c.beginPath(); c.moveTo(x, 486); c.lineTo(x, 548); c.stroke();
      });

      /* 吹き流しのポール（本体はdrawSkyLifeで動かす） */
      c.strokeStyle = '#7c858e'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(1128, 188); c.lineTo(1128, 154); c.stroke();
    },

    /* 動きのある背景要素（毎フレーム描画。数が少ないので軽い） */
    drawSkyLife(state) {
      const c = this.ctx;
      const wet = !!(state && state.stage && state.stage.rainAll);
      /* 遠くを飛ぶ飛行機（ひこうき雲つき） */
      const fpx = ((this.time * 26) % (SCENE_W + 420)) - 210;
      c.strokeStyle = wet ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.7)';
      c.lineWidth = 2.5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(fpx - 150, 12.5); c.lineTo(fpx - 14, 12.5); c.stroke();
      c.strokeStyle = wet ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.32)';
      c.lineWidth = 4.5;
      c.beginPath(); c.moveTo(fpx - 195, 12.5); c.lineTo(fpx - 120, 12.5); c.stroke();
      c.lineCap = 'butt';
      c.fillStyle = '#fff';
      c.beginPath();
      c.moveTo(fpx + 12, 12.5); c.lineTo(fpx - 6, 7.5); c.lineTo(fpx - 2.5, 12.5); c.lineTo(fpx - 6, 17.5);
      c.closePath(); c.fill();
      /* 雲 */
      c.fillStyle = wet ? 'rgba(228,236,242,.8)' : 'rgba(255,255,255,.9)';
      const cl = (x, y, s) => { this.rr(x, y, 54 * s, 11 * s, 5.5 * s); c.fill(); this.rr(x + 12 * s, y - 6 * s, 30 * s, 9 * s, 4.5 * s); c.fill(); };
      cl(220 + Math.sin(this.time * 0.08) * 24, 9, 0.9);
      cl(500 + Math.cos(this.time * 0.05) * 36, 13, 0.6);
      cl(760 + Math.cos(this.time * 0.06) * 30, 11, 0.75);
      /* 屋根の旗（ぱたぱた） */
      [508, 548, 588].forEach((fx, i) => {
        const wave = Math.sin(this.time * 3 + i * 1.1) * 3;
        c.strokeStyle = '#8496a8'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(fx, 30); c.lineTo(fx, 13); c.stroke();
        c.fillStyle = ['#e2711d', '#0f8fb0', '#2f9e63'][i];
        c.beginPath();
        c.moveTo(fx, 13); c.lineTo(fx + 15, 16 + wave); c.lineTo(fx, 21);
        c.closePath(); c.fill();
      });
      /* 管制塔のランプ点滅 */
      c.fillStyle = `rgba(255,86,86,${(0.4 + 0.6 * Math.abs(Math.sin(this.time * 2.4))).toFixed(3)})`;
      c.beginPath(); c.arc(1094, 16, 3.2, 0, TAU); c.fill();
      /* 吹き流し */
      const flap = Math.sin(this.time * 2.2) * 4;
      c.fillStyle = '#e2711d';
      c.beginPath();
      c.moveTo(1128, 154); c.lineTo(1154, 158 + flap); c.lineTo(1154, 162 + flap); c.lineTo(1128, 164);
      c.closePath(); c.fill();
    },

    planeTransform(state) {
      const push = state.tasks.pushback;
      const dep = state.tasks.depart;
      const G = window.Game;
      let x = 0, y = 0, rot = 0, alpha = 1;
      const ease = (t) => t * t * (3 - 2 * t);
      /* 到着シネマティック（出発経路の逆再生でスポットイン） */
      if (this.arrivalT != null) {
        const a = ease(clamp(this.arrivalT, 0, 1));
        if (a < 0.72) {
          const p = 1 - a / 0.72;
          x = p * 470; y = 85 + p * 210; rot = rad(16) + p * rad(30);
        } else {
          const p = 1 - (a - 0.72) / 0.28;
          y = p * 85; rot = p * rad(16);
        }
        alpha = this.arrivalT < 0.05 ? this.arrivalT / 0.05 : 1;
        return { x, y, rot, alpha };
      }
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

      /* 落ち影（光源=左上 → 右下へオフセット。フチはやわらかく） */
      const psh = c.createRadialGradient(636, 352, 60, 636, 352, 390);
      psh.addColorStop(0, 'rgba(28,38,52,.20)');
      psh.addColorStop(0.75, 'rgba(28,38,52,.13)');
      psh.addColorStop(1, 'rgba(28,38,52,0)');
      c.fillStyle = psh;
      c.beginPath(); c.ellipse(636, 352, 385, 62, 0, 0, TAU); c.fill();

      const ACC = '#1793b8', ACC_D = '#0e6f8c';
      /* 主翼（上側）: つけ根→翼端へのシェーディング */
      const wingU = c.createLinearGradient(520, 300, 788, 182);
      wingU.addColorStop(0, '#dde3e9');
      wingU.addColorStop(0.5, '#eef1f4');
      wingU.addColorStop(1, '#f7f9fb');
      c.fillStyle = wingU; c.strokeStyle = '#95a1ac'; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(520, 300); c.lineTo(742, 182); c.lineTo(788, 182); c.lineTo(668, 300);
      c.closePath(); c.fill(); c.stroke();
      c.fillStyle = 'rgba(120,140,158,.22)';
      c.beginPath(); c.moveTo(520, 300); c.lineTo(600, 258); c.lineTo(648, 258); c.lineTo(576, 300); c.closePath(); c.fill();
      c.fillStyle = ACC; c.fillRect(742, 178, 46, 7);
      c.fillStyle = '#ffd24a'; c.fillRect(742, 185, 46, 2.5);
      /* 主翼（下側） */
      const wingL = c.createLinearGradient(520, 340, 788, 458);
      wingL.addColorStop(0, '#d3dae1');
      wingL.addColorStop(0.5, '#e2e7ec');
      wingL.addColorStop(1, '#eef2f5');
      c.beginPath();
      c.fillStyle = wingL;
      c.moveTo(520, 340); c.lineTo(742, 458); c.lineTo(788, 458); c.lineTo(668, 340);
      c.closePath(); c.fill(); c.stroke();
      c.fillStyle = ACC; c.fillRect(742, 455, 46, 7);
      c.fillStyle = '#ffd24a'; c.fillRect(742, 452.5, 46, 2.5);
      /* 水平尾翼 */
      c.fillStyle = '#e8edf1';
      c.beginPath(); c.moveTo(898, 305); c.lineTo(962, 258); c.lineTo(988, 258); c.lineTo(944, 305); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = '#dfe5ea';
      c.beginPath(); c.moveTo(898, 335); c.lineTo(962, 382); c.lineTo(988, 382); c.lineTo(944, 335); c.closePath(); c.fill(); c.stroke();
      /* エンジン（青いリング+ファン） */
      const eng = (y) => {
        const eb = c.createLinearGradient(0, y, 0, y + 26);
        eb.addColorStop(0, '#e6ebf0');
        eb.addColorStop(0.35, '#cfd6dd');
        eb.addColorStop(1, '#aab4bd');
        c.fillStyle = eb;
        this.rr(536, y, 58, 26, 12); c.fill();
        c.strokeStyle = '#8d99a5'; c.lineWidth = 2; this.rr(536, y, 58, 26, 12); c.stroke();
        c.fillStyle = ACC;
        c.beginPath(); c.ellipse(543, y + 13, 7, 13, 0, Math.PI / 2, Math.PI * 1.5); c.fill();
        c.fillStyle = '#3d4854';
        c.beginPath(); c.ellipse(538, y + 13, 5, 11, 0, 0, TAU); c.fill();
        c.fillStyle = '#e8edf1';
        c.beginPath(); c.ellipse(538, y + 13, 2.2, 5, 0, 0, TAU); c.fill();
      };
      eng(244); eng(370);
      /* 胴体（白+おなかの2トーン+青のライン） */
      const fus = new Path2D();
      fus.moveTo(340, 292);
      fus.lineTo(856, 292);
      fus.quadraticCurveTo(946, 297, 990, 317);
      fus.lineTo(990, 323);
      fus.quadraticCurveTo(946, 343, 856, 348);
      fus.lineTo(340, 348);
      fus.quadraticCurveTo(283, 344, 271, 320);
      fus.quadraticCurveTo(283, 296, 340, 292);
      fus.closePath();
      c.fillStyle = '#fbfcfe'; c.strokeStyle = '#8d99a5'; c.lineWidth = 2;
      c.fill(fus);
      c.save();
      c.clip(fus);
      /* 胴体のシェーディング（上面ハイライト→腹の陰。光源=左上） */
      const hull = c.createLinearGradient(0, 292, 0, 348);
      hull.addColorStop(0, 'rgba(125,150,172,.20)');   // 上フチは空の映りこみ
      hull.addColorStop(0.18, 'rgba(255,255,255,.85)'); // ハイライト帯
      hull.addColorStop(0.42, 'rgba(255,255,255,.05)');
      hull.addColorStop(0.78, 'rgba(96,118,138,.14)');
      hull.addColorStop(1, 'rgba(70,92,112,.30)');      // 腹の陰
      c.fillStyle = hull;
      c.fillRect(258, 290, 745, 60);
      /* 青のチートライン（窓の下の飾り線） */
      c.fillStyle = ACC;
      c.fillRect(260, 329, 745, 3.5);
      c.fillStyle = '#ffd24a';
      c.fillRect(260, 332.5, 745, 1.8);
      /* 機首のワンポイント */
      c.fillStyle = ACC;
      c.beginPath(); c.moveTo(271, 306); c.quadraticCurveTo(282, 298, 300, 295); c.lineTo(300, 345); c.quadraticCurveTo(282, 342, 271, 334); c.closePath();
      c.globalAlpha = 0.12; c.fill(); c.globalAlpha = 1;
      /* パネルのつなぎ目（ごく薄く） */
      c.strokeStyle = 'rgba(120,135,150,.14)'; c.lineWidth = 1;
      [420, 560, 700, 840].forEach((px) => {
        c.beginPath(); c.moveTo(px, 292); c.lineTo(px, 348); c.stroke();
      });
      c.restore();
      c.stroke(fus);
      /* まどの列 */
      c.fillStyle = '#33414f';
      for (let wx = 428; wx <= 858; wx += 26) {
        this.rr(wx, 303, 9, 6, 2.5); c.fill();
      }
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
      /* 垂直尾翼（上から見た形・雲マークつき） */
      const tail = c.createLinearGradient(890, 0, 996, 0);
      tail.addColorStop(0, '#1ba0c6');
      tail.addColorStop(1, ACC_D);
      c.fillStyle = tail;
      c.beginPath();
      c.moveTo(890, 317); c.lineTo(980, 312); c.lineTo(996, 320); c.lineTo(980, 328); c.lineTo(890, 323);
      c.closePath(); c.fill();
      c.strokeStyle = ACC_D; c.lineWidth = 1.5; c.stroke();
      c.strokeStyle = '#fff'; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(946, 320); c.quadraticCurveTo(958, 313, 972, 318); c.stroke();
      c.fillStyle = '#ffd24a';
      c.beginPath(); c.arc(936, 319, 2.6, 0, TAU); c.fill();
      /* 衝突防止ライト（赤の点滅・胴体の中央） */
      const blink = 0.35 + 0.65 * Math.abs(Math.sin(this.time * 3.4));
      c.fillStyle = `rgba(255,90,90,${blink * 0.35})`;
      c.beginPath(); c.arc(640, 320, 7, 0, TAU); c.fill();
      c.fillStyle = `rgba(255,70,70,${blink})`;
      c.beginPath(); c.arc(640, 320, 3.2, 0, TAU); c.fill();

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
      c.font = 'bold 13px ' + CF + '';
      c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText('AOZORA', 356, 302);

      c.restore();
    },

    updateBridge(state, dtReal) {
      const closed = state.tasks.doorclose.status === 'done';
      const target = (closed || !this.planeParked) ? 0 : 1;
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

    /* ロックが開いた瞬間、その持ち場でリングを広げて知らせる */
    popSpot(taskId) { this.spotFx[taskId] = 0; },

    drawSpotPops(dtReal) {
      const c = this.ctx;
      Object.keys(this.spotFx).forEach((id) => {
        this.spotFx[id] += dtReal;
        const p = this.spotFx[id] / 1.1;
        const a = this.anchorOf(id);
        if (p >= 1 || !a) { delete this.spotFx[id]; return; }
        c.save();
        c.globalAlpha = 1 - p;
        c.strokeStyle = '#2e9e5b';
        c.lineWidth = 3.5;
        c.beginPath(); c.arc(a[0], a[1], 16 + p * 44, 0, TAU); c.stroke();
        c.restore();
      });
    },

    /* 「もうすぐできる」持ち場の予告。
     * 前提の作業がぜんぶ進行中のときだけ、うすいサークルと「あと◯ふん」を出す。 */
    drawSoonSpots(state) {
      const c = this.ctx;
      const G = window.Game;
      state.taskList.forEach((t) => {
        if (t.status !== 'locked') return;
        const rest = G.opensInMinutes(t.id);
        if (rest == null) return;
        const a = this.anchorOf(t.id);
        if (!a) return;
        c.save();
        c.setLineDash([4, 4]);
        c.strokeStyle = 'rgba(88, 104, 120, 0.7)';
        c.fillStyle = 'rgba(255, 255, 255, 0.45)';
        c.lineWidth = 2;
        c.beginPath(); c.arc(a[0], a[1], 15, 0, TAU); c.fill(); c.stroke();
        c.setLineDash([]);
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = '12px sans-serif';
        c.fillStyle = '#54636f';
        c.fillText('🔒', a[0], a[1] + 0.5);
        /* Canvasにはルビが振れないので、かな書き */
        const label = `あと${rest}ふん`;
        c.font = 'bold 10px ' + CF + '';
        const w = c.measureText(label).width + 10;
        c.fillStyle = 'rgba(246, 249, 251, 0.95)';
        this.rr(a[0] - w / 2, a[1] + 18, w, 15, 7); c.fill();
        c.strokeStyle = '#9aa8b5'; c.lineWidth = 1;
        this.rr(a[0] - w / 2, a[1] + 18, w, 15, 7); c.stroke();
        c.fillStyle = '#54636f';
        c.fillText(label, a[0], a[1] + 26);
        c.restore();
      });
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
        /* あと何人・何台（かなが振れないのでアイコンで） */
        if (t.status === 'gathering') {
          const missing = G.missingIcons(t.id);
          if (missing) {
            c.font = 'bold 10px ' + CF + '';
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
          c.font = 'bold 9px ' + CF + '';
          c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText('ねんりょう', 11, -7);
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

    /* ---------- 人物（地上スタッフ。等身高めのフラットな作業員） ----------
     * x, yFeet = 足もとの座標。全長約24px。かわいさよりも「現場のプロ」の造形。
     * o: { color(ベスト色), phase(歩行サイクル), moving, working, sway(待機のゆれ) } */
    drawPerson(x, yFeet, o) {
      const c = this.ctx;
      const walk = o.moving ? Math.sin(o.phase) : 0;           // -1..1 交互の足
      const bob = o.moving ? Math.abs(Math.cos(o.phase)) * 0.7 // 歩行の上下はひかえめに
        : o.working ? Math.sin(o.phase * 0.5) * 0.5
        : (o.sway || 0);
      const top = yFeet - 24 - bob;                            // 頭のてっぺん
      c.save();
      /* かげ（光源=左上 → 右下へ少しずらす） */
      c.fillStyle = 'rgba(30,40,54,.22)';
      c.beginPath(); c.ellipse(x + 1.6, yFeet + 1.4, 5.4, 2.2, 0, 0, TAU); c.fill();
      /* 足（ネイビーの作業ズボン。歩くと交互に前後） */
      c.strokeStyle = '#39434f'; c.lineWidth = 2.4; c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - 1.9, yFeet - 8.5); c.lineTo(x - 1.9 + walk * 2.2, yFeet - walk * 1.2);
      c.moveTo(x + 1.9, yFeet - 8.5); c.lineTo(x + 1.9 - walk * 2.2, yFeet + walk * 1.2);
      c.stroke();
      /* うで（歩行時は足と逆にふる。作業中はわずかに前へ） */
      const armY = top + 10;
      const armSwing = o.moving ? walk * 2.2 : 0;
      const armLift = o.working ? -1.6 + Math.sin(o.phase) * 0.8 : 0;
      c.strokeStyle = o.color; c.lineWidth = 2.1;
      c.beginPath();
      c.moveTo(x - 4.2, armY); c.lineTo(x - 5.2 - armSwing * 0.5, armY + 6 + armSwing + armLift);
      c.moveTo(x + 4.2, armY); c.lineTo(x + 5.2 + armSwing * 0.5, armY + 6 - armSwing + armLift);
      c.stroke();
      c.lineCap = 'butt';
      /* 胴体（ハイビズベスト: 肩がわずかに広い台形） */
      c.fillStyle = o.color;
      c.strokeStyle = 'rgba(30,40,50,.45)'; c.lineWidth = 1.1;
      c.beginPath();
      c.moveTo(x - 4.6, top + 8);
      c.lineTo(x + 4.6, top + 8);
      c.lineTo(x + 3.9, top + 17);
      c.lineTo(x - 3.9, top + 17);
      c.closePath(); c.fill(); c.stroke();
      /* ベスト下半分のかげ（体の丸みを出す） */
      c.fillStyle = 'rgba(25,38,52,.14)';
      c.beginPath();
      c.moveTo(x - 4.25, top + 13); c.lineTo(x + 4.25, top + 13);
      c.lineTo(x + 3.9, top + 17); c.lineTo(x - 3.9, top + 17);
      c.closePath(); c.fill();
      /* 反射ベストの2本ライン（実物のハイビズと同じ） */
      c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.1;
      c.beginPath();
      c.moveTo(x - 4.3, top + 11); c.lineTo(x + 4.3, top + 11);
      c.moveTo(x - 4.05, top + 14); c.lineTo(x + 4.05, top + 14);
      c.stroke();
      /* 頭（小さめ・落ちついた肌色） */
      c.fillStyle = '#e8bf95';
      c.beginPath(); c.arc(x, top + 4.4, 3.6, 0, TAU); c.fill();
      /* 目（小さく2点。表情はひかえめ） */
      c.fillStyle = '#33404d';
      c.beginPath(); c.arc(x - 1.4, top + 4.9, 0.6, 0, TAU); c.fill();
      c.beginPath(); c.arc(x + 1.4, top + 4.9, 0.6, 0, TAU); c.fill();
      /* ヘルメット（白。つば+通気ラインでそれらしく） */
      c.fillStyle = '#f2f4f6';
      c.beginPath(); c.arc(x, top + 3.9, 3.9, Math.PI, 0); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(90,105,120,.55)'; c.lineWidth = 0.9;
      c.beginPath(); c.moveTo(x - 4.6, top + 3.9); c.lineTo(x + 4.6, top + 3.9); c.stroke();
      c.strokeStyle = 'rgba(90,105,120,.35)';
      c.beginPath(); c.arc(x, top + 3.7, 2.2, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
      c.restore();
      return top;   // バッジ表示用に頭の位置を返す
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
        c.fillStyle = 'rgba(30,40,54,.18)';
        c.beginPath(); c.ellipse(4, 7, 50, 16, 0, 0, TAU); c.fill();
        c.restore();
        c.rotate(ang);
        this.vehicleBody(e.type, active, gt, reverse);
        /* 作業中はキャブの上で黄色の回転灯が点滅（実際のGSEと同じ） */
        if (active) {
          const CAB = { beltloader: -34, cart: -26, fuel: -38, catering: -33, pushback: 0 };
          const bx = CAB[e.type] != null ? CAB[e.type] : 0;
          const bl = 0.3 + 0.7 * Math.abs(Math.sin(this.time * 5 + x));
          c.fillStyle = `rgba(255,170,40,${(bl * 0.3).toFixed(3)})`;
          c.beginPath(); c.arc(bx, 0, 6.5, 0, TAU); c.fill();
          c.fillStyle = `rgba(255,150,20,${bl.toFixed(3)})`;
          c.beginPath(); c.arc(bx, 0, 2.5, 0, TAU); c.fill();
        }
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
        const working = e.status === 'working' && e.taskId !== 'inspect';
        if (e.id === selected) {
          c.strokeStyle = '#fff'; c.lineWidth = 3;
          c.beginPath(); c.arc(x, y - 9, 16, 0, TAU); c.stroke();
          c.strokeStyle = '#0f8fb0'; c.lineWidth = 2;
          c.beginPath(); c.arc(x, y - 9, 19 + Math.sin(this.time * 6) * 2, 0, TAU); c.stroke();
        }
        /* 人物（歩行サイクルは個体ごとに位相をずらす） */
        const idx = Number(e.id.slice(1)) || 0;
        const top = this.drawPerson(x, y, {
          color: meta.color,
          moving,
          working,
          phase: moving ? gt * 26 + idx * 2.1 : gt * 6 + idx * 2.1,
          sway: (!moving && !working) ? Math.sin(this.time * 1.7 + idx * 1.9) * 0.5 : 0,
        });
        /* 熟練度バッジ（頭の上） */
        if (e.skill === 'vet' || e.skill === 'rookie') {
          c.font = '9px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(e.skill === 'vet' ? '⭐' : '🔰', x, top - 5);
        }
      });

      /* 選択中エンティティのラベル */
      if (selected) {
        const e = state.entities.find((x) => x.id === selected);
        const rec = e && this.ent[e.id];
        if (e && rec) {
          const meta = e.kind === 'staff' ? window.RES_META.staff[e.type] : window.RES_META.vehicles[e.type];
          const skillTxt = e.skill === 'vet' ? '⭐はやい ' : e.skill === 'rookie' ? '🔰ゆっくり ' : '';
          const label = `${meta.icon}${e.label} ${skillTxt}— いきさきをタップ！`;
          c.font = 'bold 11px ' + CF + '';
          const w = c.measureText(label).width + 14;
          const lx = rec.pos.x, ly = rec.pos.y - (e.kind === 'staff' ? 36 : 42);
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
      this.paxDots.forEach((d, i) => {
        const t01 = d.dir === 'out' ? d.p : 1 - d.p;
        const pts = BRIDGE_PATH;
        const seg = t01 < 0.5 ? 0 : 1;
        const k = (t01 - seg * 0.5) / 0.5;
        const x = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * k;
        const y = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * k;
        /* ミニ人物（体+頭+髪。歩きの上下はひかえめ） */
        const hop = Math.abs(Math.sin((d.p * 26) + i)) * 0.5;
        c.fillStyle = d.color;
        this.rr(x - 2.2, y - 4.5 - hop, 4.4, 5.4, 2.2); c.fill();
        c.fillStyle = '#f6cfa4';
        c.beginPath(); c.arc(x, y - 6.6 - hop, 2.1, 0, TAU); c.fill();
        c.fillStyle = 'rgba(60,50,40,.55)';
        c.beginPath(); c.arc(x, y - 7.5 - hop, 2.1, Math.PI * 1.05, Math.PI * 1.95); c.fill();
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
        text = `🚶 おりる人 のこり${n}人`;
      } else if (brd.status === 'active') {
        const n = Math.floor(clamp(brd.progress / G.effDur(brd), 0, 1) * PAX_TOTAL);
        text = `🧑‍🤝‍🧑 のる人 ${n}/${PAX_TOTAL}人`;
      }
      if (!text) return;
      c.font = 'bold 12px ' + CF + '';
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
      /* 雷雨イベント中はつよい雨、rainAllステージ（ステージ5）はずっとよわい雨 */
      const storm = state.outdoorPauseUntil != null && state.clock < state.outdoorPauseUntil;
      const always = !!(state.stage && state.stage.rainAll);
      if (!storm && !always) return;
      const c = this.ctx;
      c.fillStyle = storm ? 'rgba(45, 62, 88, 0.13)' : 'rgba(45, 62, 88, 0.05)';
      c.fillRect(0, 0, SCENE_W, SCENE_H);
      c.strokeStyle = storm ? 'rgba(210, 228, 246, 0.75)' : 'rgba(210, 228, 246, 0.5)';
      c.lineWidth = storm ? 2.2 : 1.7;
      c.lineCap = 'round';
      c.beginPath();
      const n = storm ? 80 : 52;
      for (let i = 0; i < n; i++) {
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
    bgm: Bgm,
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
        'stage-list', 'modal-backdrop', 'modal', 'panel-tasks', 'panel-status', 'flow-ribbon',
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
      $('#btn-title-zukan').addEventListener('click', () => { Sfx.play('click'); this.openZukan('flow'); });
      $('#btn-flowmap').addEventListener('click', () => { Sfx.play('click'); cb.onFlowMap(); });
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
        this.els['btn-log-toggle'].textContent = open ? '📜 きろくをとじる ▴' : '📜 きろくを見る ▾';
      });

      /* ズーム */
      this.els['btn-zoom-in'].addEventListener('click', () => { Sfx.play('click'); Scene.zoomAt(1.3); });
      this.els['btn-zoom-out'].addEventListener('click', () => { Sfx.play('click'); Scene.zoomAt(1 / 1.3); });
      this.els['btn-zoom-reset'].addEventListener('click', () => { Sfx.play('click'); Scene.resetCam(); });

      this.bindCanvasInput();

      this.els['modal-backdrop'].addEventListener('click', (ev) => {
        if (ev.target === this.els['modal-backdrop'] && this.modalKind && this.modalDismissible) this.closeModal();
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && this.modalKind && this.modalDismissible) this.closeModal();
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
        /* 到着シネマティック中のタップはスキップ扱い */
        if (Scene.arrivalT != null) { Scene.arrivalT = 1; return; }
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
      const hit = Scene.hitTest(s, sx, sy);

      if (hit && hit.type === 'entity') {
        const e = s.entities.find((x) => x.id === hit.id);
        this.closeSpotPop();
        if (e.taskId === null && (e.status === 'idle' || e.status === 'returning')) {
          this.selected = (this.selected === e.id) ? null : e.id;
          Sfx.play('click');
        } else {
          const task = e.taskId ? s.tasks[e.taskId] : null;
          this.toast(`${e.label}はいま${task ? `「${task.def.name}」のおしごと中` : 'いそがしいみたい'}`, 'info');
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

    /* ---------------- ながれリボン（常時表示の進行バー） ----------------
     * 12の作業を「ステップ1〜7」の順に並べ、いまどこまで進んだかを一目で見せる。
     * 同じまるの中に入っている作業は「同時にできる仲間」。 */
    buildRibbon() {
      const wrap = this.els['flow-ribbon'];
      if (!wrap) return;
      this.ribbonChips = {};
      this.ribbonSteps = [];
      const rows = window.FLOW_ROWS;
      wrap.innerHTML = '<span class="fr-lead">🗺<br>ながれ</span>' + rows.map((row, i) => {
        const chips = row.tasks.map((id) => {
          const d = window.TASK_MAP[id];
          return `<button class="fr-chip" data-task="${id}" title="${d.name}">${d.icon}<span class="fr-mark"></span></button>`;
        }).join('');
        return `<span class="fr-step" data-step="${row.step}">` +
          `<button class="fr-num" data-step="${row.step}" title="ステップ${row.step}: ${row.title}">${row.step}</button>` +
          chips + '</span>' +
          (i < rows.length - 1 ? '<span class="fr-arrow">›</span>' : '');
      }).join('');

      wrap.querySelectorAll('.fr-chip').forEach((b) => {
        this.ribbonChips[b.dataset.task] = b;
        b.addEventListener('click', () => { Sfx.play('click'); this.onRibbonChip(b.dataset.task); });
      });
      wrap.querySelectorAll('.fr-num').forEach((b) => {
        const row = rows[Number(b.dataset.step) - 1];
        b.addEventListener('click', () => {
          Sfx.play('click');
          this.toast(`【ステップ${row.step}】${row.cond}`, 'info');
        });
      });
      rows.forEach((row) => {
        this.ribbonSteps.push({ row, el: wrap.querySelector(`.fr-step[data-step="${row.step}"]`) });
      });
      this.updateRibbon();
    },

    /* リボンのタップ: いまの状態におうじて「次にすること」へ案内する */
    onRibbonChip(id) {
      const s = this.state;
      if (!s) return;
      const t = s.tasks[id];
      if (t.status === 'locked') {
        this.toast('🔒 ' + window.Game.lockReason(id), 'warn');
      } else if (t.status === 'done') {
        this.toast(`✅ 「${t.def.name}」は もうおわったよ`, 'info');
      } else {
        this.openSpotPop(id);
      }
    },

    updateRibbon() {
      const s = this.state;
      if (!s || !this.ribbonChips) return;
      Object.keys(this.ribbonChips).forEach((id) => {
        const el = this.ribbonChips[id];
        const st = s.tasks[id].status;
        const cls = 'fr-' + (st === 'moving' ? 'gathering' : st);
        if (el.dataset.st === cls) return;
        el.dataset.st = cls;
        el.classList.remove('fr-locked', 'fr-ready', 'fr-gathering', 'fr-active', 'fr-done');
        el.classList.add(cls);
        el.querySelector('.fr-mark').textContent =
          st === 'done' ? '✓' : (st === 'ready' ? '!' : '');
      });
      this.ribbonSteps.forEach(({ row, el }) => {
        if (!el) return;
        const sts = row.tasks.map((id) => s.tasks[id].status);
        const done = sts.every((x) => x === 'done');
        const now = !done && sts.some((x) => x === 'ready' || x === 'gathering' || x === 'active');
        el.classList.toggle('fr-sdone', done);
        el.classList.toggle('fr-snow', now);
      });
    },

    /* ---------------- 作業スポットのポップオーバー ---------------- */
    openSpotPop(taskId) {
      const s = this.state;
      const t = s.tasks[taskId];
      if (!t) return;
      this.spotPopTask = taskId;
      const pop = this.els['spot-pop'];
      const G = window.Game;

      const rubi = window.rubi;
      let info = '';
      const btns = [];
      if (t.status === 'ready' || t.status === 'gathering') {
        const missing = G.missingSummary(t.id);
        info = missing
          ? `あと <strong>${rubi(missing)}</strong> がひつよう。<br>スタッフや車をタップでおくるか、おまかせでOK！`
          : rubi('メンバーがあつまっています。到着を待ちましょう。');
        if (missing) btns.push({ label: t.status === 'gathering' ? '▶ おまかせでそろえる' : '▶ おまかせではじめる', cls: 'btn-primary btn-sm', act: () => this.cb.onStartTask(t.id) });
        if (t.status === 'gathering') btns.push({ label: 'ストップ', cls: 'btn-warnghost btn-sm', act: () => this.cb.onCancelTask(t.id) });
      } else if (t.status === 'active') {
        info = rubi(`のこり 約${Math.max(1, Math.ceil(G.effDur(t) - t.progress))}分`);
        if (t.id !== 'pushback' && t.id !== 'depart') {
          btns.push({ label: 'ストップ', cls: 'btn-warnghost btn-sm', act: () => this.cb.onCancelTask(t.id) });
        }
      } else if (t.status === 'locked') {
        info = '🔒 ' + rubi(G.lockReason(t.id));
      } else if (t.status === 'done') {
        info = rubi(`✅ ${window.fmtClock(t.doneAt)}に かんりょう！`);
      }
      const opens = G.nextOpens(t.id);
      if (t.status !== 'done' && opens.length) {
        info += `<div class="sp-next">🔓 おわると → ${opens.map((d) => `${d.icon}${rubi(d.name)}`).join('・')}</div>`;
      }
      btns.push({ label: 'くわしく', cls: 'btn-ghost btn-sm', act: () => this.openTaskDetail(t.id) });

      const paceHtml = window.PACE_ALLOWED.has(t.id) && t.status !== 'done' && t.status !== 'locked'
        ? `<div class="pace-ctrl">${['careful', 'normal', 'rush'].map((p) =>
            `<button class="pace-btn pace-${p} ${t.pace === p ? 'on' : ''}" data-pace="${p}">${window.PACE[p].icon}${rubi(window.PACE[p].label)}</button>`).join('')}</div>`
        : '';

      pop.innerHTML = `
        <div class="sp-title"><span class="sp-step" data-step="${t.def.step || ''}">ステップ${t.def.step || '-'}</span>${t.def.icon} ${rubi(t.def.name)}</div>
        <div class="sp-info">${info}</div>
        ${paceHtml}
        <div class="sp-btns" style="margin-top:6px;"></div>`;
      const btnWrap = pop.querySelector('.sp-btns');
      btns.forEach((b) => {
        const el = document.createElement('button');
        el.className = 'btn ' + b.cls;
        el.innerHTML = b.label;
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
      /* 紙ふぶきは結果画面だけ。ほかの画面へ移ったら、すぐ消す */
      if (name !== 'result') document.querySelectorAll('.confetti-box').forEach((c) => c.remove());
      document.querySelectorAll('.screen').forEach((s) => { s.classList.remove('active'); s.inert = false; });
      const el = $('#screen-' + name);
      el.classList.add('active');
      el.scrollTop = 0;
      /* モーダルが開いたままなら、新しい画面もモーダルの裏として操作できないようにする */
      if (this.modalKind) { el.inert = true; this._inertEl = el; }
    },

    /* ---------------- ステージ選択 ---------------- */
    renderStageSelect(save, isUnlocked) {
      const rubi = window.rubi;
      const ic = (n, o) => (window.Icons ? window.Icons.svg(n, o) : '');
      const wrap = this.els['stage-list'];
      wrap.innerHTML = '';
      const TEN = '<ruby>点<rt>てん</rt></ruby>';
      /* むずかしさは表示だけ かなにする（データの 初級/中級/上級 は変えない） */
      const DIFF = { 初級: ['やさしい', 'easy'], 中級: ['ふつう', 'mid'], 上級: ['むずかしい', 'hard'] };
      /* 空の色の枠: ステージの天気（データの絵文字）ごとの空。晴れ=青→白 / くもり=灰 / かみなりが来るかも=青→暗い灰 / 夕方=紺→橙 / 雨=寒色の灰青 */
      const SKY = { '☀': 'clear', '⛅': 'cloudy', '🌦': 'storm', '🌇': 'dusk', '🌧': 'rain' };
      const skyOf = (e) => SKY[String(e || '').replace(/️/g, '')] || 'clear';
      const best0 = (id) => save.best && save.best[id];
      const nextId = (window.STAGES.find((st) => isUnlocked(st.id) && !(best0(st.id) && best0(st.id).cleared)) || {}).id;
      window.STAGES.forEach((st) => {
        const best = best0(st.id);
        const unlocked = isUnlocked(st.id);
        const cleared = !!(best && best.cleared);
        const stars = cleared ? (best.stars != null ? best.stars : (best.score >= 95 ? 3 : best.score >= 80 ? 2 : 1)) : 0;
        const starHtml = `<span class="sc-stars" role="img" aria-label="スター ${stars} / 3">${[1, 2, 3].map((i) =>
          ic(i <= stars ? 'star' : 'star-outline', { cls: i <= stars ? 'on' : 'off' })).join('')}</span>`;
        const parts = st.name.split('　');
        const num = parts[0];
        const title = parts.slice(1).join('　');
        const diff = DIFF[st.difficulty] || [st.difficulty, 'mid'];
        const wx = (window.Icons && window.Icons.emojiName(st.weather.icon)) || 'sun';
        /* つぎの★まで: いまの★が1なら 80点、2なら 95点 */
        let toNext = '';
        if (cleared && stars < 3) {
          const n = (stars === 1 ? 80 : 95) - best.score;
          if (n > 0) toNext = `<span class="sc-next">あと ${n}${TEN}で ${ic('star')}${stars + 1}</span>`;
        }
        const card = document.createElement('button');
        card.className = 'stage-card' + (unlocked ? '' : ' locked') + (st.id === nextId ? ' next' : '');
        if (!unlocked) card.setAttribute('aria-disabled', 'true');
        card.innerHTML = `
          <span class="sc-sky sky-${skyOf(st.weather.icon)}" aria-hidden="true">${ic(wx)}</span>
          <span class="sc-body">
            <span class="sc-row1">
              <span class="sc-name"><span class="sc-num">${num}</span><span class="sc-title">${this.phraseBreaks(rubi(title))}</span></span>
              ${unlocked ? `<span class="sc-diff diff-${diff[1]}">${diff[0]}</span>` : `<span class="sc-lockbadge" aria-hidden="true">${ic('lock')}</span>`}
            </span>
            <span class="sc-sub">${this.phraseBreaks(rubi(st.subtitle))}</span>
            <span class="sc-row2">
              <span class="sc-wx">${rubi(st.weather.label)}</span>
              ${!unlocked
                ? `<span class="sc-lock">${ic('lock')}ステージ${st.id - 1}を クリアすると あそべるよ</span>`
                : (cleared
                  ? `<span class="sc-best">${starHtml}${toNext}<span class="sc-score">ベスト ${best.score}${TEN}（${best.rank}）</span></span>`
                  : `<span class="sc-best sc-best-none">${starHtml}<span>まだ クリアしていない</span></span>`)}
            </span>
          </span>
          ${st.id === nextId ? '<span class="sc-nexttag">つぎは ここ</span>' : ''}`;
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
      /* 前の結果画面の紙ふぶきが残っていたら消す */
      const cf = document.querySelector('.confetti-box');
      if (cf) cf.remove();
      this.cardEls = {};
      this.chipEls = {};
      this.lastClockText = '';
      this.lastRemainText = '';
      this.selected = null;
      this.issueTask = null;
      this.coachShown = new Set();
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
      this.els['btn-log-toggle'].textContent = '📜 きろくを見る ▾';

      const rubi = window.rubi;
      this.els['start-overlay'].classList.remove('hidden');
      this.els['start-overlay-title'].innerHTML = rubi(state.stage.name);
      this.els['start-overlay-text'].innerHTML = rubi(state.stage.intro).replace(/\n/g, '<br>');
      document.getElementById('start-trivia').innerHTML = '💡 まめちしき: ' + rubi(pickTrivia());
      document.getElementById('pause-chip').classList.add('hidden');
      this.prevMetrics = { safety: 100, punct: 100, sat: 100, cost: 100 };

      const list = this.els['task-list'];
      list.innerHTML = '';
      state.taskList.forEach((t) => {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.id = 'card-' + t.id;
        const reqs = window.taskReqList(t.def).map((r) =>
          `<span class="req-chip" style="--c:${r.color}">${r.icon}${rubi(r.label)}×${r.n}</span>`).join('');
        const paceHtml = window.PACE_ALLOWED.has(t.id)
          ? `<div class="pace-ctrl">${['careful', 'normal', 'rush'].map((p) =>
              `<button class="pace-btn pace-${p}" data-pace="${p}" title="${p === 'rush' ? 'はやいが、まんぞく度(安全)が下がる' : p === 'careful' ? 'ゆっくりだが、まんぞく度が上がる' : 'ふつうのはやさ'}">${window.PACE[p].icon}${rubi(window.PACE[p].label)}</button>`).join('')}</div>`
          : '';
        card.innerHTML = `
          <div class="tc-head">
            <span class="tc-step" data-step="${t.def.step || ''}">ステップ${t.def.step || '-'}</span>
            <span class="tc-icon">${t.def.icon}</span>
            <span class="tc-name">${rubi(t.def.name)}</span>
            <span class="tc-state"></span>
          </div>
          <div class="tc-reqs">${reqs || '<span class="req-chip req-none">だれもいらない</span>'}</div>
          <div class="tc-bar"><div class="tc-fill"></div></div>
          <div class="tc-foot">
            <span class="tc-time"></span>
            <span class="tc-extra"></span>
            <span class="tc-prio ${t.def.priority === 'high' ? 'prio-high' : ''}">${t.def.priority === 'high' ? 'だいじ！' : 'ふつう'}</span>
          </div>
          ${paceHtml}
          <div class="tc-lockmsg"></div>
          <div class="tc-unlocks"></div>
          <div class="tc-btns">
            <button class="btn btn-sm btn-primary tc-start">はじめる</button>
            <button class="btn btn-sm btn-ghost tc-info">くわしく</button>
            <button class="btn btn-sm btn-warnghost tc-cancel hidden">ストップ</button>
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
        const skillMark = e.skill === 'vet' ? '⭐' : e.skill === 'rookie' ? '🔰' : '';
        if (e.skill === 'vet') chip.title = 'ベテラン: おしごとが15%はやい';
        if (e.skill === 'rookie') chip.title = 'ルーキー: おしごとが15%ゆっくり';
        chip.innerHTML = `<span class="rc-ico">${meta.icon}</span><span class="rc-name">${skillMark}${window.rubi(e.label)}</span><span class="rc-st"></span>`;
        (e.kind === 'staff' ? sStrip : vStrip).appendChild(chip);
        this.chipEls[e.id] = chip;
      });
      this.buildRibbon();
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
      const rubi = window.rubi;
      const stEl = card.querySelector('.tc-state');
      const stMap = {
        locked: '🔒 まだ', ready: 'はじめられるよ！', gathering: '🚶 あつまり中',
        active: '⚙ おしごと中', done: '✅',
      };
      stEl.textContent = issue ? '⚠ トラブル！' : (paused ? '⏸ ストップ中（天気）' : (stMap[t.status] || t.status));

      const G = window.Game;
      const timeEl = card.querySelector('.tc-time');
      if (t.status === 'done') {
        timeEl.textContent = `かんりょう ${window.fmtClock(t.doneAt)}`;
      } else if (t.status === 'active') {
        timeEl.textContent = (paused ? '⏸ ' : '') + `のこり 約${Math.max(1, Math.ceil(G.effDur(t) - t.progress))}分`;
      } else if (t.status === 'gathering') {
        const missing = G.missingSummary(id);
        if (paused) timeEl.textContent = '⏸ 天気がよくなるまで待ってね…';
        else if (missing) timeEl.innerHTML = 'あと ' + rubi(missing);
        else timeEl.textContent = 'メンバーがむかっています…';
      } else {
        timeEl.textContent = `かかる時間 約${Math.ceil(G.effDur(t) - t.progress)}分`;
      }
      card.querySelector('.tc-extra').innerHTML = rubi(t.extra || '');

      const fill = card.querySelector('.tc-fill');
      fill.style.width = `${clamp((t.progress / G.effDur(t)) * 100, 0, 100)}%`;

      const lockEl = card.querySelector('.tc-lockmsg');
      if (t.status === 'locked') {
        lockEl.innerHTML = '🔒 ' + rubi(window.Game.lockReason(id));
        lockEl.classList.add('show');
      } else {
        lockEl.textContent = '';
        lockEl.classList.remove('show');
      }

      /* この作業がおわると、つぎに何が開くか（順番のつながりを見せる） */
      const unEl = card.querySelector('.tc-unlocks');
      if (unEl) {
        const opens = window.Game.nextOpens(id).filter((d) => !d.auto);
        if (opens.length && t.status !== 'done' && t.status !== 'locked') {
          unEl.innerHTML = '🔓 おわると → ' + opens.map((d) => `${d.icon}${rubi(d.name)}`).join('・');
          unEl.classList.add('show');
        } else {
          unEl.classList.remove('show');
        }
      }

      /* ペースの選択状態 */
      card.querySelectorAll('.pace-btn').forEach((el) => {
        el.classList.toggle('on', el.dataset.pace === t.pace);
      });

      const btnStart = card.querySelector('.tc-start');
      const btnCancel = card.querySelector('.tc-cancel');
      const gatherFilled = t.status === 'gathering' && !G.missingSummary(id);
      btnStart.classList.toggle('hidden', t.status === 'active' || t.status === 'done' || gatherFilled);
      btnStart.textContent = t.status === 'gathering' ? 'おまかせでそろえる' : 'はじめる';
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
      const rubi = window.rubi;
      const I = window.Icons;
      const t = this.state.tasks[id];
      /* 作業・職種・車のアイコンは Icons.task / Icons.res で出す（作業の絵文字は iconize にわたさない） */
      const reqs = window.taskReqList(t.def).map((r) =>
        `<span class="req-chip" style="--c:${r.color}">${I.svg(I.res(r.type))}${rubi(r.label)}×${r.n}</span>`).join('') || 'なし';
      const canStart = t.status === 'ready' || t.status === 'gathering';
      const buttons = [{ label: 'とじる', cls: 'btn-ghost' }];
      /* はじめられる・あつまり中なら、ここからそのまま はじめられる（ボタンで閉じてから onStartTask） */
      if (canStart) buttons.push({ label: `${I.svg('play')} はじめる`, cls: 'btn-primary', onClick: () => this.cb.onStartTask(t.id) });
      this.openModal({
        kind: 'detail',
        title: `${I.svg(I.task(t.id))} ${rubi(t.def.name)}`,
        body: `
          <p>${rubi(t.def.desc)}</p>
          <dl class="td-kv">
            <dt>かかる${rubi('時間')}</dt><dd>${rubi(`約${Math.max(1, Math.ceil(window.Game.effDur(t)))}分`)}</dd>
            <dt>ひつような<ruby>人<rt>ひと</rt></ruby>と<ruby>車<rt>くるま</rt></ruby></dt><dd>${reqs}</dd>
            <dt>はじめられるのは</dt><dd>${rubi(t.def.depNote)}</dd>
          </dl>
          ${t.def.why ? `<p class="zk-why">${I.svg('info')} <strong>なぜやるの？</strong> ${rubi(t.def.why)}</p>` : ''}
          ${t.def.note ? `<p class="modal-note">${I.svg('shield')} <strong>${rubi('安全')}メモ</strong> ${rubi(t.def.note)}</p>` : ''}`,
        buttons,
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
      const stMap = { idle: 'スタンバイ', moving: 'いどう中', working: 'おしごと中', returning: 'もどり中' };
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
      if (!this.prevMetrics) this.prevMetrics = { safety: 100, punct: 100, sat: 100, cost: 100 };
      const upd = (key, val) => {
        const v = Math.round(val);
        const bar = this.els['bar-' + key];
        const num = this.els['val-' + key];
        const prev = this.prevMetrics[key];
        /* 2ポイント以上動いたら「±N」を浮かせる（定時性のじわじわ減少は除く） */
        if (key !== 'punct' && Math.abs(v - prev) >= 2) {
          const delta = v - prev;
          const span = document.createElement('span');
          span.className = 'metric-delta ' + (delta < 0 ? 'minus' : 'plus');
          span.textContent = (delta > 0 ? '+' : '') + delta;
          bar.parentElement.parentElement.appendChild(span);
          setTimeout(() => span.remove(), 1500);
          bar.classList.remove('hit');
          void bar.offsetWidth;
          bar.classList.add('hit');
        }
        if (Math.abs(v - prev) >= 1) this.prevMetrics[key] = v;
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
      /* ドロワーのバッジ: いま開始できる作業の数 */
      const ready = s.taskList.filter((t) => t.status === 'ready').length;
      const badge = document.getElementById('drawer-badge');
      badge.textContent = String(ready);
      badge.classList.toggle('hidden', ready === 0);
    },

    /* 一時停止チップ */
    setPausedIndicator(show) {
      document.getElementById('pause-chip').classList.toggle('hidden', !show);
    },

    updateHint(force) {
      if (!this.state) return;
      const now = performance.now();
      if (!force && now - this.hintThrottle < 800) return;
      this.hintThrottle = now;
      const el = this.els['hint-banner'];
      const hint = window.Game.getHint();
      if (hint) {
        if (this._lastHint !== hint) {
          this._lastHint = hint;
          el.innerHTML = '💡 ' + window.rubi(hint);
        }
        el.classList.remove('hidden');
      } else {
        this._lastHint = null;
        el.classList.add('hidden');
      }
    },

    addLog(entry) {
      const li = document.createElement('li');
      li.className = 'lg-' + entry.cls;
      li.innerHTML = `<span class="lg-t">${window.fmtClock(entry.t)}</span>${window.rubi(entry.msg)}`;
      const ul = this.els['game-log'];
      ul.prepend(li);
      while (ul.children.length > 40) ul.removeChild(ul.lastChild);
    },

    toast(msg, type) {
      const div = document.createElement('div');
      div.className = 'toast toast-' + (type || 'info');
      div.innerHTML = window.rubi(msg);
      this.els['toast-area'].appendChild(div);
      const life = type === 'coach' ? 7200 : 3400;
      setTimeout(() => { div.classList.add('out'); }, life);
      setTimeout(() => { div.remove(); }, life + 500);
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
        remainText = 'しゅっぱつ！';
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
      b.innerHTML = `${def.icon} <strong>${window.rubi(def.title)}</strong> — タップしてえらぶ！`;
      b.classList.remove('hidden');
    },
    hideEventBanner() {
      this.els['event-banner'].classList.add('hidden');
      if (this.modalKind === 'event') this.closeModal();
    },
    openEventModal() {
      const s = this.state;
      if (!s || !s.activeEvent) return;
      const rubi = window.rubi;
      const I = window.Icons;
      const def = s.activeEvent.def;
      const choicesHtml = def.choices.map((ch, i) => `
        <button class="event-choice" data-i="${i}">
          <span class="ec-top"><span class="ec-label">${rubi(ch.label)}</span>${i === def.defaultChoice ? `<span class="ec-default">${I.svg('hourglass')} えらばないと これ</span>` : ''}</span>
          <span class="ec-hint">${rubi(ch.hint)}</span>
          ${ch.critical ? `<span class="ec-crit">${I.svg('alert')} ${rubi('大きなペナルティ')}</span>` : ''}
          ${this.eventChoiceGrid(ch)}
        </button>`).join('');
      /* 期限: 時間で決まるイベントは「あと約N分」、作業で決まるイベントは「〇〇が おわるまで」（その作業がおしごと中なら のこりの分も） */
      let deadline = '';
      if (def.deadlineAfter != null) {
        const left = Math.max(1, Math.ceil(def.deadlineAfter - (s.clock - s.activeEvent.firedAt)));
        deadline = `えらべるのは あと約${left}分`;
      } else if (def.deadlineTask && s.tasks[def.deadlineTask]) {
        const dt = s.tasks[def.deadlineTask];
        deadline = `「${dt.def.name}」が おわるまでに えらんでね`;
        if (dt.status === 'active') deadline += `（あと約${Math.max(1, Math.ceil(window.Game.effDur(dt) - dt.progress))}分）`;
      }
      const nm = I.emojiName(def.icon);
      const titleIcon = nm && !/^(task|staff|veh)-/.test(nm) ? nm : 'alert';
      this.openModal({
        kind: 'event',
        title: `${I.svg(titleIcon)} ${rubi(def.title)}`,
        body: `<p>${rubi(def.desc)}</p>
               <p class="ev-legend" aria-hidden="true"><span><b class="up">▲</b> よくなる</span><span><b class="down">▼</b> わるくなる</span><span>— かわらない</span></p>
               <div class="event-choices">${choicesHtml}</div>
               ${deadline ? `<p class="modal-note">${I.svg('hourglass')} ${rubi(deadline)}</p>` : ''}
               <p class="modal-info" style="margin-top:8px;">${I.svg('info')} よんでいる あいだも じかんは すすむよ。とめたいときは『あとで きめる』で とじて ${I.svg('pause')} を おしてね</p>`,
        buttons: [{ label: 'あとで きめる', cls: 'btn-ghost' }],
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
      const rubi = window.rubi;
      const I = window.Icons;
      this.openModal({
        kind: 'safety',
        title: `${I.svg('shield')} ${rubi('プッシュバック前の安全確認')}`,
        body: `<p>${rubi('押す車が飛行機の前に着きました。動かす前に、まわりに')}<strong><ruby>人<rt>ひと</rt></ruby>・<ruby>車<rt>くるま</rt></ruby>・${rubi('置きわすれた道具')}</strong>${rubi('がのこっていないかたしかめます。どうする？')}</p>`,
        buttons: [
          /* 安全な主ボタンを先頭に。危ない選択は枠だけの赤（塗らない） */
          { label: `${I.svg('shield')} ` + rubi('しっかり確認する（+1分）'), cls: 'btn-primary btn-big', onClick: () => this.cb.onSafetyChoice(true) },
          { label: `${I.svg('alert')} ` + rubi('確認をとばして急ぐ（大きなペナルティ）'), cls: 'btn-dangerghost', onClick: () => this.cb.onSafetyChoice(false) },
        ],
        dismissible: false,
      });
    },

    /* 作業の短い名前（結果のタイムライン・イベントのマスで使う。正式な名前は TASK_MAP の name） */
    SHORT_NAMES: {
      deboard: '降機', unload: '取り降ろし', clean: '清掃', catering: '機内食', refuel: '給油', inspect: '点検',
      load: '積み込み', board: '搭乗', bagmatch: '照合', doorclose: 'ドアクローズ', pushback: 'プッシュバック', depart: '出発',
    },

    /* イベントの選択肢ごとの4つのマス（あんぜん・じかん・まんぞく・おかね）。データ（effects・taskDelta）から作る。
     * ▲=よくなる / ▼=わるくなる。大きさは記号の数（1〜5 は1つ、6〜10 は2つ、11 以上は3つ）。0 やキーがないときは「—」 */
    eventChoiceGrid(ch) {
      const rubi = window.rubi;
      const I = window.Icons;
      const eff = ch.effects || {};
      const marks = (v) => (v > 0 ? '▲' : '▼').repeat(Math.abs(v) >= 11 ? 3 : Math.abs(v) >= 6 ? 2 : 1);
      const cell = (icon, key, cls, val) =>
        `<span class="ec-cell ${cls}">${I.svg(icon)}<span class="ec-k">${key}</span><span class="ec-v">${val}</span></span>`;
      const metric = (icon, key, k) => {
        const v = Math.round(eff[k] || 0);
        return v ? cell(icon, key, v > 0 ? 'up' : 'down', `<span class="sym" aria-label="${v > 0 ? 'よくなる' : 'わるくなる'}">${marks(v)}</span>`)
          : cell(icon, key, 'none', '—');
      };
      /* じかん: 作業がのびる(+)=わるくなる / ちぢむ(-)=よくなる。外のおしごとのおやすみも わるくなる */
      const SHORT = this.SHORT_NAMES;
      const tparts = [];
      let tdir = 0;
      Object.entries(ch.taskDelta || {}).forEach(([id, d]) => {
        if (!d) return;
        const nm = SHORT[id] || (window.TASK_MAP[id] ? window.TASK_MAP[id].name : id);
        tparts.push(`${rubi(nm)} ${d > 0 ? '+' : '-'}${rubi(Math.abs(d) + '分')}`);
        tdir += d > 0 ? -1 : 1;
      });
      if (ch.pauseOutdoor) { tparts.push(`そとの おしごと ${rubi(ch.pauseOutdoor + '分')} おやすみ`); tdir -= 1; }
      const timeCell = tparts.length
        ? cell('clock', 'じかん', tdir >= 0 ? 'up' : 'down', `<span class="sym" aria-label="${tdir >= 0 ? 'よくなる' : 'わるくなる'}">${tdir >= 0 ? '▲' : '▼'}</span> ${tparts.join('・')}`)
        : cell('clock', 'じかん', 'none', '—');
      return `<span class="ec-grid">${metric('shield', 'あんぜん', 'safety')}${timeCell}${metric('smile', 'まんぞく', 'sat')}${metric('coin', 'おかね', 'cost')}</span>`;
    },

    /* ---------------- モーダル共通 ---------------- */
    /* openModal({kind, title, body, buttons, dismissible, cls, foot})
     *   ・見出し・本文・ボタンの3段（本文だけスクロール）。dismissible なら見出しの右に「とじる」(44x44)
     *   ・cls と data-kind は毎回付け直す（前のモーダルのクラスを残さない）
     *   ・buttons[].silent=true のボタンは、閉じても onModalClosed を呼ばない（チュートリアルのページ送りなど）
     *   ・開いている間は、うしろの画面を inert にして、閉じたら元のボタンへフォーカスを戻す */
    openModal({ kind, title, body, buttons, dismissible, cls, foot }) {
      const rubi = window.rubi;
      const ize = (h) => (window.Icons ? window.Icons.iconize(h) : h);
      const m = this.els['modal'];
      const wasOpen = !!this.modalKind;
      if (!wasOpen && !this._modalReturn) this._modalReturn = document.activeElement;
      this.modalKind = kind || 'generic';
      this.modalDismissible = dismissible !== false;
      m.className = 'modal' + (cls ? ' ' + cls : '');
      m.dataset.kind = this.modalKind;
      const btns = (buttons || []).map((b, i) =>
        `<button class="btn ${b.cls || 'btn-ghost'}" data-mb="${i}">${ize(rubi(b.label))}</button>`).join('');
      const x = this.modalDismissible
        ? `<button class="modal-x" type="button" aria-label="とじる" title="とじる">${window.Icons ? window.Icons.svg('close') : '×'}</button>` : '';
      m.innerHTML = `
        <div class="modal-head"><h2 class="modal-title" id="modal-title">${ize(rubi(title))}</h2>${x}</div>
        <div class="modal-body">${ize(rubi(body))}</div>
        ${foot ? `<div class="modal-foot">${ize(rubi(foot))}</div>` : ''}
        <div class="modal-btns">${btns}</div>`;
      (buttons || []).forEach((b, i) => {
        m.querySelector(`[data-mb="${i}"]`).addEventListener('click', () => {
          this.closeModal({ silent: !!b.silent });
          if (b.onClick) b.onClick();
        });
      });
      const xb = m.querySelector('.modal-x');
      if (xb) xb.addEventListener('click', () => { Sfx.play('click'); this.closeModal(); });
      this.els['modal-backdrop'].classList.remove('hidden');
      m.scrollTop = 0;
      const bodyEl = m.querySelector('.modal-body');
      if (bodyEl) bodyEl.scrollTop = 0;
      /* うしろの画面は操作できないようにする（Tab でモーダルの外へ出ない） */
      const scr = document.querySelector('.screen.active');
      if (scr) { scr.inert = true; this._inertEl = scr; }
      /* 最初の選択肢か主ボタンへフォーカス（ずかんのタブを切りかえたときは、えらんだタブへ） */
      const first = m.querySelector('.zk-tab.on') || m.querySelector('.event-choice') ||
        m.querySelector('.modal-btns .btn-primary') || m.querySelector('.modal-btns .btn') || xb;
      if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
    },
    /* closeModal({silent}): silent のときは onModalClosed を呼ばず、フォーカスの戻り先も覚えたまま（つぎのモーダルへ移るとき） */
    closeModal(opts) {
      const silent = !!(opts && opts.silent === true);
      const m = this.els['modal'];
      this.els['modal-backdrop'].classList.add('hidden');
      m.innerHTML = '';
      m.className = 'modal';
      delete m.dataset.kind;
      if (this._inertEl) { this._inertEl.inert = false; this._inertEl = null; }
      const k = this.modalKind;
      this.modalKind = null;
      if (silent) return;
      const back = this._modalReturn;
      this._modalReturn = null;
      if (back && back.isConnected && typeof back.focus === 'function' && back !== document.body) {
        try { back.focus({ preventScroll: true }); } catch (e) { /* フォーカスできない要素は そのまま */ }
      }
      if (this.cb.onModalClosed) this.cb.onModalClosed(k);
    },

    /* ---------------- ながれマップ・ずかん・コーチ ---------------- */
    buildFlowHtml(live) {
      const s = live ? this.state : null;
      const rubi = window.rubi;
      const I = window.Icons;
      /* 作業の状態 → 見た目（契約: かんりょう=緑✓ / おしごと中=青緑ぬり+輪 / はじめられる=白+青緑わく+▶ / あつまり中=こはく+… / まだ=灰の点線+鍵） */
      const ST = {
        done: ['fc-done', 'check', 'かんりょう'], active: ['fc-active', 'working', 'おしごと<ruby>中<rt>ちゅう</rt></ruby>'],
        ready: ['fc-ready', 'play', 'はじめられる'], gathering: ['fc-wait', 'dots', 'あつまり<ruby>中<rt>ちゅう</rt></ruby>'],
        moving: ['fc-wait', 'dots', 'あつまり<ruby>中<rt>ちゅう</rt></ruby>'], locked: ['fc-locked', 'lock', 'まだ'],
      };
      const chip = (id) => {
        const def = window.TASK_MAP[id];
        const name = `${I.svg(I.task(id))}${rubi(def.name)}`;
        if (!s) return `<span class="flow-chip flat">${name}</span>`;
        /* ゲーム中だけ押せるボタン（押すと、とじてから持ち場の案内へ） */
        const st = ST[s.tasks[id].status] || ST.locked;
        return `<button type="button" class="flow-chip ${st[0]}" data-task="${id}">${name}${I.svg(st[1], { cls: 'fc-st' })}</button>`;
      };
      /* いまここ: 進行中の作業がある、番号がいちばん大きいステップ1か所だけ */
      const busy = (x) => x === 'ready' || x === 'gathering' || x === 'moving' || x === 'active';
      const rows = window.FLOW_ROWS;
      let front = -1;
      if (s) rows.forEach((r, i) => { if (r.tasks.some((id) => busy(s.tasks[id].status))) front = i; });
      const stepHead = (r, i) => {
        let cls = '', tags = '';
        if (s) {
          const sts = r.tasks.map((id) => s.tasks[id].status);
          if (sts.every((x) => x === 'done')) cls = ' fs-done';
          if (i === front) { cls = ' fs-now'; tags += `<span class="flow-tag flow-here">${I.svg('pin')} いまここ</span>`; }
          if (sts.some((x) => x === 'ready')) tags += `<span class="flow-tag ft-ready">${I.svg('play')} はじめられる</span>`;
          else if (i < front && sts.some((x) => x === 'active')) tags += `<span class="flow-tag ft-working">${I.svg('working')} おしごと<ruby>中<rt>ちゅう</rt></ruby></span>`;
        }
        const note = String(r.note || '').replace(/^\u{1F447}\s*/u, '');   // 先頭の「下をさす手」の絵文字は出さない（データは変えない）
        return `<div class="flow-step${cls}"><span class="flow-stepnum" style="--sc:var(--s${r.step})">${r.step}</span><div class="flow-note">${rubi(note)}</div>${tags}</div>`;
      };
      const legend = s ? '<div class="flow-legend">' +
        [ST.done, ST.active, ST.ready, ST.gathering, ST.locked].map((x) => `<span class="${x[0]}">${I.svg(x[1])}${x[2]}</span>`).join('') +
        '</div>' : '';
      return '<div class="flow-map">' + rows.map((r, i) =>
        `<div class="flow-block${i === rows.length - 1 ? ' fb-last' : ''}">${stepHead(r, i)}<div class="flow-row">${r.tasks.map(chip).join('')}</div></div>`).join('') +
        legend + '</div>';
    },

    openFlowMap() {
      const live = !!this.state && $('#screen-game').classList.contains('active');
      this.openModal({
        kind: 'flow',
        title: '🗺 出発準備のながれ',
        body: this.buildFlowHtml(live) +
          `<p class="modal-info" style="margin-top:10px;">${window.Icons.svg('info')} じゅんばんを守りながら、同時にできる作業をどれだけ重ねられるかがコツ！</p>`,
        buttons: [{ label: 'とじる', cls: 'btn-primary' }],
        dismissible: true,
      });
      if (live) {
        this.els['modal'].querySelectorAll('button.flow-chip').forEach((b) => {
          b.addEventListener('click', () => {
            Sfx.play('click');
            this.closeModal();
            this.onRibbonChip(b.dataset.task);
          });
        });
      }
    },

    /* タイトル画面の「スター・バッジ」進捗表示 */
    updateTitleProgress() {
      const el = document.getElementById('title-progress');
      if (!el || !this.cb.getProgress) return;
      const p = this.cb.getProgress();
      const earned = Object.keys(p.earned || {}).length;
      if (!earned && !p.totalStars) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      const I = window.Icons;
      el.innerHTML = `${I.svg('star')} スター ${p.totalStars}/${p.maxStars}<span class="tp-gap"></span>${I.svg('medal')} バッジ ${earned}/${p.badgeDefs.length}`;
    },

    /* 絵文字を「絵文字のまま」出す（バッジの絵文字は今回は残す。iconize が SVG に置きかえないよう、文字参照にしておく） */
    emojiRaw(str) {
      return Array.from(String(str || '')).map((ch) => `&#x${ch.codePointAt(0).toString(16)};`).join('');
    },

    /* ずかん「なかまたち」の絵: 駐機場と同じ Scene.drawPerson / Scene.vehicleBody で、72x72（2倍の解像度）に1回だけ描いてキャッシュする */
    crewArt(kind, type) {
      this._crewArt = this._crewArt || {};
      const key = kind + ':' + type;
      if (this._crewArt[key]) return this._crewArt[key];
      const SIZE = 144;                       // 72px を 2倍で描く
      const W = 360, H = 240;                 // 下書き（大きめに描いてから、絵のある所だけ切り出す）
      const draft = document.createElement('canvas');
      draft.width = W; draft.height = H;
      const g = draft.getContext('2d');
      const prev = Scene.ctx;
      Scene.ctx = g;                          // drawPerson・vehicleBody は this.ctx に描くので、一時的に差しかえる
      try {
        g.save();
        if (kind === 'staff') {
          const meta = window.RES_META.staff[type];
          g.translate(W / 2, H / 2 + 60);
          g.scale(5, 5);                        // 全長約24 → 120px（72px の箱で 2.5倍）
          Scene.drawPerson(0, 0, { color: meta.color, type, moving: false, working: false, phase: 0, sway: 0 });
        } else {
          g.translate(W / 2, H / 2);
          g.scale(1.6, 1.6);
          Scene.vehicleBody(type, false, 0, false);
        }
        g.restore();
      } catch (e) {
        g.restore();
      } finally {
        Scene.ctx = prev;                     // かならず元に戻す
      }
      /* 絵のある範囲を測る */
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      try {
        const px = g.getImageData(0, 0, W, H).data;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (px[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          }
        }
      } catch (e) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const out = document.createElement('canvas');
      out.width = SIZE; out.height = SIZE;
      const o = out.getContext('2d');
      const pad = kind === 'staff' ? 14 : 12;
      const k = Math.min((SIZE - pad * 2) / bw, (SIZE - pad * 2) / bh);
      const dw = bw * k, dh = bh * k;
      if (kind !== 'staff') {
        /* 車は右下へ落ちる影をつける（光源は左上。人は drawPerson が足もとの影を描く） */
        o.shadowColor = 'rgba(30, 40, 54, 0.32)';
        o.shadowBlur = 5; o.shadowOffsetX = 4; o.shadowOffsetY = 5;
      }
      o.drawImage(draft, x0, y0, bw, bh, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);
      let url = '';
      try { url = out.toDataURL('image/png'); } catch (e) { url = ''; }
      this._crewArt[key] = url;
      return url;
    },

    openZukan(tab) {
      tab = tab || 'flow';
      const rubi = window.rubi;
      const I = window.Icons;
      const tabs = [['flow', 'flow', 'ながれ'], ['tasks', 'list', 'おしごと'], ['crew', 'people', 'なかまたち'], ['badge', 'medal', 'バッジ']];
      const tabBtns = '<div class="zk-tabs" role="tablist">' + tabs.map(([k, ico, l]) =>
        `<button type="button" role="tab" aria-selected="${k === tab}" class="zk-tab ${k === tab ? 'on' : ''}" data-tab="${k}">${I.svg(ico)}${l}</button>`).join('') + '</div>';
      let body = '';
      /* ずかんはどのタブも同じ広い板（タブを切りかえても幅が変わらない） */
      if (tab === 'flow') {
        body = this.buildFlowHtml(false);
      } else if (tab === 'tasks') {
        /* ステップ1〜7 の見出しでまとめる。カードは名前と1行の説明。なぜ・安全メモは「くわしく」の中（最初のカードだけ開いておく） */
        let first = true;
        body = '<div class="zk-list zk-cards">' + window.FLOW_ROWS.map((r) => {
          const head = `<h3 class="zk-stephead"><span class="flow-stepnum" style="--sc:var(--s${r.step})">${r.step}</span>${rubi(r.title)}</h3>`;
          return head + r.tasks.map((id) => {
            const d = window.TASK_MAP[id];
            const desc = String(d.desc || '');
            const cut = desc.indexOf('。');
            const lead = cut >= 0 && cut < desc.length - 1 ? desc.slice(0, cut + 1) : desc;
            const rest = lead.length < desc.length ? desc.slice(lead.length) : '';
            const open = first ? ' open' : '';
            first = false;
            return `<div class="zk-item">
              <div class="zk-head">${I.svg(I.task(id))}${rubi(d.name)}</div>
              <p>${rubi(lead)}</p>
              <details class="zk-more"${open}><summary>${I.svg('chevron-right')}くわしく</summary>
                ${rest ? `<p>${rubi(rest)}</p>` : ''}
                <p class="zk-why">${I.svg('info')} <strong>なぜ必要？</strong> ${rubi(d.why)}</p>
                ${d.note ? `<p class="zk-note">${I.svg('shield')} <strong>${rubi('安全')}メモ</strong> ${rubi(d.note)}</p>` : ''}
              </details>
            </div>`;
          }).join('');
        }).join('') + '</div>';
      } else if (tab === 'badge') {
        const p = this.cb.getProgress ? this.cb.getProgress() : { badgeDefs: [], earned: {}, totalStars: 0, maxStars: 15 };
        const earned = Object.keys(p.earned || {}).length;
        body = `<p class="zk-badge-sum"><span>${I.svg('star')} スター ${p.totalStars}/${p.maxStars}</span><span>${I.svg('medal')} バッジ ${earned}/${p.badgeDefs.length}</span></p>` +
          '<div class="zk-list badges">' + p.badgeDefs.map((b) => {
            const got = !!p.earned[b.id];
            /* 未獲得も文字はふつうの濃さ。メダルだけ灰のシルエット＋鍵。説明の前に「とりかた：」 */
            return `<div class="zk-item badge-item ${got ? 'bd-got' : 'bd-notyet'}">
              <span class="medal${got ? '' : ' off'}" aria-hidden="true">${got ? this.emojiRaw(b.icon) : I.svg('lock')}</span>
              <div>
                <div class="zk-head"><span>${this.phraseBreaks(rubi(b.name))}</span>${got ? ' <span class="bd-mark">もらった！</span>' : ''}</div>
                <p>${got ? '' : '<span class="bd-how">とりかた：</span>'}${this.phraseBreaks(rubi(b.desc))}</p>
              </div>
            </div>`;
          }).join('') + '</div>';
      } else {
        /* なかまたち: 駐機場と同じ絵 + 見た目の手がかり（描いた服・車の色と合わせる） */
        const LOOK = {
          ramp: 'きいろの ベスト', baggage: 'オレンジの ベスト', cleaning: 'みどりの ベスト',
          maintenance: 'あかい いろが めじるし', gate: 'あおい ベスト',
          beltloader: 'ななめに のびる ながい ベルト', cart: 'にもつを のせた だいしゃを つなげて ひっぱる',
          fuel: 'しろい タンクに あかい せん', catering: 'しろい はこの 荷台', pushback: 'ひくくて きいろが めじるし',
        };
        const item = (kind, type, m) => {
          const url = this.crewArt(kind, type);
          return `<div class="zk-item crew">${url ? `<img class="zk-art" src="${url}" width="72" height="72" alt="">` : '<span class="zk-art"></span>'}
            <div><div class="zk-head">${I.svg(I.res(type))}${rubi(m.label)}</div>
            <p>${rubi(m.desc)}</p>${LOOK[type] ? `<p class="zk-look">めじるし：${rubi(LOOK[type])}</p>` : ''}</div></div>`;
        };
        body = '<div class="zk-list zk-cards"><h3 class="zk-cat">スタッフ</h3>' +
          Object.keys(window.RES_META.staff).map((k) => item('staff', k, window.RES_META.staff[k])).join('') +
          '<h3 class="zk-cat">はたらく<ruby>車<rt>くるま</rt></ruby>（GSE）</h3>' +
          Object.keys(window.RES_META.vehicles).map((k) => item('veh', k, window.RES_META.vehicles[k])).join('') + '</div>';
      }
      this.openModal({
        kind: 'zukan',
        cls: 'wide',
        title: '📖 空港ずかん',
        body: tabBtns + body,
        buttons: [{ label: 'とじる', cls: 'btn-primary' }],
        dismissible: true,
      });
      this.els['modal'].querySelectorAll('.zk-tab').forEach((b) => {
        b.addEventListener('click', () => { Sfx.play('click'); this.openZukan(b.dataset.tab); });
      });
    },

    coach(msg) { this.toast(msg, 'coach'); },
    coachBegin() {
      if (this.state && this.state.stage.hints === true) {
        this.coach('👨‍✈️ リーダー、到着だ！まずは『降機』🚶と『取り降ろし』📤。『給油』⛽と『点検』🔍も同時に始めよう！');
      }
    },
    checkCoach() {
      const s = this.state;
      if (!s || s.ended || s.stage.hints !== true) return;
      for (const r of COACH_RULES) {
        if (!this.coachShown.has(r.id) && r.when(s)) {
          this.coachShown.add(r.id);
          this.coach(r.msg);
          break;
        }
      }
    },

    /* ---------------- チュートリアル ---------------- */
    openTutorial(onDone, opts) {
      const I = window.Icons;
      const rubi = window.rubi;
      const kind = (opts && opts.kind) || 'tutorial';
      /* 画面の見方は、スマホと PC で並びがちがうので、開いたときの幅で文を分ける */
      const phone = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
      const steps = [
        {
          title: `${I.svg('plane')} ようこそ、地上作業リーダー！`,
          body: `<p class="tut-lead">飛行機が 空港に ついてから、つぎに 出発するまでの じゅんびを <strong>ターンアラウンド</strong>と いうよ。</p>
                 <div class="tut-fig pace" aria-hidden="true"><span class="tut-key">${I.svg('plane')} とうちゃく</span><span class="tut-key">45分</span><span class="tut-key">${I.svg('plane')} 出発</span></div>
                 <p>きみの しごとは、スタッフと <ruby>車<rt>くるま</rt></ruby>に おしごとを わりあてて、<strong>45分 あとの 出発</strong>に まにあわせること！</p>`,
        },
        {
          title: `${I.svg('flow')} 出発準備の ながれ`,
          body: `<p class="tut-lead">おしごとには <strong>じゅんばん</strong>が あるよ。ステップ1から 7へ。おなじ ステップは 同時に すすめよう！</p>
                 <ol class="tut-steps">${window.FLOW_ROWS.map((r) => `<li><span class="tut-num" style="--sc:var(--s${r.step})">${r.step}</span><span>${rubi(r.title)}</span><span class="tut-ico" aria-hidden="true">${r.tasks.map((id) => I.svg(I.task(id))).join('')}</span></li>`).join('')}</ol>
                 <p class="modal-info">${I.svg('book')} くわしくは ずかんの「ながれ」で みられるよ。</p>`,
        },
        {
          title: `${I.svg('help')} 画面の 見方`,
          body: (phone
            ? `<ul class="tut-list">
                 <li><span class="tut-where">うえ</span><span>じこくと はやさ</span></li>
                 <li><span class="tut-where">まんなか</span><span>駐機場（ゆびで うごかせるよ）</span></li>
                 <li><span class="tut-where">その した</span><span>スコアと スタッフ</span></li>
                 <li><span class="tut-where">さらに した</span><span>作業カード（したに スクロール）</span></li></ul>`
            : `<ul class="tut-list">
                 <li><span class="tut-where">${I.svg('list')} ひだり</span><span>おしごと タブ（作業カード）</span></li>
                 <li><span class="tut-where">みぎうえ</span><span>スコアのもと</span></li>
                 <li><span class="tut-where">した</span><span>スタッフと <ruby>車<rt>くるま</rt></ruby></span></li></ul>`) +
            `<p class="tut-lead"><strong>ながれバーの しるし</strong></p>
             <ul class="tut-list tut-marks"><li><span class="tut-mark ready">${I.svg('play')}</span><span>の わく ＝ いま はじめられる</span></li><li><span class="tut-mark done">${I.svg('check')}</span><span>＝ おわった</span></li></ul>
             <p class="tut-lead"><strong>駐機場の 持ち場の いろ</strong></p>
             <div class="tut-swatches" aria-hidden="true">
               <span class="tut-sw"><span class="tsw tsw-ready"></span>はじめられる</span>
               <span class="tut-sw"><span class="tsw tsw-wait"></span>あつまり<ruby>中<rt>ちゅう</rt></ruby></span>
               <span class="tut-sw"><span class="tsw tsw-target"></span>おくれる ところ</span>
               <span class="tut-sw"><span class="tsw tsw-soon"></span>もうすぐ</span>
             </div>`,
        },
        {
          title: `${I.svg('list')} おしごとの すすめかた`,
          body: `<p><strong>① おまかせ</strong>：作業カードの「${I.svg('play')} はじめる」を おすと、ひつような 人と車が じぶんで うごくよ。</p>
                 <p><strong>② 自分で 配置</strong>：駐機場の スタッフや <ruby>車<rt>くるま</rt></ruby>を タップして えらび、<strong>みどりの ふとい わ</strong>の 持ち場を タップ。そろうと はじまるよ。</p>
                 <p>${I.svg('vet')} ベテランは はやい、${I.svg('rookie')} 新人は ゆっくり。だれを おくるかも 作戦だよ。</p>
                 <p>${I.svg('lock')} は まだ はじめられない しるし。${I.svg('unlock')}「はじめられるよ！」の おしらせが 合図だよ。</p>`,
        },
        {
          title: `${I.svg('clock')} 時間と すすめかた`,
          body: `<p>うえの ボタンで 時間の はやさを かえられるよ。まよったら とめて 作戦タイム！</p>
                 <div class="tut-fig hud" aria-hidden="true"><span class="tut-key">${I.svg('pause')} とめる</span><span class="tut-key on">${I.svg('play')} ふつう</span><span class="tut-key">${I.svg('fast')} はやい</span></div>
                 <p>おしごとごとに <strong>すすめかた</strong>を えらべるよ。いそぐと はやいけど、まんぞくや 安全が 下がることも。</p>
                 <div class="tut-fig pace" aria-hidden="true"><span class="tut-key">${I.svg('gauge-slow')} ていねい</span><span class="tut-key on">${I.svg('gauge-mid')} ふつう</span><span class="tut-key">${I.svg('gauge-fast')} いそぐ</span></div>
                 <p>ここぞ という ときだけ いそぐのが コツ！</p>`,
        },
        {
          title: `${I.svg('shield')} 安全が いちばん！`,
          body: `<p>とちゅうで <strong>トラブル</strong>が おきたら、うえの きいろい おしらせを タップして、どうするか えらぼう。</p>
                 <p>いそいでいても、<strong>安全確認は ぜったいに とばさない</strong>。それが プロの しごとだよ。</p>
                 <p>それでは、よい フライトを！</p>`,
        },
      ];
      let idx = 0;
      const done = () => { if (onDone) onDone(); };
      const render = () => {
        const st = steps[idx];
        const last = idx === steps.length - 1;
        const dots = steps.map((_, i) => `<span class="tut-dot ${i === idx ? 'on' : ''}"></span>`).join('');
        /* ボタンの並び: とばす（左はしの文字リンク）→ まえへ → つぎへ（主ボタンはいつも右はし）。ページ送りは silent で閉じる */
        const buttons = [];
        if (!last) buttons.push({ label: 'とばす', cls: 'btn-link btn-skip', onClick: done });
        if (idx > 0) buttons.push({ label: '← まえへ', cls: 'btn-ghost', silent: true, onClick: () => { idx--; render(); } });
        buttons.push(last
          ? { label: 'とじる', cls: 'btn-primary', onClick: done }
          : { label: 'つぎへ →', cls: 'btn-primary', silent: true, onClick: () => { idx++; render(); } });
        this.openModal({
          kind,
          cls: 'tut',
          title: st.title,
          body: st.body,
          foot: `<div class="tut-foot" aria-label="${idx + 1} / ${steps.length} ページ"><div class="tut-dots" aria-hidden="true">${dots}</div><span class="tut-count">${idx + 1} / ${steps.length}</span></div>`,
          buttons,
          dismissible: false,
        });
      };
      render();
    },

    /* ---------------- 設定 ---------------- */
    openSettings(opts) {
      const { sound, bgm, inGame } = opts;
      const sw = (id, label, on) => `
          <div class="set-row sw-row" data-sw="${id}">
            <span id="lbl-${id}">${label}</span>
            <button type="button" role="switch" class="switch" id="${id}" aria-checked="${on ? 'true' : 'false'}" aria-labelledby="lbl-${id}"><span class="sw-track"><span class="sw-knob"></span></span><span class="sw-txt">${on ? 'オン' : 'オフ'}</span></button>
          </div>`;
      this.openModal({
        kind: 'settings',
        title: '⚙ せってい',
        body: `
          ${sw('set-sound', '効果音', !!sound)}
          ${sw('set-bgm', 'おんがく（BGM）', bgm !== false)}
          <div class="set-row">
            <span>あそびかたを もう一度 みる</span>
            <button class="btn btn-sm btn-ghost" id="set-tutorial">ひらく</button>
          </div>
          ${inGame ? `
          <div class="set-row">
            <span>このステージを やめる</span>
            <button class="btn btn-sm btn-warnghost" id="set-quit">やめる</button>
          </div>` : `
          <div class="set-row">
            <span>セーブデータを けす</span>
            <button class="btn btn-sm btn-warnghost" id="set-reset">けす</button>
          </div>`}`,
        buttons: [{ label: 'とじる', cls: 'btn-primary' }],
        dismissible: true,
      });
      /* スイッチ: 押すたびにオン/オフ（行のどこを押してもよい） */
      const bindSwitch = (id, fn) => {
        const b = $('#' + id);
        b.addEventListener('click', () => {
          const on = b.getAttribute('aria-checked') !== 'true';
          b.setAttribute('aria-checked', on ? 'true' : 'false');
          b.querySelector('.sw-txt').textContent = on ? 'オン' : 'オフ';
          fn(on);
        });
        const row = b.closest('.set-row');
        row.addEventListener('click', (ev) => { if (!ev.target.closest('.switch')) b.click(); });
      };
      bindSwitch('set-sound', (on) => this.cb.onSoundToggle(on));
      bindSwitch('set-bgm', (on) => this.cb.onBgmToggle(on));
      /* せっていから開くモーダルは kind='settings-sub'。せっていは silent で閉じる（その間にゲームの時間が進まない） */
      $('#set-tutorial').addEventListener('click', () => {
        Sfx.play('click');
        this.closeModal({ silent: true });
        this.openTutorial(null, { kind: 'settings-sub' });
      });
      const quit = $('#set-quit');
      if (quit) quit.addEventListener('click', () => {
        Sfx.play('click');
        this.closeModal({ silent: true });
        this.openModal({
          kind: 'settings-sub',
          title: 'かくにん', body: '<p>このステージを やめて、ステージえらびに もどりますか？<br>すすみぐあいは のこりません。</p>',
          buttons: [
            { label: 'やめて ステージえらびへ', cls: 'btn-danger', onClick: () => this.cb.onGotoSelect() },
            { label: 'つづける', cls: 'btn-primary' },
          ],
          dismissible: true,
        });
      });
      const reset = $('#set-reset');
      if (reset) reset.addEventListener('click', () => {
        Sfx.play('click');
        this.closeModal({ silent: true });
        this.openModal({
          kind: 'settings-sub',
          title: 'かくにん', body: '<p>クリアの 記録と ベストスコアを ぜんぶ けしますか？</p>',
          buttons: [
            { label: 'けす', cls: 'btn-danger', onClick: () => this.cb.onResetData() },
            { label: 'やめる', cls: 'btn-primary' },
          ],
          dismissible: true,
        });
      });
    },

    /* 紙ふぶき（クリア演出。数秒でひとりでに消える。動きをへらす設定の人には出さない） */
    dropConfetti(n) {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const old = document.querySelector('.confetti-box');
      if (old) old.remove();
      const box = document.createElement('div');
      box.className = 'confetti-box';
      const colors = ['#e5867c', '#7ca3d8', '#ffd24a', '#8fc98f', '#b493cf', '#7cc2c9', '#0f8fb0'];
      for (let i = 0; i < n; i++) {
        const p = document.createElement('i');
        const r = (a, b) => a + Math.random() * (b - a);
        p.style.left = r(0, 100) + '%';
        p.style.background = colors[i % colors.length];
        p.style.animationDuration = r(2.4, 4.2) + 's';
        p.style.animationDelay = r(0, 0.9) + 's';
        p.style.width = r(7, 11) + 'px';
        p.style.height = r(10, 15) + 'px';
        box.appendChild(p);
      }
      document.body.appendChild(box);
      setTimeout(() => box.remove(), 5600);
    },

    /* 文節ごとに改行する: 文を文節（ひらがな・句読点のあと → 漢字・カタカナ・ルビ・かっこ の前、と空白で切る）に分け、
     * 1つずつ white-space:nowrap の <span class="phr"> で包む。「定刻ど｜おり」「急｜いで」のような語の途中の改行をなくす
     * （body の word-break:auto-phrase はルビの入った文では効かず、ルビの前後はいつでも改行できてしまうため）。
     * 入力は rubi()・iconize() のあとの HTML。<ruby> と <svg> はまるごと1つの文節の中に入れる */
    phraseBreaks(html) {
      const HIRA = /[ぁ-ゖ]/;
      const CLOSE = /[、。！？」』）…]/;
      const OPEN = /[「『（]/;
      const WORD = /[一-鿿々ァ-ヺ0-9A-Za-z０-９]/;
      const SPACE = /[\s　]/;
      let prev = '';
      let out = '';
      let cur = '';
      const flush = () => { if (cur) out += `<span class="phr">${cur}</span>`; cur = ''; };
      String(html).split(/(<ruby>[\s\S]*?<\/ruby>|<[^>]+>)/g).forEach((seg) => {
        if (!seg) return;
        if (seg.startsWith('<ruby>')) {
          if (prev === 'H' || prev === 'P') flush();
          cur += seg;
          prev = 'W';
          return;
        }
        if (seg.startsWith('<')) { cur += seg; return; }   // svg などのタグは、いまの文節に入れる
        for (const c of seg) {
          if (SPACE.test(c)) { flush(); out += c; prev = 'S'; continue; }
          let cls = 'X';
          if (HIRA.test(c)) cls = 'H';
          else if (CLOSE.test(c)) cls = 'P';
          else if (OPEN.test(c)) cls = 'O';
          else if (WORD.test(c)) cls = 'W';
          else if (c === 'ー') cls = prev;                       // のばす音は前の字と同じあつかい
          if (((prev === 'H' || prev === 'P') && (cls === 'W' || cls === 'O')) || (prev === 'P' && cls === 'H')) flush();
          cur += c;
          prev = cls;
        }
      });
      flush();
      return out;
    },

    /* ---------------- 結果画面 ---------------- */
    renderResult(res, isBest, nextStageId, prevBest, extras) {
      extras = extras || { stars: 0, newBadges: [], nextGoal: '' };
      const rubi = window.rubi;
      const I = window.Icons;
      const ize = (h) => I.iconize(h);
      const pb = (s) => this.phraseBreaks(ize(rubi(s)));
      const TEN = '<ruby>点<rt>てん</rt></ruby>';
      const fail = !res.cleared;
      const inner = document.querySelector('#screen-result .result-inner');
      if (inner) inner.classList.toggle('is-fail', fail);

      const nextBtn = document.getElementById('btn-next-stage');
      const retryBtn = document.getElementById('btn-retry');
      nextBtn.classList.toggle('hidden', !nextStageId);
      nextBtn.dataset.stage = nextStageId || '';
      retryBtn.classList.toggle('btn-primary', !nextStageId);
      retryBtn.classList.toggle('btn-ghost', !!nextStageId);

      /* 見出し（2段: 「クリア！」「クリアならず」と、その下の短い文）。失格でも赤にしない */
      const flag = this.els['result-flag'];
      let head, sub, fcls;
      if (!res.departed) {
        head = 'クリアならず'; sub = '時間までに 出発できなかった…'; fcls = 'bad';
      } else if (res.critical) {
        head = 'クリアならず'; sub = '出発は できたけど、安全の もんだいが あった…'; fcls = 'bad';
      } else if (res.delay != null && res.delay > 0.5) {
        head = 'クリア！'; sub = `✈ 出発しました（${Math.ceil(res.delay)}分 おくれ）`; fcls = 'ok';
      } else {
        head = 'クリア！'; sub = '✈ 時間ぴったりに 出発！ おみごと！'; fcls = 'great';
      }
      flag.className = 'result-flag ' + fcls;
      flag.innerHTML = `<h2 class="result-head">${head}</h2><p class="result-sub">${pb(sub)}</p>`;

      /* クリアするには（失格・時間切れのとき。見出しのすぐ下） */
      const howEl = document.getElementById('result-howto');
      if (fail && extras.nextGoal) {
        howEl.innerHTML = `<span class="rh-label">クリアするには</span>${pb(extras.nextGoal)}`;
        howEl.classList.remove('hidden');
      } else {
        howEl.innerHTML = '';
        howEl.classList.add('hidden');
      }

      const rankEl = this.els['result-rank'];
      rankEl.textContent = res.rank;
      rankEl.className = 'result-rank rank-' + (res.rank === '×' ? 'X' : res.rank);
      /* スコアのカウントアップ演出 */
      const scoreEl = this.els['result-score'];
      if (this._scoreAnim) cancelAnimationFrame(this._scoreAnim);
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / 900);
        scoreEl.textContent = String(Math.round(res.score * (1 - Math.pow(1 - p, 3))));
        if (p < 1) this._scoreAnim = requestAnimationFrame(tick);
      };
      this._scoreAnim = requestAnimationFrame(tick);
      /* じこベスト: 点数の横のピル。まえのベストは点数の下に小さく（★の字は使わない） */
      document.getElementById('result-newbest').classList.toggle('hidden', !isBest);
      const prevEl = document.getElementById('result-prevbest');
      prevEl.innerHTML = prevBest != null ? `まえのベスト ${prevBest}${TEN}` : '';
      prevEl.classList.toggle('hidden', prevBest == null);

      /* ★の獲得表示（取った★は金で1つずつ光る。取っていない☆は灰の線） */
      const starsEl = document.getElementById('result-stars');
      starsEl.setAttribute('role', 'img');
      starsEl.setAttribute('aria-label', `スター ${extras.stars} / 3`);
      starsEl.innerHTML = [1, 2, 3].map((i) => (i <= extras.stars
        ? `<i class="on" style="animation-delay:${0.1 + i * 0.15}s">${I.svg('star')}</i>`
        : `<i>${I.svg('star-outline')}</i>`)).join('');

      /* 新しくとれたバッジ（クリアできなかった回は祝わない: しずかな見た目・🎉なし・はんこの動きなし） */
      const badgeEl = document.getElementById('result-badges');
      if (extras.newBadges && extras.newBadges.length) {
        badgeEl.classList.remove('hidden');
        badgeEl.classList.toggle('quiet', fail);
        badgeEl.innerHTML = `<span class="rb-title">${fail ? 'バッジを ゲットしたよ' : '🎉 あたらしいバッジ！'}</span>` +
          extras.newBadges.map((b) => `<span class="badge-chip">${this.emojiRaw(b.icon)} ${rubi(b.name)}</span>`).join('');
      } else {
        badgeEl.classList.add('hidden');
        badgeEl.classList.remove('quiet');
        badgeEl.innerHTML = '';
      }

      /* つぎの目標（クリアしたとき。★のすぐ下のカード） */
      const goalEl = document.getElementById('result-goal');
      if (!fail && extras.nextGoal) {
        goalEl.innerHTML = `<span class="rg-label">${rubi('つぎの目標')}</span>${pb(extras.nextGoal)}` +
          (extras.goalNote ? `<span class="rg-note">${pb(extras.goalNote)}</span>` : '');
        goalEl.classList.remove('hidden');
      } else {
        goalEl.innerHTML = '';
        goalEl.classList.add('hidden');
      }

      /* クリアしたら紙ふぶき */
      if (res.cleared) this.dropConfetti(res.rank === 'S' ? 56 : 36);

      /* 点数の内訳（50% 未満・安全のもんだいは、赤のしま + ⚠ で色以外でも分かるように） */
      const bd = this.els['result-breakdown'];
      bd.innerHTML = '';
      Object.entries(res.breakdown).forEach(([key, b]) => {
        const li = document.createElement('li');
        const pct = (b.got / b.max) * 100;
        const low = pct < 50 || (res.critical && key === 'safety');
        li.innerHTML = `<span class="rb-label">${ize(rubi(b.label))}</span>
          <span class="rb-bar"><span class="rb-fill fill-${key}${low ? ' low' : ''}" style="width:${pct}%"></span></span>
          <span class="rb-num">${low ? I.svg('alert') : ''}${b.got} / ${b.max}${TEN}</span>`;
        bd.appendChild(li);
      });

      /* 時刻（時刻だけ。じこベストは点数の横へ移した） */
      const times = this.els['result-times'];
      if (res.blockOff != null) {
        const d = Math.ceil(Math.max(0, res.blockOff - res.std));
        times.innerHTML = pb(`出発予定 ${window.fmtClock(res.std)} → ほんとうの出発 ${window.fmtClock(res.blockOff)}` +
          (d > 0 ? `（${d}分 おくれ）` : '（時間ぴったり）'));
      } else {
        times.innerHTML = pb(`出発予定 ${window.fmtClock(res.std)} → 出発できず`);
      }

      /* ふりかえり: 「つぎに 気をつけること」（先に）と「よかったこと」の2つに分ける */
      const adv = this.els['result-advice'];
      const parts = res.adviceParts || [];
      if (parts.length) {
        const fix = parts.filter((p) => p.kind !== 'good');
        const good = parts.filter((p) => p.kind === 'good');
        const list = (arr) => '<ul class="adv-list">' + arr.map((p) => `<li>${pb(String(p.text).replace(/^一方で、/, ''))}</li>`).join('') + '</ul>';
        adv.innerHTML =
          (fix.length ? `<div class="adv-group adv-fix"><h4>${I.svg('alert')}つぎに <ruby>気<rt>き</rt></ruby>を つけること</h4>${list(fix)}</div>` : '') +
          (good.length ? `<div class="adv-group adv-good"><h4>よかったこと</h4>${list(good)}</div>` : '');
      } else {
        adv.innerHTML = `<p>${pb(res.advice)}</p>`;
      }

      /* 作業タイムライン（どれだけ並行できたか）。最初はたたんでおく */
      const more = document.getElementById('result-more');
      if (more) more.open = false;
      const gantt = document.getElementById('result-gantt');
      gantt.innerHTML = '';
      if (res.timeline) {
        const ta = res.arrival;
        const tEnd = Math.max(res.std + 4, ta + 46, ...res.timeline.map((t) => t.doneAt || 0));
        const span = tEnd - ta;
        const pct = (m) => clamp(((m - ta) / span) * 100, 0, 100);
        const stdPct = pct(res.std);
        res.timeline.forEach((t) => {
          const row = document.createElement('div');
          row.className = 'gr';
          const stp = (window.TASK_MAP[t.id] && window.TASK_MAP[t.id].step) || 0;
          const short = this.SHORT_NAMES[t.id] || t.name;
          const label = `<span class="gr-label" title="${String(t.name).replace(/"/g, '&quot;')}">` +
            (stp ? `<span class="gr-step" style="--sc:var(--s${stp})">${stp}</span>` : '') +
            `${I.svg(I.task(t.id))}${rubi(short)}</span>`;
          if (t.startedAt == null) {
            row.innerHTML = label + '<span class="gr-none">はじめられなかった</span>';
          } else {
            let bars = `<i class="gr-stdline" style="left:${stdPct}%"></i>`;
            if (t.activeAt != null) {
              bars += `<i class="gr-gather" style="left:${pct(t.startedAt)}%;width:${Math.max(0.5, pct(t.activeAt) - pct(t.startedAt))}%"></i>`;
            }
            if (t.activeAt != null && t.doneAt != null) {
              /* ながれリボンと同じステップ色でぬる（順番の学びとつなげる） */
              const col = stp ? `background:var(--s${stp});` : '';
              bars += `<i class="gr-work" style="left:${pct(t.activeAt)}%;width:${Math.max(1, pct(t.doneAt) - pct(t.activeAt))}%;${col}"></i>`;
            }
            row.innerHTML = label + `<span class="gr-track">${bars}</span>`;
          }
          gantt.appendChild(row);
        });
        const axis = document.createElement('div');
        axis.className = 'gr-axis';
        axis.innerHTML = `<span></span><span class="gr-axis-track">` +
          `<span class="ax-left" style="left:0">${window.fmtClock(ta)} ${rubi('到着')}</span>` +
          `<span class="ax-std${stdPct > 80 ? ' ax-right' : ''}" style="left:${stdPct}%">${rubi('出発予定')} ${window.fmtClock(res.std)}</span>` +
          `</span>`;
        gantt.appendChild(axis);
        /* 色の凡例（色に1つの意味） */
        const lg = document.createElement('p');
        lg.className = 'gr-legend';
        lg.innerHTML = '<span class="lg"><i class="lg-sw lg-steps"></i>いろ＝ステップ1〜7</span>' +
          '<span class="lg"><i class="lg-sw lg-gather"></i>しましま＝あつまり<ruby>中<rt>ちゅう</rt></ruby></span>' +
          `<span class="lg"><i class="lg-sw lg-std"></i>あかい せん＝${rubi('出発予定')}</span>`;
        gantt.appendChild(lg);
      }
      document.getElementById('result-trivia').innerHTML = ize('💡 まめちしき: ' + rubi(pickTrivia()));
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
              `のこり 約${Math.max(1, Math.ceil(G.effDur(t) - t.progress))}分`;
            if (timeEl.textContent !== txt) timeEl.textContent = txt;
          } else if (t.status === 'locked') {
            /* 「あと約N分でおわったら〜」のカウントダウンを更新 */
            const card = this.cardEls[t.id];
            if (!card) return;
            const lockEl = card.querySelector('.tc-lockmsg');
            const html = '🔒 ' + window.rubi(G.lockReason(t.id));
            if (lockEl._raw !== html) { lockEl._raw = html; lockEl.innerHTML = html; }
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
          this.updateRibbon();
          this.updateUnfinished();
          this.updateHint(true);
          this.checkCoach();
          if (this.spotPopTask === payload.id) {
            const t = this.state.tasks[payload.id];
            if (!t || t.status === 'done' || t.status === 'active') this.closeSpotPop();
            else this.openSpotPop(payload.id);  // ロック解除などで内容がかわったら開き直す
          }
          break;
        case 'unlocked':
          /* 次に進めるようになった瞬間を、音+トースト+カード/リボン/持ち場の光りで知らせる */
          Sfx.play('unlock');
          this.toast('🔓 ' + payload.ids.map((id) => `「${window.TASK_MAP[id].icon}${window.TASK_MAP[id].name}」`).join('と') + 'が はじめられるよ！', 'open');
          payload.ids.forEach((id) => {
            const card = this.cardEls[id];
            if (card) {
              card.classList.remove('just-open');
              void card.offsetWidth;
              card.classList.add('just-open');
            }
            const chip = this.ribbonChips && this.ribbonChips[id];
            if (chip) {
              chip.classList.remove('fr-flash');
              void chip.offsetWidth;
              chip.classList.add('fr-flash');
            }
            Scene.popSpot(id);
          });
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
          this.setPausedIndicator(false);
          if (this.modalKind && this.modalKind !== 'tutorial') this.closeModal();
          break;
      }
    },
  };

  window.UI = UI;
})();
