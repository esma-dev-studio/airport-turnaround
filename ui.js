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

  /* ---------- 機体の寸法（エアバスA320相当。単位はメートル） ----------
   * u = 機首からの距離（うしろへ+）、v = 中心線からの横の距離（右主翼＝スターボード側が+）。
   * 機首は右向き。右向きの機体を上から見ると、画面の上が左側（ポート）、下が右側（スターボード）。
   * だから搭乗橋は上のL1ドアにつき、貨物ドア・ケータリング（R2）・給油口（右主翼の下）は下側にくる。 */
  const PK = 9.2;                          // 1m = 9.2px（全長37.6m→346px・翼幅35.8m→329px）
  const NOSE_X = 856, PLANE_CY = 316;      // 駐機位置の機首先端のxと、胴体の中心線のy
  const PIVOT_U = 17.7;                    // 主脚の位置（向きを変えるときの中心）
  const PIVOT_X = NOSE_X - PIVOT_U * PK;
  const NOSE_GEAR_U = 5.1;
  const WHEELBASE = (PIVOT_U - NOSE_GEAR_U) * PK;
  const PLANE_MID = [NOSE_X - 18.8 * PK, PLANE_CY];
  const ux = (u) => +(NOSE_X - u * PK).toFixed(1);     // 機首からu[m]の位置のx（駐機中）
  const FUS_R = 1.975;                     // 胴体の半径（幅3.95m）
  /* 胴体の平面形（半幅[m]）。機首はレドームの丸み、うしろはテールコーンへしぼる */
  const fusHW = (u) => {
    if (u <= 0) return 0;
    if (u < 6.5) { const t = u / 6.5; return FUS_R * Math.pow(1 - (1 - t) * (1 - t), 0.6); }
    if (u <= 28) return FUS_R;
    const s = Math.min(1, (u - 28) / 9.6);
    return 0.3 + (FUS_R - 0.3) * (1 - Math.pow(s, 1.8));
  };
  /* 主翼: 前縁の後退角は約28.5°（25%翼弦で約25°）。後縁は胴体近くがまっすぐで、キンクから先が後退する */
  const W_LE0 = 12.5, W_SWEEP = 0.543, W_KINK = 6.3, W_TE_IN = 19.0, W_TIP = 17.05, W_TIP_CHORD = 1.5;
  const wingLE = (v) => W_LE0 + (Math.abs(v) - 1.98) * W_SWEEP;
  const W_TIP_LE = wingLE(W_TIP), W_TIP_TE = W_TIP_LE + W_TIP_CHORD;
  const wingTE = (v) => {
    const a = Math.abs(v);
    return a <= W_KINK ? W_TE_IN : W_TE_IN + (a - W_KINK) * ((W_TIP_TE - W_TE_IN) / (W_TIP - W_KINK));
  };
  const ENG_V = 5.75;                      // エンジンは中心線から5.75m（パイロンで主翼の前下に吊る）
  const DOOR_U = { L1: 5.3, R2: 30.4, fwdCargo: 8.8, aftCargo: 24.4 };
  const BELT_Y = 397;                      // ベルトの先が貨物ドアの敷居にとどく位置

  /* 作業ごとの持ち場（x, y, [車両の向きdeg]）。人や車が翼・エンジンに重ならないように置く */
  const SLOTS = {
    deboard:   { staff: [[744, 186]] },                      // 搭乗橋の入口のそば（ターミナル側）
    board:     { staff: [[744, 186]] },
    doorclose: { staff: [[794, 248]] },                      // 搭乗橋の先（L1ドアの手前）
    clean:     { staff: [[791, 238], [801, 258]] },                 // 搭乗橋を通って機内へ
    unload:    { staff: [[800, 432], [889, 457]], vehicles: { beltloader: [[ux(DOOR_U.fwdCargo), BELT_Y, -90]], cart: [[835, 452, 0]] } },
    load:      { staff: [[604, 432], [502, 457]], vehicles: { beltloader: [[ux(DOOR_U.aftCargo), BELT_Y, -90]], cart: [[560, 452, 0]] } },
    bagmatch:  { staff: [[612, 470]] },
    refuel:    { staff: [[716, 434]], vehicles: { fuel: [[732, 455, 0]] } },     // 右主翼の前（給油口は翼の下）
    catering:  { staff: [[548, 405]], vehicles: { catering: [[ux(DOOR_U.R2), 377, -90]] } },
    inspect:   { staff: [[898, 296]] },                      // 機首の前から一周
    pushback:  { staff: [[890, 362]], vehicles: { pushback: [[884, 316, 180]] } },  // 機首の前で押す
    depart:    {},
  };
  const TUG_SLOT = SLOTS.pushback.vehicles.pushback[0];
  /* 点検スタッフが機体を一周する経路（機首→左側→尾翼→右側→機首。エンジンの前で立ちどまる位置を通る） */
  const INSPECT_LOOP = [
    [898, 296], [833, 289], [782, 288], [760, 263], [704, 246], [661, 277], [608, 288], [543, 248],
    [495, 284], [492, 316], [495, 348], [543, 384], [608, 344], [661, 355], [704, 386], [760, 369],
    [782, 344], [833, 343], [902, 334],
  ];
  const VEHICLE_HOME = {
    beltloader: [[500, 516, 0]],
    cart: [[600, 516, 0], [688, 516, 0]],
    fuel: [[790, 516, 0]],
    catering: [[892, 516, 0]],
    pushback: [[996, 516, 0]],
  };
  /* 搭乗橋: ターミナルから出る固定通路（背景）→ ロタンダ（回転部）→ のびちぢみする通路 → キャブ */
  const BRG = { x: 770, rot: [770, 198], rotR: 14, dock: [ux(DOOR_U.L1), 274.6], parkLen: 44, parkAng: 45 };
  const BRIDGE_PATH = [[ux(DOOR_U.L1), 297], [ux(DOOR_U.L1), 284], [770, 198], [770, 132]];
  const PAX_SIGN = [880, 169];             // 降機・搭乗の人数カウンターの位置

  /* ---------- 地上走行の経路（直線と円弧をつないでサンプリング） ---------- */
  function taxiPath(x, y, hDeg, segs) {
    let h = rad(hDeg), s = 0;
    const out = [{ x, y, h, s }];
    segs.forEach((g) => {
      if (g.L != null) {
        const n = Math.max(1, Math.ceil(g.L / 3)), x0 = x, y0 = y, s0 = s;
        for (let i = 1; i <= n; i++) {
          const d = (g.L * i) / n;
          x = x0 + Math.cos(h) * d; y = y0 + Math.sin(h) * d;
          out.push({ x, y, h, s: s0 + d });
        }
        s += g.L;
      } else {
        /* a>0 は右（時計まわり）、a<0 は左へ曲がる */
        const a = rad(g.a), sg = Math.sign(a), R = g.R, h0 = h, s0 = s;
        const cx = x - sg * R * Math.sin(h), cy = y + sg * R * Math.cos(h);
        const n = Math.max(2, Math.ceil((Math.abs(a) * R) / 3));
        for (let i = 1; i <= n; i++) {
          h = h0 + (a * i) / n;
          x = cx + sg * R * Math.sin(h); y = cy - sg * R * Math.cos(h);
          out.push({ x, y, h, s: s0 + (Math.abs(a) * R * i) / n });
        }
        s += Math.abs(a) * R;
      }
    });
    return out;
  }
  function poseAt(path, s) {
    if (s <= 0) return path[0];
    const last = path[path.length - 1];
    if (s >= last.s) return last;
    let lo = 0, hi = path.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (path[m].s <= s) lo = m; else hi = m; }
    const a = path[lo], b = path[hi], k = (s - a.s) / ((b.s - a.s) || 1);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, h: a.h + (b.h - a.h) * k, s };
  }
  /* 到着: 誘導路（左）からスタンドの誘導線に入り、停止線で止まる。
   * 誘導線は前輪の通り道。主脚は前輪のあとを追いかけるので、機体の向き＝主脚→前輪。 */
  let _arrival = null;
  function arrivalPaths() {
    if (_arrival) return _arrival;
    const stopX = NOSE_X - NOSE_GEAR_U * PK;
    const nose = taxiPath(-200, 602, 0, [{ L: 240 }, { R: 110, a: -90 }, { L: 66 }, { R: 110, a: 90 }, { L: stopX - 260 }]);
    let mx = nose[0].x - WHEELBASE, my = nose[0].y;
    const main = nose.map((n) => {
      const dx = n.x - mx, dy = n.y - my, d = Math.hypot(dx, dy) || 1;
      mx = n.x - (dx / d) * WHEELBASE; my = n.y - (dy / d) * WHEELBASE;
      return { x: mx, y: my, h: Math.atan2(dy, dx), s: n.s };
    });
    _arrival = { nose, main };
    return _arrival;
  }
  /* プッシュバック: トーイングカーが機首を押して、まっすぐうしろ（左）へ。
   * 出発: 右へ曲がって誘導路へ出て、右へ走り去る（左の翼が搭乗橋に当たらない半径） */
  const PUSH_DIST = 170;
  let _depart = null;
  const departPath = () => _depart || (_depart = taxiPath(PIVOT_X - PUSH_DIST, PLANE_CY, 0, [{ R: 120, a: 90 }, { R: 166, a: -90 }, { L: 660 }]));

  /* ---------- 機体の形（機体ローカル座標: 主脚が原点・機首が+x・右主翼が+y。単位px） ---------- */
  const PX = (u) => (PIVOT_U - u) * PK;
  const PY = (v) => v * PK;
  const SPR = { x0: -196, y0: -174, w: 372, h: 348 };   // 機体スプライトの範囲
  const SPR_SH = 12;                                     // 影スプライトのぼかし余白
  /* 多角形の向きをそろえる（左右反転した形も union で正しく塗れるように） */
  const orient = (pts) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a < 0 ? pts.slice().reverse() : pts;
  };
  const toPath = (pts, path) => {
    const p = path || new Path2D();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    return p;
  };
  let _geo = null;
  function planeGeometry() {
    if (_geo) return _geo;
    const G = {};
    /* 胴体 */
    const us = [];
    for (let u = 0.05; u < 6.5; u += 0.15) us.push(u);
    for (let u = 6.5; u < 37.6; u += 0.4) us.push(u);
    us.push(37.6);
    const fus = [[PX(0), 0]];
    us.forEach((u) => fus.push([PX(u), -fusHW(u) * PK]));
    for (let i = 1; i < 8; i++) {
      const a = -Math.PI / 2 - (i / 8) * Math.PI;
      fus.push([PX(37.6) + Math.cos(a) * 0.3 * PK, Math.sin(a) * 0.3 * PK]);
    }
    us.slice().reverse().forEach((u) => fus.push([PX(u), fusHW(u) * PK]));
    G.fus = orient(fus);
    /* 主翼（s=+1 右/下、s=-1 左/上） */
    G.wing = (s) => orient([
      [PX(12.2), s * PY(1.0)], [PX(W_LE0), s * PY(1.98)], [PX(W_TIP_LE), s * PY(W_TIP)],
      [PX(W_TIP_TE), s * PY(W_TIP)], [PX(W_TE_IN), s * PY(W_KINK)], [PX(W_TE_IN), s * PY(1.0)],
    ]);
    /* シャークレット（翼端の上向きの小翼。上から見ると後ろへ流れる細い帯） */
    G.shark = (s) => orient([
      [PX(W_TIP_LE + 0.02), s * PY(16.98)], [PX(21.95), s * PY(17.78)], [PX(22.55), s * PY(17.9)], [PX(W_TIP_TE), s * PY(16.98)],
    ]);
    /* 水平尾翼（翼幅12.5m・後退角約29°） */
    G.hstab = (s) => orient([
      [PX(31.95), s * PY(0.5)], [PX(35.7), s * PY(6.22)], [PX(37.0), s * PY(6.22)], [PX(35.48), s * PY(0.5)],
    ]);
    /* エンジンナセル（長さ4.4m・直径2.1m）。吸気口の唇→最大径→ノズルへしぼる */
    const nacR = (u) => {
      if (u < 11.55) return 0.9 + ((u - 11.3) / 0.25) * 0.12;
      if (u < 12.4) return 1.02 + ((u - 11.55) / 0.85) * 0.03;
      if (u < 13.9) return 1.05;
      return 1.05 - ((u - 13.9) / 1.8) * 0.27;
    };
    G.nac = (s) => {
      const vc = s * ENG_V, top = [], bot = [];
      for (let u = 11.3; u <= 15.71; u += 0.2) { top.push([PX(u), PY(vc - nacR(u))]); bot.push([PX(u), PY(vc + nacR(u))]); }
      return orient(top.concat(bot.reverse()));
    };
    G.plug = (s) => orient([[PX(15.6), PY(s * ENG_V - 0.42)], [PX(16.45), PY(s * ENG_V)], [PX(15.6), PY(s * ENG_V + 0.42)]]);
    G.pylon = (s) => orient([[PX(12.25), PY(s * ENG_V - 0.24)], [PX(15.2), PY(s * ENG_V - 0.24)], [PX(15.2), PY(s * ENG_V + 0.24)], [PX(12.25), PY(s * ENG_V + 0.24)]]);
    /* フラップのレール覆い（カヌー型。後縁から少し後ろへ飛び出す） */
    G.fairings = (s) => [4.4, 8.6, 11.0, 13.4].map((v) => {
      const u0 = wingTE(v) - 1.4, u1 = wingTE(v) + 1.3, top = [], bot = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10, u = u0 + (u1 - u0) * t;
        const w = 0.22 * (t < 0.3 ? Math.sqrt(t / 0.3) : Math.pow(1 - (t - 0.3) / 0.7, 0.9));
        top.push([PX(u), s * PY(v - w)]); bot.push([PX(u), s * PY(v + w)]);
      }
      return orient(top.concat(bot.reverse()));
    });
    /* 垂直尾翼（上から見ると、細く後ろへのびた帯） */
    const finProf = [[26.6, 0], [28.0, 0.1], [29.4, 0.26], [31.2, 0.33], [33.4, 0.31], [35.6, 0.2], [37.1, 0.08], [37.55, 0]];
    G.fin = orient(finProf.map(([u, t]) => [PX(u), -PY(t)]).concat(finProf.slice(1, -1).reverse().map(([u, t]) => [PX(u), PY(t)])));
    /* 主翼のつけ根のフェアリング（胴体からほんの少しはみ出す） */
    G.rootFair = (() => {
      /* 角丸の長方形（u方向に長い） */
      const pts = [];
      const r = 1.2, a0 = 10.6, a1 = 22.2, hw = 2.22;
      const arc = (cu, cv, from, to) => { for (let i = 0; i <= 6; i++) { const a = from + ((to - from) * i) / 6; pts.push([PX(cu + Math.cos(a) * r), PY(cv + Math.sin(a) * r)]); } };
      arc(a0 + r, -(hw - r), Math.PI, Math.PI * 1.5);
      arc(a1 - r, -(hw - r), Math.PI * 1.5, Math.PI * 2);
      arc(a1 - r, hw - r, 0, Math.PI / 2);
      arc(a0 + r, hw - r, Math.PI / 2, Math.PI);
      return orient(pts);
    })();
    /* パスにまとめる */
    G.fusP = toPath(G.fus);
    G.wingP = { 1: toPath(G.wing(1)), [-1]: toPath(G.wing(-1)) };
    G.hstabP = { 1: toPath(G.hstab(1)), [-1]: toPath(G.hstab(-1)) };
    G.nacP = { 1: toPath(G.nac(1)), [-1]: toPath(G.nac(-1)) };
    G.finP = toPath(G.fin);
    const sil = new Path2D();
    [G.fus, G.wing(1), G.wing(-1), G.shark(1), G.shark(-1), G.hstab(1), G.hstab(-1), G.nac(1), G.nac(-1), G.fin]
      .forEach((pts) => toPath(pts, sil));
    G.silhouette = sil;
    const ao = new Path2D();
    [G.fus, G.nac(1), G.nac(-1)].forEach((pts) => toPath(pts, ao));
    G.aoShape = ao;
    _geo = G;
    return G;
  }

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
      this.arrivalT += dtReal / 4.0;
      if (this.arrivalT >= 1) {
        this.arrivalT = null;
        this.planeParked = true;
        const cb = this.arrivalCb;
        this.arrivalCb = null;
        this.float(PLANE_MID[0], 236, '✈ とうちゃく！ じゅんびスタート！', '#0e6f8c');
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
      /* ボタンで拡大するときは、機体が画面に見えていれば機体を中心に（機首や尾翼が切れにくい） */
      let pivot = (px != null) ? { x: px, y: py } : { x: this.cw / 2, y: this.ch / 2 };
      if (px == null) {
        const m = this.sceneToScreen(PLANE_MID[0], PLANE_MID[1]);
        if (m.x > 0 && m.x < this.cw && m.y > 0 && m.y < this.ch) pivot = m;
      }
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

    /* 機体エリアを避けるL字経路をつくる（上側＝搭乗橋のまわりへは、機首の前を回りこむ） */
    route(from, to) {
      const pts = [from.slice(0, 2)];
      const CORR = 480;      // 横移動用の通路（機体の下側と車両置き場のあいだ）
      const SIDE = 912;      // 機首の前を回りこむ縦通路
      const topSide = (p) => p[1] < 300;
      const a = from, b = to;
      if (topSide(a) && topSide(b)) {
        /* 搭乗橋のまわりどうしは、そのまま歩く */
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
      if (taskId === 'pushback') {
        /* 押し終わった位置（トーイングカーのところ）で祝う */
        const p = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1], this.planeTransform(state));
        a = [p.x, p.y];
      }
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
        /* 到着・出発で走っているときは、地上の車や人より上（翼の下にかくれる） */
        const dep = state.tasks.depart.status;
        const planeTop = this.arrivalT != null || dep === 'active' || dep === 'done';
        if (!planeTop) this.drawPlane(state);
        this.drawBridge(state);
        this.drawEffectsUnder(state, gt);
        this.drawSoonSpots(state);
        this.drawSpots(state, ui);
        this.drawSpotPops(dtReal);
        this.drawEntities(state, gt, ui);
        this.drawPlaneOverlay(state);
        if (planeTop) this.drawPlane(state);
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
      /* ゲート表示（搭乗橋の根元の上） */
      c.fillStyle = '#22405f';
      this.rr(BRG.x - 46, 100, 92, 24, 6); c.fill();
      c.fillStyle = '#ffd24a';
      c.font = 'bold 13px ' + CF;
      c.textAlign = 'center';
      c.fillText('GATE 7', BRG.x, 113);
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
      /* 主脚のタイヤあと（誘導線に入るときに主脚が通るところ。左右2本） */
      c.strokeStyle = 'rgba(40,48,58,.06)'; c.lineWidth = 4; c.lineCap = 'round';
      [-1, 1].forEach((s) => {
        c.beginPath();
        arrivalPaths().main.forEach((p, i) => {
          if (p.s < 300 || p.s > 760 || i % 3) return;
          const x = p.x - Math.sin(p.h) * s * 3.8 * PK, y = p.y + Math.cos(p.h) * s * 3.8 * PK;
          if (p.s < 303) c.moveTo(x, y); else c.lineTo(x, y);
        });
        c.stroke();
      });
      c.lineCap = 'butt';
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

      /* --- スタンドの誘導線（前輪の通り道）・停止線・スポット番号 ---
       * 誘導路のセンターラインから分かれ、左から入って機首を右に向けて止まる。黄色の線に黒いふち。 */
      const yel = wet ? '#c8ae44' : '#e8c84a';
      const lead = arrivalPaths().nose.filter((p) => p.s >= 236);
      const stopX = NOSE_X - NOSE_GEAR_U * PK;
      const leadLine = (w, col) => {
        c.strokeStyle = col; c.lineWidth = w; c.lineJoin = 'round';
        c.beginPath();
        lead.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
        c.lineTo(stopX + 16, PLANE_CY);
        c.stroke();
      };
      leadLine(5.5, 'rgba(34,36,32,.38)');
      leadLine(3, yel);
      /* 停止線（A320の前輪が止まる位置。駐機中は機体の下にかくれる） */
      c.strokeStyle = 'rgba(34,36,32,.38)'; c.lineWidth = 5.5;
      c.beginPath(); c.moveTo(stopX, PLANE_CY - 13); c.lineTo(stopX, PLANE_CY + 13); c.stroke();
      c.strokeStyle = yel; c.lineWidth = 3;
      c.beginPath(); c.moveTo(stopX, PLANE_CY - 12); c.lineTo(stopX, PLANE_CY + 12); c.stroke();
      /* スポット番号（誘導線の上に黄色の地・黒の文字でペイント） */
      c.fillStyle = 'rgba(34,36,32,.5)';
      this.rr(419, PLANE_CY - 10.5, 40, 21, 3); c.fill();
      c.fillStyle = yel;
      this.rr(421, PLANE_CY - 8.5, 36, 17, 2); c.fill();
      c.fillStyle = '#22262b';
      c.font = 'bold 13px ' + CF;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('S7', 439, PLANE_CY + 0.5);
      /* 搭乗橋の待機位置（駆動輪をとめる場所の白い枠） */
      c.save();
      c.translate(BRG.rot[0] + Math.cos(rad(BRG.parkAng)) * 37.6, BRG.rot[1] + Math.sin(rad(BRG.parkAng)) * 37.6);
      c.rotate(rad(BRG.parkAng));
      c.strokeStyle = 'rgba(255,255,255,.38)'; c.lineWidth = 1.2;
      c.strokeRect(-6, -17, 12, 34);
      c.restore();

      /* 制限区域ライン（赤の点線）: 駐機中の機体（翼端・尾翼・機首の車）を囲む。ターミナル側はあけておく */
      c.strokeStyle = 'rgba(214,69,69,.45)'; c.lineWidth = 2.5;
      c.setLineDash([14, 10]);
      c.beginPath();
      c.moveTo(472, 150); c.lineTo(472, 458); c.arcTo(472, 484, 498, 484, 26);
      c.lineTo(906, 484); c.arcTo(932, 484, 932, 458, 26); c.lineTo(932, 150);
      c.stroke();
      c.setLineDash([]);

      /* スタッフ待機所（うっすら影つき） */
      c.fillStyle = 'rgba(30,40,52,.16)';
      this.rr(253, 487, 172, 58, 8); c.fill();
      c.fillStyle = wet ? '#98a2ab' : '#aeb7be';
      this.rr(250, 484, 172, 58, 8); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(252, 485.5); c.lineTo(420, 485.5); c.stroke();
      c.strokeStyle = '#87919a'; c.lineWidth = 2; this.rr(250, 484, 172, 58, 8); c.stroke();
      /* 名前は区画の下に（上は機体の制限区域ラインと重なるため） */
      c.fillStyle = '#57626d';
      c.font = '11px ' + CF;
      c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText('スタッフのまちあい', 256, 558);

      /* 車両置き場 */
      c.fillStyle = '#57626d';
      c.fillText('はたらく車のおきば', 452, 558);
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2;
      [450, 552, 648, 742, 844, 948, 1046].forEach((x) => {
        c.beginPath(); c.moveTo(x, 486); c.lineTo(x, 548); c.stroke();
      });

      /* 吹き流しのポール（本体はdrawSkyLifeで動かす） */
      c.strokeStyle = '#7c858e'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(1128, 188); c.lineTo(1128, 154); c.stroke();

      /* 搭乗橋の固定通路（ターミナルからロタンダまで。動かないので背景に描く。光は左上→左の面が明るい） */
      const fx0 = BRG.x - 10, fy0 = 124, fy1 = BRG.rot[1] - BRG.rotR + 3;
      c.fillStyle = 'rgba(16,26,40,.17)';
      c.fillRect(fx0 + 10, Math.max(fy0 + 14, 140), 20, fy1 + 14 - Math.max(fy0 + 14, 140));
      const fgr = c.createLinearGradient(fx0, 0, fx0 + 20, 0);
      fgr.addColorStop(0, '#e0e7ed'); fgr.addColorStop(0.45, '#c9d2da'); fgr.addColorStop(1, '#a3afba');
      c.fillStyle = fgr; c.fillRect(fx0, fy0, 20, fy1 - fy0);
      c.strokeStyle = 'rgba(86,102,118,.28)'; c.lineWidth = 0.6;
      c.beginPath();
      for (let y = fy0 + 4; y < fy1 - 1; y += 4.5) { c.moveTo(fx0 + 1, y); c.lineTo(fx0 + 19, y); }
      c.stroke();
      c.strokeStyle = 'rgba(58,72,88,.68)'; c.lineWidth = 0.8;
      c.strokeRect(fx0, fy0, 20, fy1 - fy0);
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
      const ease = (t) => t * t * (3 - 2 * t);
      const out = (p, alpha) => ({ x: p.x - PIVOT_X, y: p.y - PLANE_CY, rot: p.h, alpha });
      /* 到着シネマティック: 誘導路から誘導線をたどってスポットへ（減速して停止線で止まる） */
      if (this.arrivalT != null) {
        const t = clamp(this.arrivalT, 0, 1);
        const main = arrivalPaths().main;
        const L = main[main.length - 1].s, s = L * (1 - (1 - t) * (1 - t));
        const p = poseAt(main, s);
        /* 最後の直線で、ぴったり駐機位置（向き0）へなめらかに合わせる */
        const w = ease(clamp((s / L - 0.8) / 0.2, 0, 1));
        const fit = { x: p.x + (PIVOT_X - p.x) * w, y: p.y + (PLANE_CY - p.y) * w, h: p.h * (1 - w) };
        return out(fit, t < 0.05 ? t / 0.05 : 1);
      }
      let pose = { x: PIVOT_X, y: PLANE_CY, h: 0 }, alpha = 1;
      /* プッシュバック: 機首のトーイングカーが、まっすぐうしろ（左）へ押し出す */
      if (push.status === 'active' || push.status === 'done') {
        const p = push.status === 'done' ? 1 : ease(clamp(push.progress / G.effDur(push), 0, 1));
        pose = { x: PIVOT_X - PUSH_DIST * p, y: PLANE_CY, h: 0 };
      }
      /* 出発: 右へ曲がって誘導路に出て、右へ走り去る */
      if (dep.status === 'active' || dep.status === 'done') {
        const p = dep.status === 'done' ? 1 : ease(clamp(dep.progress / G.effDur(dep), 0, 1));
        const path = departPath();
        pose = poseAt(path, path[path.length - 1].s * p);
        alpha = p > 0.75 ? clamp(1 - (p - 0.75) / 0.22, 0, 1) : 1;
      }
      return out(pose, alpha);
    },

    /* ============ 機体（上から見たA320） ============
     * 形・塗装・陰影・パネルライン・窓・航行灯は、オフスクリーンに高解像度で1回だけ描いてキャッシュする。
     * 毎フレームは「影・機体の絵を回して貼る」「ドアの開閉」「衝突防止灯の点滅」だけを描く。 */
    planeSprites(state) {
      const wet = !!(state && state.stage && state.stage.rainAll);
      const q = clamp(Math.round(this.baseScale() * this.dpr * 2.6), 2, 5);
      /* Webフォントが読めたら1回だけ描き直す（以後は読みこみ中に戻っても描き直さない） */
      this._fontOk = this._fontOk || !document.fonts || document.fonts.status === 'loaded';
      const fontOk = this._fontOk;
      const key = q + '|' + (wet ? 1 : 0) + '|' + (fontOk ? 1 : 0);
      if (this._plane && this._plane.key === key) return this._plane;
      const G = planeGeometry();
      const mk = (w, h) => { const cv = document.createElement('canvas'); cv.width = Math.ceil(w); cv.height = Math.ceil(h); return cv; };
      /* 機体 */
      const body = mk(SPR.w * q, SPR.h * q);
      const g = body.getContext('2d');
      g.setTransform(q, 0, 0, q, -SPR.x0 * q, -SPR.y0 * q);
      this.renderPlaneBody(g, G, wet);
      /* 落ち影と接地の陰（シルエットをぼかす。ぼかしは影オフセットの技法でにじませる） */
      const B = SPR_SH, sq = 2, FAR = 3000;
      const soft = (shape, blur) => {
        const cv = mk((SPR.w + 2 * B) * sq, (SPR.h + 2 * B) * sq);
        const sg = cv.getContext('2d');
        sg.setTransform(sq, 0, 0, sq, (-SPR.x0 + B - FAR) * sq, (-SPR.y0 + B) * sq);
        sg.shadowColor = '#101a28'; sg.shadowBlur = blur * sq; sg.shadowOffsetX = FAR * sq;
        sg.fillStyle = '#101a28';
        sg.fill(shape);
        return cv;
      };
      this._plane = { key, body, shadow: soft(G.silhouette, 6), ao: soft(G.aoShape, 3.5) };
      return this._plane;
    },

    /* 機体の静的な部分を描く。g は機体ローカル座標（主脚が原点・機首が+x・右主翼が+y）。
     * 光源は左上: 上（左側）のふちが明るく、下（右側）のふちと右主翼のつけ根に胴体の陰。 */
    renderPlaneBody(g, G, wet) {
      const X = PX, Y = PY, R = FUS_R * PK;
      const LINE = 'rgba(70,86,104,.6)';
      const P = (u, v) => [X(u), Y(v)];
      const fillP = (pts, style) => { g.fillStyle = style; g.fill(toPath(pts)); };
      const strokeP = (path, style, w) => { g.strokeStyle = style; g.lineWidth = w; g.stroke(path); };
      const seg = (pairs, style, w) => {
        g.strokeStyle = style; g.lineWidth = w; g.beginPath();
        pairs.forEach(([a, b]) => { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); });
        g.stroke();
      };
      const fusShade = () => { g.save(); g.translate(6, 8.5); g.fillStyle = 'rgba(28,42,60,.22)'; g.fill(G.fusP); g.restore(); };

      /* 1) フラップのレール覆い（翼の下から後ろへ飛び出した部分だけ見える） */
      [1, -1].forEach((s) => G.fairings(s).forEach((pts) => {
        fillP(pts, s > 0 ? '#cfd6dc' : '#c6cdd4');
        strokeP(toPath(pts), 'rgba(70,86,104,.45)', 0.45);
      }));

      /* 2) エンジン（主翼より下にあるので先に描く。前半が翼の前に出て見える） */
      [1, -1].forEach((s) => {
        const vc = s * ENG_V, path = G.nacP[s];
        g.fillStyle = '#59636e'; g.fill(toPath(G.plug(s)));      // 排気コーン（上からは翼にかくれる）
        const gr = g.createLinearGradient(0, Y(vc - 1.05), 0, Y(vc + 1.05));
        gr.addColorStop(0, '#d7dee5'); gr.addColorStop(0.22, '#fbfcfd'); gr.addColorStop(0.5, '#edf1f4');
        gr.addColorStop(0.8, '#bdc6cf'); gr.addColorStop(1, '#9ca7b2');
        g.fillStyle = gr; g.fill(path);
        g.save(); g.clip(path);
        g.fillStyle = 'rgba(255,255,255,.8)';                       // 吸気口の唇（みがいた金属）
        g.fillRect(X(11.5), Y(vc - 1.2), X(11.3) - X(11.5), PY(2.4));
        g.fillStyle = 'rgba(47,127,196,.85)';                       // あおぞら航空の青いライン
        g.fillRect(X(11.92), Y(vc - 1.2), X(11.74) - X(11.92), PY(2.4));
        g.fillStyle = '#161d24';                                    // 吸気口の暗いのぞき
        g.beginPath(); g.ellipse(X(11.3) + 0.4, Y(vc), 2.1, PY(0.78), 0, 0, TAU); g.fill();
        g.restore();
        strokeP(path, LINE, 0.6);
        const py = toPath(G.pylon(s));                              // パイロン（主翼から吊る柱）
        g.fillStyle = '#cdd4da'; g.fill(py);
        strokeP(py, 'rgba(70,86,104,.5)', 0.45);
        seg([[P(12.35, vc - 0.08 * s), P(15.1, vc - 0.08 * s)]], 'rgba(255,255,255,.7)', 0.4);
      });

      /* 3) 主翼 */
      const hinge = (v) => wingTE(v) - (0.25 * (wingTE(v) - wingLE(v)) + 0.15);
      [1, -1].forEach((s) => {
        const path = G.wingP[s];
        g.fillStyle = s > 0 ? '#dbe1e6' : '#d1d8de';   // 上反角: 右翼は少し光のほうへ、左翼は少し背を向ける
        g.fill(path);
        g.save(); g.clip(path);
        /* 翼型のふくらみのハイライト（前縁から2〜4割） */
        const hi = [], lo = [];
        for (let v = 1.0; v <= W_TIP + 0.01; v += 0.5) {
          const le = v < 1.98 ? W_LE0 : wingLE(v), ch = wingTE(v) - le;
          hi.push(P(le + ch * 0.16, s * v)); lo.push(P(le + ch * 0.42, s * v));
        }
        fillP(hi.concat(lo.reverse()), 'rgba(255,255,255,.3)');
        /* 前縁のまるみ（前を向く面は光の反対で少し暗い） */
        const le1 = [], le2 = [];
        for (let v = 1.0; v <= W_TIP + 0.01; v += 0.5) {
          const le = v < 1.98 ? W_LE0 : wingLE(v);
          le1.push(P(le - 0.2, s * v)); le2.push(P(le + 0.35, s * v));
        }
        fillP(le1.concat(le2.reverse()), 'rgba(80,96,112,.10)');
        /* 後縁の動翼（フラップ・補助翼）は少し暗い */
        const fl = [], te = [];
        for (let v = 1.0; v <= 16.31; v += 0.5) { fl.push(P(hinge(v), s * v)); te.push(P(wingTE(v) + 0.3, s * v)); }
        fillP(fl.concat(te.reverse()), 'rgba(70,86,102,.09)');
        if (s > 0) fusShade();                       // 胴体の落とす影（右翼のつけ根）
        g.restore();
        /* 線: スラット・ヒンジ・スポイラー・ノーステップ枠 */
        const L = [];
        [[2.3, 5.35], [6.15, 8.6], [8.6, 11.2], [11.2, 13.9], [13.9, 16.9]].forEach(([a, b]) => {
          L.push([P(wingLE(a) + 0.55, s * a), P(wingLE(b) + 0.55, s * b)]);
          L.push([P(wingLE(a), s * a), P(wingLE(a) + 0.55, s * a)]);
        });
        for (let v = 1.98; v < 16.3; v += 0.5) {
          const v2 = Math.min(16.3, v + 0.5);
          L.push([P(hinge(v), s * v), P(hinge(v2), s * v2)]);
        }
        [6.3, 12.4, 16.3].forEach((v) => L.push([P(hinge(v), s * v), P(wingTE(v), s * v)]));
        [[3.0, 5.1], [6.6, 12.2]].forEach(([a, b]) => {
          for (let v = a; v < b - 0.01; v += 0.5) {
            const v2 = Math.min(b, v + 0.5);
            L.push([P(hinge(v) - 0.9, s * v), P(hinge(v2) - 0.9, s * v2)]);
          }
        });
        [3.0, 5.1, 6.6, 8.0, 9.4, 10.8, 12.2].forEach((v) => L.push([P(hinge(v) - 0.9, s * v), P(hinge(v), s * v)]));
        seg(L, 'rgba(70,86,104,.36)', 0.45);
        const walk = [P(wingLE(2.4) + 0.9, s * 2.4), P(wingLE(5.0) + 0.9, s * 5.0), P(hinge(5.0) - 1.15, s * 5.0), P(hinge(2.4) - 1.15, s * 2.4)];
        strokeP(toPath(walk), 'rgba(30,36,44,.42)', 0.4);
        strokeP(path, LINE, 0.6);
      });

      /* 4) シャークレット（翼端の小翼。あおぞら航空の青） */
      [1, -1].forEach((s) => {
        const pts = G.shark(s);
        fillP(pts, s < 0 ? '#4a94d5' : '#22659c');
        strokeP(toPath(pts), 'rgba(16,46,80,.65)', 0.5);
      });

      /* 5) 水平尾翼 */
      [1, -1].forEach((s) => {
        const path = G.hstabP[s];
        g.fillStyle = s > 0 ? '#d9dfe4' : '#d0d7dd';
        g.fill(path);
        g.save(); g.clip(path);
        fillP([P(32.3, s * 0.5), P(35.95, s * 6.22), P(36.3, s * 6.22), P(33.2, s * 0.5)], 'rgba(255,255,255,.26)');
        if (s > 0) fusShade();
        g.restore();
        seg([[P(34.43, s * 0.6), P(36.6, s * 6.05)]], 'rgba(70,86,104,.42)', 0.45);   // 昇降舵のヒンジ
        strokeP(path, LINE, 0.6);
      });

      /* 6) 主翼のつけ根のフェアリング */
      fillP(G.rootFair, '#dde2e7');
      strokeP(toPath(G.rootFair), 'rgba(70,86,104,.35)', 0.5);

      /* 7) 胴体（白い円筒。上のふちが明るく、下のふちに陰） */
      const fp = G.fusP;
      const hull = g.createLinearGradient(0, -R, 0, R);
      hull.addColorStop(0, '#dde4ea'); hull.addColorStop(0.12, '#f3f6f8'); hull.addColorStop(0.24, '#ffffff');
      hull.addColorStop(0.45, '#f7f9fa'); hull.addColorStop(0.68, '#e6ebef'); hull.addColorStop(0.86, '#cdd5dc');
      hull.addColorStop(1, '#b2bcc6');
      g.fillStyle = hull; g.fill(fp);
      g.save(); g.clip(fp);
      /* 尾部の青（垂直尾翼のつけ根から胴体の上へ、細くまわりこむ塗装） */
      const tw = (u) => 0.58 * Math.pow(Math.min(1, (u - 26.0) / 6), 0.7);   // 前はとがり、うしろほど少し太い
      const tb = [];
      for (let u = 26.0; u <= 38.0; u += 0.3) tb.push(P(u, -tw(u)));
      for (let u = 38.0; u >= 26.0; u -= 0.3) tb.push(P(u, tw(u)));
      const bg = g.createLinearGradient(0, -PY(0.95), 0, PY(0.95));
      bg.addColorStop(0, '#4b97d8'); bg.addColorStop(0.5, '#2f7fc4'); bg.addColorStop(1, '#205f99');
      fillP(tb, bg);
      /* レドーム（機首の先）はわずかに色がちがう */
      fillP([P(-0.5, -2), P(1.55, -2), P(1.55, 2), P(-0.5, 2)], 'rgba(150,162,174,.12)');
      seg([[P(1.55, -fusHW(1.55)), P(1.55, fusHW(1.55))]], 'rgba(100,115,130,.4)', 0.5);
      /* 機首の先は光から背を向ける → 少し暗い */
      const nd = g.createRadialGradient(X(0), 0, 0, X(0), 0, PY(3.2));
      nd.addColorStop(0, 'rgba(58,74,92,.22)'); nd.addColorStop(1, 'rgba(58,74,92,0)');
      g.fillStyle = nd; g.fillRect(X(3.3), -R, PY(3.4), 2 * R);
      /* つやのハイライト（上寄りに細く） */
      g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(X(4.5), -0.5 * R); g.lineTo(X(28.4), -0.5 * R); g.stroke();
      /* パネルのつなぎ目（ごく薄く） */
      const pl = [];
      [6.5, 10.6, 13.2, 21.8, 26.0, 28.6, 33.0].forEach((u) => pl.push([P(u, -fusHW(u)), P(u, fusHW(u))]));
      pl.push([P(3.2, -0.42 * FUS_R), P(29.5, -0.42 * FUS_R)], [P(3.2, 0.42 * FUS_R), P(29.5, 0.42 * FUS_R)]);
      seg(pl, 'rgba(108,124,140,.17)', 0.45);
      /* 窓の列（両側のふち）。左側は空が映ってやや明るい */
      [-1, 1].forEach((s) => {
        g.fillStyle = s < 0 ? 'rgba(52,68,84,.85)' : 'rgba(34,44,56,.9)';
        g.beginPath();
        for (let u = 6.9; u <= 29.3; u += 0.535) {
          if (u > 14.15 && u < 15.85) continue;               // 非常口のところは窓なし
          g.rect(X(u) - 1.2, s * fusHW(u) * PK * 0.82 - 0.8, 2.4, 1.6);
        }
        g.fill();
      });
      /* 控えめな青い帯（窓の下のライン） */
      g.strokeStyle = 'rgba(47,127,196,.75)'; g.lineWidth = 0.8;
      [-1, 1].forEach((s) => {
        g.beginPath();
        for (let u = 4.6; u <= 28.6; u += 0.5) {
          const y = s * fusHW(u) * PK * 0.93;
          if (u === 4.6) g.moveTo(X(u), y); else g.lineTo(X(u), y);
        }
        g.stroke();
      });
      /* ドアの輪郭（左=L1・L2、右=R1・R2、主翼の上の非常口、右側の貨物ドア） */
      const door = (u, w, s, inner) => {
        const hw = fusHW(u) * PK;
        g.strokeRect(X(u + w / 2), s > 0 ? hw * inner : -hw, PY(w), hw * (1 - inner));
      };
      g.strokeStyle = 'rgba(60,74,90,.65)'; g.lineWidth = 0.5;
      [-1, 1].forEach((s) => {
        door(DOOR_U.L1, 0.85, s, 0.7); door(DOOR_U.R2, 0.85, s, 0.7);
        door(14.55, 0.5, s, 0.74); door(15.45, 0.5, s, 0.74);
      });
      door(DOOR_U.fwdCargo, 1.7, 1, 0.84); door(DOOR_U.aftCargo, 1.7, 1, 0.84);
      /* コックピットの窓（左右に4枚ずつの台形） */
      const cwin = [
        [[1.62, 0.07], [2.3, 0.09], [2.36, 0.93], [1.8, 0.66]],
        [[2.44, 0.97], [2.98, 1.14], [3.0, 1.38], [2.48, 1.24]],
        [[3.06, 1.17], [3.56, 1.28], [3.58, 1.5], [3.08, 1.42]],
        [[3.64, 1.3], [3.98, 1.36], [4.0, 1.56], [3.66, 1.52]],
      ];
      [-1, 1].forEach((s) => cwin.forEach((qd) => {
        const pts = qd.map(([u, v]) => P(u, s * v));
        fillP(pts, s < 0 ? '#2e3f50' : '#1b2631');
        strokeP(toPath(pts), 'rgba(18,26,34,.75)', 0.4);
      }));
      fillP([P(1.78, -0.14), P(2.22, -0.16), P(2.26, -0.55), P(1.92, -0.44)], 'rgba(176,206,230,.4)');  // 空の映りこみ
      /* アンテナ・衝突防止灯の台座 */
      g.fillStyle = '#56616d';
      [[6.2, 0, 0.5], [13.9, 0.35, 0.4], [21.4, 0, 0.5], [23.6, -0.3, 0.35]].forEach(([u, v, l]) => g.fillRect(X(u + l / 2), Y(v) - 0.45, PY(l), 0.9));
      g.fillStyle = '#7d3b3b'; g.beginPath(); g.arc(X(16.8), 0, 1.3, 0, TAU); g.fill();
      /* 機体の名前（上から見える屋根に小さく） */
      g.fillStyle = 'rgba(34,92,152,.92)';
      g.font = 'bold 8.5px ' + CF; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('あおぞら', X(9.6), Y(-0.02));
      /* ふちの陰（円筒のまるみ） */
      g.strokeStyle = 'rgba(52,68,86,.18)'; g.lineWidth = 3.4; g.stroke(fp);
      g.restore();
      strokeP(fp, 'rgba(66,82,100,.62)', 0.7);

      /* 8) 垂直尾翼の影（胴体と右の水平尾翼に落ちる）と垂直尾翼 */
      const clipU = new Path2D();
      toPath(G.fus, clipU); toPath(G.hstab(1), clipU);
      g.save(); g.clip(clipU);
      fillP([[X(26.6), 0], [X(35.2), PY(0.3)], [X(37.3) + 14.4, 19.8], [X(34.6) + 14.4, 19.8]], 'rgba(28,42,60,.2)');
      g.restore();
      const fg = g.createLinearGradient(0, -PY(0.33), 0, PY(0.33));
      fg.addColorStop(0, '#6cafe7'); fg.addColorStop(0.45, '#3a87cb'); fg.addColorStop(1, '#1a548e');
      g.fillStyle = fg; g.fill(G.finP);
      seg([[P(34.6, -0.24), P(34.6, 0.24)]], 'rgba(14,42,76,.6)', 0.4);   // 方向舵のつなぎ目
      strokeP(G.finP, 'rgba(14,42,76,.75)', 0.5);

      /* 9) 航行灯（左翼端=赤・右翼端=緑・尾=白） */
      const nav = (x, y, rgb, r) => {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, `rgba(${rgb},.85)`); gr.addColorStop(0.35, `rgba(${rgb},.35)`); gr.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
        g.fillStyle = `rgb(${rgb})`; g.beginPath(); g.arc(x, y, 0.9, 0, TAU); g.fill();
      };
      nav(X(20.9), -PY(17.15), '255,64,64', 4.4);
      nav(X(20.9), PY(17.15), '52,222,120', 4.4);
      nav(X(37.75), 0, '255,255,255', 3.4);

      /* 雨の日: ひんやりした色にくもらせる */
      if (wet) {
        g.save();
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = 'rgba(62,86,116,.14)';
        g.fillRect(SPR.x0, SPR.y0, SPR.w, SPR.h);
        g.restore();
      }
    },

    drawPlane(state) {
      const c = this.ctx;
      const tr = this.planeTransform(state);
      if (tr.alpha <= 0) return;
      const spr = this.planeSprites(state);
      const wet = !!(state.stage && state.stage.rainAll);
      const px = PIVOT_X + tr.x, py = PLANE_CY + tr.y;
      const cos = Math.cos(tr.rot), sin = Math.sin(tr.rot);
      const W = (x, y, ox, oy) => [px + x * cos - y * sin + ox, py + x * sin + y * cos + oy];
      const blink = 0.35 + 0.65 * Math.abs(Math.sin(this.time * 3.4));
      const B = SPR_SH;
      c.save();
      /* 落ち影: 光源=左上 → 世界の右下へずらす（機体が向きを変えても影の向きは同じ） */
      c.globalAlpha = tr.alpha * (wet ? 0.16 : 0.27);
      c.save(); c.translate(px + 8, py + 11); c.rotate(tr.rot);
      c.drawImage(spr.shadow, SPR.x0 - B, SPR.y0 - B, SPR.w + 2 * B, SPR.h + 2 * B);
      c.restore();
      /* 垂直尾翼の影: 背が高い（約12m）ので、先のほうほど遠くへ落ちる */
      c.globalAlpha = tr.alpha * (wet ? 0.55 : 1);
      c.fillStyle = 'rgba(16,26,40,.075)';
      [[0, 0], [1.3, 1.3], [-1.3, -1.3]].forEach(([dx, dy]) => {
        c.fill(toPath([
          W(PX(26.6), 0, 8.8 + dx, 12.1 + dy), W(PX(35.2), 0, 8.8 + dx, 12.1 + dy),
          W(PX(37.3), 0, 23.6 + dx, 32.5 + dy), W(PX(34.6), 0, 23.6 + dx, 32.5 + dy),
        ]));
      });
      /* 接地の陰（胴体とエンジンの真下） */
      c.globalAlpha = tr.alpha * (wet ? 0.3 : 0.38);
      c.save(); c.translate(px + 1.5, py + 2.5); c.rotate(tr.rot);
      c.drawImage(spr.ao, SPR.x0 - B, SPR.y0 - B, SPR.w + 2 * B, SPR.h + 2 * B);
      c.restore();
      /* 下面の衝突防止灯が地面を赤く照らす */
      c.globalAlpha = tr.alpha;
      const [gx, gy] = W(PX(15.5), 0, 0, 0);
      const rg = c.createRadialGradient(gx, gy, 0, gx, gy, 44);
      rg.addColorStop(0, `rgba(255,70,60,${(0.22 * blink).toFixed(3)})`);
      rg.addColorStop(1, 'rgba(255,70,60,0)');
      c.fillStyle = rg; c.beginPath(); c.arc(gx, gy, 44, 0, TAU); c.fill();
      /* 機体（キャッシュした絵を回して貼る） */
      c.translate(px, py); c.rotate(tr.rot);
      c.drawImage(spr.body, SPR.x0, SPR.y0, SPR.w, SPR.h);
      this.drawPlaneDoors(state, blink);
      c.restore();
    },

    /* ドアの開閉と上面の衝突防止灯（機体ローカル座標で描く） */
    drawPlaneDoors(state, blink) {
      const c = this.ctx, t = state.tasks;
      const open = (u, w, s, inner) => {
        const hw = fusHW(u) * PK, x0 = PX(u + w / 2), ww = w * PK;
        c.fillStyle = '#1f272e';
        c.fillRect(x0, s > 0 ? hw * inner : -hw, ww, hw * (1 - inner));
        /* 開いたドアから機内のあかりがこぼれる */
        const gx = x0 + ww / 2, gy = s * hw, r = 6 + ww * 0.4;
        const gl = c.createRadialGradient(gx, gy, 0, gx, gy, r);
        gl.addColorStop(0, 'rgba(255,212,140,.6)'); gl.addColorStop(1, 'rgba(255,212,140,0)');
        c.fillStyle = gl; c.beginPath(); c.arc(gx, gy, r, 0, TAU); c.fill();
      };
      if (this.bridge > 0.9) open(DOOR_U.L1, 0.85, -1, 0.66);           // L1: 搭乗橋がついたら開く
      if (t.catering.status === 'active') {                            // R2: ケータリング中
        open(DOOR_U.R2, 0.85, 1, 0.66);
        /* 客室ドアは外へ出て前へスライドする（上から見ると胴体の横の細い板） */
        const hw = fusHW(DOOR_U.R2) * PK;
        c.fillStyle = '#eef2f5'; c.fillRect(PX(29.85), hw + 0.4, 0.85 * PK, 2.4);
        c.strokeStyle = 'rgba(60,74,90,.7)'; c.lineWidth = 0.5; c.strokeRect(PX(29.85), hw + 0.4, 0.85 * PK, 2.4);
      }
      if (t.unload.status === 'active') open(DOOR_U.fwdCargo, 1.7, 1, 0.8);  // 前方貨物ドア
      if (t.load.status === 'active') open(DOOR_U.aftCargo, 1.7, 1, 0.8);    // 後方貨物ドア
      /* 上面の衝突防止灯（赤の点滅） */
      const bx = PX(16.8);
      const bg = c.createRadialGradient(bx, 0, 0, bx, 0, 7);
      bg.addColorStop(0, `rgba(255,86,72,${(blink * 0.55).toFixed(3)})`);
      bg.addColorStop(1, 'rgba(255,86,72,0)');
      c.fillStyle = bg; c.beginPath(); c.arc(bx, 0, 7, 0, TAU); c.fill();
      c.fillStyle = `rgba(255,66,58,${blink.toFixed(3)})`;
      c.beginPath(); c.arc(bx, 0, 1.5, 0, TAU); c.fill();
    },

    /* 開いた貨物ドアの扉（上へはね上がる）。ベルトローダーの先より上にあるので、車両のあとに描く */
    drawPlaneOverlay(state) {
      const t = state.tasks;
      const fwd = t.unload.status === 'active', aft = t.load.status === 'active';
      if (!fwd && !aft) return;
      const c = this.ctx, tr = this.planeTransform(state);
      c.save();
      c.globalAlpha = tr.alpha;
      c.translate(PIVOT_X + tr.x, PLANE_CY + tr.y); c.rotate(tr.rot);
      const panel = (u) => {
        const R = fusHW(u) * PK, w = 1.7 * PK, d = 1.3 * PK, x0 = PX(u) - w / 2;
        c.fillStyle = 'rgba(22,32,46,.28)'; c.fillRect(x0 + 1.6, R + 2.2, w, d);   // ベルトに落ちる影
        const gr = c.createLinearGradient(0, R, 0, R + d);
        gr.addColorStop(0, '#c0c8d0'); gr.addColorStop(0.3, '#f1f4f6'); gr.addColorStop(1, '#dce2e7');
        c.fillStyle = gr; c.fillRect(x0, R - 0.4, w, d + 0.4);
        c.strokeStyle = 'rgba(60,74,90,.75)'; c.lineWidth = 0.6; c.strokeRect(x0, R - 0.4, w, d + 0.4);
        c.strokeStyle = 'rgba(108,124,140,.5)'; c.lineWidth = 0.45; c.strokeRect(x0 + 1.5, R + 1.3, w - 3, d - 2.8);
        c.fillStyle = 'rgba(38,50,64,.6)'; c.fillRect(x0, R - 0.6, w, 1.1);       // ちょうつがい
      };
      if (fwd) panel(DOOR_U.fwdCargo);
      if (aft) panel(DOOR_U.aftCargo);
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

    /* 搭乗橋の形（k=1 でL1ドアに接続、0 で機首側の待機位置へ縮める） */
    bridgeGeom(k) {
      const [rx, ry] = BRG.rot;
      const a1 = Math.atan2(BRG.dock[1] - ry, BRG.dock[0] - rx), L1 = Math.hypot(BRG.dock[0] - rx, BRG.dock[1] - ry);
      const a0 = rad(BRG.parkAng);
      const L = BRG.parkLen + (L1 - BRG.parkLen) * k, a = a0 + (a1 - a0) * k;
      return { rx, ry, L, a, ex: rx + Math.cos(a) * L, ey: ry + Math.sin(a) * L, phi: a + (Math.PI / 2 - a) * k };
    },

    /* 搭乗橋の動く部分（のびちぢみする通路・駆動輪・キャブ・ロタンダ）。固定通路は背景にある */
    drawBridge() {
      const c = this.ctx;
      const B = this.bridgeGeom(this.bridge);
      const s0 = BRG.rotR - 2, len = B.L - s0;
      const corners = (ox, oy, ang, x0, x1, y0, y1) => {
        const co = Math.cos(ang), si = Math.sin(ang);
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [ox + x * co - y * si, oy + x * si + y * co]);
      };
      /* 影（高さ約5m → 右下へずらす） */
      const sh = new Path2D();
      toPath(corners(B.rx + 10, B.ry + 14, B.a, s0, B.L, -10, 10), sh);
      toPath(corners(B.ex + 10, B.ey + 14, B.phi, -1, 24, -15, 15), sh);
      sh.moveTo(B.rx + 10 + BRG.rotR, B.ry + 14); sh.arc(B.rx + 10, B.ry + 14, BRG.rotR, 0, TAU);
      c.fillStyle = 'rgba(16,26,40,.17)'; c.fill(sh);
      /* 通路（3段の筒。キャブ側ほど太い） */
      const sect = (f0, f1, w) => {
        const a0 = s0 + len * f0, a1 = s0 + len * f1;
        c.save(); c.translate(B.rx, B.ry); c.rotate(B.a);
        const gr = c.createLinearGradient(0, -w / 2, 0, w / 2);
        gr.addColorStop(0, '#a1adb8'); gr.addColorStop(0.55, '#c8d1d9'); gr.addColorStop(1, '#e0e7ed');
        c.fillStyle = gr; c.fillRect(a0, -w / 2, a1 - a0, w);
        c.strokeStyle = 'rgba(86,102,118,.28)'; c.lineWidth = 0.6; c.beginPath();
        for (let x = a0 + 3; x < a1 - 1; x += 4.5) { c.moveTo(x, -w / 2 + 1); c.lineTo(x, w / 2 - 1); }
        c.stroke();
        c.strokeStyle = 'rgba(58,72,88,.68)'; c.lineWidth = 0.8; c.strokeRect(a0, -w / 2, a1 - a0, w);
        c.fillStyle = 'rgba(28,40,56,.26)'; c.fillRect(a0 - 1.6, -w / 2 + 1, 1.6, w - 2);   // 段差の陰
        c.restore();
      };
      sect(0, 0.42, 16); sect(0.32, 0.74, 18); sect(0.64, 1, 20);
      /* 駆動輪（通路の下から左右にのぞく） */
      c.save(); c.translate(B.rx, B.ry); c.rotate(B.a);
      c.fillStyle = '#2b3239';
      const wx = s0 + len * 0.8;
      this.rr(wx - 3.6, -14.2, 7.2, 3.6, 1.2); c.fill();
      this.rr(wx - 3.6, 10.6, 7.2, 3.6, 1.2); c.fill();
      c.restore();
      /* キャブ（ドアにつく先頭の箱）とじゃばら */
      c.save(); c.translate(B.ex, B.ey); c.rotate(B.phi);
      const cg = c.createLinearGradient(0, -15, 0, 15);
      cg.addColorStop(0, '#9eabb6'); cg.addColorStop(0.5, '#c3ccd5'); cg.addColorStop(1, '#dbe2e8');
      c.fillStyle = cg; c.fillRect(-1, -15, 21, 30);
      c.fillStyle = 'rgba(110,124,138,.45)'; c.fillRect(4, -9, 7, 6);
      c.strokeStyle = 'rgba(58,72,88,.72)'; c.lineWidth = 0.8; c.strokeRect(-1, -15, 21, 30);
      c.fillStyle = '#39414a'; c.fillRect(20, -13, 4, 26);
      c.strokeStyle = 'rgba(160,172,184,.5)'; c.lineWidth = 0.5; c.beginPath();
      for (let y = -11; y <= 11; y += 3) { c.moveTo(20, y); c.lineTo(24, y); }
      c.stroke();
      c.restore();
      /* ロタンダ（通路がまわる丸い部屋） */
      const rgd = c.createRadialGradient(B.rx - 4, B.ry - 4, 2, B.rx, B.ry, BRG.rotR);
      rgd.addColorStop(0, '#e3e9ee'); rgd.addColorStop(1, '#a7b3be');
      c.fillStyle = rgd; c.beginPath(); c.arc(B.rx, B.ry, BRG.rotR, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(58,72,88,.65)'; c.lineWidth = 0.8; c.stroke();
      c.fillStyle = '#98a4af'; c.beginPath(); c.arc(B.rx, B.ry, 5.5, 0, TAU); c.fill();
    },

    drawEffectsUnder(state, gt) {
      const c = this.ctx;
      const t = state.tasks;
      if (t.refuel.status === 'active') {
        /* 給油ホース: 給油車から右主翼の下の給油口へ（翼の前縁の下へもぐる） */
        c.strokeStyle = 'rgba(20,28,38,.22)'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(710, 449); c.quadraticCurveTo(720, 430, 703, 414); c.stroke();
        c.strokeStyle = '#3c4652'; c.lineWidth = 2.6;
        c.beginPath(); c.moveTo(708, 446); c.quadraticCurveTo(718, 427, 701, 411); c.stroke();
        c.fillStyle = '#2a3139'; c.beginPath(); c.arc(701, 411, 1.8, 0, TAU); c.fill();
        /* 安全コーン */
        [[682, 472], [788, 472]].forEach(([x, y]) => {
          c.fillStyle = '#e2711d';
          c.beginPath(); c.moveTo(x, y); c.lineTo(x - 5, y + 9); c.lineTo(x + 5, y + 9); c.closePath(); c.fill();
          c.fillStyle = '#fff'; c.fillRect(x - 2.6, y + 4, 5.2, 1.4);
        });
      }
      if (t.clean.status === 'active') {
        c.save();
        c.font = '14px sans-serif'; c.textAlign = 'center';
        for (let i = 0; i < 3; i++) {
          const a = 0.35 + 0.6 * Math.abs(Math.sin(gt * 3 + i * 1.3));
          c.globalAlpha = a;
          c.fillStyle = '#7fd1e8';
          c.fillText('✦', 610 + i * 72, 312 + (i % 2) * 12);
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
          /* 全長は実物（約8〜9m）に合わせる。ベルトの先が貨物ドアの敷居（+64）にとどく */
          c.fillStyle = '#67727f'; this.rr(-34, -12, 44, 24, 4); c.fill();
          c.strokeStyle = '#49525c'; c.lineWidth = 1.5; this.rr(-34, -12, 44, 24, 4); c.stroke();
          c.fillStyle = '#4d5866'; this.rr(-34, -12, 15, 24, 4); c.fill();
          c.fillStyle = '#9fb4c4'; this.rr(-31, -8, 8, 16, 2); c.fill();
          c.save();
          c.translate(2, 0);
          c.fillStyle = '#cfd6dd'; this.rr(0, -6, 62, 12, 3); c.fill();
          c.strokeStyle = '#8d99a5'; this.rr(0, -6, 62, 12, 3); c.stroke();
          c.strokeStyle = '#aab6c0';
          c.beginPath(); c.moveTo(4, 0); c.lineTo(58, 0); c.stroke();
          if (active) {
            const cols = ['#c96f5c', '#5c88c9', '#c9b25c'];
            for (let i = 0; i < 3; i++) {
              let p = (gt * 0.7 + i / 3) % 1;
              if (reverse) p = 1 - p;
              c.fillStyle = cols[i];
              this.rr(5 + p * 46, -4, 9, 8, 2); c.fill();
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
          /* 機首といっしょに動く。戻るときはその場所から帰れるよう、位置も覚えておく */
          const nose = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1], tr);
          x = rec.pos.x = nose.x; y = rec.pos.y = nose.y; ang = rec.angle = tr.rot + Math.PI;
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
        c.translate(4, 7);   // 影は車の向きにかかわらず右下へ（光源=左上）
        c.rotate(ang);
        c.fillStyle = 'rgba(30,40,54,.18)';
        c.beginPath(); c.ellipse(0, 0, 50, 16, 0, 0, TAU); c.fill();
        c.restore();
        c.rotate(ang);
        this.vehicleBody(e.type, active, gt, reverse);
        /* 作業中はキャブの上で黄色の回転灯が点滅（実際のGSEと同じ） */
        if (active) {
          const CAB = { beltloader: -27, cart: -26, fuel: -38, catering: -33, pushback: 0 };
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
        /* プッシュバックの係は機首のそばを歩いてついていく */
        const pushWalk = e.status === 'working' && e.taskId === 'pushback' && push.status === 'active';
        if (e.status === 'working' && e.taskId === 'pushback' && (push.status === 'active' || push.status === 'done')) {
          const s = SLOTS.pushback.staff[0];
          const p = this.transformPoint(s[0], s[1], tr);
          x = rec.pos.x = p.x; y = rec.pos.y = p.y;
        }
        const meta = window.RES_META.staff[e.type];
        const moving = e.status === 'moving' || e.status === 'returning' || pushWalk ||
          (e.status === 'working' && e.taskId === 'inspect');
        const working = e.status === 'working' && e.taskId !== 'inspect' && !pushWalk;
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

    /* 駐機中のシーン座標の点が、いまの機体の姿勢でどこにあるか（中心=主脚） */
    transformPoint(px, py, tr) {
      const dx = px - PIVOT_X, dy = py - PLANE_CY;
      const cos = Math.cos(tr.rot), sin = Math.sin(tr.rot);
      return { x: PIVOT_X + tr.x + dx * cos - dy * sin, y: PLANE_CY + tr.y + dx * sin + dy * cos };
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
        /* L1ドア → キャブ → 通路 → ロタンダ → 固定通路 → ターミナル（降機）。搭乗はその逆 */
        const t01 = d.dir === 'out' ? d.p : 1 - d.p;
        const pts = BRIDGE_PATH;
        let total = 0;
        for (let j = 1; j < pts.length; j++) total += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
        let rest = t01 * total, j = 1;
        for (; j < pts.length - 1; j++) {
          const sl = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
          if (rest <= sl) break;
          rest -= sl;
        }
        const sl = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]) || 1;
        const k = clamp(rest / sl, 0, 1);
        const x = pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * k;
        const y = pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * k;
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
      const [sx, sy] = PAX_SIGN;
      this.rr(sx - w / 2, sy - 11, w, 22, 11); c.fill();
      c.strokeStyle = '#b9c9d8'; c.lineWidth = 1.5; this.rr(sx - w / 2, sy - 11, w, 22, 11); c.stroke();
      c.fillStyle = '#27496d'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(text, sx, sy + 0.5);
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
          const p = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1] - 16, this.planeTransform(state));
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
        const stars = best && best.cleared ? (best.stars != null ? best.stars : (best.score >= 95 ? 3 : best.score >= 80 ? 2 : 1)) : 0;
        const starHtml = `<span class="sc-stars">${[1, 2, 3].map((i) => `<i class="${i <= stars ? 'on' : ''}">★</i>`).join('')}</span>`;
        const card = document.createElement('button');
        card.className = 'stage-card' + (unlocked ? '' : ' locked');
        card.innerHTML = `
          <div class="sc-row1">
            <span class="sc-name">${window.rubi(st.name)}</span>
            <span class="sc-diff diff-${st.difficulty === '上級' ? 'hard' : st.difficulty === '中級' ? 'mid' : 'easy'}">${window.rubi(st.difficulty)}</span>
          </div>
          <div class="sc-sub">${window.rubi(st.subtitle)}</div>
          <div class="sc-row2">
            <span>${st.weather.icon} ${window.rubi(st.weather.label)}</span>
            ${!unlocked
              ? `<span class="sc-soon">🔒 ステージ${st.id - 1}をクリアするとあそべるよ</span>`
              : (best ? `<span class="sc-best">${starHtml} ベスト ${best.score}点（${best.rank}）</span>` : `<span class="sc-best sc-best-none">${starHtml} まだクリアしていない</span>`)}
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
      const t = this.state.tasks[id];
      const reqs = window.taskReqList(t.def).map((r) =>
        `<span class="req-chip" style="--c:${r.color}">${r.icon}${rubi(r.label)}×${r.n}</span>`).join('') || 'なし';
      this.openModal({
        title: `${t.def.icon} ${rubi(t.def.name)}`,
        body: `
          <p>${rubi(t.def.desc)}</p>
          ${t.def.why ? `<p class="zk-why">💡 <strong>なぜやるの？</strong> — ${rubi(t.def.why)}</p>` : ''}
          <p class="modal-kv"><strong>かかる${rubi('時間')}:</strong> ${rubi(`約${Math.ceil(t.def.dur)}分`)}　<strong>ひつような人と車:</strong> ${reqs}</p>
          <p class="modal-kv"><strong>はじめられるのは:</strong> ${rubi(t.def.depNote)}</p>
          ${t.def.note ? `<p class="modal-note">🦺 <strong>${rubi('安全')}メモ:</strong> ${rubi(t.def.note)}</p>` : ''}`,
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
      const def = s.activeEvent.def;
      const choicesHtml = def.choices.map((ch, i) => `
        <button class="event-choice" data-i="${i}">
          <span class="ec-label">${rubi(ch.label)}</span>
          <span class="ec-hint">${rubi(ch.hint)}</span>
          <span class="ec-tags">${(ch.tags || []).map((t) => `<em>${rubi(t)}</em>`).join('')}</span>
        </button>`).join('');
      this.openModal({
        kind: 'event',
        title: `${def.icon} ${rubi(def.title)}`,
        body: `<p>${rubi(def.desc)}</p><div class="event-choices">${choicesHtml}</div>
               <p class="modal-note">⏳ ${rubi(def.deadlineHint)}</p>`,
        buttons: [{ label: 'あとできめる', cls: 'btn-ghost' }],
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
      this.openModal({
        kind: 'safety',
        title: '🦺 ' + rubi('プッシュバック前の安全確認'),
        body: `<p>${rubi('押す車が飛行機の前に着きました。動かす前に、まわりに')}<strong>${rubi('人・車・置きわすれた道具')}</strong>${rubi('がのこっていないかたしかめます。どうする？')}</p>`,
        buttons: [
          { label: '✅ ' + rubi('しっかり確認する（+1分）'), cls: 'btn-primary', onClick: () => this.cb.onSafetyChoice(true) },
          { label: '⚠ ' + rubi('確認をとばして急ぐ（大きなペナルティ）'), cls: 'btn-danger', onClick: () => this.cb.onSafetyChoice(false) },
        ],
        dismissible: false,
      });
    },

    /* ---------------- モーダル共通 ---------------- */
    openModal({ kind, title, body, buttons, dismissible }) {
      const rubi = window.rubi;
      this.modalKind = kind || 'generic';
      this.modalDismissible = dismissible !== false;
      const btns = (buttons || []).map((b, i) =>
        `<button class="btn ${b.cls || 'btn-ghost'}" data-mb="${i}">${rubi(b.label)}</button>`).join('');
      this.els['modal'].innerHTML = `
        <div class="modal-title">${rubi(title)}</div>
        <div class="modal-body">${rubi(body)}</div>
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

    /* ---------------- ながれマップ・ずかん・コーチ ---------------- */
    buildFlowHtml(live) {
      const s = live ? this.state : null;
      const chip = (id) => {
        const def = window.TASK_MAP[id];
        let cls = '';
        if (s) {
          const st = s.tasks[id].status;
          cls = st === 'done' ? ' fc-done' : st === 'active' ? ' fc-active'
            : (st === 'ready' || st === 'gathering') ? ' fc-ready' : ' fc-locked';
        }
        return `<span class="flow-chip${cls}">${def.icon} ${def.name}</span>`;
      };
      /* ステップ見出し: 番号を丸で見せ、プレイ中は「いまここ！」を付ける */
      const stepHead = (r) => {
        let cls = '', here = '';
        if (s) {
          const sts = r.tasks.map((id) => s.tasks[id].status);
          if (sts.every((x) => x === 'done')) cls = ' fs-done';
          else if (sts.some((x) => x === 'ready' || x === 'gathering' || x === 'active')) {
            cls = ' fs-now';
            here = '<span class="flow-here">👉 いまここ！</span>';
          }
        }
        return `<div class="flow-step${cls}"><span class="flow-stepnum" data-step="${r.step}">${r.step}</span><div class="flow-note">${r.note}</div>${here}</div>`;
      };
      return '<div class="flow-map">' + window.FLOW_ROWS.map((r) =>
        stepHead(r) + `<div class="flow-row">${r.tasks.map(chip).join('')}</div>`).join('') +
        (s ? '<div class="flow-legend"><span class="fc-done">✓ 完了</span><span class="fc-active">作業中</span><span class="fc-ready">開始できる</span><span class="fc-locked">まだ</span></div>' : '') +
        '</div>';
    },

    openFlowMap() {
      const live = !!this.state && $('#screen-game').classList.contains('active');
      this.openModal({
        kind: 'flow',
        title: '🗺 出発準備のながれ',
        body: this.buildFlowHtml(live) +
          '<p class="modal-note" style="margin-top:10px;">じゅんばんを守りながら、同時にできる作業をどれだけ重ねられるかがコツ！</p>',
        buttons: [{ label: 'とじる', cls: 'btn-primary' }],
        dismissible: true,
      });
    },

    /* タイトル画面の「スター・バッジ」進捗表示 */
    updateTitleProgress() {
      const el = document.getElementById('title-progress');
      if (!el || !this.cb.getProgress) return;
      const p = this.cb.getProgress();
      const earned = Object.keys(p.earned || {}).length;
      if (!earned && !p.totalStars) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      el.innerHTML = `🌟 スター ${p.totalStars}/${p.maxStars}　🏅 バッジ ${earned}/${p.badgeDefs.length}`;
    },

    openZukan(tab) {
      tab = tab || 'flow';
      const tabs = [['flow', '🗺 ながれ'], ['tasks', '🛠 おしごと'], ['crew', '🧑‍✈️ なかまたち'], ['badge', '🏅 バッジ']];
      const tabBtns = '<div class="zk-tabs">' + tabs.map(([k, l]) =>
        `<button class="zk-tab ${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('') + '</div>';
      let body = '';
      if (tab === 'flow') {
        body = this.buildFlowHtml(false);
      } else if (tab === 'tasks') {
        body = '<div class="zk-list">' + window.TASK_DEFS.map((d) => `
          <div class="zk-item">
            <div class="zk-head"><span class="zk-step" data-step="${d.step || ''}">ステップ${d.step || '-'}</span>${d.icon} ${d.name}${d.ruby ? `<small>（${d.ruby}）</small>` : ''}</div>
            <p>${d.desc}</p>
            <p class="zk-why">💡 なぜ必要？ — ${d.why}</p>
            ${d.note ? `<p class="zk-note">🦺 ${d.note}</p>` : ''}
          </div>`).join('') + '</div>';
      } else if (tab === 'badge') {
        const p = this.cb.getProgress ? this.cb.getProgress() : { badgeDefs: [], earned: {}, totalStars: 0, maxStars: 15 };
        const earned = Object.keys(p.earned || {}).length;
        body = `<p class="zk-badge-sum">🌟 スター ${p.totalStars}/${p.maxStars}　🏅 バッジ ${earned}/${p.badgeDefs.length}</p>` +
          '<div class="zk-list">' + p.badgeDefs.map((b) => {
            const got = !!p.earned[b.id];
            return `<div class="zk-item badge-item ${got ? 'bd-got' : 'bd-notyet'}">
              <div class="zk-head">${got ? b.icon : '❔'} ${window.rubi(b.name)}${got ? ' <span class="bd-mark">GET!</span>' : ''}</div>
              <p>${window.rubi(b.desc)}</p>
            </div>`;
          }).join('') + '</div>';
      } else {
        body = '<div class="zk-list"><h4 class="zk-cat">スタッフ</h4>' +
          Object.values(window.RES_META.staff).map((m) =>
            `<div class="zk-item"><div class="zk-head">${m.icon} ${m.label}</div><p>${m.desc}</p></div>`).join('') +
          '<h4 class="zk-cat">はたらく車（GSE）</h4>' +
          Object.values(window.RES_META.vehicles).map((m) =>
            `<div class="zk-item"><div class="zk-head">${m.icon} ${m.label}</div><p>${m.desc}</p></div>`).join('') + '</div>';
      }
      this.openModal({
        kind: 'zukan',
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
    openTutorial(onDone) {
      const steps = [
        {
          title: '✈ ようこそ、地上作業リーダー！',
          body: `<p>飛行機が空港に着いてから次に出発するまでの作業を<strong>ターンアラウンド</strong>といいます。</p>
                 <p>あなたの仕事は、たくさんの作業をスタッフと車両にわりあてて、<strong>45分後の出発</strong>に間に合わせること！</p>`,
        },
        {
          title: '🗺 出発準備のながれ',
          body: `<p>作業には<strong>じゅんばん</strong>があるよ。<strong>ステップ1→7</strong>の順にすすむよ。同じステップの作業は、どんどん同時に進めよう！</p>` +
            this.buildFlowHtml(false) +
            `<p style="margin-top:8px;">ゲーム中も右上の<strong>🗺ボタン</strong>でいつでも見られるよ。</p>`,
        },
        {
          title: '🗺 画面の見方',
          body: `<ul class="tut-list">
                 <li><strong>画面ぜんたい：</strong>駐機場のようす（ドラッグで移動、ホイールやピンチ、右下の＋−でズーム）</li>
                 <li><strong>上のながれバー：</strong>作業のじゅんばん（ステップ1→7）。緑✓＝おわった、はねている＝いまできる！</li>
                 <li><strong>左の📋タブ：</strong>作業カードのひらけ・とじ</li>
                 <li><strong>右上：</strong>安全性などの管理指標</li>
                 <li><strong>下：</strong>スタッフと車両の状態</li></ul>`,
        },
        {
          title: '🛠 作業のすすめ方（2つのやり方）',
          body: `<p><strong>① おまかせ：</strong>作業カードの「開始」を押すと、必要なメンバーが自動で移動します。</p>
                 <p><strong>② 自分で配置：</strong>駐機場の<strong>スタッフや車両をタップ</strong>して選び、<strong>緑に光る持ち場</strong>をタップして送りこみます。必要な人数がそろうと作業開始！</p>
                 <p><strong>⭐ベテラン</strong>は作業が速く、<strong>🔰新人</strong>はゆっくり。だれを送るかも作戦のうち！</p>
                 <p>🔒がついた作業は順番の条件があります（例：清掃はお客さんが降りてから）。<strong>🔓はじめられるよ！</strong>のお知らせが出たら、次にすすめる合図だよ。</p>`,
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
      const { sound, bgm, inGame } = opts;
      this.openModal({
        kind: 'settings',
        title: '⚙ 設定',
        body: `
          <label class="set-row">
            <span>🔊 効果音</span>
            <input type="checkbox" id="set-sound" ${sound ? 'checked' : ''}>
          </label>
          <label class="set-row">
            <span>🎵 おんがく（BGM）</span>
            <input type="checkbox" id="set-bgm" ${bgm !== false ? 'checked' : ''}>
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
      $('#set-bgm').addEventListener('change', (ev) => this.cb.onBgmToggle(ev.target.checked));
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

    /* 紙ふぶき（クリア演出。数秒でひとりでに消える） */
    dropConfetti(n) {
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

    /* ---------------- 結果画面 ---------------- */
    renderResult(res, isBest, nextStageId, prevBest, extras) {
      extras = extras || { stars: 0, newBadges: [], nextGoal: '' };
      const nextBtn = document.getElementById('btn-next-stage');
      const retryBtn = document.getElementById('btn-retry');
      nextBtn.classList.toggle('hidden', !nextStageId);
      nextBtn.dataset.stage = nextStageId || '';
      retryBtn.classList.toggle('btn-primary', !nextStageId);
      retryBtn.classList.toggle('btn-ghost', !!nextStageId);

      /* ★の獲得表示（1つずつ順番に光る） */
      const starsEl = document.getElementById('result-stars');
      starsEl.innerHTML = [1, 2, 3].map((i) =>
        `<i class="${i <= extras.stars ? 'on' : ''}" style="animation-delay:${0.3 + i * 0.35}s">★</i>`).join('');

      /* 新しくとれたバッジ */
      const badgeEl = document.getElementById('result-badges');
      if (extras.newBadges && extras.newBadges.length) {
        badgeEl.classList.remove('hidden');
        badgeEl.innerHTML = '<span class="rb-title">🎉 あたらしいバッジ！</span>' +
          extras.newBadges.map((b) => `<span class="badge-chip">${b.icon} ${window.rubi(b.name)}</span>`).join('');
      } else {
        badgeEl.classList.add('hidden');
        badgeEl.innerHTML = '';
      }

      /* つぎの目標 */
      const goalEl = document.getElementById('result-goal');
      goalEl.innerHTML = extras.nextGoal ? '🎯 ' + window.rubi(extras.nextGoal) : '';
      goalEl.classList.toggle('hidden', !extras.nextGoal);

      const rubi = window.rubi;
      const flag = this.els['result-flag'];
      if (!res.departed) {
        flag.innerHTML = rubi('⏰ 時間内に出発できなかった…');
        flag.className = 'result-flag bad';
      } else if (res.critical) {
        flag.innerHTML = rubi('⚠ 出発はできたけど、安全のもんだいがあってクリアならず…');
        flag.className = 'result-flag bad';
      } else if (res.delay != null && res.delay > 0.5) {
        flag.innerHTML = rubi(`✈ 出発しました（${Math.ceil(res.delay)}分遅れ）— クリア！`);
        flag.className = 'result-flag ok';
      } else {
        flag.innerHTML = rubi('🎉 時間ぴったりに出発！おみごと！— クリア！');
        flag.className = 'result-flag great';
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
      /* クリアしたら紙ふぶき */
      if (res.cleared) this.dropConfetti(res.rank === 'S' ? 56 : 36);

      const bd = this.els['result-breakdown'];
      bd.innerHTML = '';
      Object.entries(res.breakdown).forEach(([key, b]) => {
        const li = document.createElement('li');
        const pct = (b.got / b.max) * 100;
        li.innerHTML = `<span class="rb-label">${rubi(b.label)}</span>
          <span class="rb-bar"><span class="rb-fill fill-${key}" style="width:${pct}%"></span></span>
          <span class="rb-num">${b.got} / ${b.max}点</span>`;
        bd.appendChild(li);
      });

      const times = this.els['result-times'];
      const bestNote = isBest ? '　★ じぶんのさいこうきろく！' :
        (prevBest != null ? `　（これまでのベスト ${prevBest}点）` : '');
      if (res.blockOff != null) {
        const d = Math.ceil(Math.max(0, res.blockOff - res.std));
        times.innerHTML = rubi(`出発予定 ${window.fmtClock(res.std)} → ほんとうの出発 ${window.fmtClock(res.blockOff)}` +
          (d > 0 ? `（${d}分遅れ）` : `（時間ぴったり）`) + bestNote);
      } else {
        times.innerHTML = rubi(`出発予定 ${window.fmtClock(res.std)} → 出発できず` + bestNote);
      }
      this.els['result-advice'].innerHTML = rubi(res.advice);

      /* 作業タイムライン（どれだけ並行できたか） */
      const gantt = document.getElementById('result-gantt');
      gantt.innerHTML = '';
      if (res.timeline) {
        const t0 = res.arrival;
        const tEnd = Math.max(res.std + 4, t0 + 46, ...res.timeline.map((t) => t.doneAt || 0));
        const span = tEnd - t0;
        const pct = (m) => clamp(((m - t0) / span) * 100, 0, 100);
        const stdPct = pct(res.std);
        res.timeline.forEach((t) => {
          const row = document.createElement('div');
          row.className = 'gr';
          const nm = t.name.length > 7 ? t.name.slice(0, 7) + '…' : t.name;
          let bars = `<i class="gr-stdline" style="left:${stdPct}%"></i>`;
          if (t.startedAt != null && t.activeAt != null) {
            bars += `<i class="gr-gather" style="left:${pct(t.startedAt)}%;width:${Math.max(0.5, pct(t.activeAt) - pct(t.startedAt))}%"></i>`;
          }
          if (t.activeAt != null && t.doneAt != null) {
            /* ながれリボンと同じステップ色でぬる（順番の学びとつなげる） */
            const stp = (window.TASK_MAP[t.id] && window.TASK_MAP[t.id].step) || 0;
            const col = stp ? `background:var(--s${stp});` : '';
            bars += `<i class="gr-work" style="left:${pct(t.activeAt)}%;width:${Math.max(1, pct(t.doneAt) - pct(t.activeAt))}%;${col}"></i>`;
          }
          row.innerHTML = `<span class="gr-label" title="${t.name}">${t.icon}${rubi(nm)}</span>` +
            `<span class="gr-track">${t.startedAt == null ? '<span class="gr-none">できなかった…</span>' : bars}</span>`;
          gantt.appendChild(row);
        });
        const axis = document.createElement('div');
        axis.className = 'gr-axis';
        axis.innerHTML = `<span></span><span class="gr-axis-track">` +
          `<span style="left:2%">${window.fmtClock(t0)} ${rubi('到着')}</span>` +
          `<span class="ax-std" style="left:${stdPct}%">${rubi('出発予定')} ${window.fmtClock(res.std)}</span>` +
          `</span>`;
        gantt.appendChild(axis);
      }
      document.getElementById('result-trivia').innerHTML = '💡 まめちしき: ' + rubi(pickTrivia());
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
