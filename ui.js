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
  /* 胴体の中心線は、上の翼端とターミナル側のエプロンのふち(y143)のあいだ・下の翼端と車両おきば(y502)のあいだに
   * すき間が取れる高さにする（翼端は y159 と y489。制限区域ラインは y150 と y498 で囲む） */
  const NOSE_X = 856, PLANE_CY = 324;      // 駐機位置の機首先端のxと、胴体の中心線のy
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
  const FUS_EDGE = PLANE_CY + FUS_R * PK;  // 胴体の下（右側）のふちのy（駐機中）
  const BELT_Y = Math.round(FUS_EDGE + 63); // ベルトの先が貨物ドアの敷居にとどく位置

  /* 区画（背景にえがく。人や車の待機位置もここから決める） */
  const ZONE = {
    staff: { x: 296, y: 500, w: 144, h: 56 },   // スタッフのまちあい（左の作業カードを開いても見える位置）
    veh: { x: 450, y: 502, w: 596, h: 54 },     // はたらく車のおきば
    era: { x0: 472, y0: 150, x1: 932, y1: 498 }, // 制限区域ライン（駐機中の機体を囲む）
  };

  /* 作業ごとの持ち場（x, y, [車両の向きdeg]）。人や車が翼・エンジンに重ならないように置く。
   * 同時に出ることのある持ち場どうしは、サークル（半径25）と札が重ならないよう50px以上はなす */
  const SLOTS = {
    deboard:   { staff: [[744, 186]] },                      // 搭乗橋の入口のそば（ターミナル側）
    board:     { staff: [[744, 186]] },                      // 降機と同じ場所（同時には出ない）
    doorclose: { staff: [[836, 294]] },                      // L1ドアのよこ（搭乗橋のキャブの右）
    clean:     { staff: [[783, 230], [795, 256]] },          // 搭乗橋の通路を通って機内へ
    unload:    { staff: [[800, 440], [889, 465]], vehicles: { beltloader: [[ux(DOOR_U.fwdCargo), BELT_Y, -90]], cart: [[835, 460, 0]] } },
    load:      { staff: [[604, 440], [502, 465]], vehicles: { beltloader: [[ux(DOOR_U.aftCargo), BELT_Y, -90]], cart: [[560, 460, 0]] } },
    bagmatch:  { staff: [[612, 478]] },
    refuel:    { staff: [[716, 442]], vehicles: { fuel: [[732, 463, 0]] } },     // 右主翼の前（給油口は翼の下）
    catering:  { staff: [[548, 413]], vehicles: { catering: [[ux(DOOR_U.R2), 393, -90]] } },
    inspect:   { staff: [[900, 306]] },                      // 機首の前から一周
    pushback:  { staff: [[890, 370]], vehicles: { pushback: [[884, PLANE_CY, 180]] } },  // 機首の前で押す
    depart:    {},
  };
  const TUG_SLOT = SLOTS.pushback.vehicles.pushback[0];
  /* 点検スタッフが機体を一周する経路（機首→左側→左エンジンの前→左の主脚→尾翼→右側→右の主脚→右エンジン→機首）。
   * 搭乗橋の下や翼・胴体の下をくぐるところは、上から見るとかくれる（うすいかげだけ出す） */
  /* 尾翼のところは、水平尾翼の先と尾のうしろのコーンの外を回りこむ（尾翼の上を歩かない） */
  const INSPECT_LOOP = [
    [900, 306], [868, 280], [836, 254], [812, 232], [770, 240], [765, 268], [745, 296], [700, 290],
    [656, 292], [596, 298], [556, 254], [520, 254], [486, 290], [482, 324], [486, 358], [520, 394], [556, 394], [596, 350],
    [656, 356], [700, 360], [740, 400], [748, 350], [790, 334], [850, 340],
  ];
  const VEH_ROW = ZONE.veh.y + 26;
  const VEHICLE_HOME = {
    beltloader: [[500, VEH_ROW, 0]],
    cart: [[600, VEH_ROW, 0], [688, VEH_ROW, 0]],
    fuel: [[790, VEH_ROW, 0]],
    catering: [[892, VEH_ROW, 0]],
    pushback: [[996, VEH_ROW, 0]],
  };
  /* 車体の外形（車両ローカル座標: x0, x1, y0, y1）。機体の下にかかっているかの判定に使う */
  const VEH_EXT = { beltloader: [-34, 64, -12, 12], cart: [-45, 42, -10, 10], fuel: [-48, 48, -13, 13], catering: [-42, 40, -14, 14], pushback: [-26, 32, -15, 15] };
  /* 搭乗橋: ターミナルから出る固定通路（背景）→ ロタンダ（回転部）→ のびちぢみする通路 → キャブ。
   * キャブの先（じゃばら）がL1ドアのところの胴体のふちにとどく位置で止まる */
  const L1_EDGE = PLANE_CY - fusHW(DOOR_U.L1) * PK;
  const BRG = { x: 770, rot: [770, 198], rotR: 14, dock: [ux(DOOR_U.L1), +(L1_EDGE - 23.6).toFixed(1)], parkLen: 44, parkAng: 45 };
  const BRIDGE_PATH = [[ux(DOOR_U.L1), L1_EDGE - 1], [ux(DOOR_U.L1), L1_EDGE - 14], [770, 198], [770, 132]];
  const PAX_SIGN = [880, 169];             // 降機・搭乗の人数カウンターの位置

  /* ---------- 背景キャッシュの範囲（左右にはみ出して描く。プッシュバック・出発で機体が左のはしをこえても地面がつづく） ---------- */
  const BG_X0 = -260, BG_X1 = SCENE_W + 220;
  /* カメラがはじめに入れる範囲: 制限区域と、そのまわりの待機所・車のおきば・押す車 */
  const FOCUS = { x0: 288, x1: 1054, y0: 144, y1: 562 };
  /* 場内の人の大きさ（ずかんの絵は 1 のまま）。機体が実寸の比率なので、人も実寸に近い 0.72（身長約1.9m）にする。
   * 押せる範囲は見た目とは別に、画面上の半径 24px を保つ */
  const PERSON_K = 0.72;
  const PERSON_MID = 7;                    // 人の当たり判定・選択リングの中心（足もとからの高さ）
  /* 選択ラベルなどに使う、かなの職種名（Canvas はルビが振れないので漢字を使わない） */
  const KANA_SHORT = {
    ramp: 'ランプ', baggage: 'てにもつ', cleaning: 'せいそう', maintenance: 'せいび', gate: 'ゲート',
    beltloader: 'ベルト', cart: 'カート', fuel: 'きゅうゆ', catering: 'きないしょく', pushback: 'おすくるま',
  };
  /* 持ち場の色（DOM と同じ。:root の --st-* があればそれを使う） */
  const SPOT_COL = { ready: '#0b6f8a', gather: '#c98a00', accept: '#1f7a45', soon: '#8796a8', unlock: '#0b6f8a', done: '#1f7a45', locked: '#5b6b80' };
  let _spotColRead = false;
  const spotCol = () => {
    if (!_spotColRead && typeof getComputedStyle === 'function' && document.documentElement) {
      _spotColRead = true;
      const cs = getComputedStyle(document.documentElement);
      const pick = (k, v) => { const x = (cs.getPropertyValue(v) || '').trim(); if (/^#[0-9a-f]{6}$/i.test(x)) SPOT_COL[k] = x; };
      pick('ready', '--st-ready'); pick('gather', '--st-wait'); pick('accept', '--st-done'); pick('done', '--st-done'); pick('locked', '--st-locked');
      SPOT_COL.unlock = SPOT_COL.ready;
    }
    return SPOT_COL;
  };
  /* 動きを減らす設定（OS の prefers-reduced-motion） */
  const _rm = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = () => !!(_rm && _rm.matches);
  /* 「あと◯ぷん/ふん」の読み（1・3・4・6・8・0 は ぷん、2・5・7・9 は ふん） */
  const funPun = (n) => ('134680'.includes(String(n).slice(-1)) ? 'ぷん' : 'ふん');

  /* ---------- 照明のプリセット ----------
   * ステージ4=夕方、かみなりの間=storm、くもり=overcast、雨のステージ=rain、それ以外=day。
   * sky: [シーンの外の上のはし, 空の帯の上(y0), 空の帯の下(y30)]、sun: 太陽（無いときは null）、
   * apronTint: エプロンにかぶせる色、shadowA/shadowL: 影の濃さ・長さの倍率、win: ターミナルの窓、flood: 投光器の光だまり、
   * move: 動く物（機体・車・人）にかぶせる色（draw で1回だけ）。値は背景キャッシュに1回だけ使う */
  const LIGHT_DAY = {
    name: 'day', sky: ['#5b9fd3', '#7fbfe9', '#cfe8f8'],
    sun: { x: 66, y: 13, r: 9, col: '#ffd95e', glow: '255,225,140', gr: 26 }, cloudBand: null,
    facade: ['#f2f6fa', '#dde5ec'], roof: '#b0c2d2', roofEdge: '#cbd5e0', tower: '#d6dee6', towerCab: '#6f8598',
    win: ['#a9c6de', '#87a9c6'], winSheen: 'rgba(255,255,255,.30)', winGlow: null,
    apron: ['#bcc2c9', '#a9b0b8'], apronTint: null, warm: 'rgba(255,240,205,.13)', noiseA: 0.75,
    taxi: ['#9aa2ab', '#8e969f'], shoulder: '#a3a9b0', grass: '#7f9470', yel: '#e8c84a',
    shadowA: 1, shadowL: 1, shadowCol: '28,38,52', move: null, flood: false, wet: false, cloud: 'rgba(255,255,255,.92)',
  };
  const LIGHT = {
    day: LIGHT_DAY,
    overcast: Object.assign({}, LIGHT_DAY, {
      name: 'overcast', sky: ['#7d8d9c', '#9fb0bf', '#d3dbe2'], sun: null, cloudBand: 'rgba(214,222,230,.75)',
      facade: ['#e6ebf0', '#d3dae1'], win: ['#9db3c6', '#8199ae'], winSheen: 'rgba(255,255,255,.18)',
      apron: ['#b5bbc2', '#a3aab2'], apronTint: 'rgba(110,125,140,.06)', warm: null,
      shadowA: 0.5, shadowL: 0.8, move: 'rgba(120,132,146,.05)', grass: '#7a8a6e', cloud: 'rgba(236,240,244,.95)',
    }),
    storm: Object.assign({}, LIGHT_DAY, {
      name: 'storm', sky: ['#2c3644', '#4d5a6a', '#7d8a98'], sun: null, cloudBand: 'rgba(52,62,76,.85)',
      facade: ['#c7cfd7', '#b2bcc6'], roof: '#8e9ba8', roofEdge: '#a6b1bc', tower: '#aeb8c2', towerCab: '#55687a',
      win: ['#7e93a6', '#687d90'], winSheen: 'rgba(255,255,255,.10)',
      apron: ['#959ca5', '#838a94'], apronTint: 'rgba(40,60,90,.14)', warm: null, noiseA: 0.5,
      taxi: ['#747c87', '#69717c'], shoulder: '#868d96', grass: '#5f6f58', yel: '#c8ae44',
      shadowA: 0.35, shadowL: 0.7, move: 'rgba(40,60,90,.12)', wet: true, cloud: 'rgba(150,160,172,.9)',
    }),
    rain: Object.assign({}, LIGHT_DAY, {
      name: 'rain', sky: ['#6a7b8b', '#8798a8', '#b7c4cf'], sun: null, cloudBand: 'rgba(190,200,210,.6)',
      facade: ['#d3dae1', '#bcc6cf'], roof: '#9aa9b6', roofEdge: '#aeb9c3', tower: '#b8c1ca', towerCab: '#5d7183',
      win: ['#8b9fb2', '#76899b'], winSheen: 'rgba(255,255,255,.12)',
      apron: ['#99a0a9', '#878e98'], apronTint: 'rgba(70,90,115,.08)', warm: null, noiseA: 0.5,
      taxi: ['#79818c', '#6e7681'], shoulder: '#8a9099', grass: '#6f8163', yel: '#c8ae44',
      shadowA: 0.6, shadowL: 0.85, move: 'rgba(40,60,90,.11)', wet: true, cloud: 'rgba(228,236,242,.85)',
    }),
    dusk: Object.assign({}, LIGHT_DAY, {
      name: 'dusk', sky: ['#3e5480', '#f2a066', '#ffd9a6'],
      sun: { x: 40, y: 26, r: 11, col: '#ff8a3d', glow: '255,150,80', gr: 58 }, cloudBand: null,
      facade: ['#eadfd5', '#d2c6bc'], roof: '#ada19b', roofEdge: '#cfc3b9', tower: '#d9cdc3', towerCab: '#6d6a78',
      win: ['#f3cf92', '#d9a464'], winSheen: 'rgba(255,240,210,.25)', winGlow: 'rgba(255,196,110,.30)',
      apron: ['#b6b2ae', '#a29c98'], apronTint: 'rgba(255,140,70,.07)', warm: 'rgba(255,170,110,.12)',
      taxi: ['#999189', '#8b837c'], shoulder: '#a49c95', grass: '#77805f',
      shadowA: 1.05, shadowL: 1.7, shadowCol: '40,30,50', move: 'rgba(255,130,60,.07)', flood: true, cloud: 'rgba(255,214,186,.9)',
    }),
  };
  function lightOf(state) {
    const st = state && state.stage;
    if (!st) return LIGHT.day;
    if (st.id === 4) return LIGHT.dusk;
    const now = (state.weatherNow && state.weatherNow.label) || '';
    if (now.includes('かみなり')) return LIGHT.storm;
    if (now.includes('くもり') || (!now && st.weather && String(st.weather.label).includes('くもり'))) return LIGHT.overcast;
    if (st.rainAll) return LIGHT.rain;
    return LIGHT.day;
  }

  /* ---------- 車の落ち影の外形（車両ローカル座標の矩形 [x, y, w, h]） ---------- */
  const VEH_SHADOW = {
    beltloader: [[-34, -12, 44, 24], [2, -6, 62, 12]],
    cart: [[-45, -10, 87, 20]],
    fuel: [[-48, -13, 96, 26]],
    catering: [[-42, -14, 82, 28]],
    pushback: [[-26, -15, 58, 30]],
  };
  /* 回転灯の位置（キャブの屋根のうしろ。窓をかくさない。車両ローカル座標） */
  const VEH_BEACON = { beltloader: [-22, 0], cart: [-28, 0], fuel: [-32, 0], catering: [-28, 0], pushback: [-4, -8] };
  /* 客室の窓（機首からの距離 u[m]。非常口のところは窓なし）。清掃の進み具合で前から順に明かりをつける */
  const CABIN_WIN = { u0: 6.9, u1: 29.3, step: 0.535, gap: [14.15, 15.85], v: 0.82 };
  /* セーフティコーン（駐機中だけ）: 左右の翼端のうしろの外（翼の下にかくれない所）と、尾のうしろ。
   * 車・人の通り道（区画の前 y494 付近・点検の一周）にはかからない */
  const CONES = [[638, 170], [638, 478], [497, 324]];
  /* 給油中のコーン */
  const FUEL_CONES = [[682, 482], [788, 482]];
  /* 照明つき投光器（夕方だけ光だまりを描く） */
  const FLOOD_MASTS = [[262, 146], [1010, 146]];

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
  /* 誘導路（タキシーウェイ）の中心線と、スタンドの誘導線が北へのびる縦の部分のx。
   * 誘導路のうち車両おきば・スタッフのまちあいの前（x250〜1046）は、翼が区画にかかるので機体は通らない。
   * 機体は左のはしで誘導路とスタンドを行き来する（縦の部分 x60 なら、右の翼端は x225 まで） */
  const TAXI_Y = 602, LEAD_X = 60, LEAD_R = 110;
  /* 到着: 誘導路（左）からスタンドの誘導線に入り、停止線で止まる。
   * 誘導線は前輪の通り道。主脚は前輪のあとを追いかけるので、機体の向き＝主脚→前輪。 */
  const ARR_TAXI_L = 180;                  // 誘導路を走る長さ（そのあと左へ曲がって誘導線に入る）
  let _arrival = null;
  function arrivalPaths() {
    if (_arrival) return _arrival;
    const stopX = NOSE_X - NOSE_GEAR_U * PK;
    const x0 = LEAD_X - LEAD_R - ARR_TAXI_L;
    const up = TAXI_Y - LEAD_R - (PLANE_CY + LEAD_R);
    const nose = taxiPath(x0, TAXI_Y, 0, [{ L: ARR_TAXI_L }, { R: LEAD_R, a: -90 }, { L: up }, { R: LEAD_R, a: 90 }, { L: stopX - (LEAD_X + LEAD_R) }]);
    let mx = nose[0].x - WHEELBASE, my = nose[0].y;
    const main = nose.map((n) => {
      const dx = n.x - mx, dy = n.y - my, d = Math.hypot(dx, dy) || 1;
      mx = n.x - (dx / d) * WHEELBASE; my = n.y - (dy / d) * WHEELBASE;
      return { x: mx, y: my, h: Math.atan2(dy, dx), s: n.s };
    });
    _arrival = { nose, main };
    return _arrival;
  }
  /* プッシュバック（主脚の通り道。うしろ向きに進む）:
   * トーイングカーが機首を押して、誘導線にそってまっすぐうしろ（左）へ → しっぽを下（南）へふって機首を上に向ける
   * → そのまま下がって誘導路へ → しっぽを右（東）へふって、機首を出発の方向（左＝西）に向けて止まる。
   * 出発: 誘導路を左へ走り去る（車両おきば・スタッフのまちあいの前は通らない） */
  const PUSH_R2 = 40;
  let _push = null, _depart = null;
  const pushPath = () => _push || (_push = taxiPath(PIVOT_X, PLANE_CY, 180, [
    { L: PIVOT_X - (LEAD_X + LEAD_R) }, { R: LEAD_R, a: -90 },
    { L: TAXI_Y - PUSH_R2 - (PLANE_CY + LEAD_R) }, { R: PUSH_R2, a: -90 },
  ]));
  const pushEnd = () => { const p = pushPath(); return p[p.length - 1]; };
  const departPath = () => _depart || (_depart = taxiPath(pushEnd().x, pushEnd().y, 180, [{ L: pushEnd().x + 260 }]));

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
  /* 色を明るく(f>0)・暗く(f<0)する（#rrggbb）。結果はおぼえておく */
  const _shade = {};
  const shadeHex = (hex, f) => {
    const key = hex + f;
    if (_shade[key]) return _shade[key];
    const n = parseInt(hex.slice(1), 16), t = f < 0 ? 0 : 255, a = Math.abs(f);
    const ch = (v) => Math.round(v + (t - v) * a);
    const out = `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
    _shade[key] = out;
    return out;
  };
  /* (ox,oy) を中心に ang まわした矩形 [x0..x1]×[y0..y1] の4すみ */
  const boxPts = (ox, oy, ang, x0, x1, y0, y1) => {
    const co = Math.cos(ang), si = Math.sin(ang);
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [ox + x * co - y * si, oy + x * si + y * co]);
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
    /* フラップのレールの覆い（後縁のうしろに少し出る、丸いカヌー形。5.75mはパイロンのうしろの覆い）
     * [中心線からの距離v, 幅, 後縁から出る長さ]（単位m） */
    G.fairings = [[3.7, 0.32, 0.6], [5.75, 0.48, 1.0], [8.2, 0.34, 0.7], [10.6, 0.32, 0.65], [12.6, 0.3, 0.6]];
    /* 垂直尾翼（上から見ると細い刃。前に背びれ（ドーサルフィン）がつく。つけ根の翼弦は約6m） */
    const finProf = [[28.7, 0], [29.7, 0.07], [30.5, 0.19], [31.6, 0.29], [33.3, 0.31], [35.3, 0.23], [36.9, 0.1], [37.55, 0]];
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
    spotFx: {},       // taskId -> 経過秒（ロックが開いた瞬間のリング）、'done:'+taskId -> 経過秒（かんりょうの輪）
    doneTags: [],     // かんりょうの札（スクリーン層）
    arrivalT: null,   // 到着シネマティックの進行(0..1)。null=なし
    arrivalCb: null,
    planeParked: true,
    /* 安全な範囲（キャンバスのうち、上にのる DOM の欄をのぞいた所）の余白。GAME が setViewInsets でわたす */
    insets: { l: 0, r: 0, t: 0, b: 0 },
    _insetsSet: false,  // setViewInsets が1回でも呼ばれたか（呼ばれないあいだは DOM の欄を測って使う）
    camMode: 'fit',     // 'fit'=はじめの画角 / 'all'=ぜんたい / 'user'=自分で動かした
    _tween: null,       // カメラ・余白の補間
    _needFit: true,
    light: LIGHT.day,

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
      this.doneTags = [];
      this.bgKey = '';   // ステージが変わったら背景キャッシュを作り直す
      this.cam = { zoom: 1, cx: 600, cy: 330 };
      this.arrivalT = null;
      this.arrivalCb = null;
      this.planeParked = true;
      /* 最初の画角は、キャンバスの大きさが決まった最初の draw で決める */
      this._needFit = true;
      this.camMode = 'fit';
      this._tween = null;
      this._follow = null;
      this._followOff = false;
    },

    /* 到着シネマティック: 誘導路からスポットへ入ってくる（動きを減らす設定では、すぐ駐機した形にする） */
    playArrival(cb) {
      this.arrivalT = reduceMotion() ? 1 : 0;
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
        this.float(PLANE_MID[0], 236, 'とうちゃく！ じゅんびスタート！', '#0b5f78');
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

    /* ---- カメラ ----
     * cam.cx/cy（シーン座標）を「安全な範囲」の中心 viewCenter() に合わせて描く。
     * 安全な範囲 = キャンバスから insets（ドロワー・スコア・スタッフ欄など DOM の欄）をのぞいた所。
     * 倍率は baseScale(=キャンバス幅/1200)×zoom（絵の大きさの基準は今までと同じ）。 */
    baseScale() { return this.cw / SCENE_W; },
    scale() { return this.baseScale() * this.cam.zoom; },
    minZoom() {
      /* 縦もぜんぶ入るところまで引ける（最低0.55倍） */
      const fitH = (this.ch / SCENE_H) / this.baseScale();
      return Math.max(0.55, Math.min(1, fitH));
    },
    safeW() { return Math.max(40, this.cw - this.insets.l - this.insets.r); },
    safeH() { return Math.max(40, this.ch - this.insets.t - this.insets.b); },
    viewCenter() {
      const I = this.insets;
      return { x: I.l + (this.cw - I.l - I.r) / 2, y: I.t + (this.ch - I.t - I.b) / 2 };
    },
    /* cam.cx・cy の動ける範囲。安全な範囲がシーンでおおわれる所まで（シーンの端は欄の下までは出てよい）。
     * relax=true は機体を追っているとき（左のはしの外の地面まで見せてよい） */
    camRange(zoom, relax) {
      const S = this.baseScale() * zoom;
      const vw = this.safeW() / S, vh = this.safeH() / S;
      const x0 = relax ? BG_X0 + 30 : 0, x1 = SCENE_W;
      const rx = vw >= x1 - x0 ? [(x0 + x1) / 2, (x0 + x1) / 2] : [x0 + vw / 2, x1 - vw / 2];
      const y1 = SCENE_H + (relax ? 150 : 0);   // 追っているときは、誘導路の下の芝まで見せてよい
      const ry = vh >= y1 ? [y1 / 2, y1 / 2] : [vh / 2, y1 - vh / 2];
      if (!relax && vw >= SCENE_W) rx[0] = rx[1] = SCENE_W / 2;
      return { x: rx, y: ry };
    },
    clampCam(relax) {
      const c = this.cam;
      /* キャンバス未サイズ時や不正値からの復帰 */
      if (!isFinite(c.zoom)) c.zoom = 1;
      if (!isFinite(c.cx)) c.cx = 600;
      if (!isFinite(c.cy)) c.cy = 330;
      if (!this.cw || !this.ch) return;
      c.zoom = clamp(c.zoom, this.minZoom(), 2.6);
      const R = this.camRange(c.zoom, relax != null ? relax : !!this._relax);
      c.cx = clamp(c.cx, R.x[0], R.x[1]);
      c.cy = clamp(c.cy, R.y[0], R.y[1]);
    },
    /* いまのズームで、縦か横にパンできるか（GAME が「ドラッグでうごかせるよ」の案内に使う） */
    canPan() {
      if (!this.cw || !this.ch) return false;
      const R = this.camRange(this.cam.zoom, false);
      return R.x[1] - R.x[0] > 1 || R.y[1] - R.y[0] > 1;
    },
    sceneToScreen(x, y) {
      const S = this.scale(), v = this.viewCenter();
      return { x: (x - this.cam.cx) * S + v.x, y: (y - this.cam.cy) * S + v.y };
    },
    screenToScene(x, y) {
      const S = this.scale(), v = this.viewCenter();
      return { x: (x - v.x) / S + this.cam.cx, y: (y - v.y) / S + this.cam.cy };
    },
    /* はじめの画角: 制限区域とまわりの待機所・車のおきば（FOCUS）が、安全な範囲いっぱいに入る倍率と位置 */
    fitTarget() {
      const base = this.baseScale();
      const z = clamp(Math.min(this.safeW() / ((FOCUS.x1 - FOCUS.x0) * base), this.safeH() / ((FOCUS.y1 - FOCUS.y0) * base)), this.minZoom(), 2.6);
      const R = this.camRange(z, false);
      return { zoom: z, cx: clamp((FOCUS.x0 + FOCUS.x1) / 2, R.x[0], R.x[1]), cy: clamp((FOCUS.y0 + FOCUS.y1) / 2, R.y[0], R.y[1]) };
    },
    /* ⛶ ぜんたい: 場全体が見える倍率（今までと同じ）。中心は安全な範囲の中心 */
    allTarget() {
      const z = this.minZoom() < 1 ? this.minZoom() : 1;
      const R = this.camRange(z, false);
      return { zoom: z, cx: clamp(600, R.x[0], R.x[1]), cy: clamp(330, R.y[0], R.y[1]) };
    },
    /* GAME から: ドロワーの開け閉めなどで、安全な範囲が変わったら呼ぶ（{l,r,t,b} はキャンバスの画面座標の余白px） */
    setViewInsets(ins) {
      this._insetsSet = true;
      this._applyInsets(ins || {}, true);
    },
    _applyInsets(ins, animate) {
      const n = { l: Math.max(0, +ins.l || 0), r: Math.max(0, +ins.r || 0), t: Math.max(0, +ins.t || 0), b: Math.max(0, +ins.b || 0) };
      /* 欄が大きすぎて安全な範囲がせまくなりすぎるときは、その向きの余白をあきらめる */
      if (this.cw && this.cw - n.l - n.r < this.cw * 0.35) { n.l = 0; n.r = 0; }
      if (this.ch && this.ch - n.t - n.b < this.ch * 0.35) { n.t = 0; n.b = 0; }
      const o = this._tween ? this._tween.to.ins : this.insets;
      if (Math.abs(o.l - n.l) < 1 && Math.abs(o.r - n.r) < 1 && Math.abs(o.t - n.t) < 1 && Math.abs(o.b - n.b) < 1) return;
      if (!this.cw || !this.ch || this._needFit) { this._endTween(); this.insets = n; return; }
      this._endTween();
      const from = { zoom: this.cam.zoom, cx: this.cam.cx, cy: this.cam.cy, ins: { ...this.insets } };
      this.insets = n;
      /* はじめの画角・ぜんたいのままなら、新しい範囲で決めなおす。自分で動かしたあとは、見ていた所を新しい範囲の中心に */
      const to = this.camMode === 'fit' ? this.fitTarget() : this.camMode === 'all' ? this.allTarget()
        : (() => { const R = this.camRange(this.cam.zoom, !!this._relax); return { zoom: this.cam.zoom, cx: clamp(this.cam.cx, R.x[0], R.x[1]), cy: clamp(this.cam.cy, R.y[0], R.y[1]) }; })();
      to.ins = n;
      this.insets = from.ins;
      if (!animate || reduceMotion()) { this.insets = n; Object.assign(this.cam, { zoom: to.zoom, cx: to.cx, cy: to.cy }); return; }
      this._tween = { t: 0, dur: 0.25, from, to };
    },
    stepTween(dt) {
      const w = this._tween;
      if (!w) return;
      w.t += dt;
      const k = clamp(w.t / w.dur, 0, 1), e = k * k * (3 - 2 * k);
      const L = (a, b) => a + (b - a) * e;
      this.cam.zoom = L(w.from.zoom, w.to.zoom);
      this.cam.cx = L(w.from.cx, w.to.cx);
      this.cam.cy = L(w.from.cy, w.to.cy);
      ['l', 'r', 't', 'b'].forEach((s) => { this.insets[s] = L(w.from.ins[s], w.to.ins[s]); });
      if (k >= 1) this._tween = null;
    },
    _endTween() {
      const w = this._tween;
      if (!w) return;
      this._tween = null;
      this.insets = { ...w.to.ins };
      Object.assign(this.cam, { zoom: w.to.zoom, cx: w.to.cx, cy: w.to.cy });
    },
    /* setViewInsets が呼ばれないあいだは、DOM の欄を測って安全な範囲にする（0.4秒ごと） */
    pollInsets(dt, force) {
      if (this._insetsSet || !this.cw) return;
      this._pollT = (this._pollT || 0) - dt;
      if (this._pollT > 0 && !force) return;
      this._pollT = 0.4;
      const f = this.freeRect();
      this._applyInsets({ l: f.l, r: this.cw - f.r, t: f.t, b: this.ch - f.b }, true);
    },
    /* 自分でズーム・パンしたら、機体を追うのをやめる */
    _userCam(mode) {
      this._endTween();
      this._needFit = false;   // はじめの画角を決める前に自分で動かしたら、その画角を優先する
      this.camMode = mode || 'user';
      if (this._follow) this._followOff = true;
    },
    /* プッシュバック・出発のあいだは、機体を追う（誘導路がスタッフ欄の下にかくれる画面でも、出発が見えるように） */
    updateFollow(state, tr, dt) {
      /* 到着: はじめは誘導路を走ってくる機体を映し、後半でなめらかに、はじめの画角へもどる（とちゅうでタップしたら補間でもどる） */
      if (this.arrivalT != null && this.camMode === 'fit' && !reduceMotion()) {
        const t = clamp(this.arrivalT, 0, 1), F = this.fitTarget();
        const u = clamp((t - 0.3) / 0.6, 0, 1), w = u * u * (3 - 2 * u);
        const m = this.transformPoint(PLANE_MID[0], PLANE_MID[1], tr);
        const R = this.camRange(F.zoom, true);
        this._relax = true;
        this._arrCam = true;
        this.cam.zoom = F.zoom;
        this.cam.cx = clamp(m.x, R.x[0], R.x[1]) * (1 - w) + F.cx * w;
        this.cam.cy = clamp(m.y, R.y[0], R.y[1]) * (1 - w) + F.cy * w;
        return;
      }
      if (this._arrCam) {
        this._arrCam = false;
        if (this.camMode === 'fit') {
          const to = this.fitTarget();
          to.ins = { ...this.insets };
          this._tween = { t: 0, dur: 0.4, from: { zoom: this.cam.zoom, cx: this.cam.cx, cy: this.cam.cy, ins: { ...this.insets } }, to };
        }
      }
      const push = state.tasks.pushback.status, dep = state.tasks.depart.status;
      const phase = push === 'active' || (push === 'done' && dep !== 'done') || dep === 'active';
      this._relax = phase || !!this._tween;   // 補間のあいだは、ゆるい範囲のまま（はしでとばない）
      this._follow = phase && !this._followOff && tr.alpha > 0.05 ? true : null;
      if (!this._follow || this._tween) return;
      const m = this.transformPoint(PLANE_MID[0], PLANE_MID[1], tr);
      const R = this.camRange(this.cam.zoom, true);
      const tx = clamp(m.x, R.x[0], R.x[1]), ty = clamp(m.y + 10, R.y[0], R.y[1]);
      const k = 1 - Math.exp(-dt * 2.2);
      this.cam.cx += (tx - this.cam.cx) * k;
      this.cam.cy += (ty - this.cam.cy) * k;
    },
    /* キャンバスのうち、上にのっているDOMの欄（右のスコア・下のスタッフ・左の作業カード）をのぞいた、
     * 見えている範囲（キャンバスの画面座標）。欄が大きすぎるときはキャンバス全体を返す。
     * setViewInsets が呼ばれないときだけ使う */
    freeRect() {
      const full = { l: 0, t: 0, r: this.cw, b: this.ch };
      if (!this.canvas || !this.canvas.getBoundingClientRect) return full;
      const cv = this.canvas.getBoundingClientRect();
      const f = { ...full };
      const boxes = [];
      ['panel-status', 'panel-resources', 'panel-tasks'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.classList.contains('closed')) return;   // とじた作業カード（とじる途中のアニメーションも）は数えない
        const q = el.getBoundingClientRect();
        const b = { x0: q.left - cv.left, x1: q.right - cv.left, y0: q.top - cv.top, y1: q.bottom - cv.top };
        if (q.width < 1 || q.height < 1 || b.x1 <= 0 || b.x0 >= this.cw || b.y1 <= 0 || b.y0 >= this.ch) return;
        b.wide = b.x1 - b.x0 > this.cw * 0.6;
        boxes.push(b);
      });
      /* 横に長い欄（下のスタッフ欄など）は上か下の余白 */
      boxes.filter((b) => b.wide).forEach((b) => {
        if (b.y0 > this.ch / 2) f.b = Math.min(f.b, b.y0); else f.t = Math.max(f.t, b.y1);
      });
      /* 横の欄（作業カード・スコア）は、左右の余白にするか、上下の余白にするかを、
       * はじめの画角（FOCUS）が大きく入るほうにする（縦長の画面で右上だけにある欄は上の余白に） */
      const fit = (r) => Math.min((r.r - r.l) / (FOCUS.x1 - FOCUS.x0), (r.b - r.t) / (FOCUS.y1 - FOCUS.y0));
      boxes.filter((b) => !b.wide).forEach((b) => {
        const side = { ...f }, vert = { ...f };
        if (b.x0 > this.cw / 2) side.r = Math.min(side.r, b.x0); else side.l = Math.max(side.l, b.x1);
        if (b.y0 + b.y1 < this.ch) vert.t = Math.max(vert.t, b.y1); else vert.b = Math.min(vert.b, b.y0);
        Object.assign(f, fit(vert) > fit(side) * 1.08 ? vert : side);
      });
      if (f.r - f.l < this.cw * 0.45 || f.b - f.t < this.ch * 0.45) return full;
      return f;
    },
    zoomAt(factor, px, py) {
      if (!this.cw || !this.ch) return;   // キャンバスがまだ表示されていない
      this._userCam();
      /* ボタンで拡大・縮小するときは、安全な範囲（insets の内側）の中心に合わせる。
       * 機体がその範囲に見えていれば、機体のまん中をそこへ（機首がスコア欄の下に入らない）。
       * insets は setViewInsets の値。呼ばれていないときは DOM の欄を測った値（pollInsets） */
      const v = this.viewCenter();
      let pivot = (px != null) ? { x: px, y: py } : v;
      let anchor = null;
      if (px == null) {
        const I = this.insets;
        const m = this.sceneToScreen(PLANE_MID[0], PLANE_MID[1]);
        if (this._planeHome !== false && m.x > I.l && m.x < this.cw - I.r && m.y > I.t && m.y < this.ch - I.b) anchor = { x: PLANE_MID[0], y: PLANE_MID[1] };
      }
      const before = anchor || this.screenToScene(pivot.x, pivot.y);
      this.cam.zoom = clamp(this.cam.zoom * factor, this.minZoom(), 2.6);
      const S = this.scale();
      this.cam.cx = before.x - (pivot.x - v.x) / S;
      this.cam.cy = before.y - (pivot.y - v.y) / S;
      this.clampCam();
    },
    panBy(dxScreen, dyScreen) {
      if (!this.cw || !this.ch) return;
      this._userCam();
      const S = this.scale();
      this.cam.cx -= dxScreen / S;
      this.cam.cy -= dyScreen / S;
      this.clampCam();
    },
    resetCam() {
      this._userCam('all');
      Object.assign(this.cam, this.allTarget());
      this.clampCam();
    },

    /* ---- ホーム位置（待機所は左ドロワーに隠れない位置に置く） ---- */
    staffHome(state, entity) {
      const staff = state.entities.filter((e) => e.kind === 'staff');
      const i = staff.indexOf(entity);
      return [ZONE.staff.x + 16 + (i % 5) * 28, ZONE.staff.y + 22 + Math.floor(i / 5) * 26];
    },
    homeOf(state, e) {
      if (e.kind === 'staff') return this.staffHome(state, e);
      const arr = VEHICLE_HOME[e.type] || [[1100, VEH_ROW, 0]];
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
      const CORR = Math.round((ZONE.era.y1 + ZONE.staff.y) / 2) - 5;   // 横移動用の通路（下の翼端と区画のあいだ）
      const SIDE = 912;      // 機首の前を回りこむ縦通路
      const topSide = (p) => p[1] < PLANE_CY - 22;
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

    /* 人・車の当たり判定の中心（シーン座標）。人は体の中ほど、車は車体の外形のまん中 */
    hitCenter(e, rec) {
      if (e.kind === 'staff') return [rec.pos.x, rec.pos.y - PERSON_MID];
      const ex = VEH_EXT[e.type] || [-40, 40, -12, 12];
      const mx = (ex[0] + ex[1]) / 2, a = rec.drawAngle != null ? rec.drawAngle : rec.angle;
      return [rec.pos.x + Math.cos(a) * mx, rec.pos.y + Math.sin(a) * mx];
    },
    /* 小さい画面で持ち場・予告・進行リング・スキルの印だけを大きくする倍率（人と車には掛けない） */
    spotK() { const S = this.scale() || 1; return Math.min(2, Math.max(1, 0.6 / S)); },

    /* タップ判定: 人・車のいちばん近いものと、持ち場のいちばん近いものを両方求めて、近いほうを返す。
     * 距離は「画面上のピクセル」で比べる。押せる範囲は見た目とは別に、人は半径24px・車は22px以上（小学2年生の指でも押せる）。
     * 持ち場は、見た目の円の中（+8px）か、人・車より近ければ持ち場を返す。
     * 人をえらんでいるあいだは、その人を送れる持ち場を優先する（ほかの人をえらび直すこともできる） */
    hitTest(state, sx, sy) {
      const S = this.scale(), k = this.spotK();
      const G = window.Game;
      const sel = this._ui ? this._ui.selected : null;
      let ent = null, entD = 1e9;
      state.entities.forEach((e) => {
        const rec = this.ent[e.id];
        if (!rec) return;
        const [hx, hy] = this.hitCenter(e, rec);
        const sp = this.sceneToScreen(hx, hy);
        const r = e.kind === 'staff' ? 24 : Math.max(22, 40 * S);
        const d = Math.hypot(sp.x - sx, sp.y - sy);
        if (d < r && d < entD) { ent = { type: 'entity', id: e.id }; entD = d; }
      });
      let spot = null, spotD = 1e9, spotVis = 0, spotAcc = false;
      state.taskList.forEach((t) => {
        const open = t.status === 'ready' || t.status === 'gathering' || t.status === 'active';
        /* 「もうすぐできる」予告サークルも押せる（なぜまだできないかを読めるように） */
        const soon = t.status === 'locked' && G.opensInMinutes(t.id) != null;
        if (!open && !soon) return;
        const a = this.anchorOf(t.id);
        if (!a) return;
        const sp = this.sceneToScreen(a[0], a[1]);
        const d = Math.hypot(sp.x - sx, sp.y - sy);
        const r = open ? 36 : 24;
        if (d >= r) return;
        const acc = !!(sel && open && G.canAccept(t.id, sel));
        if ((acc && !spotAcc) || (acc === spotAcc && d < spotD)) {
          spot = { type: 'spot', id: t.id }; spotD = d; spotAcc = acc;
          spotVis = (open ? 23 : 18.5) * S * k;
        }
      });
      if (spot && (spotAcc || !ent || spotD <= spotVis + 8 || spotD < entD)) return spot;
      return ent || spot;
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
    /* 知らせの札（スクリーン層に、白い角丸の札で出す。上へは動かさない） */
    float(x, y, text, color) {
      this.fx.floats.push({ x, y, text, color: color || '#1e3a5f', life: 2.2, age: 0 });
    },
    /* 作業がおわったとき: ふだんは静かに（持ち場で緑の輪が1回広がり、「かんりょう」の札が1.2秒）。
     * 紙ふぶきの粒は、出発してクリアしたときだけ */
    celebrate(state, taskId) {
      if (taskId === 'depart') {
        const clear = !(state.flags && state.flags.critical);
        if (clear && !reduceMotion()) {
          const colors = ['#ffd166', '#57c98a', '#3bb0f2', '#f2544a', '#b07fe6'];
          const v = this.screenToScene(this.viewCenter().x, this.viewCenter().y);
          for (let i = 0; i < 5; i++) this.burst(v.x - 260 + i * 130, v.y - 20, 12, colors);
        }
        const v = this.screenToScene(this.viewCenter().x, this.viewCenter().y);
        this.float(v.x, v.y - 60, clear ? 'いってらっしゃい！' : 'しゅっぱつ', '#0b5f78');
        return;
      }
      let a = this.anchorOf(taskId);
      if (taskId === 'pushback') {
        /* 押し終わった位置（トーイングカーのところ） */
        const p = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1], this.planeTransform(state));
        a = [p.x, p.y];
      }
      if (!a) return;
      this.spotFx['done:' + taskId] = 0;
      this.doneTags.push({ id: taskId, x: a[0], y: a[1], age: 0, life: 1.2 });
    },
    /* 粒（クリアのときだけ）。シーン座標で描く */
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
      this._ui = ui || null;
      this._labels = [];
      const gt = state ? state.clock : 0;
      const L = this.light = lightOf(state);
      spotCol();

      this.stepArrival(dtReal);
      /* カメラ: 安全な範囲を決め（setViewInsets がなければ DOM を測る）、はじめの画角・補間・機体を追う */
      if (this.cw && this.ch) {
        this.pollInsets(dtReal, this._needFit);
        if (this._needFit) {
          this._needFit = false;
          this.camMode = 'fit';
          Object.assign(this.cam, this.fitTarget());
        }
        this.stepTween(dtReal);
      }
      const tr = state ? this.planeTransform(state) : null;
      if (state && this.cw) this.updateFollow(state, tr, dtReal);
      this.clampCam();

      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.cw, this.ch);
      c.fillStyle = L.taxi[1];
      c.fillRect(0, 0, this.cw, this.ch);

      c.save();
      const v = this.viewCenter(), S = this.scale();
      c.translate(v.x, v.y);
      c.scale(S, S);
      c.translate(-this.cam.cx, -this.cam.cy);

      this.ensureBg(state);
      this.drawOutside();
      c.drawImage(this.bgCanvas, BG_X0, 0, BG_X1 - BG_X0, SCENE_H);
      this.drawSkyLife(state);
      this.addSignLabels(state);
      if (state) {
        this.updateBridge(state, dtReal);
        this._planeHome = this.arrivalT == null && Math.abs(tr.x) + Math.abs(tr.y) + Math.abs(tr.rot) < 0.5;
        const ents = this.layoutEntities(state, gt, tr, dtReal);
        /* 到着してくるあいだは、持ち場のサークルより機体を上に（走ってくる機体の下にかくれる） */
        const arriving = this.arrivalT != null;
        if (arriving) this.drawSpotLayer(state, ui, dtReal);
        /* 重なり順: 地面の物（コーン・搭乗橋の影）→ 機体の下にいる物 → 機体 → 搭乗橋の下をくぐる人
         * → 搭乗橋の床 → 搭乗橋の中の人・乗客 → ガラスの屋根 → そのほか */
        this.drawCones(state);
        this.drawBridgeShadow();
        this.drawEntityLayer(state, ents, 'under', gt);
        this.drawPlane(state, tr);
        this.drawEntityLayer(state, ents, 'bridge', gt);
        this.drawBridge(state);
        this.drawEntityLayer(state, ents, 'inside', gt);
        this.drawPax(state, gt);
        this.drawBridgeRoof();
        this.drawEffectsUnder(state, gt);
        if (!arriving) this.drawSpotLayer(state, ui, dtReal);
        this.drawEntityLayer(state, ents, 'over', gt);
        this.drawPlaneOverlay(state, tr);
        this.drawGhosts(state, ents, gt);
        /* 照明の色（夕方の暖色・雨の寒色）を、動く物の上に1回だけかぶせる。持ち場の印・リング・文字はこのあと */
        this.drawMoveTint();
        this.drawBadges(state, ents);
        this.drawSelection(state, ents, ui);
        this.drawRings(state, tr);
        this.drawPaxCounter(state);
        this.drawFx(dtReal);
        this.drawRain(state);
      }
      c.restore();
      this.drawLabelsScreen(state, dtReal);
    },

    /* いま画面に見えている範囲（シーン座標） */
    viewBounds() {
      const a = this.screenToScene(0, 0), b = this.screenToScene(this.cw, this.ch);
      return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    },
    /* シーンの外（縦長の画面やズームアウトで見える所）: 上は空のつづき、下は誘導路の路肩と芝、左右は背景のはしをのばす */
    drawOutside() {
      const c = this.ctx, L = this.light, B = this.viewBounds();
      const x0 = B.x0 - 4, x1 = B.x1 + 4;
      if (B.y0 < 0) {
        const key = 'sky:' + L.name;
        this._grad = this._grad || {};
        if (!this._grad[key]) {
          const g = c.createLinearGradient(0, -620, 0, 0);
          g.addColorStop(0, L.sky[0]); g.addColorStop(1, L.sky[1]);
          this._grad[key] = g;
        }
        c.fillStyle = this._grad[key];
        c.fillRect(x0, B.y0 - 4, x1 - x0, -B.y0 + 4.5);
      }
      if (B.y1 > SCENE_H) {
        c.fillStyle = L.shoulder;
        c.fillRect(x0, SCENE_H - 0.5, x1 - x0, 14.5);
        c.fillStyle = L.grass;
        c.fillRect(x0, SCENE_H + 14, x1 - x0, B.y1 - SCENE_H - 10);
        if (!this._noisePat) this._noisePat = c.createPattern(this.noiseTile(), 'repeat');
        c.save();
        c.globalAlpha = 0.9;
        c.fillStyle = this._noisePat;
        c.fillRect(x0, SCENE_H - 0.5, x1 - x0, B.y1 - SCENE_H + 4);
        c.restore();
        /* 芝のふち（路肩との境の陰）と、ところどころの濃い草 */
        c.fillStyle = 'rgba(30,45,30,.18)';
        c.fillRect(x0, SCENE_H + 14, x1 - x0, 2.5);
        c.fillStyle = 'rgba(40,60,35,.10)';
        for (let x = Math.floor(x0 / 90) * 90; x < x1; x += 90) {
          c.beginPath(); c.ellipse(x + 30, SCENE_H + 40 + ((x / 90) % 3) * 22, 34, 7, 0, 0, TAU); c.fill();
        }
      }
      const H2 = this.bgCanvas.height, W2 = this.bgCanvas.width;
      const side = (a, b) => {
        if (!this._noisePat) this._noisePat = c.createPattern(this.noiseTile(), 'repeat');
        c.save(); c.globalAlpha = 0.7; c.fillStyle = this._noisePat; c.fillRect(a, 138, b - a, SCENE_H - 138); c.restore();
      };
      if (x0 < BG_X0) { c.drawImage(this.bgCanvas, 0, 0, 1, H2, x0, 0, BG_X0 - x0 + 0.5, SCENE_H); side(x0, BG_X0); }
      if (x1 > BG_X1) { c.drawImage(this.bgCanvas, W2 - 1, 0, 1, H2, BG_X1 - 0.5, 0, x1 - BG_X1 + 0.5, SCENE_H); side(BG_X1, x1); }
    },
    /* 動く物にかぶせる照明の色（夕方・雨・くもり・かみなり） */
    drawMoveTint() {
      const L = this.light;
      if (!L.move) return;
      const c = this.ctx, B = this.viewBounds();
      c.fillStyle = L.move;
      c.fillRect(B.x0 - 2, B.y0 - 2, B.x1 - B.x0 + 4, B.y1 - B.y0 + 4);
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
      const L = this.light || lightOf(state);
      const st = state && state.stage;
      const key = (st ? st.id : 0) + '|' + L.name;
      if (this.bgCanvas && this.bgKey === key) return;
      this.bgKey = key;
      if (!this.bgCanvas) {
        this.bgCanvas = document.createElement('canvas');
        this.bgCanvas.width = (BG_X1 - BG_X0) * 2;
        this.bgCanvas.height = SCENE_H * 2;
      }
      const g = this.bgCanvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
      g.setTransform(2, 0, 0, 2, -BG_X0 * 2, 0);
      const prev = this.ctx;
      this.ctx = g;   // rr()等のヘルパーを使うため一時的に差し替え
      try { this.renderBg(g, L); } finally { this.ctx = prev; }
    },

    /* 静的背景（照明のプリセット L で1回だけ描く）。文字はここには描かない（スクリーン層の案内板で描く）。
     * x は BG_X0〜BG_X1（シーンの左右のそと）まで描く */
    renderBg(c, L) {
      const X0 = BG_X0, X1 = BG_X1, W = X1 - X0;
      const shA = L.shadowA, shL = L.shadowL;
      const h01 = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
      /* --- 空（グラデーション）と太陽・雲の帯 --- */
      const sky = c.createLinearGradient(0, 0, 0, 30);
      sky.addColorStop(0, L.sky[1]); sky.addColorStop(1, L.sky[2]);
      c.fillStyle = sky;
      c.fillRect(X0, 0, W, 30);
      if (L.sun) {
        const s = L.sun;
        const glow = c.createRadialGradient(s.x, s.y, 2, s.x, s.y, s.gr);
        glow.addColorStop(0, `rgba(${s.glow},.9)`);
        glow.addColorStop(0.45, `rgba(${s.glow},.35)`);
        glow.addColorStop(1, `rgba(${s.glow},0)`);
        c.fillStyle = glow;
        c.beginPath(); c.arc(s.x, s.y, s.gr, 0, TAU); c.fill();
        c.fillStyle = s.col;
        c.beginPath(); c.arc(s.x, s.y, s.r, 0, TAU); c.fill();
      }
      if (L.cloudBand) {
        /* くもり・雨・かみなり: 太陽のかわりに空をおおう雲。かみなりは太陽の位置にとくに暗い雲 */
        c.fillStyle = L.cloudBand;
        for (let x = X0 - 20; x < X1 + 40; x += 44) {
          const k = h01(x, 3);
          c.beginPath(); c.ellipse(x, 7 + k * 12, 32 + k * 20, 7 + k * 4, 0, 0, TAU); c.fill();
        }
        if (L.name === 'storm') {
          const db = c.createRadialGradient(80, 10, 4, 80, 10, 150);
          db.addColorStop(0, 'rgba(26,32,42,.75)'); db.addColorStop(1, 'rgba(26,32,42,0)');
          c.fillStyle = db; c.fillRect(X0, 0, 420, 30);
        }
      }

      /* --- ターミナルビル（面の明暗つき。夕方は窓に明かり） --- */
      c.fillStyle = L.roof;
      c.fillRect(X0, 30, W, 8);
      const fac = c.createLinearGradient(0, 38, 0, 126);
      fac.addColorStop(0, L.facade[0]); fac.addColorStop(1, L.facade[1]);
      c.fillStyle = fac;
      c.fillRect(X0, 38, W, 88);
      const win = c.createLinearGradient(0, 52, 0, 106);
      win.addColorStop(0, L.win[0]); win.addColorStop(1, L.win[1]);
      for (let x = 48 - 46 * 5; x < X1 - 60; x += 46) {
        if (L.winGlow) { c.fillStyle = L.winGlow; this.rr(x - 4, 48, 36, 62, 6); c.fill(); }
        c.fillStyle = win;
        c.fillRect(x, 52, 28, 54);
        /* 窓のななめの光 */
        c.fillStyle = L.winSheen;
        c.beginPath();
        c.moveTo(x, 52); c.lineTo(x + 13, 52); c.lineTo(x, 74);
        c.closePath(); c.fill();
        /* 窓わくと、たてのさん */
        c.strokeStyle = 'rgba(70,90,110,.25)'; c.lineWidth = 1;
        c.strokeRect(x + 0.5, 52.5, 27, 53);
        c.beginPath(); c.moveTo(x + 14, 53); c.lineTo(x + 14, 105); c.stroke();
      }
      /* 屋根のフチ（上面が明るく、下に影の線） */
      c.fillStyle = L.roofEdge;
      c.fillRect(X0, 126, W, 12);
      c.fillStyle = 'rgba(255,255,255,.4)';
      c.fillRect(X0, 126, W, 2.5);
      c.fillStyle = 'rgba(30,45,65,.25)';
      c.fillRect(X0, 136, W, 2);
      /* 管制塔（右面に陰） */
      c.fillStyle = L.tower;
      c.fillRect(1082, 48, 24, 78);
      c.fillStyle = 'rgba(255,255,255,.45)'; c.fillRect(1082, 48, 5, 78);
      c.fillStyle = 'rgba(50,65,85,.18)'; c.fillRect(1098, 48, 8, 78);
      c.fillStyle = L.towerCab;
      this.rr(1068, 30, 52, 26, 8); c.fill();
      const twin = c.createLinearGradient(0, 36, 0, 46);
      twin.addColorStop(0, L.winGlow ? '#f6d9a6' : L.win[0]);
      twin.addColorStop(1, L.winGlow ? '#d9a464' : L.win[1]);
      c.fillStyle = twin; this.rr(1073, 36, 42, 10, 4); c.fill();
      c.fillStyle = 'rgba(255,255,255,.5)'; this.rr(1073, 36, 42, 3.5, 2); c.fill();
      c.strokeStyle = L.towerCab; c.lineWidth = 2;
      c.beginPath(); c.moveTo(1094, 30); c.lineTo(1094, 18); c.stroke();

      /* --- エプロン（コンクリート。奥が明るく手前がわずかに暗い。板ごとに明暗のむら） --- */
      const ap = c.createLinearGradient(0, 138, 0, SCENE_H);
      ap.addColorStop(0, L.apron[0]); ap.addColorStop(1, L.apron[1]);
      c.fillStyle = ap;
      c.fillRect(X0, 138, W, SCENE_H - 138);
      const rows = [138, 230, 360, 490, 574];
      for (let gx = 120 - 150 * 3; gx < X1; gx += 150) {
        for (let r = 0; r < rows.length - 1; r++) {
          const h = h01(gx, rows[r]) - 0.5;   // ±3%
          c.fillStyle = h > 0 ? `rgba(255,255,255,${(h * 0.12).toFixed(3)})` : `rgba(20,28,36,${(-h * 0.06).toFixed(3)})`;
          c.fillRect(gx, rows[r], 150, rows[r + 1] - rows[r]);
        }
      }
      /* コンクリートの質感（ノイズ） */
      const noise = c.createPattern(this.noiseTile(), 'repeat');
      c.save();
      c.globalAlpha = L.noiseA;
      c.fillStyle = noise;
      c.fillRect(X0, 138, W, SCENE_H - 138);
      c.restore();
      /* ターミナルの落ち影（光源が左上→建物の南側に影。夕方は長い） */
      const bsh = c.createLinearGradient(0, 138, 0, 138 + 38 * shL);
      bsh.addColorStop(0, `rgba(${L.shadowCol},${(0.24 * Math.min(1.2, shA)).toFixed(3)})`);
      bsh.addColorStop(1, `rgba(${L.shadowCol},0)`);
      c.fillStyle = bsh;
      c.fillRect(X0, 138, W, 38 * shL);
      /* 日ざしの色（左上からのあたたかい光） */
      if (L.warm) {
        const sx = L.sun ? L.sun.x + 70 : 140;
        const sun = c.createRadialGradient(sx, 40, 60, sx, 40, 1100);
        sun.addColorStop(0, L.warm);
        sun.addColorStop(1, 'rgba(255,240,205,0)');
        c.fillStyle = sun;
        c.fillRect(X0, 30, W, SCENE_H - 30);
      }
      /* 夕方: 投光器の光だまり */
      if (L.flood) {
        [[300, 176], [1000, 176], [690, 168]].forEach(([x, y], i) => {
          const r = i === 2 ? 200 : 250;
          const fl = c.createRadialGradient(x, y, 10, x, y, r);
          fl.addColorStop(0, 'rgba(255,222,170,.20)');
          fl.addColorStop(1, 'rgba(255,222,170,0)');
          c.fillStyle = fl;
          c.beginPath(); c.ellipse(x, y + r * 0.35, r, r * 0.7, 0, 0, TAU); c.fill();
        });
      }
      /* コンクリートのつなぎ目（影＋ハイライトの2重線で彫りを出す） */
      for (let x = 120 - 150 * 3; x < X1; x += 150) {
        c.strokeStyle = 'rgba(55,65,75,.14)'; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(x, 138); c.lineTo(x, 574); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x + 1.5, 138); c.lineTo(x + 1.5, 574); c.stroke();
      }
      for (let y = 230; y < 574; y += 130) {
        c.strokeStyle = 'rgba(55,65,75,.14)'; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(X0, y); c.lineTo(X1, y); c.stroke();
        c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(X0, y + 1.5); c.lineTo(X1, y + 1.5); c.stroke();
      }
      /* 車と人の通り道の黒ずみ（区画の前のよこの通り道と、車が持ち場へ向かうたての道） */
      const band = c.createLinearGradient(0, 480, 0, 504);
      band.addColorStop(0, 'rgba(36,44,54,0)'); band.addColorStop(0.5, 'rgba(36,44,54,.07)'); band.addColorStop(1, 'rgba(36,44,54,0)');
      c.fillStyle = band; c.fillRect(X0, 480, W, 24);
      [[576, 400], [732, 446], [775, 412], [835, 446], [560, 446]].forEach(([x, y]) => {
        const g = c.createLinearGradient(x - 11, 0, x + 11, 0);
        g.addColorStop(0, 'rgba(36,44,54,0)'); g.addColorStop(0.5, 'rgba(36,44,54,.045)'); g.addColorStop(1, 'rgba(36,44,54,0)');
        c.fillStyle = g; c.fillRect(x - 11, y, 22, 492 - y);
      });
      /* 路面のよごれ・エンジンの下の油じみ・タイヤあと */
      c.fillStyle = 'rgba(50,60,70,.07)';
      [[210, 320, 60, 20], [1030, 260, 56, 18], [400, 462, 40, 12], [980, 440, 52, 16], [300, 210, 70, 16]].forEach(([x, y, w, h]) => {
        c.beginPath(); c.ellipse(x, y, w, h, 0.3, 0, TAU); c.fill();
      });
      [[730, PLANE_CY - ENG_V * PK], [730, PLANE_CY + ENG_V * PK]].forEach(([x, y]) => {
        c.fillStyle = 'rgba(26,30,36,.11)';
        c.beginPath(); c.ellipse(x, y + 2, 13, 6, -0.2, 0, TAU); c.fill();
        c.fillStyle = 'rgba(26,30,36,.08)';
        c.beginPath(); c.ellipse(x - 9, y - 3, 5, 3, 0.4, 0, TAU); c.fill();
        c.beginPath(); c.ellipse(x + 11, y + 6, 4, 2.4, 0, 0, TAU); c.fill();
      });
      /* 主脚のタイヤあと（誘導線の曲がり角で主脚が通るところ。左右2本） */
      c.strokeStyle = 'rgba(40,48,58,.06)'; c.lineWidth = 4; c.lineCap = 'round';
      [-1, 1].forEach((s) => {
        c.beginPath();
        let first = true;
        arrivalPaths().main.forEach((p, i) => {
          if (p.s < 440 || p.s > 660 || i % 3) return;
          const x = p.x - Math.sin(p.h) * s * 3.8 * PK, y = p.y + Math.cos(p.h) * s * 3.8 * PK;
          if (first) { c.moveTo(x, y); first = false; } else c.lineTo(x, y);
        });
        c.stroke();
      });
      c.lineCap = 'butt';
      /* 雨の日: 水たまり（周りより暗く、左上のふちだけ空が映って明るい） */
      if (L.wet) {
        [[350, 300, 70, 14], [610, 236, 60, 11], [520, 470, 60, 12], [1000, 480, 80, 14], [150, 420, 56, 10], [960, 222, 44, 9]].forEach(([x, y, w, h]) => {
          c.fillStyle = 'rgba(55,72,92,.22)';
          c.beginPath(); c.ellipse(x, y, w, h, 0, 0, TAU); c.fill();
          c.strokeStyle = 'rgba(220,235,250,.35)'; c.lineWidth = 1.2;
          c.beginPath(); c.ellipse(x, y, w - 1, h - 1, 0, Math.PI * 1.02, Math.PI * 1.62); c.stroke();
        });
      }
      /* エプロンのふち取り（白線） */
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(X0, 143); c.lineTo(X1, 143); c.stroke();

      /* --- 誘導路（タキシーウェイ）: 中心線は黄色の実線、ふちは黄色の2本線と青い誘導路灯 --- */
      const tw = c.createLinearGradient(0, 574, 0, 630);
      tw.addColorStop(0, L.taxi[0]); tw.addColorStop(1, L.taxi[1]);
      c.fillStyle = tw;
      c.fillRect(X0, 574, W, 56);
      c.fillStyle = L.shoulder;
      c.fillRect(X0, 630, W, 10);
      c.save();
      c.globalAlpha = 0.6;
      c.fillStyle = noise;
      c.fillRect(X0, 574, W, 66);
      c.restore();
      c.fillStyle = 'rgba(30,40,52,.18)';
      c.fillRect(X0, 574, W, 3);
      c.fillStyle = 'rgba(30,40,52,.10)';
      c.fillRect(X0, 630, W, 1.5);
      c.strokeStyle = L.yel; c.lineWidth = 1.3;
      c.beginPath();
      [578, 581, 623, 626].forEach((y) => { c.moveTo(X0, y); c.lineTo(X1, y); });
      c.stroke();
      c.strokeStyle = 'rgba(34,36,32,.28)'; c.lineWidth = 4.6;
      c.beginPath(); c.moveTo(X0, TAXI_Y); c.lineTo(X1, TAXI_Y); c.stroke();
      c.strokeStyle = L.yel; c.lineWidth = 2.6;
      c.beginPath(); c.moveTo(X0, TAXI_Y); c.lineTo(X1, TAXI_Y); c.stroke();
      const lamp = L.flood || L.name === 'storm';
      for (let x = X0 + 20; x < X1; x += 60) {
        [571.5, 633.5].forEach((y) => {
          if (lamp) {
            const gl = c.createRadialGradient(x, y, 0, x, y, 7);
            gl.addColorStop(0, 'rgba(90,150,255,.55)'); gl.addColorStop(1, 'rgba(90,150,255,0)');
            c.fillStyle = gl; c.beginPath(); c.arc(x, y, 7, 0, TAU); c.fill();
          }
          c.fillStyle = 'rgba(20,28,40,.35)'; c.beginPath(); c.arc(x + 0.6, y + 0.8, 1.9, 0, TAU); c.fill();
          c.fillStyle = '#2f6fd6'; c.beginPath(); c.arc(x, y, 1.8, 0, TAU); c.fill();
          c.fillStyle = 'rgba(235,245,255,.9)'; c.beginPath(); c.arc(x - 0.5, y - 0.5, 0.6, 0, TAU); c.fill();
        });
      }

      /* --- スタンドの誘導線（前輪の通り道）・停止線 ---
       * 誘導路のセンターラインから分かれ、左から入って機首を右に向けて止まる。黄色の線に黒いふち。 */
      const yel = L.yel;
      const lead = arrivalPaths().nose.filter((p) => p.s >= ARR_TAXI_L - 4);
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
      /* 停止線（A320の前輪が止まる位置）。胴体の幅より長くして、駐機中も機首の左右に見える */
      c.strokeStyle = 'rgba(34,36,32,.40)'; c.lineWidth = 5.5;
      c.beginPath(); c.moveTo(stopX, PLANE_CY - 29); c.lineTo(stopX, PLANE_CY + 29); c.stroke();
      c.strokeStyle = yel; c.lineWidth = 3;
      c.beginPath(); c.moveTo(stopX, PLANE_CY - 28); c.lineTo(stopX, PLANE_CY + 28); c.stroke();
      /* 搭乗橋の待機位置（駆動輪をとめる場所の白い枠） */
      c.save();
      c.translate(BRG.rot[0] + Math.cos(rad(BRG.parkAng)) * 37.6, BRG.rot[1] + Math.sin(rad(BRG.parkAng)) * 37.6);
      c.rotate(rad(BRG.parkAng));
      c.strokeStyle = 'rgba(255,255,255,.38)'; c.lineWidth = 1.2;
      c.strokeRect(-6, -17, 12, 34);
      c.restore();

      /* 制限区域ライン（赤の実線。白いふちで地面から浮かせる）: 駐機中の機体（翼端・尾翼・機首の車）をぐるりと囲む。
       * 機体が入ってくるまで、車や人はこの中に入らない。上の辺は搭乗橋の固定通路の下をくぐる */
      const E = ZONE.era;
      c.strokeStyle = 'rgba(255,255,255,.32)'; c.lineWidth = 4.4;
      this.rr(E.x0, E.y0, E.x1 - E.x0, E.y1 - E.y0, 26); c.stroke();
      c.strokeStyle = 'rgba(198,48,48,.80)'; c.lineWidth = 2.2;
      this.rr(E.x0, E.y0, E.x1 - E.x0, E.y1 - E.y0, 26); c.stroke();

      /* スタッフのまちあい（うっすら影つき） */
      const Z = ZONE.staff;
      c.fillStyle = `rgba(${L.shadowCol},${(0.16 * Math.min(1.2, shA)).toFixed(3)})`;
      this.rr(Z.x + 3 * shL, Z.y + 3 * shL, Z.w, Z.h, 8); c.fill();
      c.fillStyle = L.wet ? '#98a2ab' : '#aeb7be';
      this.rr(Z.x, Z.y, Z.w, Z.h, 8); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(Z.x + 2, Z.y + 1.5); c.lineTo(Z.x + Z.w - 2, Z.y + 1.5); c.stroke();
      c.strokeStyle = '#87919a'; c.lineWidth = 2; this.rr(Z.x, Z.y, Z.w, Z.h, 8); c.stroke();
      /* はたらく車のおきば（白い区切り線） */
      const V = ZONE.veh;
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2;
      [450, 552, 648, 742, 844, 948, 1046].forEach((x) => {
        c.beginPath(); c.moveTo(x, V.y); c.lineTo(x, V.y + V.h - 2); c.stroke();
      });

      /* エプロンにかぶせる色（くもり・雨は寒色、夕方は暖色）。区画・標示も同じ光の中に入れる */
      if (L.apronTint) {
        c.fillStyle = L.apronTint;
        c.fillRect(X0, 138, W, SCENE_H - 138);
      }

      /* 吹き流しのポール（本体はdrawSkyLifeで動かす） */
      c.strokeStyle = '#7c858e'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(1128, 188); c.lineTo(1128, 154); c.stroke();
      c.fillStyle = `rgba(${L.shadowCol},.18)`;
      c.beginPath(); c.ellipse(1131 + 6 * shL, 190 + 4 * shL, 8 * shL, 2, 0.5, 0, TAU); c.fill();

      /* 搭乗橋の固定通路（ターミナルからロタンダまで。動かないので背景に描く。光は左上→左の面が明るい） */
      const fx0 = BRG.x - 10, fy0 = 124, fy1 = BRG.rot[1] - BRG.rotR + 3;
      c.fillStyle = `rgba(16,26,40,${(0.17 * Math.min(1.2, shA)).toFixed(3)})`;
      c.fillRect(fx0 + 10 * shL, Math.max(fy0 + 14, 140), 20, fy1 + 14 * shL - Math.max(fy0 + 14, 140));
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

    /* 雲のスプライト（大小の円を重ね、上が白・下が少し青い。照明ごとに1回だけ作る） */
    cloudSprite(L) {
      this._clouds = this._clouds || {};
      if (this._clouds[L.name]) return this._clouds[L.name];
      const cv = document.createElement('canvas');
      cv.width = 280; cv.height = 104;
      const g = cv.getContext('2d');
      g.scale(2, 2);
      const top = { day: '#ffffff', overcast: '#f2f4f6', storm: '#a5afbb', rain: '#e6ebf0', dusk: '#fff0e2' }[L.name] || '#ffffff';
      const bot = { day: '#dfe9f1', overcast: '#cfd7df', storm: '#6f7987', rain: '#b9c4ce', dusk: '#e2a98e' }[L.name] || '#dfe9f1';
      const gr = g.createLinearGradient(0, 8, 0, 48);
      gr.addColorStop(0, top); gr.addColorStop(1, bot);
      g.fillStyle = gr;
      [[28, 34, 15], [50, 25, 19], [76, 27, 17], [100, 34, 13], [62, 37, 15], [40, 39, 11], [88, 40, 10]].forEach(([x, y, r]) => {
        g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      });
      g.fillRect(28, 34, 74, 15);
      this._clouds[L.name] = cv;
      return cv;
    },

    /* 動きのある背景要素（毎フレーム描画。数が少ないので軽い）。動きを減らす設定では止める */
    drawSkyLife(state) {
      const c = this.ctx, L = this.light;
      const T = reduceMotion() ? 0 : this.time;
      /* 遠くを飛ぶ飛行機（主翼と尾翼のある十字のシルエット・ひこうき雲つき） */
      const fpx = ((T * 26) % (SCENE_W + 420)) - 210, fy = 12.5;
      const dim = L.wet || L.name === 'storm';
      c.lineCap = 'round';
      c.strokeStyle = dim ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.7)';
      c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(fpx - 150, fy - 1.3); c.lineTo(fpx - 12, fy - 1.3); c.moveTo(fpx - 150, fy + 1.3); c.lineTo(fpx - 12, fy + 1.3); c.stroke();
      c.strokeStyle = dim ? 'rgba(255,255,255,.15)' : 'rgba(255,255,255,.28)';
      c.lineWidth = 4.5;
      c.beginPath(); c.moveTo(fpx - 195, fy); c.lineTo(fpx - 110, fy); c.stroke();
      c.lineCap = 'butt';
      c.fillStyle = L.name === 'dusk' ? '#5a5560' : dim ? '#dfe5ea' : '#ffffff';
      c.beginPath();
      c.moveTo(fpx + 9, fy);                                   // 機首
      c.lineTo(fpx + 6, fy - 0.9); c.lineTo(fpx + 1.5, fy - 0.9);
      c.lineTo(fpx - 2.5, fy - 7.5); c.lineTo(fpx - 4.5, fy - 7.5); c.lineTo(fpx - 2.5, fy - 0.9);   // 主翼（後退角）
      c.lineTo(fpx - 8, fy - 0.8); c.lineTo(fpx - 10.5, fy - 3.4); c.lineTo(fpx - 11.8, fy - 3.4); c.lineTo(fpx - 11, fy - 0.6);   // 水平尾翼
      c.lineTo(fpx - 11, fy + 0.6); c.lineTo(fpx - 11.8, fy + 3.4); c.lineTo(fpx - 10.5, fy + 3.4); c.lineTo(fpx - 8, fy + 0.8);
      c.lineTo(fpx - 2.5, fy + 0.9); c.lineTo(fpx - 4.5, fy + 7.5); c.lineTo(fpx - 2.5, fy + 7.5); c.lineTo(fpx + 1.5, fy + 0.9);
      c.lineTo(fpx + 6, fy + 0.9);
      c.closePath(); c.fill();
      /* 雲（スプライトを貼るだけ）。シーンの上のそと（縦長の画面で見える空）にも浮かべる */
      const cs = this.cloudSprite(L);
      const cl = (x, y, w) => c.drawImage(cs, x, y, w, w * (104 / 280));
      cl(200 + Math.sin(T * 0.08) * 24, 1, 54);
      cl(486 + Math.cos(T * 0.05) * 36, 4, 36);
      cl(750 + Math.cos(T * 0.06) * 30, 2, 46);
      const B = this.viewBounds && this.cw ? this.viewBounds() : null;
      if (B && B.y0 < 0) {
        cl(80 + Math.sin(T * 0.04) * 30, -96, 150);
        cl(560 + Math.cos(T * 0.03) * 40, -190, 210);
        cl(940 + Math.sin(T * 0.05) * 30, -74, 120);
        cl(330 + Math.cos(T * 0.045) * 30, -300, 180);
      }
      /* 屋根の旗（ぱたぱた。根元が少し暗い） */
      [508, 548, 588].forEach((fx, i) => {
        const wave = Math.sin(T * 3 + i * 1.1) * 3;
        c.strokeStyle = '#8496a8'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(fx, 30); c.lineTo(fx, 13); c.stroke();
        const col = ['#e2711d', '#0f8fb0', '#2f9e63'][i];
        const fg = c.createLinearGradient(fx, 0, fx + 15, 0);
        fg.addColorStop(0, 'rgba(0,0,0,.22)'); fg.addColorStop(0.35, 'rgba(0,0,0,0)');
        c.fillStyle = col;
        c.beginPath();
        c.moveTo(fx, 13); c.lineTo(fx + 15, 16 + wave); c.lineTo(fx, 21);
        c.closePath(); c.fill();
        c.fillStyle = fg; c.fill();
      });
      /* 管制塔のランプ点滅 */
      c.fillStyle = `rgba(255,86,86,${(0.4 + 0.6 * Math.abs(Math.sin(T * 2.4))).toFixed(3)})`;
      c.beginPath(); c.arc(1094, 16, 3.2, 0, TAU); c.fill();
      /* 吹き流し（先細りの円すいを、オレンジと白の5本の帯で） */
      const flap = Math.sin(T * 2.2) * 2.6;
      const sx = 1128, sy = 154, len = 30;
      const pt = (f, side) => {
        const r = 5.2 - f * 2.4;                          // 先へいくほど細い
        const cx = sx + f * len, cy = sy + 4.5 + f * 2.5 + Math.sin(f * 2.4) * flap;
        return [cx, cy + side * r];
      };
      for (let i = 0; i < 5; i++) {
        const f0 = i / 5, f1 = (i + 1) / 5;
        const a = pt(f0, -1), b = pt(f1, -1), d = pt(f1, 1), e = pt(f0, 1);
        c.fillStyle = i % 2 ? '#f4f6f8' : '#e2711d';
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineTo(d[0], d[1]); c.lineTo(e[0], e[1]); c.closePath(); c.fill();
      }
      /* 下半分の陰（円すいの丸み） */
      c.fillStyle = 'rgba(40,40,50,.18)';
      c.beginPath();
      const p0 = pt(0, 0), p1 = pt(1, 0), q1 = pt(1, 1), q0 = pt(0, 1);
      c.moveTo(p0[0], p0[1]); c.lineTo(p1[0], p1[1]); c.lineTo(q1[0], q1[1]); c.lineTo(q0[0], q0[1]); c.closePath(); c.fill();
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
      /* プッシュバック: 機首のトーイングカーが、うしろ向きに押して誘導路まで下げる（しっぽをふって向きを変える）。
       * 速さは「ゆっくり押しはじめ → 一定 → ゆっくり止まる」の台形（いちばん速いときを平均の約1.2倍におさえる） */
      if (push.status === 'active' || push.status === 'done') {
        const trap = (t) => {
          const a = 0.18, v = 1 / (1 - a);
          if (t < a) return (v * t * t) / (2 * a);
          if (t > 1 - a) { const u = 1 - t; return 1 - (v * u * u) / (2 * a); }
          return v * (t - a / 2);
        };
        const p = push.status === 'done' ? 1 : trap(clamp(push.progress / G.effDur(push), 0, 1));
        const path = pushPath();
        const q = poseAt(path, path[path.length - 1].s * p);
        pose = { x: q.x, y: q.y, h: q.h - Math.PI };   // うしろ向きに進むので、機首は進む向きの反対
      }
      /* 出発: 誘導路を左へ走り去る（ゆっくり動き出して加速） */
      if (dep.status === 'active' || dep.status === 'done') {
        const p = dep.status === 'done' ? 1 : clamp(dep.progress / G.effDur(dep), 0, 1);
        const path = departPath();
        pose = poseAt(path, path[path.length - 1].s * p * p);
        alpha = p > 0.8 ? clamp(1 - (p - 0.8) / 0.18, 0, 1) : 1;
      }
      return out(pose, alpha);
    },

    /* ============ 機体（上から見たA320） ============
     * 形・塗装・陰影・パネルライン・窓・航行灯は、オフスクリーンに高解像度で1回だけ描いてキャッシュする。
     * 毎フレームは「影・機体の絵を回して貼る」「ドアの開閉」「衝突防止灯の点滅」だけを描く。
     * 光源は画面の左上で固定。機体が向きを変えると光の当たる側が変わるので、絵は2通りキャッシュする:
     *   lit=-1 … 機体の左側（ポート）が光の側（駐機中・到着・プッシュバックの前半）
     *   lit=+1 … 機体の右側（スターボード）が光の側（プッシュバックの終わり〜出発で、機首が左を向いたとき） */
    planeSprites(state, lit) {
      const wet = !!this.light.wet;
      const L = lit > 0 ? 1 : -1;
      /* 解像度: 最大ズーム(2.6倍)×devicePixelRatio に合わせて2〜6倍 */
      const q = clamp(Math.ceil(this.baseScale() * this.dpr * 2.6 - 0.15), 2, 6);
      const key = q + '|' + (wet ? 1 : 0);
      const G = planeGeometry();
      const mk = (w, h) => { const cv = document.createElement('canvas'); cv.width = Math.ceil(w); cv.height = Math.ceil(h); return cv; };
      if (!this._plane || this._plane.key !== key) {
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
        this._plane = { key, body: {}, shadow: soft(G.silhouette, 6), ao: soft(G.aoShape, 3.5) };
      }
      const P = this._plane;
      if (!P.body[L]) {
        /* 右側が光の向き（出発のときだけ使う）は、動いている機体なので解像度をひかえめに */
        const qq = L > 0 ? Math.min(q, 4) : q;
        const body = mk(SPR.w * qq, SPR.h * qq);
        const g = body.getContext('2d');
        g.setTransform(qq, 0, 0, qq, -SPR.x0 * qq, -SPR.y0 * qq);
        this.renderPlaneBody(g, G, wet, L);
        P.body[L] = body;
      }
      return { body: P.body[L], shadow: P.shadow, ao: P.ao };
    },

    /* 機体の静的な部分を描く。g は機体ローカル座標（主脚が原点・機首が+x・右主翼が+y）。
     * L=-1: 光は機体の左うしろ（駐機中の画面の左上）から。L=+1: 右まえから（機首が左を向いたとき）。
     * 光の側のふちが明るく、反対側のふちと、反対側の主翼のつけ根に胴体の陰。 */
    renderPlaneBody(g, G, wet, L) {
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
      const rrg = (x, y, w, h, r) => {
        g.beginPath();
        g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
      };
      /* 光の側（y0側 or y1側）から陰の側へのグラデーション */
      const vgrad = (y0, y1, stops) => {
        const gr = L < 0 ? g.createLinearGradient(0, y0, 0, y1) : g.createLinearGradient(0, y1, 0, y0);
        stops.forEach(([o, col]) => gr.addColorStop(o, col));
        return gr;
      };
      const lit = (s) => s === L;            // 光の側の翼・面か
      const SHX = -L * 6, SHY = -L * 8.5;      // 胴体が翼に落とす影のずれ（光と反対の向き）
      const fusShade = () => { g.save(); g.translate(SHX, SHY); g.fillStyle = 'rgba(28,42,60,.22)'; g.fill(G.fusP); g.restore(); };
      const teH = (v) => 35.48 + (Math.abs(v) - 0.5) * (1.52 / 5.72);   // 水平尾翼の後縁（uの位置）

      /* 1) 主脚のタイヤと接地の陰（AO）。主翼のつけ根の後縁から少しだけ見える */
      [1, -1].forEach((s) => {
        const [ax, ay] = P(19.1, s * 3.8);
        const ao = g.createRadialGradient(ax, ay, 0.1 * PK, ax, ay, 1.45 * PK);
        ao.addColorStop(0, 'rgba(16,22,30,.55)'); ao.addColorStop(1, 'rgba(16,22,30,0)');
        g.fillStyle = ao;
        g.beginPath(); g.ellipse(ax, ay, 1.45 * PK, 1.05 * PK, 0, 0, TAU); g.fill();
        [3.33, 4.26].forEach((wv) => {
          const x0 = X(19.42), w = 1.12 * PK, y0 = Y(s * wv - 0.18), h = 0.36 * PK;
          g.fillStyle = '#20262c'; rrg(x0, y0, w, h, 0.16 * PK); g.fill();
          g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(x0 + 0.2 * PK, L < 0 ? y0 + 0.3 : y0 + h - 0.9, w - 0.4 * PK, 0.6);
          g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 0.28;     // タイヤのみぞ
          g.beginPath();
          for (let tu = 19.05; tu < 19.42; tu += 0.1) { g.moveTo(X(tu), y0 + 0.4); g.lineTo(X(tu), y0 + h - 0.4); }
          g.stroke();
        });
      });

      /* 2) フラップのレールの覆い（翼の下から後ろへ飛び出した、丸いカヌー形の部分だけ見える） */
      G.fairings.forEach(([fv, fw, fl]) => [1, -1].forEach((s) => {
        const te = wingTE(fv), u0 = te - 1.4, ue = te + fl, yc = s * fv;
        g.beginPath();
        g.moveTo(X(u0), Y(yc - fw / 2));
        g.lineTo(X(ue - fl * 0.55), Y(yc - fw / 2));
        g.quadraticCurveTo(X(ue), Y(yc - fw * 0.3), X(ue), Y(yc));
        g.quadraticCurveTo(X(ue), Y(yc + fw * 0.3), X(ue - fl * 0.55), Y(yc + fw / 2));
        g.lineTo(X(u0), Y(yc + fw / 2));
        g.closePath();
        g.fillStyle = vgrad(Y(yc - fw / 2), Y(yc + fw / 2), [[0, '#e2e7ec'], [1, '#9ca8b3']]);
        g.fill();
        g.strokeStyle = 'rgba(74,88,104,.62)'; g.lineWidth = 0.37; g.stroke();
      }));

      /* 3) エンジン（主翼より下にあるので先に描く。前半が翼の前に出て見える） */
      [1, -1].forEach((s) => {
        const vc = s * ENG_V, path = G.nacP[s];
        g.fillStyle = '#59636e'; g.fill(toPath(G.plug(s)));      // 排気コーン（上からは翼にかくれる）
        g.fillStyle = vgrad(Y(vc - 1.05), Y(vc + 1.05), [[0, '#d7dee5'], [0.22, '#fbfcfd'], [0.5, '#edf1f4'], [0.8, '#bdc6cf'], [1, '#9ca7b2']]);
        g.fill(path);
        g.save(); g.clip(path);
        g.fillStyle = '#2f7fc4';                                   // ファンカウルの青い帯（あおぞら航空の塗装）
        g.fillRect(X(12.28), Y(vc - 1.2), X(11.92) - X(12.28), PY(2.4));
        g.fillStyle = 'rgba(255,255,255,.18)';                     // 帯にも円筒の光
        g.fillRect(X(12.28), Y(vc + L * 0.75) - PY(0.3), X(11.92) - X(12.28), PY(0.6));
        seg([[P(13.75, vc - 1.1), P(13.75, vc + 1.1)]], 'rgba(80,96,112,.35)', 0.37);   // 逆噴射装置の継ぎ目
        g.restore();
        strokeP(path, LINE, 0.6);
        /* 吸気口（前から少しのぞいた楕円）: みがいた金属の唇 → 暗い内側 → ファンブレード → スピナー */
        const ix = X(11.5), iy = Y(vc);
        g.fillStyle = '#e2e7eb';
        g.beginPath(); g.ellipse(ix, iy, 0.24 * PK, 0.9 * PK, 0, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(60,72,86,.6)'; g.lineWidth = 0.32; g.stroke();
        const fx = X(11.52);
        g.fillStyle = '#1b222a';
        g.beginPath(); g.ellipse(fx, iy, 0.16 * PK, 0.76 * PK, 0, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(130,145,160,.5)'; g.lineWidth = 0.23;
        g.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * TAU;
          g.moveTo(fx + Math.cos(a) * 0.04 * PK, iy + Math.sin(a) * 0.2 * PK);
          g.lineTo(fx + Math.cos(a) * 0.14 * PK, iy + Math.sin(a) * 0.7 * PK);
        }
        g.stroke();
        g.fillStyle = '#c9d1d8';
        g.beginPath(); g.ellipse(X(11.51), iy, 0.06 * PK, 0.2 * PK, 0, 0, TAU); g.fill();
        /* パイロン（主翼から吊る柱） */
        const py = toPath(G.pylon(s));
        g.fillStyle = '#cdd4da'; g.fill(py);
        strokeP(py, 'rgba(70,86,104,.5)', 0.45);
        seg([[P(12.35, vc + 0.1 * L), P(15.1, vc + 0.1 * L)]], 'rgba(255,255,255,.7)', 0.4);
      });

      /* 4) 主翼 */
      const hinge = (v) => wingTE(v) - (0.25 * (wingTE(v) - wingLE(v)) + 0.15);
      [1, -1].forEach((s) => {
        const path = G.wingP[s];
        g.fillStyle = lit(-s) ? '#dbe1e6' : '#d1d8de';   // 上反角: 光と反対側の翼は、面が少し光のほうへ向く
        g.fill(path);
        g.save(); g.clip(path);
        /* 翼型のふくらみのハイライト（前縁から2〜4割） */
        const hi = [], lo = [];
        for (let v = 1.0; v <= W_TIP + 0.01; v += 0.5) {
          const le = v < 1.98 ? W_LE0 : wingLE(v), ch = wingTE(v) - le;
          hi.push(P(le + ch * 0.16, s * v)); lo.push(P(le + ch * 0.42, s * v));
        }
        fillP(hi.concat(lo.reverse()), 'rgba(255,255,255,.3)');
        /* 前縁のまるみ（前を向く面は、光がうしろからのときは少し暗い） */
        const le1 = [], le2 = [];
        for (let v = 1.0; v <= W_TIP + 0.01; v += 0.5) {
          const le = v < 1.98 ? W_LE0 : wingLE(v);
          le1.push(P(le - 0.2, s * v)); le2.push(P(le + 0.35, s * v));
        }
        fillP(le1.concat(le2.reverse()), L < 0 ? 'rgba(80,96,112,.10)' : 'rgba(255,255,255,.22)');
        /* 後縁の動翼（フラップ・補助翼）は少し暗い */
        const fl = [], te = [];
        for (let v = 1.0; v <= 16.31; v += 0.5) { fl.push(P(hinge(v), s * v)); te.push(P(wingTE(v) + 0.3, s * v)); }
        fillP(fl.concat(te.reverse()), 'rgba(70,86,102,.09)');
        if (lit(-s)) fusShade();                     // 胴体の落とす影（光と反対側の翼のつけ根）
        g.restore();
        /* 線: スラット・ヒンジ・スポイラー */
        const Ls = [];
        [[2.3, 5.35], [6.15, 8.6], [8.6, 11.2], [11.2, 13.9], [13.9, 16.9]].forEach(([a, b]) => {
          Ls.push([P(wingLE(a) + 0.55, s * a), P(wingLE(b) + 0.55, s * b)]);
          Ls.push([P(wingLE(a), s * a), P(wingLE(a) + 0.55, s * a)]);
        });
        for (let v = 1.98; v < 16.3; v += 0.5) {
          const v2 = Math.min(16.3, v + 0.5);
          Ls.push([P(hinge(v), s * v), P(hinge(v2), s * v2)]);
        }
        [6.3, 12.4, 16.3].forEach((v) => Ls.push([P(hinge(v), s * v), P(wingTE(v), s * v)]));
        [[3.0, 5.1], [6.6, 12.2]].forEach(([a, b]) => {
          for (let v = a; v < b - 0.01; v += 0.5) {
            const v2 = Math.min(b, v + 0.5);
            Ls.push([P(hinge(v) - 0.9, s * v), P(hinge(v2) - 0.9, s * v2)]);
          }
        });
        [3.0, 5.1, 6.6, 8.0, 9.4, 10.8, 12.2].forEach((v) => Ls.push([P(hinge(v) - 0.9, s * v), P(hinge(v), s * v)]));
        seg(Ls, 'rgba(70,86,104,.36)', 0.45);
        /* 歩いてよい場所の線（ウォークウェイ。非常口から翼の上へ） */
        g.strokeStyle = 'rgba(38,48,60,.34)'; g.lineWidth = 0.46; g.beginPath();
        [P(14.3, s * 2.0), P(15.2, s * 3.9), P(16.4, s * 3.9), P(16.4, s * 2.0)].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
        strokeP(path, LINE, 0.6);
        /* 静電放電索（後縁の細いひげ。かみなりなどでたまった電気を空気へにがす） */
        seg([14.6, 15.6, 16.5].map((v) => [P(wingTE(v) - 0.02, s * v), P(wingTE(v) + 0.3, s * (v + 0.04))]), 'rgba(56,66,78,.7)', 0.28);
      });

      /* 5) シャークレット（翼端の上向きの小翼。あおぞら航空の青。外側の面は光の側が明るい） */
      [1, -1].forEach((s) => {
        const pts = G.shark(s);
        fillP(pts, lit(s) ? '#4a94d5' : '#22659c');
        strokeP(toPath(pts), 'rgba(16,46,80,.65)', 0.5);
      });

      /* 6) 水平尾翼 */
      [1, -1].forEach((s) => {
        const path = G.hstabP[s];
        g.fillStyle = lit(-s) ? '#d9dfe4' : '#d0d7dd';
        g.fill(path);
        g.save(); g.clip(path);
        fillP([P(32.3, s * 0.5), P(35.95, s * 6.22), P(36.3, s * 6.22), P(33.2, s * 0.5)], 'rgba(255,255,255,.26)');
        if (lit(-s)) fusShade();
        g.restore();
        seg([[P(34.43, s * 0.6), P(36.6, s * 6.05)]], 'rgba(70,86,104,.42)', 0.45);   // 昇降舵のヒンジ
        strokeP(path, LINE, 0.6);
        seg([5.3, 6.0].map((v) => [P(teH(v) - 0.02, s * v), P(teH(v) + 0.3, s * (v + 0.03))]), 'rgba(56,66,78,.7)', 0.28);   // 放電索
      });

      /* 7) 主翼のつけ根のフェアリング */
      fillP(G.rootFair, '#dde2e7');
      strokeP(toPath(G.rootFair), 'rgba(70,86,104,.35)', 0.5);

      /* 8) 胴体（白い円筒。光の側のふちが明るく、反対のふちに陰） */
      const fp = G.fusP;
      g.fillStyle = vgrad(-R, R, [[0, '#dde4ea'], [0.12, '#f3f6f8'], [0.24, '#ffffff'], [0.45, '#f7f9fa'], [0.68, '#e6ebef'], [0.86, '#cdd5dc'], [1, '#b2bcc6']]);
      g.fill(fp);
      g.save(); g.clip(fp);
      /* 尾部の青（垂直尾翼のつけ根をつつむ、やりの穂先の形の塗装。長さは尾翼のつけ根の翼弦と同じくらい。
       * うしろのテールコーンは白のまま → 細い垂直尾翼の形が見分けられる） */
      const U0 = 29.8, U1 = 36.8, tw = (u) => 1.3 * Math.pow(Math.max(0, Math.sin((Math.PI * (u - U0)) / (U1 - U0))), 0.8);
      const tb = [];
      for (let u = U0; u <= U1 + 0.001; u += 0.2) tb.push(P(u, -tw(u)));
      for (let u = U1; u >= U0 - 0.001; u -= 0.2) tb.push(P(u, tw(u)));
      fillP(tb, vgrad(-PY(1.3), PY(1.3), [[0, '#58a2df'], [0.5, '#2f7fc4'], [1, '#2368a6']]));
      /* 尾部のマーク（あおぞら航空: 白い風のカーブと黄色い太陽。文字は使わない。実在の会社には似せない） */
      [-1, 1].forEach((s) => {
        g.fillStyle = 'rgba(255,255,255,.95)';
        g.beginPath();
        g.moveTo(...P(30.8, s * 0.36));
        g.quadraticCurveTo(...P(32.8, s * 0.95), ...P(34.7, s * 0.84));
        g.quadraticCurveTo(...P(32.8, s * 0.6), ...P(30.8, s * 0.36));
        g.fill();
        g.fillStyle = '#ffd24a';
        g.beginPath(); g.arc(...P(33.3, s * 1.07), 0.2 * PK, 0, TAU); g.fill();
      });
      /* APUの排気口のまわり（テールコーンの先）は少しくすむ */
      fillP([P(36.9, -0.5), P(38, -0.5), P(38, 0.5), P(36.9, 0.5)], 'rgba(120,132,146,.18)');
      /* レドーム（機首の先）はわずかに色がちがう */
      fillP([P(-0.5, -2), P(1.9, -2), P(1.9, 2), P(-0.5, 2)], 'rgba(150,162,174,.12)');
      seg([[P(1.9, -fusHW(1.9)), P(1.9, fusHW(1.9))]], 'rgba(100,115,130,.4)', 0.5);
      if (L < 0) {
        /* 機首の先は光から背を向ける → 少し暗い */
        const nd = g.createRadialGradient(X(0), 0, 0, X(0), 0, PY(3.2));
        nd.addColorStop(0, 'rgba(58,74,92,.22)'); nd.addColorStop(1, 'rgba(58,74,92,0)');
        g.fillStyle = nd; g.fillRect(X(3.3), -R, PY(3.4), 2 * R);
      } else {
        /* 光が前から来るときは、テールコーンが背を向けて少し暗い */
        const td = g.createLinearGradient(X(31), 0, X(37.6), 0);
        td.addColorStop(0, 'rgba(50,70,92,0)'); td.addColorStop(1, 'rgba(50,70,92,.2)');
        g.fillStyle = td; g.fillRect(X(37.8), -R, X(31) - X(37.8), 2 * R);
      }
      /* つやのハイライト（光の側に寄せて細く） */
      g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(X(4.5), L * 0.5 * R); g.lineTo(X(28.4), L * 0.5 * R); g.stroke();
      /* パネルのつなぎ目（ごく薄く） */
      const pl = [];
      [6.5, 10.6, 13.2, 21.8, 26.0, 28.6, 33.0].forEach((u) => pl.push([P(u, -fusHW(u)), P(u, fusHW(u))]));
      pl.push([P(3.2, -0.42 * FUS_R), P(29.5, -0.42 * FUS_R)], [P(3.2, 0.42 * FUS_R), P(29.5, 0.42 * FUS_R)]);
      seg(pl, 'rgba(108,124,140,.17)', 0.45);
      /* 窓の列（両側のふち）。光の側は空が映ってやや明るい */
      [-1, 1].forEach((s) => {
        g.fillStyle = lit(s) ? 'rgba(52,68,84,.85)' : 'rgba(34,44,56,.9)';
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
      /* コックピットの窓（左右それぞれ3枚: 前の風防・開くスライド窓・うしろの固定窓。A320の実機どおり） */
      const glass = (pts) => {
        const q = pts.map(([u, v]) => P(u, v));
        const path = toPath(q);
        const gg = g.createLinearGradient(q[0][0], q[0][1], q[2][0], q[2][1]);
        gg.addColorStop(0, '#5a7690'); gg.addColorStop(0.45, '#26384a'); gg.addColorStop(1, '#18232f');
        g.fillStyle = gg; g.fill(path);
        strokeP(path, 'rgba(214,222,230,.9)', 0.64);
      };
      [1, -1].forEach((s) => {
        glass([[2.28, 0.08 * s], [2.5, 0.9 * s], [3.2, 1.1 * s], [3.32, 0.08 * s]]);
        glass([[3.4, 1.2 * s], [3.44, 1.47 * s], [4.0, 1.62 * s], [3.97, 1.3 * s]]);
        glass([[4.1, 1.38 * s], [4.13, 1.66 * s], [4.6, 1.75 * s], [4.58, 1.46 * s]]);
      });
      seg([[P(2.47, L * 0.72), P(2.92, L * 0.2)]], 'rgba(200,226,246,.55)', 0.8);   // 風防に映る空
      /* ピトー管（機首の左右の小さな突起） */
      seg([2.8, 3.15].flatMap((u) => [-1, 1].map((s) => [P(u, s * fusHW(u)), P(u + 0.06, s * (fusHW(u) + 0.2))])), '#7b8590', 0.46);
      /* アンテナ・衝突防止灯の台座 */
      g.fillStyle = '#56616d';
      [[6.2, 0, 0.5], [13.9, 0.35, 0.4], [21.4, 0, 0.5], [23.6, -0.3, 0.35]].forEach(([u, v, l]) => g.fillRect(X(u + l / 2), Y(v) - 0.45, PY(l), 0.9));
      g.fillStyle = '#7d3b3b'; g.beginPath(); g.arc(X(16.8), 0, 1.3, 0, TAU); g.fill();
      /* ふちの陰（円筒のまるみ） */
      g.strokeStyle = 'rgba(52,68,86,.18)'; g.lineWidth = 3.4; g.stroke(fp);
      g.restore();
      strokeP(fp, 'rgba(66,82,100,.62)', 0.7);

      /* 9) 垂直尾翼の影（胴体と、光と反対側の水平尾翼に落ちる）と垂直尾翼 */
      const clipU = new Path2D();
      toPath(G.fus, clipU); toPath(G.hstab(-L), clipU);
      g.save(); g.clip(clipU);
      fillP([[X(28.7), 0], [X(35.3), -L * PY(0.3)], [X(37.3) - L * 14.4, -L * 19.8], [X(34.8) - L * 14.4, -L * 19.8]], 'rgba(28,42,60,.2)');
      g.restore();
      /* 垂直尾翼は紺色の細い刃。光の側の面が明るく、上のふちにハイライト */
      g.fillStyle = vgrad(-PY(0.33), PY(0.33), [[0, '#5d9ad3'], [0.42, '#21558f'], [1, '#0f2f57']]);
      g.fill(G.finP);
      seg([[P(29.9, L * 0.06), P(37.3, L * 0.03)]], 'rgba(214,234,250,.75)', 0.5);   // 尾翼のてっぺんのふち
      seg([[P(34.8, -0.24), P(34.8, 0.24)]], 'rgba(8,26,50,.7)', 0.4);   // 方向舵のつなぎ目
      strokeP(G.finP, 'rgba(8,26,50,.85)', 0.5);

      /* 10) 航行灯（左翼端=赤・右翼端=緑・尾=白） */
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

    drawPlane(state, trIn) {
      const c = this.ctx;
      const tr = trIn || this.planeTransform(state);
      if (tr.alpha <= 0) return;
      /* 光（左上）が機体の右側(+)・左側(-)のどちらから来るか。0をまたぐところで2枚の絵をなめらかに入れかえる */
      const side = 0.7071 * (Math.sin(tr.rot) - Math.cos(tr.rot));
      const k = clamp((side + 0.22) / 0.44, 0, 1), wR = k * k * (3 - 2 * k);
      const push = state.tasks.pushback.status;
      if (push === 'active' || push === 'done') this.planeSprites(state, 1);   // 向きが変わる前に用意しておく
      const spr = this.planeSprites(state, -1);
      const Lt = this.light;
      const px = PIVOT_X + tr.x, py = PLANE_CY + tr.y;
      const cos = Math.cos(tr.rot), sin = Math.sin(tr.rot);
      const W = (x, y, ox, oy) => [px + x * cos - y * sin + ox, py + x * sin + y * cos + oy];
      const beacon = this.beaconLevel(state);
      const B = SPR_SH;
      const sA = Lt.shadowA, sL = Lt.shadowL;
      c.save();
      /* 落ち影: 光源=左上 → 世界の右下へずらす（機体が向きを変えても影の向きは同じ）。濃さ・長さは照明のプリセットで */
      c.globalAlpha = tr.alpha * clamp(0.27 * sA, 0, 0.4);
      c.save(); c.translate(px + 8 * sL, py + 11 * sL); c.rotate(tr.rot);
      c.drawImage(spr.shadow, SPR.x0 - B, SPR.y0 - B, SPR.w + 2 * B, SPR.h + 2 * B);
      c.restore();
      /* 垂直尾翼の影: 背が高い（約12m）ので、先のほうほど遠くへ落ちる */
      c.globalAlpha = tr.alpha * clamp(sA, 0, 1.2);
      c.fillStyle = 'rgba(16,26,40,.075)';
      [[0, 0], [1.3, 1.3], [-1.3, -1.3]].forEach(([dx, dy]) => {
        c.fill(toPath([
          W(PX(28.7), 0, 8.8 * sL + dx, 12.1 * sL + dy), W(PX(35.3), 0, 8.8 * sL + dx, 12.1 * sL + dy),
          W(PX(37.3), 0, 23.6 * sL + dx, 32.5 * sL + dy), W(PX(34.8), 0, 23.6 * sL + dx, 32.5 * sL + dy),
        ]));
      });
      /* 接地の陰（胴体とエンジンの真下） */
      c.globalAlpha = tr.alpha * (Lt.wet ? 0.3 : 0.38);
      c.save(); c.translate(px + 1.5, py + 2.5); c.rotate(tr.rot);
      c.drawImage(spr.ao, SPR.x0 - B, SPR.y0 - B, SPR.w + 2 * B, SPR.h + 2 * B);
      c.restore();
      /* 下面の衝突防止灯が地面を赤く照らす（灯っているときだけ） */
      if (beacon > 0.02) {
        c.globalAlpha = tr.alpha;
        const [gx, gy] = W(PX(15.5), 0, 0, 0);
        const rg = c.createRadialGradient(gx, gy, 0, gx, gy, 44);
        rg.addColorStop(0, `rgba(255,70,60,${(0.24 * beacon).toFixed(3)})`);
        rg.addColorStop(1, 'rgba(255,70,60,0)');
        c.fillStyle = rg; c.beginPath(); c.arc(gx, gy, 44, 0, TAU); c.fill();
      }
      /* 機体（キャッシュした絵を回して貼る） */
      c.globalAlpha = tr.alpha;
      c.translate(px, py); c.rotate(tr.rot);
      if (wR < 0.999) c.drawImage(spr.body, SPR.x0, SPR.y0, SPR.w, SPR.h);
      if (wR > 0.001) {
        c.globalAlpha = tr.alpha * (wR < 0.999 ? wR : 1);
        c.drawImage(this.planeSprites(state, 1).body, SPR.x0, SPR.y0, SPR.w, SPR.h);
        c.globalAlpha = tr.alpha;
      }
      this.drawCabinLights(state);
      this.drawPlaneDoors(state);
      this.drawPlaneLights(state, beacon);
      c.restore();
    },

    /* 衝突防止灯の明るさ（0..1）。ドアクローズがおわってから、またはプッシュバック・出発のあいだだけ点滅する
     * （「もうすぐ動くよ」の合図）。動きを減らす設定では点いたまま */
    beaconLevel(state) {
      const t = state.tasks;
      const on = t.doorclose.status === 'done' || t.pushback.status === 'active' || t.pushback.status === 'done' || t.depart.status === 'active';
      if (!on) return 0;
      if (reduceMotion()) return 0.85;
      const f = (this.time * 1.15) % 1;
      return f < 0.12 ? 1 : f < 0.22 ? 1 - (f - 0.12) / 0.1 : 0;
    },
    /* 機体の灯火（機体ローカル座標）: 上面の衝突防止灯（消えているときは暗い赤の小さい点）と、
     * 出発中だけ翼端・尾端の白いストロボ（2回ずつ光る）。航法灯（左翼=赤・右翼=緑）は機体の絵にある */
    drawPlaneLights(state, beacon) {
      const c = this.ctx;
      const bx = PX(16.8);
      if (beacon > 0.02) {
        const bg = c.createRadialGradient(bx, 0, 0, bx, 0, 7);
        bg.addColorStop(0, `rgba(255,86,72,${(beacon * 0.6).toFixed(3)})`);
        bg.addColorStop(1, 'rgba(255,86,72,0)');
        c.fillStyle = bg; c.beginPath(); c.arc(bx, 0, 7, 0, TAU); c.fill();
      }
      c.fillStyle = beacon > 0.02 ? `rgba(255,66,58,${(0.35 + 0.65 * beacon).toFixed(3)})` : '#7a2b2b';
      c.beginPath(); c.arc(bx, 0, 1.4, 0, TAU); c.fill();
      if (state.tasks.depart.status === 'active' && !reduceMotion()) {
        const f = (this.time * 0.9) % 1;
        const fl = (f < 0.05 || (f > 0.13 && f < 0.18)) ? 1 : 0;
        if (fl) {
          [[PX(20.9), -PY(17.2)], [PX(20.9), PY(17.2)], [PX(37.75), 0]].forEach(([x, y]) => {
            const sg = c.createRadialGradient(x, y, 0, x, y, 9);
            sg.addColorStop(0, 'rgba(255,255,255,.95)'); sg.addColorStop(0.3, 'rgba(235,245,255,.5)'); sg.addColorStop(1, 'rgba(235,245,255,0)');
            c.fillStyle = sg; c.beginPath(); c.arc(x, y, 9, 0, TAU); c.fill();
          });
        }
      }
    },
    /* 機内清掃のあいだ: 客室の窓に、前から順に明かりがつく（清掃の進み具合）。点滅はしない */
    drawCabinLights(state) {
      const t = state.tasks.clean;
      if (t.status !== 'active') return;
      const p = clamp(t.progress / window.Game.effDur(t), 0, 1);
      const W = CABIN_WIN, c = this.ctx;
      c.fillStyle = '#f3dca6';
      c.beginPath();
      for (let u = W.u0; u <= W.u1; u += W.step) {
        if (u > W.gap[0] && u < W.gap[1]) continue;
        if ((u - W.u0) / (W.u1 - W.u0) > p) break;
        [-1, 1].forEach((s) => c.rect(PX(u) - 1.2, s * fusHW(u) * PK * W.v - 0.8, 2.4, 1.6));
      }
      c.fill();
    },

    /* ドアの開閉（機体ローカル座標で描く） */
    drawPlaneDoors(state) {
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
    },

    /* 開いた貨物ドアの扉（上へはね上がる）。ベルトローダーの先より上にあるので、車両のあとに描く */
    drawPlaneOverlay(state, trIn) {
      const t = state.tasks;
      const fwd = t.unload.status === 'active', aft = t.load.status === 'active';
      if (!fwd && !aft) return;
      const c = this.ctx, tr = trIn || this.planeTransform(state);
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

    /* 搭乗橋の動く部分の形（ロタンダ → 3段にのびちぢみする通路 → キャブ）。固定通路は背景にある */
    bridgeParts() {
      const B = this.bridgeGeom(this.bridge);
      const s0 = BRG.rotR - 2;
      return { B, s0, len: B.L - s0, sects: [[0, 0.42, 16], [0.32, 0.74, 18], [0.64, 1, 20]] };
    },
    /* 搭乗橋の影（高さ約5m → 右下へずらす）。機体より先に描くので、胴体にかかる所は機体の下にかくれる */
    drawBridgeShadow() {
      const c = this.ctx, Lt = this.light, P = this.bridgeParts(), B = P.B;
      const ox = 10 * Lt.shadowL, oy = 14 * Lt.shadowL;
      const sh = new Path2D();
      toPath(boxPts(B.rx + ox, B.ry + oy, B.a, P.s0, B.L, -10, 10), sh);
      toPath(boxPts(B.ex + ox, B.ey + oy, B.phi, -1, 24, -15, 15), sh);
      sh.moveTo(B.rx + ox + BRG.rotR, B.ry + oy); sh.arc(B.rx + ox, B.ry + oy, BRG.rotR, 0, TAU);
      c.fillStyle = `rgba(16,26,40,${clamp(0.17 * Lt.shadowA, 0, 0.24).toFixed(3)})`;
      c.fill(sh);
      /* 駆動輪の脚の影（地面に立つ柱） */
      const wx = P.s0 + P.len * 0.6, wp = [B.rx + Math.cos(B.a) * wx, B.ry + Math.sin(B.a) * wx];
      c.fillStyle = `rgba(16,26,40,${clamp(0.2 * Lt.shadowA, 0, 0.28).toFixed(3)})`;
      c.beginPath(); c.ellipse(wp[0] + 4 * Lt.shadowL, wp[1] + 5 * Lt.shadowL, 8 * Lt.shadowL, 3, rad(56), 0, TAU); c.fill();
    },
    /* 搭乗橋の床（駆動輪・通路・キャブ・ロタンダ）。この上に中の人と乗客を描き、最後にガラスの屋根をかぶせる */
    drawBridge() {
      const c = this.ctx, P = this.bridgeParts(), B = P.B;
      const lit = Math.sin(B.a) - Math.cos(B.a) >= 0 ? 1 : -1;   // 通路の +y 側が光（左上）を向くか
      /* 駆動輪（回転軸から先端までの6割の所。通路と直角に2つ並び、通路の左右から少しのぞく。胴体の上には出ない） */
      c.save(); c.translate(B.rx, B.ry); c.rotate(B.a);
      const wx = P.s0 + P.len * 0.6;
      c.fillStyle = '#3a424c'; c.fillRect(wx - 1.6, -10, 3.2, 20);              // 車軸のはり
      c.fillStyle = '#2d343d';
      this.rr(wx - 5, -15, 10, 6, 1.6); c.fill();
      this.rr(wx - 5, 9, 10, 6, 1.6); c.fill();
      c.strokeStyle = 'rgba(150,160,172,.35)'; c.lineWidth = 0.5; c.beginPath();
      for (let x = wx - 3.5; x < wx + 4; x += 2.2) { c.moveTo(x, -14.5); c.lineTo(x, -9.5); c.moveTo(x, 9.5); c.lineTo(x, 14.5); }
      c.stroke();
      c.restore();
      /* 通路の床（3段の筒。キャブ側ほど太い） */
      P.sects.forEach(([f0, f1, w]) => {
        const a0 = P.s0 + P.len * f0, a1 = P.s0 + P.len * f1;
        c.save(); c.translate(B.rx, B.ry); c.rotate(B.a);
        const gr = c.createLinearGradient(0, lit * w / 2, 0, -lit * w / 2);
        gr.addColorStop(0, '#b4bfca'); gr.addColorStop(1, '#8796a4');
        c.fillStyle = gr; c.fillRect(a0, -w / 2, a1 - a0, w);
        c.fillStyle = 'rgba(60,72,86,.22)'; c.fillRect(a0, -w / 2 + 3, a1 - a0, w - 6);   // 床のじゅうたん
        c.restore();
      });
      /* キャブの床 */
      c.save(); c.translate(B.ex, B.ey); c.rotate(B.phi);
      c.fillStyle = '#9aa7b3'; c.fillRect(-1, -15, 21, 30);
      c.fillStyle = 'rgba(60,72,86,.22)'; c.fillRect(2, -12, 15, 24);
      c.restore();
      /* ロタンダの床 */
      const rgd = c.createRadialGradient(B.rx - 4, B.ry - 4, 2, B.rx, B.ry, BRG.rotR);
      rgd.addColorStop(0, '#c9d2da'); rgd.addColorStop(1, '#98a4af');
      c.fillStyle = rgd; c.beginPath(); c.arc(B.rx, B.ry, BRG.rotR, 0, TAU); c.fill();
    },
    /* 搭乗橋のガラスの屋根（寒色・うすい）とリブ。中の人ははっきり見えたまま「中にいる」と分かる */
    drawBridgeRoof() {
      const c = this.ctx, P = this.bridgeParts(), B = P.B;
      const lit = Math.sin(B.a) - Math.cos(B.a) >= 0 ? 1 : -1;
      P.sects.forEach(([f0, f1, w]) => {
        const a0 = P.s0 + P.len * f0, a1 = P.s0 + P.len * f1;
        c.save(); c.translate(B.rx, B.ry); c.rotate(B.a);
        const gr = c.createLinearGradient(0, lit * w / 2, 0, -lit * w / 2);
        gr.addColorStop(0, 'rgba(227,234,240,.42)'); gr.addColorStop(1, 'rgba(169,184,198,.32)');
        c.fillStyle = gr; c.fillRect(a0, -w / 2, a1 - a0, w);
        c.fillStyle = `rgba(255,255,255,.55)`; c.fillRect(a0, lit > 0 ? w / 2 - 1.6 : -w / 2, a1 - a0, 1.6);   // 光の側のふち
        c.strokeStyle = 'rgba(70,85,100,.25)'; c.lineWidth = 0.7; c.beginPath();
        for (let x = a0 + 3.5; x < a1 - 1; x += 7) { c.moveTo(x, -w / 2 + 0.5); c.lineTo(x, w / 2 - 0.5); }
        c.stroke();
        c.strokeStyle = 'rgba(58,72,88,.68)'; c.lineWidth = 0.8; c.strokeRect(a0, -w / 2, a1 - a0, w);
        c.fillStyle = 'rgba(28,40,56,.26)'; c.fillRect(a0 - 1.6, -w / 2 + 1, 1.6, w - 2);   // 段差の陰
        c.restore();
      });
      /* キャブ（ドアにつく先頭の箱）: ガラスの屋根・暗い窓の帯・胴体側のじゃばら */
      c.save(); c.translate(B.ex, B.ey); c.rotate(B.phi);
      const cg = c.createLinearGradient(0, -15, 0, 15);
      cg.addColorStop(0, 'rgba(178,192,206,.45)'); cg.addColorStop(1, 'rgba(230,236,242,.45)');
      c.fillStyle = cg; c.fillRect(-1, -15, 21, 30);
      c.fillStyle = 'rgba(30,44,60,.55)'; c.fillRect(15, -14, 3.2, 28);              // 窓の帯（ドアの前のガラス）
      c.fillStyle = 'rgba(190,220,240,.35)'; c.fillRect(15.4, -13, 1, 9);
      c.strokeStyle = 'rgba(70,85,100,.25)'; c.lineWidth = 0.7; c.beginPath();
      for (let x = 2.5; x < 15; x += 6) { c.moveTo(x, -14.5); c.lineTo(x, 14.5); }
      c.stroke();
      c.strokeStyle = 'rgba(58,72,88,.72)'; c.lineWidth = 0.8; c.strokeRect(-1, -15, 21, 30);
      c.fillStyle = '#39414a'; c.fillRect(20, -13, 4, 26);
      c.strokeStyle = 'rgba(160,172,184,.5)'; c.lineWidth = 0.5; c.beginPath();
      for (let y = -11; y <= 11; y += 3) { c.moveTo(20, y); c.lineTo(24, y); }
      c.stroke();
      c.restore();
      /* ロタンダ（通路がまわる丸い部屋）の屋根 */
      const rgd = c.createRadialGradient(B.rx - 4, B.ry - 4, 2, B.rx, B.ry, BRG.rotR);
      rgd.addColorStop(0, 'rgba(232,238,243,.78)'); rgd.addColorStop(1, 'rgba(160,174,186,.7)');
      c.fillStyle = rgd; c.beginPath(); c.arc(B.rx, B.ry, BRG.rotR, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(58,72,88,.65)'; c.lineWidth = 0.8; c.stroke();
      c.fillStyle = 'rgba(152,164,175,.8)'; c.beginPath(); c.arc(B.rx, B.ry, 5.5, 0, TAU); c.fill();
    },

    /* 給油中: ホースと、給油車の前後のコーン */
    drawEffectsUnder(state) {
      const c = this.ctx;
      const t = state.tasks;
      if (t.refuel.status === 'active') {
        /* 給油ホース: 給油車から右主翼の下の給油口へ（翼の前縁の下へもぐる） */
        c.strokeStyle = 'rgba(20,28,38,.22)'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(710, 457); c.quadraticCurveTo(720, 438, 703, 422); c.stroke();
        c.strokeStyle = '#3c4652'; c.lineWidth = 2.6;
        c.beginPath(); c.moveTo(708, 454); c.quadraticCurveTo(718, 435, 701, 419); c.stroke();
        c.fillStyle = '#2a3139'; c.beginPath(); c.arc(701, 419, 1.8, 0, TAU); c.fill();
        FUEL_CONES.forEach(([x, y]) => this.drawCone(x, y));
      }
    },
    /* セーフティコーン（上から見た円すい: 四角い台・同心円・白い反射帯・右下の影） */
    drawCone(x, y) {
      const c = this.ctx, Lt = this.light, sL = Lt.shadowL;
      c.fillStyle = `rgba(${Lt.shadowCol},${clamp(0.24 * Lt.shadowA, 0, 0.32).toFixed(3)})`;
      c.beginPath(); c.ellipse(x + 2.6 * sL, y + 3.4 * sL, 3.8 + 2.4 * sL, 2.6, rad(54), 0, TAU); c.fill();
      c.fillStyle = '#b8521b'; this.rr(x - 4, y - 4, 8, 8, 1.6); c.fill();
      c.fillStyle = '#e46e22'; c.beginPath(); c.arc(x, y, 3.3, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,190,130,.75)'; c.beginPath(); c.arc(x - 0.8, y - 0.8, 2.6, Math.PI * 0.95, Math.PI * 1.75); c.lineTo(x, y); c.fill();
      c.strokeStyle = 'rgba(250,250,250,.95)'; c.lineWidth = 0.9;
      c.beginPath(); c.arc(x, y, 2.05, 0, TAU); c.stroke();
      c.fillStyle = '#f08a3c'; c.beginPath(); c.arc(x, y, 0.9, 0, TAU); c.fill();
    },
    /* 駐機してからプッシュバックが始まるまで、翼端の外と尾のうしろにコーンを置く */
    drawCones(state) {
      if (!this.planeParked || this.arrivalT != null) return;
      const p = state.tasks.pushback.status;
      if (p === 'active' || p === 'done') return;
      CONES.forEach(([x, y]) => this.drawCone(x, y));
    },

    /* ロックが開いた瞬間、その持ち場で青緑の輪を広げて知らせる */
    popSpot(taskId) { this.spotFx[taskId] = 0; },

    /* 持ち場のサークル（予告・開始まち・合図の輪）。地面の上・人と車の下に描く */
    drawSpotLayer(state, ui, dtReal) {
      this.drawSoonSpots(state);
      this.drawSpots(state, ui);
      this.drawSpotPops(dtReal);
    },

    /* 合図の輪: ロックが開いた（青緑・1.1秒）/ 作業がおわった（緑・0.6秒）。大きさは1回広がるだけ */
    drawSpotPops(dtReal) {
      const c = this.ctx, C = SPOT_COL, k = this.spotK(), still = reduceMotion();
      Object.keys(this.spotFx).forEach((key) => {
        this.spotFx[key] += dtReal;
        const done = key.startsWith('done:'), id = done ? key.slice(5) : key;
        const dur = done ? 0.6 : 1.1;
        const p = this.spotFx[key] / dur;
        let a = this.anchorOf(id);
        if (done) { const tag = this.doneTags.find((d) => d.id === id); if (tag) a = [tag.x, tag.y]; }
        if (p >= 1 || !a) { delete this.spotFx[key]; return; }
        c.save();
        c.globalAlpha = 1 - p;
        c.strokeStyle = done ? C.done : C.unlock;
        c.lineWidth = 3.5;
        const r = still ? (done ? 28 : 34) : (done ? 20 + p * 24 : 16 + p * 44);
        c.beginPath(); c.arc(a[0], a[1], r * k, 0, TAU); c.stroke();
        c.restore();
      });
    },

    /* 持ち場の輪: 暗いふち（どの地面でも見える）→ 白い内側 → 色の線（点線 or 実線） */
    spotRing(r, col, dashed, fill, lw) {
      const c = this.ctx;
      c.setLineDash([]);
      c.fillStyle = fill;
      c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(16,32,52,.72)'; c.lineWidth = 5.5; c.stroke();
      if (dashed) c.setLineDash([7, 5]);
      c.strokeStyle = col; c.lineWidth = lw || 3;
      c.beginPath(); c.arc(0, 0, r, 0, TAU); c.stroke();
      c.setLineDash([]);
    },
    /* 持ち場のアイコン: 紺の円（左上が明るい・右下に落ち影）+ 白い作業アイコン */
    spotIcon(id, r, disc, hi, size) {
      const c = this.ctx;
      c.fillStyle = 'rgba(16,26,40,.30)';
      c.beginPath(); c.arc(1.5, 2.5, r, 0, TAU); c.fill();
      const g = c.createRadialGradient(-4, -4, 1, 0, 0, r);
      g.addColorStop(0, hi); g.addColorStop(1, disc);
      c.fillStyle = g;
      c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      const nm = window.Icons && window.Icons.task(id);
      if (nm) window.Icons.draw(c, nm, 0, 0, size, '#ffffff');
    },
    /* 状態の印（色だけにたよらない）: はじめられる=▶ / あつまり中=… / まだ=かぎ */
    spotMark(x, y, kind) {
      const c = this.ctx, C = SPOT_COL;
      const col = kind === 'ready' ? C.ready : kind === 'gather' ? C.gather : C.locked;
      c.fillStyle = '#ffffff'; c.beginPath(); c.arc(x, y, 6.3, 0, TAU); c.fill();
      c.fillStyle = col; c.beginPath(); c.arc(x, y, 5, 0, TAU); c.fill();
      c.fillStyle = '#ffffff';
      if (kind === 'ready') {
        c.beginPath(); c.moveTo(x - 1.5, y - 2.7); c.lineTo(x + 2.9, y); c.lineTo(x - 1.5, y + 2.7); c.closePath(); c.fill();
      } else if (kind === 'gather') {
        [-2.2, 0, 2.2].forEach((d) => { c.beginPath(); c.arc(x + d, y, 0.95, 0, TAU); c.fill(); });
      } else if (window.Icons) {
        window.Icons.draw(c, 'lock', x, y, 7.4, '#ffffff');
      }
    },

    /* 「もうすぐできる」持ち場の予告。前提の作業がぜんぶ進行中のときだけ、灰の点線の輪と「あと◯ぷん」を出す */
    drawSoonSpots(state) {
      const c = this.ctx, G = window.Game, C = SPOT_COL, k = this.spotK();
      state.taskList.forEach((t) => {
        if (t.status !== 'locked') return;
        const rest = G.opensInMinutes(t.id);
        if (rest == null) return;
        const a = this.anchorOf(t.id);
        if (!a) return;
        c.save();
        c.translate(a[0], a[1]); c.scale(k, k);
        this.spotRing(18.5, C.soon, true, 'rgba(255,255,255,.55)', 3);
        this.spotIcon(t.id, 10, '#5f6f82', '#8796a8', 14);
        this.spotMark(9, 8.5, 'lock');
        c.restore();
        this.pushLabel({ prio: 4, sx: a[0], sy: a[1] + 23 * k, ay: 't', dy: 3, parts: [{ t: `あと${rest}${funPun(rest)}` }], base: 10, style: 'soon', minS: 0.55 });
      });
    },

    /* 作業の持ち場（はじめられる=青緑の点線・あつまり中=こはくの点線）。
     * 人をえらんでいるときは、送れる持ち場を緑の太い実線の輪にする（大きさは変えない・脈打たない） */
    drawSpots(state, ui) {
      const c = this.ctx, G = window.Game, C = SPOT_COL, k = this.spotK();
      const selected = ui ? ui.selected : null;
      state.taskList.forEach((t) => {
        if (t.status !== 'ready' && t.status !== 'gathering') return;
        const a = this.anchorOf(t.id);
        if (!a) return;
        const acceptable = selected && G.canAccept(t.id, selected);
        c.save();
        c.translate(a[0], a[1]); c.scale(k, k);
        if (acceptable) this.spotRing(23, C.accept, false, 'rgba(255,255,255,.6)', 4);
        else if (selected) { c.globalAlpha = 0.6; this.spotRing(23, '#8a96a3', true, 'rgba(255,255,255,.35)', 2.5); c.globalAlpha = 1; }
        else this.spotRing(23, t.status === 'gathering' ? C.gather : C.ready, true, 'rgba(255,255,255,.55)', 3);
        if (acceptable) { c.fillStyle = 'rgba(31,122,69,.16)'; c.beginPath(); c.arc(0, 0, 21, 0, TAU); c.fill(); }
        this.spotIcon(t.id, 11, '#1e3a5f', '#3e6592', 16);
        this.spotMark(9, 8.5, t.status === 'gathering' ? 'gather' : 'ready');
        c.restore();
        /* あと何人・何台（アイコン+数字） */
        if (t.status === 'gathering') {
          const missing = G.missingIcons(t.id);
          if (missing) this.pushLabel({ prio: 3, sx: a[0], sy: a[1] + 27 * k, ay: 't', dy: 2, parts: this.iconTextParts('あと ' + missing), base: 10, style: 'gather' });
        }
      });
    },

    /* 「あと🧳×1」などの文字列を、アイコンと文字の部品に分ける（Icons.emojiName で分かる絵文字はアイコン、ほかは文字） */
    iconTextParts(str) {
      if (!this._emojiRes) {
        const m = {}, RM = window.RES_META || {};
        ['staff', 'vehicles'].forEach((k) => Object.keys(RM[k] || {}).forEach((type) => {
          const ic = RM[k][type].icon, nm = window.Icons && window.Icons.res(type);
          if (ic && nm) m[ic.replace(/️/g, '')] = nm;
        }));
        this._emojiRes = m;
      }
      const segs = (typeof Intl !== 'undefined' && Intl.Segmenter)
        ? [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(String(str))].map((s) => s.segment)
        : Array.from(String(str));
      const parts = [];
      let buf = '';
      segs.forEach((g) => {
        const key = g.replace(/️/g, '');
        const pict = /\p{Extended_Pictographic}/u.test(g);
        const nm = this._emojiRes[key] || (pict && window.Icons ? window.Icons.emojiName(g) : null);
        if (nm) { if (buf) parts.push({ t: buf }); buf = ''; parts.push({ i: nm }); } else buf += g;
      });
      if (buf) parts.push({ t: buf });
      return parts;
    },

    /* ---------- スクリーン層の文字（ラベル・札・案内板） ----------
     * シーンの中で pushLabel しておき、c.restore() のあとにスクリーン座標で描く。
     * 文字の大きさは Math.max(13, 元のpx×S)（どの画面でも13px以上）。優先度の高い順に描き、
     * すでに描いた札と重なるものは描かない（選択 > 人数 > かんりょう > あと+アイコン > あと◯ぷん > 案内板） */
    pushLabel(l) { (this._labels || (this._labels = [])).push(l); },
    /* 案内板（看板・ゲート・スポット番号・区画の名前）。小さすぎる画面（S<0.55）では描かない */
    addSignLabels(state) {
      const Z = ZONE.staff, E = ZONE.era, V = ZONE.veh;
      this.pushLabel({ prio: 9, sx: 10, sy: 45, ax: 'l', parts: [{ i: 'plane' }, { t: 'そらみなと こくさいくうこう' }], base: 13, style: 'airport', minS: 0.55 });
      this.pushLabel({ prio: 9, sx: BRG.x, sy: 112, parts: [{ t: 'GATE 7' }], base: 13, style: 'gate', minS: 0.55 });
      if (!state || this._planeHome) this.pushLabel({ prio: 9, sx: 439, sy: PLANE_CY, parts: [{ t: 'S7' }], base: 13, style: 'spotno', minS: 0.55 });
      this.pushLabel({ prio: 8, sx: Z.x + 2, sy: Z.y - 17, ax: 'l', parts: [{ t: 'スタッフのまちあい' }], base: 13, style: 'board', minS: 0.55 });
      this.pushLabel({ prio: 8, sx: E.x1 + 12, sy: V.y - 19, ax: 'l', parts: [{ t: 'はたらく くるまの おきば' }], base: 13, style: 'board', minS: 0.55 });
    },
    drawLabelsScreen(state, dt) {
      const c = this.ctx;
      if (!c || !this.cw) return;
      const S = this.scale();
      /* 知らせの札（到着・出発）と、かんりょうの札（上へは動かさない） */
      this.fx.floats = this.fx.floats.filter((f) => (f.age += dt) < f.life);
      this.fx.floats.forEach((f) => {
        const a = clamp((f.life - f.age) / 0.5, 0, 1);
        this.pushLabel({ prio: 0, sx: f.x, sy: f.y, parts: [{ t: f.text }], base: 16, min: 15, style: 'float', alpha: a });
      });
      this.doneTags = this.doneTags.filter((d) => (d.age += dt) < d.life);
      if (state) {
        const k = this.spotK();
        this.doneTags.forEach((d) => {
          const a = clamp((d.life - d.age) / 0.4, 0, 1);
          this.pushLabel({ prio: 2.5, sx: d.x, sy: d.y - 30 * k, ay: 'b', parts: [{ i: 'check' }, { t: 'かんりょう' }], base: 11, style: 'done', alpha: a });
        });
      }
      const list = (this._labels || []).slice().sort((p, q) => p.prio - q.prio);
      const placed = [];
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.textBaseline = 'middle'; c.textAlign = 'left';
      list.forEach((L) => {
        if (L.minS && S < L.minS) return;
        const fs = Math.max(L.min || 13, L.base * S);
        c.font = `bold ${fs.toFixed(1)}px ${CF}`;
        const pad = fs * 0.55, gap = fs * 0.22, isz = fs * 1.08;
        let w = 0;
        L.parts.forEach((p, i) => { w += p.i ? isz : c.measureText(p.t).width; if (i) w += gap; });
        const bw = w + pad * 2, bh = Math.round(fs * 1.55);
        const p = this.sceneToScreen(L.sx, L.sy);
        const x = p.x + (L.dx || 0), y = p.y + (L.dy || 0);
        const left = L.ax === 'l' ? x : x - bw / 2;
        const top = L.ay === 't' ? y : L.ay === 'b' ? y - bh : y - bh / 2;
        const R = { l: left, t: top, r: left + bw, b: top + bh };
        if (R.r < 0 || R.l > this.cw || R.b < 0 || R.t > this.ch) return;
        /* 案内板は、はしで切れるなら描かない。ほかの札は画面の中へずらす */
        const out = R.l < 2 || R.t < 2 || R.r > this.cw - 2 || R.b > this.ch - 2;
        if (out && L.prio >= 8) return;
        if (out) {
          const dx = R.l < 4 ? 4 - R.l : R.r > this.cw - 4 ? this.cw - 4 - R.r : 0;
          const dy = R.t < 4 ? 4 - R.t : R.b > this.ch - 4 ? this.ch - 4 - R.b : 0;
          R.l += dx; R.r += dx; R.t += dy; R.b += dy;
        }
        if (placed.some((q) => R.l < q.r && R.r > q.l && R.t < q.b && R.b > q.t)) return;
        placed.push(R);
        this.drawLabelBox(c, L, R, fs, pad, gap, isz);
      });
      c.restore();
    },
    drawLabelBox(c, L, R, fs, pad, gap, isz) {
      const ST = {
        soon: { bg: 'rgba(246,249,251,.96)', bd: '#8f9dab', fg: '#3b4855' },
        gather: { bg: 'rgba(255,251,240,.97)', bd: SPOT_COL.gather, fg: '#6e4a00' },
        pax: { bg: 'rgba(255,255,255,.95)', bd: '#a9bccf', fg: '#24466b' },
        sel: { bg: 'rgba(24,52,88,.95)', bd: null, fg: '#ffffff' },
        done: { bg: '#ffffff', bd: SPOT_COL.done, fg: SPOT_COL.done, sh: true },
        float: { bg: 'rgba(255,255,255,.96)', bd: '#0b6f8a', fg: '#0b5f78', sh: true },
        board: { bg: 'rgba(246,249,251,.92)', bd: '#8b959e', fg: '#2f3a45', sh: true, r: 4 },
        airport: { bg: 'rgba(24,46,74,.94)', bd: null, fg: '#ffffff' },
        gate: { bg: '#22405f', bd: null, fg: '#ffd24a', r: 5 },
        spotno: { bg: this.light.yel, bd: 'rgba(34,36,32,.55)', fg: '#22262b', r: 3 },
      }[L.style] || { bg: '#fff', bd: '#999', fg: '#222' };
      const w = R.r - R.l, h = R.b - R.t, rad0 = ST.r != null ? Math.min(ST.r, h / 2) : h / 2;
      const rrp = (x, y) => {
        c.beginPath();
        c.moveTo(x + rad0, y); c.arcTo(x + w, y, x + w, y + h, rad0); c.arcTo(x + w, y + h, x, y + h, rad0);
        c.arcTo(x, y + h, x, y, rad0); c.arcTo(x, y, x + w, y, rad0); c.closePath();
      };
      c.globalAlpha = L.alpha != null ? L.alpha : 1;
      if (ST.sh) { c.fillStyle = 'rgba(16,26,40,.22)'; rrp(R.l + 1.5, R.t + 1.5); c.fill(); }
      c.fillStyle = ST.bg; rrp(R.l, R.t); c.fill();
      if (ST.bd) { c.strokeStyle = ST.bd; c.lineWidth = L.style === 'done' || L.style === 'gather' ? 1.6 : 1; rrp(R.l, R.t); c.stroke(); }
      let x = R.l + pad;
      const cy = R.t + h / 2 + 0.5;
      L.parts.forEach((p, i) => {
        if (i) x += gap;
        if (p.i) {
          const col = p.i === 'vet' ? (L.style === 'sel' ? '#f2c94c' : '#b07d12') : ST.fg;
          if (window.Icons) window.Icons.draw(c, p.i, x + isz / 2, cy - 0.5, isz, col);
          x += isz;
        } else {
          c.fillStyle = ST.fg;
          c.fillText(p.t, x, cy);
          x += c.measureText(p.t).width;
        }
      });
      c.globalAlpha = 1;
    },

    /* 車の見た目に使う光の向き（車両ローカル座標の「光の来る向き」）。this._vl があればそれ、なければ左上 */
    litGrad(x, y, w, h, base) {
      const c = this.ctx, Lv = this._vl || [-0.7071, -0.7071];
      /* 止まっている車は毎フレーム同じグラデーションになるので、光の向き（約3°きざみ）ごとにおぼえておく */
      const qa = Math.round(Math.atan2(Lv[1], Lv[0]) * 20), key = `${base}|${x}|${y}|${w}|${h}|${qa}`;
      if (!this._gcache) this._gcache = new WeakMap();
      let m = this._gcache.get(c);
      if (!m) { m = new Map(); this._gcache.set(c, m); }
      const hit = m.get(key);
      if (hit) return hit;
      if (m.size > 600) m.clear();
      const a = qa / 20, lx = Math.cos(a), ly = Math.sin(a);
      const cx = x + w / 2, cy = y + h / 2, d = Math.abs(lx) * w / 2 + Math.abs(ly) * h / 2 + 0.01;
      const g = c.createLinearGradient(cx + lx * d, cy + ly * d, cx - lx * d, cy - ly * d);
      g.addColorStop(0, shadeHex(base, 0.12)); g.addColorStop(0.5, base); g.addColorStop(1, shadeHex(base, -0.15));
      m.set(key, g);
      return g;
    },
    /* 光をうけた箱（上面が明るく下面が暗い）+ 塗りより20%暗い輪郭 */
    litBox(x, y, w, h, r, base) {
      const c = this.ctx;
      c.fillStyle = this.litGrad(x, y, w, h, base);
      this.rr(x, y, w, h, r); c.fill();
      c.strokeStyle = shadeHex(base, -0.2); c.lineWidth = 1; c.stroke();
    },
    tires(list, w, h) {
      const c = this.ctx;
      c.fillStyle = '#22272e';
      list.forEach(([x, y]) => { this.rr(x - w / 2, y, w, h, 1.2); c.fill(); });
    },
    glass(x, y, w, h, r) {
      const c = this.ctx, Lv = this._vl || [-0.7071, -0.7071];
      const g = c.createLinearGradient(x + w / 2 + Lv[0] * w / 2, y + h / 2 + Lv[1] * h / 2, x + w / 2 - Lv[0] * w / 2, y + h / 2 - Lv[1] * h / 2);
      g.addColorStop(0, '#a9c3d6'); g.addColorStop(0.5, '#56718a'); g.addColorStop(1, '#2d4052');
      c.fillStyle = g; this.rr(x, y, w, h, r); c.fill();
    },

    /* 車両の絵（車両ローカル座標。キャブは -x 側）。ずかんからも呼ぶので、引数の形は変えない。
     * 光の向きは this._vl（drawVehicleEnt が車の向きから決める。ないときは左上）。キャッシュせずにベクターで描く */
    vehicleBody(type, active, gt, reverse) {
      const c = this.ctx;
      switch (type) {
        case 'beltloader': {
          /* 全長は実物（約8m）に合わせる。ベルトの先が貨物ドアの敷居（+64）にとどく（回さない） */
          this.tires([[-28, -14.5], [-28, 10.5], [3, -14.5], [3, 10.5]], 9, 4);
          this.litBox(-34, -12, 44, 24, 4, '#5f6c79');
          c.fillStyle = shadeHex('#5f6c79', -0.12); this.rr(-34, -12, 15, 24, 4); c.fill();   // キャブ
          this.glass(-31.5, -8, 8, 16, 2);
          c.strokeStyle = 'rgba(30,38,48,.35)'; c.lineWidth = 0.8; c.beginPath();
          for (let x = -14; x <= 4; x += 4.5) { c.moveTo(x, -9); c.lineTo(x, 9); }     // エンジンカバーのすきま
          c.stroke();
          c.save();
          c.translate(2, 0);
          /* ベルトの枠（左右のレール） */
          c.fillStyle = '#6f7a86'; this.rr(0, -6.5, 62, 13, 2.5); c.fill();
          c.strokeStyle = shadeHex('#6f7a86', -0.2); c.lineWidth = 1; c.stroke();
          /* ベルトの面: 作業中は先が持ち上がる（地上側が暗く、先端が明るい） */
          const bg = c.createLinearGradient(0, 0, 62, 0);
          if (active) { bg.addColorStop(0, '#9aa6b1'); bg.addColorStop(1, '#e3e8ec'); } else { bg.addColorStop(0, '#a9b3bd'); bg.addColorStop(1, '#b8c1ca'); }
          c.fillStyle = bg; c.fillRect(1.5, -4.6, 59, 9.2);
          /* ベルトの横の板（作業中は流れる） */
          const off = active ? (((gt * 0.7 * 47) % 4.5) * (reverse ? -1 : 1) + 4.5) % 4.5 : 0;
          c.strokeStyle = 'rgba(70,82,96,.30)'; c.lineWidth = 0.6; c.beginPath();
          for (let x = 2 + off; x < 60.5; x += 4.5) { c.moveTo(x, -4.4); c.lineTo(x, 4.4); }
          c.stroke();
          c.fillStyle = '#3b4550'; c.fillRect(59, -6, 3, 12);                       // 先のローラー
          if (active) {
            const cols = ['#2f3640', '#c96f5c', '#4a5563'];                         // 差し色の荷物は1つだけ
            for (let i = 0; i < 3; i++) {
              let p = (gt * 0.7 + i / 3) % 1;
              if (reverse) p = 1 - p;
              const bx = 6 + p * 47;
              c.fillStyle = cols[i]; this.rr(bx, -4, 9, 8, 1.6); c.fill();
              c.fillStyle = 'rgba(255,255,255,.22)'; c.fillRect(bx + 1, -4, 7, 1);   // 上面のハイライト
              c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(bx + 1, 3, 7, 1);
            }
          }
          c.restore();
          break;
        }
        case 'cart': {
          /* トラクター + 2台の荷車（金属の台に紺のカーテン。荷物は黒・紺・茶が中心で、差し色は1つ） */
          this.tires([[-41, -12.2], [-41, 8.2], [-28, -12.2], [-28, 8.2], [-12, -11], [-12, 7], [4, -11], [4, 7], [19, -11], [19, 7], [35, -11], [35, 7]], 7, 4);
          c.strokeStyle = '#2d343d'; c.lineWidth = 1.6;
          c.beginPath(); c.moveTo(-23, 0); c.lineTo(-16, 0); c.moveTo(11, 0); c.lineTo(15, 0); c.stroke();
          this.litBox(-45, -10, 22, 20, 3, '#56626f');
          this.glass(-42, -6.5, 8, 13, 2);
          c.fillStyle = '#2f3740'; this.rr(-31, -5, 6, 10, 1.5); c.fill();         // 座席
          const bags = [['#2f3640', '#4a5563', '#5b4636'], ['#4a5563', '#c96f5c', '#2f3640']];
          [-16, 15].forEach((x, ti) => {
            this.litBox(x, -9, 27, 18, 2.5, '#7d8792');
            c.fillStyle = '#5d6670'; c.fillRect(x + 2, -6, 23, 12);
            bags[ti].forEach((col, i) => {
              const bx = x + 3 + i * 8;
              c.fillStyle = col; this.rr(bx, -5, 6.5, 10, 1.2); c.fill();
              c.fillStyle = 'rgba(255,255,255,.22)'; c.fillRect(bx + 0.8, -5, 4.9, 1);   // 上面のハイライト
              c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 0.6; c.beginPath(); c.moveTo(bx + 2, -1); c.lineTo(bx + 4.5, -1); c.stroke();
            });
            c.fillStyle = this.litGrad(x, -9, 27, 3, '#33506e'); c.fillRect(x, -9, 27, 3);   // 両側のカーテン
            c.fillStyle = this.litGrad(x, 6, 27, 3, '#33506e'); c.fillRect(x, 6, 27, 3);
          });
          break;
        }
        case 'fuel': {
          /* 給油車: キャブ + 円柱のタンク（角は小さく丸い）・上の歩み板・うしろのホースリール・オレンジの標識 */
          this.tires([[-40, -15], [-40, 11], [30, -15], [30, 11]], 9, 4);
          this.litBox(-48, -11, 20, 22, 3, '#9b2f3a');
          this.glass(-45, -7, 8, 14, 2);
          const Lv = this._vl || [-0.7071, -0.7071], s = Lv[1] >= 0 ? 1 : -1;   // タンクの光の側（車両ローカルの y）
          const tg = c.createLinearGradient(0, s * 13, 0, -s * 13);
          tg.addColorStop(0, '#b9c1c9'); tg.addColorStop(0.22, '#f4f6f8'); tg.addColorStop(0.6, '#cfd5db'); tg.addColorStop(1, '#8f99a3');
          c.fillStyle = tg; this.rr(-26, -13, 74, 26, 4); c.fill();
          c.strokeStyle = shadeHex('#cfd5db', -0.2); c.lineWidth = 1; c.stroke();
          c.fillStyle = '#b8434e'; c.fillRect(-24, -11.6, 70, 1.4); c.fillRect(-24, 10.2, 70, 1.4);   // 赤い帯
          c.fillStyle = 'rgba(64,74,86,.55)'; c.fillRect(-20, -3.2, 58, 6.4);                         // 歩み板
          c.strokeStyle = 'rgba(40,48,58,.6)'; c.lineWidth = 0.7; c.beginPath();
          c.moveTo(-20, -3.2); c.lineTo(38, -3.2); c.moveTo(-20, 3.2); c.lineTo(38, 3.2); c.stroke();
          [-8, 12, 30].forEach((x) => { c.fillStyle = '#aab3bc'; c.beginPath(); c.arc(x, 0, 2.3, 0, TAU); c.fill(); c.strokeStyle = 'rgba(60,70,80,.6)'; c.lineWidth = 0.6; c.stroke(); });
          c.fillStyle = '#3a434d'; c.beginPath(); c.arc(42, 0, 5.2, 0, TAU); c.fill();                // ホースリール
          c.strokeStyle = '#69747f'; c.lineWidth = 1; c.beginPath(); c.arc(42, 0, 3.3, 0, TAU); c.stroke();
          c.fillStyle = '#e2711d'; this.rr(44.6, -4, 3, 8, 0.6); c.fill();                            // オレンジの標識
          c.fillStyle = '#2a2a2a'; c.fillRect(44.6, -0.3, 3, 0.6);
          break;
        }
        case 'catering': {
          /* ケータリング車: キャブ + 荷台の箱（作業中は持ち上がる）。屋根にエアコンと会社の色の帯 */
          this.tires([[-37, -15.5], [-37, 11.5], [26, -15.5], [26, 11.5]], 9, 4);
          this.litBox(-42, -11, 18, 22, 3, '#3a7e96');
          this.glass(-39, -7, 7, 14, 2);
          if (active) {
            c.strokeStyle = 'rgba(52,62,74,.55)'; c.lineWidth = 1.2;   // 持ち上げるはさみの脚
            c.beginPath(); c.moveTo(-18, -12); c.lineTo(34, 12); c.moveTo(-18, 12); c.lineTo(34, -12); c.stroke();
          }
          this.litBox(-22, -14, 62, 28, 3, '#eef2f5');
          c.fillStyle = this.litGrad(-22, -14, 62, 5, '#3f9bb8'); c.fillRect(-21.5, -13.5, 61, 4.5);
          c.fillStyle = '#c9d1d8'; this.rr(-17, -6, 11, 12, 1.5); c.fill();                       // エアコン
          c.strokeStyle = 'rgba(90,104,118,.45)'; c.lineWidth = 0.7; c.stroke();
          c.strokeStyle = 'rgba(90,104,118,.28)'; c.lineWidth = 0.6; c.beginPath();
          for (let x = 2; x < 38; x += 12) { c.moveTo(x, -9); c.lineTo(x, 13); }
          c.stroke();
          c.fillStyle = '#9aa4ad'; this.rr(40, -12, 5, 24, 1); c.fill();                          // 前の踊り場
          break;
        }
        case 'pushback': {
          /* プッシュバック車（トーイングトラクター）: 低くて幅の広い黄色の車体・片側のキャブ・
           * 前のバンパーだけ黄黒のしま・牽引フック（+x が機体の側） */
          this.tires([[-17, -17.5], [-17, 13.5], [15, -17.5], [15, 13.5]], 11, 4.5);
          this.litBox(-26, -15, 52, 30, 5, '#e2b52f');
          c.fillStyle = 'rgba(90,64,8,.18)'; c.fillRect(-26, -13, 4, 26);                          // うしろのおもり
          c.strokeStyle = 'rgba(96,70,10,.38)'; c.lineWidth = 0.8; c.beginPath();
          for (let x = 4; x <= 17; x += 3.2) { c.moveTo(x, -2); c.lineTo(x, 11); }                  // ボンネットのすきま
          c.stroke();
          this.glass(-15, -14, 15, 11, 2);                                                          // 片側のキャブ
          c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect(-14, -13.5, 13, 1);
          c.save();
          this.rr(21, -15, 5, 30, 1.5); c.clip();
          c.fillStyle = '#f2c94c'; c.fillRect(21, -15, 5, 30);
          c.fillStyle = '#23272d';
          for (let y = -18; y < 18; y += 5) { c.beginPath(); c.moveTo(21, y); c.lineTo(26, y + 2.6); c.lineTo(26, y + 5); c.lineTo(21, y + 2.4); c.closePath(); c.fill(); }
          c.restore();
          c.fillStyle = '#2d343d'; this.rr(26, -4, 6, 8, 1.5); c.fill();                           // 牽引フック
          c.fillStyle = '#7b8590'; c.beginPath(); c.arc(29.5, 0, 1.4, 0, TAU); c.fill();
          break;
        }
      }
    },

    /* ---------- 人物（地上スタッフ）----------
     * x, yFeet = 足もとの座標。o.scale=1 で全長約24px（場内では PERSON_K で小さく描く）。かわいさより「現場のプロ」。
     * o: { color(ベスト・腕章の色), type(職種。なくてもよい), scale, phase(歩行サイクル), moving, working,
     *      sway(待機のゆれ), ghost(機体の下のうすいかげ), wands(誘導灯を持つ) }
     * 職種はシルエットで描き分ける: ゲート=紺の制帽（ヘルメットなし）・整備=紺のつなぎ・清掃=緑の帽子・
     * ランプ/手荷物=ヘルメット+イヤーマフ。どの職種も胴に o.color（ベストか胸の帯）を残す */
    drawPerson(x, yFeet, o) {
      const c = this.ctx;
      const K = o.scale || 1;
      const still = reduceMotion();
      const walk = o.moving ? Math.sin(o.phase) : 0;           // -1..1 交互の足
      const bob = o.moving ? Math.abs(Math.cos(o.phase)) * 0.7 // 歩行の上下はひかえめに
        : still ? 0 : o.working ? Math.sin(o.phase * 0.5) * 0.5 : (o.sway || 0);
      const top = -24 - bob;                                   // 頭のてっぺん（ローカル）
      const Lt = this.light || LIGHT_DAY;
      const U = {
        ramp: { legs: '#39434f', arms: '#34404e', head: 'helmet', muffs: true },
        baggage: { legs: '#39434f', arms: '#34404e', head: 'helmet', muffs: true },
        cleaning: { legs: '#3d4844', arms: '#45544c', head: 'cap', cap: '#2f7d55' },
        maintenance: { legs: '#2c3e57', arms: '#2c3e57', head: 'helmet', coverall: true },
        gate: { legs: '#26324a', arms: '#22314d', head: 'uniform', cap: '#1f2c45' },
      }[o.type] || { legs: '#39434f', arms: o.color, head: 'helmet' };
      c.save();
      c.translate(x, yFeet);
      c.scale(K, K);
      /* かげ（光源=左上 → 右下へのびる。濃さ・長さは照明のプリセット）。機体の下のうすいかげ（ghost）には付けない */
      if (!o.ghost) {
        c.fillStyle = `rgba(30,40,54,${clamp(0.20 * Lt.shadowA, 0, 0.3).toFixed(3)})`;
        c.beginPath(); c.ellipse(2.4 * Lt.shadowL, 2.8 * Lt.shadowL, 6.5 * Lt.shadowL, 2.4, rad(56), 0, TAU); c.fill();
      }
      /* 足（歩くと交互に前後） */
      c.strokeStyle = U.legs; c.lineWidth = 2.4; c.lineCap = 'round';
      c.beginPath();
      c.moveTo(-1.9, -8.5); c.lineTo(-1.9 + walk * 2.2, -walk * 1.2);
      c.moveTo(1.9, -8.5); c.lineTo(1.9 - walk * 2.2, walk * 1.2);
      c.stroke();
      /* うで（制服の色。歩行時は足と逆にふる。作業中はわずかに前へ） */
      const armY = top + 10;
      const armSwing = o.moving ? walk * 2.2 : 0;
      const armLift = o.working && !still ? -1.6 + Math.sin(o.phase) * 0.8 : o.working ? -1.2 : 0;
      const hl = [-5.2 - armSwing * 0.5, armY + 6 + armSwing + armLift], hr = [5.2 + armSwing * 0.5, armY + 6 - armSwing + armLift];
      c.strokeStyle = U.arms; c.lineWidth = 2.1;
      c.beginPath();
      c.moveTo(-4.2, armY); c.lineTo(hl[0], hl[1]);
      c.moveTo(4.2, armY); c.lineTo(hr[0], hr[1]);
      c.stroke();
      /* 誘導灯（オレンジの棒。プッシュバックのランプスタッフ） */
      if (o.wands) {
        c.strokeStyle = 'rgba(255,150,50,.35)'; c.lineWidth = 3.2;
        c.beginPath(); c.moveTo(hl[0], hl[1]); c.lineTo(hl[0] - 2.4, hl[1] + 5.5); c.moveTo(hr[0], hr[1]); c.lineTo(hr[0] + 2.4, hr[1] + 5.5); c.stroke();
        c.strokeStyle = '#ff8a1f'; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(hl[0], hl[1]); c.lineTo(hl[0] - 2.4, hl[1] + 5.5); c.moveTo(hr[0], hr[1]); c.lineTo(hr[0] + 2.4, hr[1] + 5.5); c.stroke();
      }
      c.lineCap = 'butt';
      /* 胴体（肩がわずかに広い台形）。整備はつなぎの上に o.color の胸の帯、ほかは o.color のハイビズベスト */
      const torso = () => {
        c.beginPath();
        c.moveTo(-4.6, top + 8); c.lineTo(4.6, top + 8); c.lineTo(3.9, top + 17); c.lineTo(-3.9, top + 17);
        c.closePath();
      };
      c.fillStyle = U.coverall ? '#2c3e57' : o.color;
      c.strokeStyle = 'rgba(30,40,50,.45)'; c.lineWidth = 1.1;
      torso(); c.fill(); c.stroke();
      /* 下半分のかげ（体の丸み） */
      c.fillStyle = 'rgba(25,38,52,.14)';
      c.beginPath();
      c.moveTo(-4.25, top + 13); c.lineTo(4.25, top + 13); c.lineTo(3.9, top + 17); c.lineTo(-3.9, top + 17);
      c.closePath(); c.fill();
      if (U.coverall) {
        c.strokeStyle = o.color; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(-4.4, top + 10.6); c.lineTo(4.4, top + 10.6); c.moveTo(-4.1, top + 14); c.lineTo(4.1, top + 14); c.stroke();
      } else {
        /* 反射ベストの2本ライン（実物のハイビズと同じ） */
        c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.1;
        c.beginPath();
        c.moveTo(-4.3, top + 11); c.lineTo(4.3, top + 11);
        c.moveTo(-4.05, top + 14); c.lineTo(4.05, top + 14);
        c.stroke();
      }
      /* 頭（落ちついた肌色。左上からの光で上半分が明るい） */
      c.fillStyle = '#e2b88e';
      c.beginPath(); c.arc(0, top + 4.4, 3.6, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,236,214,.55)';
      c.beginPath(); c.arc(-0.6, top + 3.9, 2.7, Math.PI * 0.95, Math.PI * 1.85); c.closePath(); c.fill();
      if (U.head === 'helmet') {
        /* ヘルメット（白。つば+通気ライン） */
        c.fillStyle = '#f2f4f6';
        c.beginPath(); c.arc(0, top + 3.9, 3.9, Math.PI, 0); c.closePath(); c.fill();
        c.fillStyle = 'rgba(255,255,255,.9)';
        c.beginPath(); c.arc(-1.1, top + 2.6, 1.4, 0, TAU); c.fill();
        c.strokeStyle = 'rgba(90,105,120,.55)'; c.lineWidth = 0.9;
        c.beginPath(); c.moveTo(-4.6, top + 3.9); c.lineTo(4.6, top + 3.9); c.stroke();
        if (U.muffs) {
          /* イヤーマフ（頭の両側のカップ。幅1.8） */
          c.fillStyle = '#2b3138';
          this.rr(-5.6, top + 3.6, 1.9, 3.4, 0.8); c.fill();
          this.rr(3.7, top + 3.6, 1.9, 3.4, 0.8); c.fill();
        }
      } else if (U.head === 'uniform') {
        /* ゲート係: 紺の制帽（平たい天井とつば・小さな記章） */
        c.fillStyle = '#3a2f28';
        c.beginPath(); c.arc(0, top + 4.2, 3.7, Math.PI * 1.05, Math.PI * 1.95); c.fill();
        c.fillStyle = U.cap;
        c.beginPath(); c.ellipse(0, top + 2.0, 4.6, 1.9, 0, 0, TAU); c.fill();
        c.fillStyle = '#121b2c';
        c.beginPath(); c.ellipse(0, top + 3.5, 4.0, 0.95, 0, 0, Math.PI); c.fill();
        c.fillStyle = '#d9b44a'; c.beginPath(); c.arc(0, top + 1.9, 0.65, 0, TAU); c.fill();
      } else {
        /* 清掃係: 緑の帽子（丸い天井と前のつば） */
        c.fillStyle = U.cap;
        c.beginPath(); c.arc(0, top + 3.8, 3.8, Math.PI, 0); c.closePath(); c.fill();
        c.fillStyle = shadeHex(U.cap, -0.25);
        c.beginPath(); c.ellipse(0, top + 4.0, 3.9, 0.9, 0, 0, Math.PI); c.fill();
        c.fillStyle = 'rgba(255,255,255,.35)';
        c.beginPath(); c.arc(-1.2, top + 2.3, 1.2, 0, TAU); c.fill();
      }
      c.restore();
      return yFeet + top * K;   // バッジ表示用に頭の位置を返す
    },

    /* 人・車両のいまの位置と、重なり順の層を決める。
     *   under  = 機体（胴体・翼・エンジン・尾翼）の下にいる → 機体より先に描く（上から見るとかくれる）
     *   bridge = 搭乗橋の下をくぐっている人 → 搭乗橋より先に描く
     *   inside = 搭乗橋の中で働く人（ガラスの屋根の下に描く）
     *   over   = それ以外 */
    layoutEntities(state, gt, tr, dt) {
      const push = state.tasks.pushback;
      const pushing = push.status === 'active' || push.status === 'done';
      const out = [];
      state.entities.forEach((e) => {
        const rec = this.resolveEntity(state, e);
        let x = rec.pos.x, y = rec.pos.y, ang = rec.angle;
        const tug = e.kind === 'vehicle' && e.type === 'pushback' && e.status === 'working' && pushing;
        if (tug) {
          /* 機首といっしょに動く。戻るときはその場所から帰れるよう、位置も覚えておく */
          const nose = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1], tr);
          x = rec.pos.x = nose.x; y = rec.pos.y = nose.y; ang = rec.angle = tr.rot + Math.PI;
        } else if (e.kind === 'staff' && e.status === 'working' && e.taskId === 'pushback' && pushing) {
          /* プッシュバックの係（ヘッドセットで操縦室と話す人）は機首のそばを歩いてついていく */
          const s = SLOTS.pushback.staff[0];
          const p = this.transformPoint(s[0], s[1], tr);
          x = rec.pos.x = p.x; y = rec.pos.y = p.y;
        } else if (e.kind === 'staff' && e.status === 'working' && e.taskId === 'inspect') {
          /* 点検の人は機体のまわりを一周する（いまの位置を覚えて、タップ・選択リング・帰り道に使う） */
          const t = state.tasks.inspect;
          const p = this.inspectAt(((t.progress / window.Game.effDur(t)) * 1.6) % 1);
          x = rec.pos.x = p[0]; y = rec.pos.y = p[1];
        }
        /* 車の描く向き: カートと給油車は走るときキャブを前に（半回転）。曲がり角でも 8rad/s で最短回りに回す */
        if (e.kind === 'vehicle') {
          const moving = (e.status === 'moving' || e.status === 'returning') && e.moveProgress < 0.999;
          const target = moving && (e.type === 'cart' || e.type === 'fuel') ? ang + Math.PI : ang;
          if (rec.drawAngle == null || tug || !dt) rec.drawAngle = target;
          else {
            const d = Math.atan2(Math.sin(target - rec.drawAngle), Math.cos(target - rec.drawAngle)), m = 8 * dt;
            rec.drawAngle += clamp(d, -m, m);
          }
        }
        const da = e.kind === 'vehicle' ? rec.drawAngle : ang;
        /* 重なり順の判定は、人・車も機体も動いていなければ前のフレームの結果を使う */
        const key = `${x.toFixed(1)},${y.toFixed(1)},${da.toFixed(3)},${e.status},${e.taskId},${tr.x.toFixed(1)},${tr.y.toFixed(1)},${tr.rot.toFixed(3)},${this.bridge.toFixed(2)}`;
        if (rec.layerKey !== key) { rec.layerKey = key; rec.layer = this.layerOf(e, x, y, da, tr); }
        out.push({ e, rec, x, y, ang: da, layer: rec.layer });
      });
      return out;
    },
    /* 点検の一周経路（長さにそって等速） */
    inspectAt(f) {
      if (!this._loop) {
        const P = INSPECT_LOOP, seg = [];
        let L = 0;
        for (let i = 0; i < P.length; i++) {
          const a = P[i], b = P[(i + 1) % P.length], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
          seg.push({ a, b, s: L, d }); L += d;
        }
        this._loop = { seg, L };
      }
      const { seg, L } = this._loop;
      const s = clamp(f, 0, 1) * L;
      const g = seg.find((q) => s <= q.s + q.d) || seg[seg.length - 1];
      const k = clamp((s - g.s) / (g.d || 1), 0, 1);
      return [g.a[0] + (g.b[0] - g.a[0]) * k, g.a[1] + (g.b[1] - g.a[1]) * k];
    },
    layerOf(e, x, y, ang, tr) {
      const pts = [];
      if (e.kind === 'staff') pts.push([x, y]);   // 人は足もとで判定
      else {
        /* 車体の外周と中心線を調べる（機首の先などが車体の一部にかかるときも見のがさない） */
        const ex = VEH_EXT[e.type] || [-40, 40, -12, 12];
        const cs = Math.cos(ang), sn = Math.sin(ang);
        for (let i = 0; i <= 6; i++) {
          const lx = ex[0] + ((ex[1] - ex[0]) * i) / 6;
          [ex[2], 0, ex[3]].forEach((ly) => pts.push([x + lx * cs - ly * sn, y + lx * sn + ly * cs]));
        }
      }
      if (tr.alpha > 0.02 && pts.some(([px, py]) => this.insidePlane(px, py, tr))) return 'under';
      /* 搭乗橋の中で働く人（降機・搭乗・ドアクローズ・清掃）は、ガラスの屋根の下 */
      if (e.kind === 'staff' && e.status === 'working' && ['deboard', 'board', 'doorclose', 'clean'].includes(e.taskId) &&
        this.bridge > 0.5 && this.insideBridge(x, y)) return 'inside';
      /* 搭乗橋の下をくぐるのは、歩いている人と点検の人だけ */
      const walker = e.kind === 'staff' && (e.status === 'moving' || e.status === 'returning' || (e.status === 'working' && e.taskId === 'inspect'));
      if (walker && this.insideBridge(x, y)) return 'bridge';
      return 'over';
    },
    /* シーン座標の点が、いまの機体を真上から見た形の中か */
    insidePlane(px, py, tr) {
      if (!this._hitCtx) this._hitCtx = document.createElement('canvas').getContext('2d');
      const dx = px - PIVOT_X - tr.x, dy = py - PLANE_CY - tr.y;
      const cs = Math.cos(tr.rot), sn = Math.sin(tr.rot);
      const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
      if (lx < SPR.x0 || lx > SPR.x0 + SPR.w || ly < SPR.y0 || ly > SPR.y0 + SPR.h) return false;
      return this._hitCtx.isPointInPath(planeGeometry().silhouette, lx, ly, 'nonzero');
    },
    /* 搭乗橋（固定通路・ロタンダ・のびちぢみする通路・キャブ）の真下か */
    insideBridge(x, y) {
      const B = this.bridgeGeom(this.bridge);
      if (Math.abs(x - BRG.x) < 11 && y > 124 && y < B.ry) return true;
      if (Math.hypot(x - B.rx, y - B.ry) < BRG.rotR + 1) return true;
      const loc = (ox, oy, a) => { const dx = x - ox, dy = y - oy, cs = Math.cos(a), sn = Math.sin(a); return [dx * cs + dy * sn, -dx * sn + dy * cs]; };
      const [tx, ty] = loc(B.rx, B.ry, B.a);
      if (tx > 0 && tx < B.L && Math.abs(ty) < 11) return true;
      const [cx, cy] = loc(B.ex, B.ey, B.phi);
      return cx > -2 && cx < 25 && Math.abs(cy) < 16;
    },
    drawEntityLayer(state, ents, layer, gt) {
      ents.forEach((it) => { if (it.layer === layer && it.e.kind === 'vehicle') this.drawVehicleEnt(state, it, gt); });
      ents.forEach((it) => { if (it.layer === layer && it.e.kind === 'staff') this.drawStaffEnt(state, it, gt); });
    },
    /* 機体・搭乗橋の下にいる人は、見失わないよう上からうすいかげを重ねる */
    drawGhosts(state, ents, gt) {
      const c = this.ctx;
      ents.forEach((it) => {
        if (it.e.kind !== 'staff' || (it.layer !== 'under' && it.layer !== 'bridge')) return;
        c.save();
        c.globalAlpha = 0.42;
        this.drawStaffEnt(state, it, gt, true);
        c.restore();
      });
    },

    /* 車の落ち影: ワールド座標で右下（光源=左上）へずらしてから回し、車種ごとの外形で塗る。
     * 作業中に持ち上がる部分（ベルトの先・ケータリングの荷台）は、高いほど遠くへ落ちる */
    drawVehicleShadow(type, x, y, ang, active) {
      const c = this.ctx, Lt = this.light, sL = Lt.shadowL;
      const col = `rgba(${Lt.shadowCol},${clamp(0.20 * Lt.shadowA, 0, 0.3).toFixed(3)})`;
      const ox = 5 * sL, oy = 7 * sL;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      const W = (lx, ly, k) => [x + lx * cs - ly * sn + ox * k, y + lx * sn + ly * cs + oy * k];
      c.fillStyle = col;
      (VEH_SHADOW[type] || [[-40, -12, 80, 24]]).forEach(([sx, sy, w, h], i) => {
        if (active && ((type === 'beltloader' && i === 1) || type === 'catering')) return;
        c.save(); c.translate(x + ox, y + oy); c.rotate(ang);
        this.rr(sx, sy, w, h, 3); c.fill();
        c.restore();
      });
      if (active && type === 'beltloader') {
        const k = (lx) => 1 + 2.2 * (lx - 2) / 62;
        c.beginPath();
        [W(2, -6, k(2)), W(64, -6, k(64)), W(64, 6, k(64)), W(2, 6, k(2))].forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
        c.closePath(); c.fill();
      }
      if (active && type === 'catering') {
        c.save(); c.translate(x + ox, y + oy); c.rotate(ang);
        this.rr(-42, -11, 18, 22, 3); c.fill();
        c.restore();
        c.beginPath();
        [W(-22, -14, 2.4), W(40, -14, 2.4), W(40, 14, 2.4), W(-22, 14, 2.4)].forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
        c.closePath(); c.fill();
      }
    },
    drawVehicleEnt(state, it, gt) {
      const c = this.ctx;
      const { e, x, y, ang } = it;
      const active = e.status === 'working' && e.taskId && state.tasks[e.taskId] && state.tasks[e.taskId].status === 'active';
      const reverse = e.taskId === 'unload';
      this.drawVehicleShadow(e.type, x, y, ang, active);
      c.save();
      c.translate(x, y);
      c.rotate(ang);
      /* 光の来る向き（左上）を、車両ローカル座標になおす */
      const cs = Math.cos(ang), sn = Math.sin(ang);
      this._vl = [(cs + sn) * -0.7071, (cs - sn) * -0.7071];
      this.vehicleBody(e.type, active, gt, reverse);
      this._vl = null;
      /* 作業中はキャブの上で黄色の回転灯が点滅（実際のGSEと同じ）。動きを減らす設定では点いたまま */
      if (active) {
        const [bx, by] = VEH_BEACON[e.type] || [0, 0];
        const bl = reduceMotion() ? 1 : 0.3 + 0.7 * Math.abs(Math.sin(this.time * 5 + x));
        c.fillStyle = `rgba(255,170,40,${(bl * 0.28).toFixed(3)})`;
        c.beginPath(); c.arc(bx, by, 5, 0, TAU); c.fill();
        c.fillStyle = `rgba(255,150,20,${bl.toFixed(3)})`;
        c.beginPath(); c.arc(bx, by, 2.1, 0, TAU); c.fill();
        c.fillStyle = 'rgba(255,240,200,.8)';
        c.beginPath(); c.arc(bx - 0.6, by - 0.6, 0.7, 0, TAU); c.fill();
      }
      c.restore();
    },

    drawStaffEnt(state, it, gt, ghost) {
      const { e, x, y } = it;
      const push = state.tasks.pushback;
      const meta = window.RES_META.staff[e.type];
      /* プッシュバックの係は機首のそばを歩いてついていく（誘導灯を持つ） */
      const pushWalk = e.status === 'working' && e.taskId === 'pushback' && push.status === 'active';
      const moving = e.status === 'moving' || e.status === 'returning' || pushWalk ||
        (e.status === 'working' && e.taskId === 'inspect');
      const working = e.status === 'working' && e.taskId !== 'inspect' && !pushWalk;
      /* 人物（歩行サイクルは個体ごとに位相をずらす） */
      const idx = Number(e.id.slice(1)) || 0;
      const top = this.drawPerson(x, y, {
        color: meta.color,
        type: e.type,
        scale: PERSON_K,
        moving,
        working,
        ghost,
        wands: pushWalk && e.type === 'ramp',
        phase: moving ? gt * 26 + idx * 2.1 : gt * 6 + idx * 2.1,
        sway: (!moving && !working && !reduceMotion()) ? Math.sin(this.time * 1.7 + idx * 1.9) * 0.5 : 0,
      });
      it.top = top;
    },
    /* 熟練度の印（頭の上。ベテラン=金の袖章・ルーキー=若葉）。搭乗橋の屋根より上に描く */
    drawBadges(state, ents) {
      const c = this.ctx, k = this.spotK();
      ents.forEach((it) => {
        const e = it.e;
        if (e.kind !== 'staff' || (e.skill !== 'vet' && e.skill !== 'rookie') || it.layer === 'under' || it.layer === 'bridge') return;
        const top = it.top != null ? it.top : it.y - 24 * PERSON_K;
        c.save();
        c.translate(it.x, top - 4.5); c.scale(k, k);
        c.fillStyle = 'rgba(16,26,40,.25)'; c.beginPath(); c.arc(0.8, 1.2, 4.6, 0, TAU); c.fill();
        c.fillStyle = '#ffffff'; c.beginPath(); c.arc(0, 0, 4.6, 0, TAU); c.fill();
        if (window.Icons) window.Icons.draw(c, e.skill, 0, 0, 7.4, '#a8770f');
        c.restore();
      });
    },

    /* 選択中のエンティティのリング（大きさは固定）と、スクリーン層のラベル。
     * 機体の下にいても見えるよう、いちばん上に描く。点検で歩いている人は、いまいる位置に出す */
    drawSelection(state, ents, ui) {
      const selected = ui ? ui.selected : null;
      if (!selected) return;
      const it = ents.find((v) => v.e.id === selected);
      if (!it) return;
      const c = this.ctx, e = it.e;
      let cx, cy, r;
      if (e.kind === 'vehicle') {
        const ex = VEH_EXT[e.type] || [-40, 40, -12, 12], mx = (ex[0] + ex[1]) / 2;
        cx = it.x + Math.cos(it.ang) * mx; cy = it.y + Math.sin(it.ang) * mx;
        r = (ex[1] - ex[0]) / 2 + 5;
      } else {
        cx = it.x; cy = it.y - PERSON_MID; r = 12.5;
      }
      c.strokeStyle = '#fff'; c.lineWidth = 3.5;
      c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.stroke();
      c.strokeStyle = SPOT_COL.ready; c.lineWidth = 2;
      c.beginPath(); c.arc(cx, cy, r + 2.8, 0, TAU); c.stroke();
      const meta = e.kind === 'staff' ? window.RES_META.staff[e.type] : window.RES_META.vehicles[e.type];
      const suffix = meta && e.label.indexOf(meta.short) === 0 ? e.label.slice(meta.short.length) : '';
      const parts = [];
      const rn = window.Icons && window.Icons.res(e.type);
      if (rn) parts.push({ i: rn });
      parts.push({ t: (KANA_SHORT[e.type] || '') + suffix });
      if (e.skill === 'vet') parts.push({ i: 'vet' }, { t: 'はやい' });
      else if (e.skill === 'rookie') parts.push({ i: 'rookie' }, { t: 'ゆっくり' });
      parts.push({ t: '─ いきさきを タップ！' });
      this.pushLabel({ prio: 1, sx: cx, sy: cy - r - 3, ay: 'b', dy: -3, parts, base: 11, style: 'sel' });
    },

    /* 駐機中のシーン座標の点が、いまの機体の姿勢でどこにあるか（中心=主脚） */
    transformPoint(px, py, tr) {
      const dx = px - PIVOT_X, dy = py - PLANE_CY;
      const cos = Math.cos(tr.rot), sin = Math.sin(tr.rot);
      return { x: PIVOT_X + tr.x + dx * cos - dy * sin, y: PLANE_CY + tr.y + dx * sin + dy * cos };
    },

    /* 乗客（搭乗橋の中を歩く。ガラスの屋根の下に描く） */
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

    /* 降機・搭乗の人数（スクリーン層の札。かな書き） */
    drawPaxCounter(state) {
      const G = window.Game;
      const deb = state.tasks.deboard, brd = state.tasks.board;
      let parts = null;
      if (deb.status === 'active') {
        const n = PAX_TOTAL - Math.floor(clamp(deb.progress / G.effDur(deb), 0, 1) * PAX_TOTAL);
        parts = [{ i: 'walk' }, { t: `おりるひと のこり ${n}にん` }];
      } else if (brd.status === 'active') {
        const n = Math.floor(clamp(brd.progress / G.effDur(brd), 0, 1) * PAX_TOTAL);
        parts = [{ i: 'people' }, { t: `のるひと ${n}/${PAX_TOTAL}にん` }];
      }
      if (!parts) return;
      this.pushLabel({ prio: 2, sx: PAX_SIGN[0], sy: PAX_SIGN[1], parts, base: 12, style: 'pax' });
    },

    /* 作業の進み具合の輪（人の頭の上。小さい画面では k 倍）。かみなりでおやすみ中は灰青 */
    drawRings(state, trIn) {
      const c = this.ctx;
      const G = window.Game, k = this.spotK();
      const paused = G.outdoorPaused && G.outdoorPaused();
      state.taskList.forEach((t) => {
        if (t.status !== 'active' || t.id === 'depart') return;
        const anchor = this.anchorOf(t.id);
        if (!anchor) return;
        let [x, y] = anchor;
        if (t.id === 'pushback') {
          const p = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1], trIn || this.planeTransform(state));
          x = p.x; y = p.y;
        }
        const pct = clamp(t.progress / G.effDur(t), 0, 1);
        const rest = paused && t.def.outdoor;
        c.save();
        c.translate(x, y - 40 * k); c.scale(k, k);
        c.fillStyle = 'rgba(16,26,40,.25)'; c.beginPath(); c.arc(1, 1.8, 12.5, 0, TAU); c.fill();
        c.fillStyle = 'rgba(255,255,255,.95)';
        c.beginPath(); c.arc(0, 0, 12.5, 0, TAU); c.fill();
        c.strokeStyle = '#d5dbe1'; c.lineWidth = 2.4;
        c.beginPath(); c.arc(0, 0, 10.6, 0, TAU); c.stroke();
        c.strokeStyle = rest ? '#5b6f86' : SPOT_COL.ready; c.lineWidth = 3;
        c.beginPath(); c.arc(0, 0, 10.6, -Math.PI / 2, -Math.PI / 2 + pct * TAU); c.stroke();
        const nm = window.Icons && window.Icons.task(t.id);
        if (nm) window.Icons.draw(c, nm, 0, 0, 13, '#1e3a5f');
        /* 状態の印: おしごと中=青緑に working（すすみぐあいの輪）/ かみなりでおやすみ=灰青に pause */
        c.fillStyle = '#ffffff'; c.beginPath(); c.arc(9.5, 9, 6.3, 0, TAU); c.fill();
        c.fillStyle = rest ? '#5b6f86' : SPOT_COL.ready; c.beginPath(); c.arc(9.5, 9, 5, 0, TAU); c.fill();
        if (window.Icons) window.Icons.draw(c, rest ? 'pause' : 'working', 9.5, 9, 7.6, '#ffffff');
        c.restore();
      });
    },

    /* 雨（雷雨イベント中はつよく、雨のステージはずっとよわく）。すじは動く向き（右下へ）にそろえ、
     * 地面に小さな波紋。画面に見えている範囲ぜんぶに降らせる */
    drawRain(state) {
      const storm = state.outdoorPauseUntil != null && state.clock < state.outdoorPauseUntil;
      const always = !!(state.stage && state.stage.rainAll);
      if (!storm && !always) return;
      const c = this.ctx, B = this.viewBounds(), T = this.time;
      const W = B.x1 - B.x0 + 120, H = B.y1 - B.y0 + 60;
      const L = storm ? 24 : 18;
      c.strokeStyle = storm ? 'rgba(210,228,246,.72)' : 'rgba(210,228,246,.5)';
      c.lineWidth = storm ? 2.0 : 1.5;
      c.lineCap = 'round';
      c.beginPath();
      const n = Math.round((storm ? 80 : 52) * clamp((W * H) / (1320 * 700), 0.5, 2.4));
      for (let i = 0; i < n; i++) {
        const x = B.x0 - 60 + ((((i * 149 + T * 340) % W) + W) % W);
        const y = B.y0 - 30 + ((((i * 97 + T * 700) % H) + H) % H);
        c.moveTo(x, y);
        c.lineTo(x - 0.44 * L, y - 0.9 * L);
      }
      c.stroke();
      /* 地面の波紋（20個。広がりながらうすくなる） */
      const gy0 = Math.max(150, B.y0), gy1 = Math.min(SCENE_H, B.y1);
      if (gy1 > gy0) {
        c.lineWidth = 0.9;
        c.strokeStyle = storm ? 'rgba(220,234,248,.55)' : 'rgba(220,234,248,.45)';
        c.beginPath();
        for (let i = 0; i < 20; i++) {
          const ph = T * 1.6 + i * 0.37, f = ph % 1, cyc = Math.floor(ph);
          const hx = Math.sin(i * 12.9898 + cyc * 78.233) * 43758.5453, hy = Math.sin(i * 39.346 + cyc * 11.135) * 24634.6345;
          const rx = B.x0 + (hx - Math.floor(hx)) * (B.x1 - B.x0), ry = gy0 + (hy - Math.floor(hy)) * (gy1 - gy0);
          const r = 1 + f * 5;
          c.moveTo(rx + r, ry); c.ellipse(rx, ry, r, r * 0.42, 0, 0, TAU);
        }
        c.stroke();
      }
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
