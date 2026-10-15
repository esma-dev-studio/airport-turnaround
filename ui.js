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
  const BELT_Y = Math.round(FUS_EDGE + 51); // ベルトの先（車両ローカルの +52）が貨物ドアの敷居にとどく位置

  /* 区画（背景にえがく。人や車の待機位置もここから決める） */
  const ZONE = {
    staff: { x: 296, y: 500, w: 144, h: 56 },   // スタッフのまちあい（左の作業カードを開いても見える位置）
    veh: { x: 450, y: 502, w: 596, h: 54 },     // はたらく車のおきば
    era: { x0: 472, y0: 150, x1: 932, y1: 498 }, // 制限区域ライン（駐機中の機体を囲む）
  };

  /* 作業ごとの持ち場（x, y, [車両の向きdeg]）。人や車が翼・エンジンに重ならないように置く。
   * 同時に出ることのある持ち場どうしは、サークル（半径25）と札が重ならないよう50px以上はなす */
  const SLOTS = {
    deboard:   { staff: [[722, 198]] },                      // 搭乗橋のロタンダの左（持ち場の輪が橋にかからない所）
    board:     { staff: [[722, 198]] },                      // 降機と同じ場所（同時には出ない）
    doorclose: { staff: [[836, 294]] },                      // L1ドアのよこ（搭乗橋のキャブの右）
    clean:     { staff: [[783, 230], [795, 256]] },          // 搭乗橋の通路を通って機内へ
    unload:    { staff: [[800, 440], [889, 465]], vehicles: { beltloader: [[ux(DOOR_U.fwdCargo), BELT_Y, -90]], cart: [[835, 460, 0]] } },
    load:      { staff: [[604, 440], [502, 465]], vehicles: { beltloader: [[ux(DOOR_U.aftCargo), BELT_Y, -90]], cart: [[560, 460, 0]] } },
    bagmatch:  { staff: [[612, 478]] },
    refuel:    { staff: [[716, 442]], vehicles: { fuel: [[732, 463, 0]] } },     // 右主翼の前（給油口は翼の下）
    catering:  { staff: [[548, 413]], vehicles: { catering: [[ux(DOOR_U.R2), 393, -90]] } },
    inspect:   { staff: [[900, 306]] },                      // 機首の前から一周
    /* 押す車は機首の約4m前（車体 x868〜926。制限区域の右はし x932 の内側）。牽引のフックから前脚までトーバーでつなぐ */
    pushback:  { staff: [[890, 370]], vehicles: { pushback: [[900, PLANE_CY, 180]] } },
    depart:    {},
  };
  const TUG_SLOT = SLOTS.pushback.vehicles.pushback[0];
  /* 持ち場の印（輪・進み具合・タップ）を、人の立つ所とは別の所に出す作業。
   * 清掃の人は搭乗橋の通路の中を歩いて機内へ入るので、輪は橋の右の地面に出す（橋の上に輪を重ねない）。
   * 機内食の輪は、積みこみ（load）の輪と同時に出るので、小さい画面で輪が大きくなっても重ならないよう少し左上に */
  const SPOT_AT = { clean: [830, 222], catering: [544, 406] };
  /* 点検スタッフが機体を一周する経路（機首→左側→左エンジンの前→左の主脚→尾翼→右側→右の主脚→右エンジン→機首）。
   * 搭乗橋の下や翼・胴体の下をくぐるところは、上から見るとかくれる（うすいかげだけ出す） */
  /* 尾翼のところは、水平尾翼の先と尾のうしろのコーンの外を回りこむ（尾翼の上を歩かない） */
  const INSPECT_LOOP = [
    [900, 306], [868, 280], [836, 254], [812, 232], [770, 240], [765, 268], [745, 296], [700, 290],
    [656, 292], [596, 298], [556, 254], [520, 254], [486, 290], [482, 324], [486, 358], [520, 394], [556, 394], [596, 350],
    [656, 356], [700, 360], [740, 400], [748, 350], [790, 334], [850, 340],
  ];
  const VEH_ROW = ZONE.veh.y + 26;
  /* 車のおきば: 区画（白線のあいだ）1つに車1台。車の外形（VEH_EXT）と白線のあいだを9ずつあけ、となりの車とは18はなす */
  const VEHICLE_HOME = {
    beltloader: [[485, VEH_ROW, 0]],
    cart: [[600, VEH_ROW, 0], [705, VEH_ROW, 0]],
    fuel: [[813, VEH_ROW, 0]],
    catering: [[921, VEH_ROW, 0]],
    pushback: [[1005, VEH_ROW, 0]],
  };
  const VEH_BAY_LINES = [450, 546, 651, 756, 870, 970, 1046];
  /* 車体の外形（車両ローカル座標: x0, x1, y0, y1）。機体の下にかかっているかの判定に使う */
  const VEH_EXT = { beltloader: [-26, 52, -10, 10], cart: [-45, 42, -10, 10], fuel: [-48, 48, -13, 13], catering: [-42, 40, -14, 14], pushback: [-26, 32, -15, 15] };
  /* 搭乗橋: ターミナルから出る固定通路（背景）→ ロタンダ（回転部）→ のびちぢみする通路 → キャブ。
   * キャブの先（じゃばら）がL1ドアのところの胴体のふちにとどく位置で止まる */
  const L1_EDGE = PLANE_CY - fusHW(DOOR_U.L1) * PK;
  const BRG = { x: 770, rot: [770, 198], rotR: 14, dock: [ux(DOOR_U.L1), +(L1_EDGE - 23.6).toFixed(1)], parkLen: 44, parkAng: 45 };
  const BRIDGE_PATH = [[ux(DOOR_U.L1), L1_EDGE - 1], [ux(DOOR_U.L1), L1_EDGE - 14], [770, 198], [770, 132]];
  const PAX_SIGN = [880, 169];             // 降機・搭乗の人数カウンターの位置

  /* ---------- 背景キャッシュの範囲（左右にはみ出して描く。プッシュバック・出発で機体が左のはしをこえても地面がつづく）。
   * 出発ではカメラは途中で止まり、機体だけが左へ走っていく。カメラが追っても左のはしが出ないよう −700 まで描く
   * （それより外は drawOutside が背景のはしをのばして描く） ---------- */
  const BG_X0 = -700, BG_X1 = SCENE_W + 220;
  /* 誘導路の下の路肩（舗装）の下のはし。プッシュバックで尾がふれても芝に出ないはば。その下は芝 */
  const SHOULDER_Y1 = 726;
  /* シーンの下のそと（路肩と芝）を照明ごとに1回だけ描いておく帯の範囲（その下は芝のタイルだけ） */
  const OUT_BAND_Y0 = SCENE_H - 1, OUT_BAND_Y1 = SCENE_H + 260;
  /* カメラがはじめに入れる範囲: 制限区域と、そのまわりの待機所・車のおきば・押す車 */
  const FOCUS = { x0: 288, x1: 1054, y0: 144, y1: 562 };
  /* エプロンのコンクリートの板の目地（実物の板は約7m角＝68）。x は JOINT_X をとおる JOINT きざみ、y は JOINT_ROWS */
  const JOINT = 68, JOINT_X = 120;
  const JOINT_ROWS = [138, 206, 274, 342, 410, 478, 546, 574];
  /* 'rgba(r,g,b,a)' / '#rrggbb' を [r,g,b,a] に */
  const parseRGBA = (s) => {
    if (s[0] === '#') { const n = parseInt(s.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
    const q = s.slice(s.indexOf('(') + 1, s.indexOf(')')).split(',').map(Number);
    return [q[0], q[1], q[2], q[3] == null ? 1 : q[3]];
  };
  /* 場内の人の大きさ（ずかんの絵は 1 のまま）。機体が実寸の比率なので、人も実寸に近い 0.72（身長約1.9m）にする。
   * 押せる範囲は見た目とは別に、画面上の半径 24px を保つ */
  const PERSON_K = 0.72;
  const PERSON_MID = 7;                    // 人の当たり判定・選択リングの中心（足もとからの高さ）
  /* 選択ラベルなどに使う、かなの職種名（Canvas はルビが振れないので漢字を使わない） */
  const KANA_SHORT = {
    ramp: 'ランプ', baggage: 'てにもつ', cleaning: 'せいそう', maintenance: 'せいび', gate: 'ゲート',
    beltloader: 'ベルト', cart: 'カート', fuel: 'きゅうゆ', catering: 'きないしょく', pushback: 'おすくるま',
  };
  /* 持ち場の色（DOM と同じ。:root の --st-* があればそれを使う）。
   * 「えらんだ人が いける ところ」は --st-target（あかむらさき。チュートリアルの凡例と同じトークン。かんりょうの緑とは別の色） */
  const SPOT_COL = { ready: '#0b6f8a', gather: '#c98a00', accept: '#c026d3', soon: '#8796a8', unlock: '#0b6f8a', done: '#1f7a45', locked: '#5b6b80', paused: '#4a5584' };
  let _spotColRead = false;
  const spotCol = () => {
    if (!_spotColRead && typeof getComputedStyle === 'function' && document.documentElement) {
      _spotColRead = true;
      const cs = getComputedStyle(document.documentElement);
      const pick = (k, v) => { const x = (cs.getPropertyValue(v) || '').trim(); if (/^#[0-9a-f]{6}$/i.test(x)) { SPOT_COL[k] = x; return true; } return false; };
      pick('ready', '--st-ready'); pick('gather', '--st-wait'); pick('done', '--st-done'); pick('locked', '--st-locked'); pick('paused', '--st-paused');
      pick('accept', '--st-target');
      SPOT_COL.unlock = SPOT_COL.ready;
    }
    return SPOT_COL;
  };
  /* #rrggbb を rgba() の文字列に */
  const rgbaOf = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
  /* スマホ（GAME の isNarrow と同じ 700px 以下） */
  const _narrowMQ = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(max-width: 700px)') : null;
  const isNarrowView = () => !!(_narrowMQ && _narrowMQ.matches);
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
      name: 'dusk', sky: ['#3e5480', '#f2a066', '#ffd9a6'], skyMid: [[0.45, '#7d6a96'], [0.75, '#c98a86']],
      /* 太陽は看板（左上のスクリーン層の札）にかくれない位置 */
      sun: { x: 140, y: 26, r: 11, col: '#ff8a3d', glow: '255,150,80', gr: 58 }, cloudBand: null,
      facade: ['#eadfd5', '#d2c6bc'], roof: '#ada19b', roofEdge: '#cfc3b9', tower: '#d9cdc3', towerCab: '#6d6a78',
      win: ['#f3cf92', '#d9a464'], winSheen: 'rgba(255,240,210,.25)', winGlow: 'rgba(255,196,110,.30)',
      apron: ['#b6b2ae', '#a29c98'], apronTint: 'rgba(255,140,70,.07)', warm: 'rgba(255,170,110,.12)',
      taxi: ['#999189', '#8b837c'], shoulder: '#a49c95', grass: '#77805f',
      shadowA: 1.05, shadowL: 1.7, shadowCol: '40,30,50', move: 'rgba(255,130,60,.10)', flood: true, cloud: 'rgba(255,214,186,.9)',
      planeTint: 'rgba(255,160,100,.13)',   // 機体の絵に1回だけ焼きこむ夕日の色（白い胴体だけ昼のままに見えないように）
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
    beltloader: [[-26, -10, 34, 20], [2, -5, 50, 10]],
    cart: [[-45, -10, 87, 20]],
    fuel: [[-48, -13, 96, 26]],
    catering: [[-42, -14, 82, 28]],
    pushback: [[-26, -15, 58, 30]],
  };
  /* 回転灯の位置（キャブの屋根のうしろ。窓をかくさない。車両ローカル座標） */
  const VEH_BEACON = { beltloader: [-17, 0], cart: [-28, 0], fuel: [-32, 0], catering: [-28, 0], pushback: [-4, -8] };
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
  /* 2つめの曲がり（しっぽを東へふる）は大きな半径で、早めに曲がりはじめる。尾が誘導路の下の路肩（y≤SHOULDER_Y1）から
   * 芝へ出ないようにするため。押しおわる位置（主脚 x=PUSH_X）は今までと同じにして、縦の部分を左（x=PUSH_X−PUSH_R2）へよせる */
  const PUSH_R2 = 140, PUSH_X = 100;
  let _push = null, _depart = null;
  const pushPath = () => _push || (_push = taxiPath(PIVOT_X, PLANE_CY, 180, [
    { L: PIVOT_X - (PUSH_X - PUSH_R2 + LEAD_R) }, { R: LEAD_R, a: -90 },
    { L: TAXI_Y - PUSH_R2 - (PLANE_CY + LEAD_R) }, { R: PUSH_R2, a: -90 },
  ]));
  const pushEnd = () => { const p = pushPath(); return p[p.length - 1]; };
  /* 出発の走る長さ: カメラが止まったあと、機体が自分で画面の左（ドロワーの下・キャンバスの外）へ出ていけるだけ（主脚が x=−900 まで）。
   * 背景キャッシュの左はし（BG_X0）より外は drawOutside が地面をのばして描く */
  const DEPART_TO_X = -900;
  const departPath = () => _depart || (_depart = taxiPath(pushEnd().x, pushEnd().y, 180, [{ L: pushEnd().x - DEPART_TO_X }]));

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

  /* コーチのふきだし（初級=ステージ1のみ・節目で流れを実況）。{clean} などは、その作業のアイコンになる */
  const COACH_RULES = [
    { id: 'afterDeboard', when: (s) => s.tasks.deboard.status === 'done',
      msg: 'お客さんが 降りたよ！ つぎは『{clean}機内清掃』と『{catering}機内食』が はじめられる！' },
    { id: 'afterClean', when: (s) => s.tasks.clean.status === 'done',
      msg: '機内が ピカピカ！『{board}乗客の搭乗』を はじめよう。給油や 積み込みは 同時に つづけて いいよ！' },
    { id: 'beforeMatch', when: (s) => s.tasks.board.status === 'done' && s.tasks.load.status === 'done' && s.tasks.bagmatch.status !== 'done',
      msg: 'しあげの『{bagmatch}手荷物照合』！ 乗っていない お客さんの 荷物が ないか 確認しよう。' },
    { id: 'afterDoor', when: (s) => s.tasks.doorclose.status === 'done',
      msg: '{doorclose}ドアクローズ かんりょう！ 点検が すんでいれば『{pushback}プッシュバック』で 出発だ！' },
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
      this._hold = false;
      this._lock = false;
      this._relax = false;
      this._depStop = false;   // 出発で、カメラが機体を追うのをやめたか
      this._fitTMax = 0;       // スマホ: このステージで出た上の余白のいちばん大きい値（はじめの画角の倍率を固定する）
      this._bgFade = null;     // 照明が切りかわるときの背景のクロスフェード
      this._bgLight = null;    // 新しいステージのはじめは、クロスフェードしない（背景キャッシュはステージが同じなら使いまわす）
      this._rainA = 0;         // 雨すじの濃さ（かみなりの雨は 1.5秒でフェード）
      this._rainMode = null;
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
      if (w !== this.cw || h !== this.ch) this._fitTMax = 0;   // 画面の大きさが変わったら、はじめの画角の倍率を決めなおす
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
    /* ⛶ ぜんたい の倍率: 場ぜんたい（1200x640）が安全な範囲（DOM の欄をのぞいた所）に入る倍率（0.45〜1） */
    allZoom() {
      const base = this.baseScale() || 1;
      return clamp(Math.min(this.safeW() / (SCENE_W * base), this.safeH() / (SCENE_H * base)), 0.45, 1);
    },
    /* 引ける下限。⛶ とピンチ・ホイールでは、ぜんたいが見えるところまで引ける */
    zoomFloor() { return Math.min(this.minZoom(), this.allZoom()); },
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
      c.zoom = clamp(c.zoom, this.zoomFloor(), 2.6);
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
    /* カメラの補間の行き先（補間がないときは今）の画角で、シーン座標を画面座標にする。
     * GAME が持ち場ポップを「カメラが止まる所」に合わせて置くのに使う。to={zoom,cx,cy,ins} をわたすと、その画角で計算する。
     * 余白だけを補間しているとき（機体を追っているあいだなど）は、カメラは今の値のまま */
    sceneToScreenAt(x, y, to) {
      const w = to || (this._tween ? this._tween.to : null);
      if (!w) return this.sceneToScreen(x, y);
      const keepCam = !to && this._tween && this._tween.camFixed;
      const I = w.ins || this.insets;
      const z = keepCam || w.zoom == null ? this.cam.zoom : w.zoom;
      const cx = keepCam || w.cx == null ? this.cam.cx : w.cx, cy = keepCam || w.cy == null ? this.cam.cy : w.cy;
      const S = this.baseScale() * z;
      const vx = I.l + (this.cw - I.l - I.r) / 2, vy = I.t + (this.ch - I.t - I.b) / 2;
      return { x: (x - cx) * S + vx, y: (y - cy) * S + vy };
    },
    /* はじめの画角: 制限区域とまわりの待機所・車のおきば（FOCUS）が、安全な範囲いっぱいに入る倍率と位置。
     * スマホでは、上の知らせ（コーチ・ヒント）が出たり消えたりするたびに場ぜんたいがズームしないよう、
     * 倍率はこのステージで出た上の余白のいちばん大きい値（_fitTMax）で決める（知らせの出し消しでは位置だけが動く） */
    fitTarget() {
      const base = this.baseScale();
      let sh = this.safeH();
      if (isNarrowView() && this._fitTMax > this.insets.t) sh = Math.max(40, sh - (this._fitTMax - this.insets.t));
      /* スマホでは、上の知らせ（コーチ）で 見える高さが へっても、倍率 S は 0.3 より小さくしない
       * （引きすぎると 人・車・進み具合の輪が 小さくなりすぎて 読めない。はみ出た上下は 知らせ・ズームのボタンの下に少し入る） */
      const zMin = isNarrowView() && base > 0 ? Math.max(this.minZoom(), 0.3 / base) : this.minZoom();
      const z = clamp(Math.min(this.safeW() / ((FOCUS.x1 - FOCUS.x0) * base), sh / ((FOCUS.y1 - FOCUS.y0) * base)), zMin, 2.6);
      const R = this.camRange(z, false);
      return { zoom: z, cx: clamp((FOCUS.x0 + FOCUS.x1) / 2, R.x[0], R.x[1]), cy: clamp((FOCUS.y0 + FOCUS.y1) / 2, R.y[0], R.y[1]) };
    },
    /* ⛶ ぜんたい: 場ぜんたいが安全な範囲に入る倍率（allZoom）。中心は安全な範囲の中心 */
    allTarget() {
      const z = this.allZoom();
      const R = this.camRange(z, false);
      return { zoom: z, cx: clamp(600, R.x[0], R.x[1]), cy: clamp(330, R.y[0], R.y[1]) };
    },
    /* 出発しきったあとに、もどる画角（⛶ ぜんたい のときは ぜんたい、それ以外は はじめの画角） */
    homeTarget() { return this.camMode === 'all' ? this.allTarget() : this.fitTarget(); },
    /* GAME から: ドロワーの開け閉めなどで、安全な範囲が変わったら呼ぶ（{l,r,t,b} はキャンバスの画面座標の余白px）。
     * 約束: わたした辺だけを、その値にする。わたさなかった辺は、ひきつづき DOM の欄（スコア・スタッフ・ズームのボタン）を測る。
     * どれか1辺でもわたしたら、作業カードのドロワー（panel-tasks）は GAME が知らせるものとして測らない。
     * 4辺ともわたすと、DOM は測らない（ズームのボタンなどの欄も GAME の値にふくめること）。 */
    setViewInsets(ins) {
      const g = {};
      ['l', 'r', 't', 'b'].forEach((s) => { if (ins && ins[s] != null && isFinite(+ins[s])) g[s] = Math.max(0, +ins[s]); });
      this._given = g;
      this._insetsSet = ['l', 'r', 't', 'b'].every((s) => g[s] != null);
      this.pollInsets(0, true);
    },
    _applyInsets(ins, animate) {
      const n = { l: Math.max(0, +ins.l || 0), r: Math.max(0, +ins.r || 0), t: Math.max(0, +ins.t || 0), b: Math.max(0, +ins.b || 0) };
      /* 欄が大きすぎて安全な範囲がせまくなりすぎるときは、その向きの余白をあきらめる */
      if (this.cw && this.cw - n.l - n.r < this.cw * 0.35) { n.l = 0; n.r = 0; }
      if (this.ch && this.ch - n.t - n.b < this.ch * 0.35) { n.t = 0; n.b = 0; }
      if (isNarrowView()) this._fitTMax = Math.max(this._fitTMax || 0, n.t);
      const w = this._tween;
      const o = w ? w.to.ins : this.insets;
      if (Math.abs(o.l - n.l) < 1 && Math.abs(o.r - n.r) < 1 && Math.abs(o.t - n.t) < 1 && Math.abs(o.b - n.b) < 1) return;
      if (!this.cw || !this.ch || this._needFit) { this._endTween(); this.insets = n; return; }
      /* 補間のとちゅうに次の変化が来ても、前の補間を一気に終わらせない（カメラがとぶ）。
       * いまの値（stepTween が毎フレーム書いている、補間とちゅうの値）から新しい補間を始める */
      const from = { zoom: this.cam.zoom, cx: this.cam.cx, cy: this.cam.cy, ins: { ...this.insets } };
      /* 出発しきったあと駐機場へもどる補間のとちゅうなら、新しい範囲で行き先を決めなおして、のこりの時間でもどる */
      const home = !!(w && w.home);
      /* 機体を追っている・到着してくる・プッシュバックと出発のあいだ・出発しきったあとの余韻（_lock）は、
       * カメラは動かさず余白だけを補間する（駐機位置へとび戻って、機体がドロワーの下に消えないように） */
      const fixed = !home && !!(this._follow || this._lock || this.arrivalT != null);
      this.insets = n;
      /* はじめの画角・ぜんたいのままなら、新しい範囲で決めなおす。自分で動かしたあとは、見ていた所を新しい範囲の中心に */
      const to = home ? this.homeTarget()
        : fixed ? { zoom: this.cam.zoom, cx: this.cam.cx, cy: this.cam.cy }
        : this.camMode === 'fit' ? this.fitTarget() : this.camMode === 'all' ? this.allTarget()
        : (() => { const R = this.camRange(this.cam.zoom, !!this._relax); return { zoom: this.cam.zoom, cx: clamp(this.cam.cx, R.x[0], R.x[1]), cy: clamp(this.cam.cy, R.y[0], R.y[1]) }; })();
      to.ins = n;
      this.insets = from.ins;
      if (!animate || reduceMotion()) {
        this._tween = null;
        this.insets = n;
        if (!fixed) Object.assign(this.cam, { zoom: to.zoom, cx: to.cx, cy: to.cy });
        return;
      }
      this._tween = { t: 0, dur: home ? Math.max(0.25, w.dur - w.t) : 0.25, from, to, camFixed: fixed, home };
    },
    stepTween(dt) {
      const w = this._tween;
      if (!w) return;
      w.t += dt;
      const k = clamp(w.t / w.dur, 0, 1), e = k * k * (3 - 2 * k);
      const L = (a, b) => a + (b - a) * e;
      if (!w.camFixed) {
        this.cam.zoom = L(w.from.zoom, w.to.zoom);
        this.cam.cx = L(w.from.cx, w.to.cx);
        this.cam.cy = L(w.from.cy, w.to.cy);
      }
      ['l', 'r', 't', 'b'].forEach((s) => { this.insets[s] = L(w.from.ins[s], w.to.ins[s]); });
      if (k >= 1) this._tween = null;
    },
    _endTween() {
      const w = this._tween;
      if (!w) return;
      this._tween = null;
      this.insets = { ...w.to.ins };
      if (!w.camFixed) Object.assign(this.cam, { zoom: w.to.zoom, cx: w.to.cx, cy: w.to.cy });
    },
    /* 出発しきったら（機体はもう画面の外）、約1秒かけて駐機場の画角へもどす（とばない）。もどしおえたら、その場で止める */
    _startHome() {
      const w = this._tween;
      const ins = w ? { ...w.to.ins } : { ...this.insets };
      const cur = this.insets;
      this.insets = ins;
      const to = this.homeTarget();
      this.insets = cur;
      to.ins = ins;
      if (reduceMotion()) {
        this._tween = null;
        this.insets = ins;
        Object.assign(this.cam, { zoom: to.zoom, cx: to.cx, cy: to.cy });
        return;
      }
      this._tween = { t: 0, dur: 1.0, from: { zoom: this.cam.zoom, cx: this.cam.cx, cy: this.cam.cy, ins: { ...cur } }, to, home: true };
    },
    /* 安全な範囲を決める（0.4秒ごと）。setViewInsets でわたされた辺はその値、わたされていない辺は DOM の欄を測った値 */
    pollInsets(dt, force) {
      if (!this.cw) return;
      const g = this._given || {};
      if (this._insetsSet) {
        if (force) this._applyInsets(g, true);
        return;
      }
      this._pollT = (this._pollT || 0) - dt;
      if (this._pollT > 0 && !force) return;
      this._pollT = 0.4;
      const f = this.freeRect(Object.keys(g).length > 0);
      const m = { l: f.l, r: this.cw - f.r, t: f.t, b: this.ch - f.b };
      const n = {};
      ['l', 'r', 't', 'b'].forEach((s) => { n[s] = g[s] != null ? g[s] : m[s]; });
      this._applyInsets(n, true);
    },
    /* キャンバスの上にときどき出る DOM（ストップ中の札・ヒント・知らせ・ズームのボタン・作業のタブなど）の矩形を測る（0.4秒ごと）。
     * 案内板（看板・GATE・区画の名前）は、これに重なるときは描かない（半分かくれた案内板を出さない） */
    pollCovers(dt) {
      this._coverT = (this._coverT || 0) - dt;
      if (this._coverT > 0 || !this.canvas || !this.canvas.getBoundingClientRect) return;
      this._coverT = 0.4;
      const cv = this.canvas.getBoundingClientRect(), out = [];
      const els = ['pause-chip', 'hint-banner', 'event-banner', 'zoom-ctrl', 'spot-pop', 'btn-drawer-tasks'].map((id) => document.getElementById(id));
      const ta = document.getElementById('toast-area');
      if (ta) els.push(...ta.children);
      els.forEach((el) => {
        if (!el || el.classList.contains('hidden')) return;
        const q = el.getBoundingClientRect();
        if (q.width < 1 || q.height < 1) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return;
        const r = { l: q.left - cv.left, t: q.top - cv.top, r: q.right - cv.left, b: q.bottom - cv.top };
        if (r.r <= 0 || r.b <= 0 || r.l >= this.cw || r.t >= this.ch) return;
        out.push(r);
      });
      this._covers = out;
      /* キャンバスの上にのる 欄（スコア板・スタッフ帯・作業カード・コーチ）の矩形。区画の看板だけが使う
       * （看板は 安全な範囲の外（insets の帯）でも、欄が のっていない所なら置ける） */
      const ov = [];
      ['panel-status', 'panel-resources', 'panel-tasks', 'coach-bubble', 'drawer-nudge', 'staff-pick'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.classList.contains('hidden') || el.classList.contains('closed')) return;
        const q = el.getBoundingClientRect();
        if (q.width < 1 || q.height < 1) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const r = { l: q.left - cv.left, t: q.top - cv.top, r: q.right - cv.left, b: q.bottom - cv.top };
        if (r.r <= 0 || r.b <= 0 || r.l >= this.cw || r.t >= this.ch) return;
        ov.push(r);
      });
      this._overlays = ov;
    },
    /* 自分でズーム・パンしたら、機体を追うのをやめる */
    _userCam(mode) {
      this._endTween();
      this._needFit = false;   // はじめの画角を決める前に自分で動かしたら、その画角を優先する
      this.camMode = mode || 'user';
      if (this._follow || this._lock) this._followOff = true;
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
      /* 出発しきったあと（結果の画面までの余韻）は、カメラをその場で止める。ゆるい範囲のままにして、はしでとばない */
      const hold = dep === 'done';
      /* 出発しきったら（機体はもう画面の外へ出ている）、約1秒かけて駐機場の画角へもどしてから止める。
       * 自分でズーム・パンして機体を追うのをやめていたときは、見ている所のまま */
      if (hold && !this._hold && !this._followOff) this._startHome();
      this._hold = hold;
      this._lock = phase || hold;
      this._relax = phase || hold || !!this._tween;   // 補間のあいだは、ゆるい範囲のまま（はしでとばない）
      /* 出発: 機体を追いつづけ（カメラは誘導路の左はしで止まる）、機体の後ろはし（右のはし。影のぶんの余白つき）が
       * 安全な範囲の左はし（insets.l。広い画面ではドロワーの右はし）より左へ出てから、追うのをやめてカメラを止める。
       * 見えている地面の上で機体がドロワーの下へすべりこまない。そのあとは機体が自分で画面の左へ走っていく（半透明にして消さない） */
      if (dep === 'active' && !this._depStop && this.cw && tr) {
        const b = this.planeScreenBox({ x: tr.x + PIVOT_X, y: tr.y + PLANE_CY, h: tr.rot }, 24);
        if (b.x1 < this.insets.l) this._depStop = true;
      }
      this._follow = phase && !this._followOff && !this._depStop && tr.alpha > 0.05 ? true : null;
      /* 余白だけの補間（camFixed）のあいだは追いつづける。カメラを動かす補間（到着から はじめの画角へ など）のあいだは止める */
      if (!this._follow || (this._tween && !this._tween.camFixed)) return;
      const m = this.transformPoint(PLANE_MID[0], PLANE_MID[1], tr);
      const R = this.camRange(this.cam.zoom, true);
      const tx = clamp(m.x, R.x[0], R.x[1]), ty = clamp(m.y + 10, R.y[0], R.y[1]);
      const k = 1 - Math.exp(-dt * 2.2);
      this.cam.cx += (tx - this.cam.cx) * k;
      this.cam.cy += (ty - this.cam.cy) * k;
    },
    /* キャンバスのうち、上にのっているDOMの欄（右のスコア・下のスタッフ・左の作業カード・右下のズームのボタン）をのぞいた、
     * 見えている範囲（キャンバスの画面座標）。欄が大きすぎるときはキャンバス全体を返す。
     * skipDrawer=true のときは、作業カードのドロワーを測らない（GAME が setViewInsets で知らせる） */
    freeRect(skipDrawer) {
      const full = { l: 0, t: 0, r: this.cw, b: this.ch };
      if (!this.canvas || !this.canvas.getBoundingClientRect) return full;
      const cv = this.canvas.getBoundingClientRect();
      const f = { ...full };
      const boxOf = (id) => {
        const el = document.getElementById(id);
        if (!el || el.classList.contains('closed') || el.classList.contains('hidden')) return null;   // とじた作業カード（とじる途中のアニメーションも）は数えない
        const q = el.getBoundingClientRect();
        const b = { x0: q.left - cv.left, x1: q.right - cv.left, y0: q.top - cv.top, y1: q.bottom - cv.top };
        if (q.width < 1 || q.height < 1 || b.x1 <= 0 || b.x0 >= this.cw || b.y1 <= 0 || b.y0 >= this.ch) return null;
        b.wide = b.x1 - b.x0 > this.cw * 0.6;
        return b;
      };
      const boxes = ['panel-status', 'panel-resources'].concat(skipDrawer ? [] : ['panel-tasks']).map(boxOf).filter(Boolean);
      /* 横に長い欄（下のスタッフ欄など）は上か下の余白 */
      boxes.filter((b) => b.wide).forEach((b) => {
        if (b.y0 > this.ch / 2) f.b = Math.min(f.b, b.y0); else f.t = Math.max(f.t, b.y1);
      });
      /* 横の欄（作業カード・スコア・ズームのボタン）は、左右の余白にするか、上下の余白にするかを、
       * はじめの画角（FOCUS）が大きく入るほうにする（縦長の画面で右上だけにある欄は上の余白に） */
      const fit = (r) => Math.min((r.r - r.l) / (FOCUS.x1 - FOCUS.x0), (r.b - r.t) / (FOCUS.y1 - FOCUS.y0));
      const small = (r) => r.r - r.l < this.cw * 0.45 || r.b - r.t < this.ch * 0.45;
      const addBox = (b) => {
        const side = { ...f }, vert = { ...f };
        if (b.x0 > this.cw / 2) side.r = Math.min(side.r, b.x0); else side.l = Math.max(side.l, b.x1);
        if (b.y0 + b.y1 < this.ch) vert.t = Math.max(vert.t, b.y1); else vert.b = Math.min(vert.b, b.y0);
        return fit(vert) > fit(side) * 1.08 ? vert : side;
      };
      boxes.filter((b) => !b.wide).forEach((b) => Object.assign(f, addBox(b)));
      if (small(f)) return full;
      /* ズームのボタン（右下）: 車のおきばがボタンの下にかくれないよう、ボタンも余白にする。
       * そのせいで安全な範囲がせまくなりすぎるときは、ボタンだけあきらめる */
      const z = boxOf('zoom-ctrl');
      if (z && z.x1 > f.l && z.x0 < f.r && z.y1 > f.t && z.y0 < f.b) {
        const g = addBox(z);
        if (!small(g)) Object.assign(f, g);
      }
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
        const inView = (q) => q.x > I.l && q.x < this.cw - I.r && q.y > I.t && q.y < this.ch - I.b;
        if (this._pushActive && this._lastTr) {
          /* プッシュバック中は「機首+押す車」の中心へ（押す車がスコア板の下に かくれない） */
          const n = this.transformPoint(NOSE_X, PLANE_CY, this._lastTr), t = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1], this._lastTr);
          const mid = { x: (n.x + t.x) / 2, y: (n.y + t.y) / 2 };
          if (inView(this.sceneToScreen(mid.x, mid.y))) anchor = mid;
        } else {
          const m = this.sceneToScreen(PLANE_MID[0], PLANE_MID[1]);
          if (this._planeHome !== false && inView(m)) anchor = { x: PLANE_MID[0], y: PLANE_MID[1] };
        }
      }
      const before = anchor || this.screenToScene(pivot.x, pivot.y);
      this.cam.zoom = clamp(this.cam.zoom * factor, this.zoomFloor(), 2.6);
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
    /* GAME から: シーンの点 (x,y) を 安全な範囲の まん中へ（いまの倍率のまま。範囲のはしでは そこまで）。約0.35秒の補間で動かす。
     * 持ち場ポップを開くとき、持ち場が 安全な範囲の外（画面の外・ドロワーの下）にあるときに使う。自分で動かしたのと同じあつかい */
    focusOn(x, y) {
      if (!this.cw || !this.ch) return;
      const w = this._tween;
      const ins = w ? { ...w.to.ins } : { ...this.insets };
      const zoom = w && !w.camFixed && w.to.zoom != null ? w.to.zoom : this.cam.zoom;
      const from = { zoom: this.cam.zoom, cx: this.cam.cx, cy: this.cam.cy, ins: { ...this.insets } };
      this._tween = null;   // _userCam で 補間を一気に終わらせない（とばない）
      this._userCam();
      const cur = this.insets;
      this.insets = ins;
      const R = this.camRange(zoom, !!this._relax);
      this.insets = cur;
      const to = { zoom, cx: clamp(x, R.x[0], R.x[1]), cy: clamp(y, R.y[0], R.y[1]), ins };
      if (reduceMotion()) { this.insets = ins; Object.assign(this.cam, { zoom, cx: to.cx, cy: to.cy }); return; }
      this._tween = { t: 0, dur: 0.35, from, to };
    },
    /* 安全な範囲（補間のとちゅうなら 行き先の範囲） */
    safeRectAt() {
      const I = this._tween ? this._tween.to.ins : this.insets;
      return { l: I.l, t: I.t, r: this.cw - I.r, b: this.ch - I.b };
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
    /* 作業スポットの代表点（リング・バッジ・タップ判定・持ち場ポップの位置に使う）。
     * プッシュバックの作業中は、機体といっしょに動く押す車の所（進み具合の輪・celebrate と同じ点）。
     * カメラが機体を追っても、ポップ・タップの場所が 押す車と輪から はなれない */
    anchorOf(taskId) {
      const gs = window.Game && window.Game.state;
      if (taskId === 'pushback' && this._lastTr && gs && gs.tasks.pushback && gs.tasks.pushback.status === 'active') {
        const p = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1], this._lastTr);
        return [p.x, p.y];
      }
      if (SPOT_AT[taskId]) return SPOT_AT[taskId];
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
      if (e.kind === 'staff') return [rec.pos.x, rec.pos.y - PERSON_MID * this.personK()];
      const ex = VEH_EXT[e.type] || [-40, 40, -12, 12];
      const mx = (ex[0] + ex[1]) / 2, a = rec.drawAngle != null ? rec.drawAngle : rec.angle;
      return [rec.pos.x + Math.cos(a) * mx, rec.pos.y + Math.sin(a) * mx];
    },
    /* 小さい画面で持ち場・予告・進行リング・スキルの印だけを大きくする倍率（人と車には掛けない）。
     * 1.6倍まで（それより大きくすると、となりの輪どうしが重なって機体の翼・機首をおおう） */
    spotK() { const S = this.scale() || 1; return Math.min(1.6, Math.max(1, 0.6 / S)); },
    /* 小さい画面（S<0.6）では、人も少し大きく描く（見つけやすく・押しやすく。最大1.6倍）。当たり判定・選択リングの中心も合わせる */
    personK() { const S = this.scale() || 1; return S < 0.6 ? Math.min(1.6, 0.6 / S) : 1; },

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

    /* ---------- 演出（パーティクル・浮き文字） ----------
     * 粒はスクリーン座標（画面px）で持つ。k は画面の大きさに合わせた倍率 */
    burst(x, y, n, colors, k) {
      k = k || 1;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const sp = (40 + Math.random() * 90) * k;
        this.fx.parts.push({
          x, y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 50 * k,
          life: 0.9 + Math.random() * 0.5,
          age: 0,
          g: 160 * k,
          size: (2.5 + Math.random() * 3) * k,
          color: colors[i % colors.length],
        });
      }
    },
    /* 知らせの札（スクリーン層に、白い角丸の札で出す。上へは動かさない）。
     * scr=true の札は、シーンではなく安全な範囲（DOM の欄をのぞいた所）のまん中より少し上に出す */
    float(x, y, text, color, scr) {
      this.fx.floats.push({ x, y, text, color: color || '#1e3a5f', life: 2.2, age: 0, scr: !!scr });
    },
    /* 作業がおわったとき: ふだんは静かに（持ち場で緑の輪が1回広がり、「かんりょう」の札が1.2秒）。
     * 紙ふぶきの粒は、出発してクリアしたときだけ。出発の札と粒は、カメラではなく安全な範囲を基準に置く
     * （出発しきったあとカメラは止まるが、欄が開け閉めされても札と粒が欄の下に入らない） */
    celebrate(state, taskId) {
      if (taskId === 'depart') {
        const clear = !(state.flags && state.flags.critical);
        if (clear && !reduceMotion() && this.cw) {
          const colors = ['#ffd166', '#57c98a', '#3bb0f2', '#f2544a', '#b07fe6'];
          const I = this.insets, w = this.safeW(), h = this.safeH(), k = clamp(this.scale(), 0.6, 1.3);
          for (let i = 0; i < 5; i++) this.burst(I.l + w * (0.18 + i * 0.16), I.t + h * 0.42, 12, colors, k);
        }
        this.float(0, 0, clear ? 'いってらっしゃい！' : 'しゅっぱつ', '#0b5f78', true);
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
    /* 粒（クリアのときだけ）。スクリーン座標で、安全な範囲の中だけに描く（drawLabelsScreen から呼ぶ） */
    drawFxScreen(dtReal) {
      this.fx.parts = this.fx.parts.filter((p) => (p.age += dtReal) < p.life);
      if (!this.fx.parts.length) return;
      const c = this.ctx, I = this.insets;
      c.save();
      c.beginPath(); c.rect(I.l, I.t, this.safeW(), this.safeH()); c.clip();
      this.fx.parts.forEach((p) => {
        p.x += p.vx * dtReal;
        p.y += p.vy * dtReal;
        p.vy += p.g * dtReal;
        c.globalAlpha = clamp(1 - p.age / p.life, 0, 1);
        c.fillStyle = p.color;
        c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      });
      c.restore();
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

    /* 毎フレームの DOM の計測（キャンバスの大きさ・安全な範囲・ときどき出る DOM の矩形）だけを先にする。
     * GAME のループが Game.tick（DOM の書きかえ）より前に呼べば、ブラウザがレイアウトをすませた直後に読むので、
     * 強制レイアウトが起きない。呼ばれないときは、今までどおり draw の中で測る */
    preFrame(dtReal) {
      if (!this.canvas) return;
      this.resize();
      if (!this.cw || !this.ch) return;
      this.pollInsets(dtReal, this._needFit);
      this.pollCovers(dtReal);
      this._premeasured = true;
    },
    draw(state, dtReal, ui) {
      if (!this.ctx) return;
      const pre = !!this._premeasured;
      this._premeasured = false;
      if (!pre) this.resize();
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
        if (!pre) {
          this.pollInsets(dtReal, this._needFit);
          this.pollCovers(dtReal);
        }
        if (this._needFit) {
          this._needFit = false;
          this.camMode = 'fit';
          Object.assign(this.cam, this.fitTarget());
        }
        this.stepTween(dtReal);
      }
      const tr = state ? this.planeTransform(state) : null;
      /* ボタンで拡大・縮小するときの基準（zoomAt）に使う */
      this._lastTr = tr;
      this._pushActive = !!(state && state.tasks.pushback.status === 'active');
      if (state && this.cw) this.updateFollow(state, tr, dtReal);
      this.clampCam();

      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.cw, this.ch);
      c.fillStyle = L.taxi[1];
      c.fillRect(0, 0, this.cw, this.ch);
      if (!this.cw || !this.ch) return;

      c.save();
      const v = this.viewCenter(), S = this.scale();
      c.translate(v.x, v.y);
      c.scale(S, S);
      c.translate(-this.cam.cx, -this.cam.cy);

      this.ensureBg(state);
      /* 照明が切りかわったとき（かみなりの始まり・終わり）は、約1.5秒で前の照明から新しい照明へクロスフェードする */
      const F = this._bgFade, fk = F ? this.bgFadeK() : 1;
      if (F) { this.drawOutside(F.fromL, 1); this.drawOutside(L, fk); } else this.drawOutside(L, 1);
      this.drawBgVisible();
      this.drawGroundLinesSharp();
      this.drawSkyLife(state);
      this.addSignLabels(state);
      this._spotDiscs = [];
      this._ringDiscs = [];
      this._ents = null;
      if (state) {
        this.updateBridge(state, dtReal);
        this._planeHome = this.arrivalT == null && Math.abs(tr.x) + Math.abs(tr.y) + Math.abs(tr.rot) < 0.5;
        const ents = this.layoutEntities(state, gt, tr, dtReal);
        this._ents = ents;   // 区画の看板が、区画の中に とまっている人・車を よけるのに使う
        /* 雨の地面の波紋は地面の層（機体・車・人・持ち場の輪の下）に描く */
        this.drawRainGround(state, dtReal);
        /* 到着してくるあいだは、持ち場のサークルより機体を上に（走ってくる機体の下にかくれる） */
        const arriving = this.arrivalT != null;
        if (arriving) this.drawSpotLayer(state, ui, dtReal);
        /* 重なり順: 地面の物（雨の波紋・コーン・搭乗橋の影）→ 機体の下にいる物 → トーバー → 機体 → 搭乗橋の下をくぐる人
         * → 搭乗橋の床 → 搭乗橋の中の人・乗客 → ガラスの屋根 → そのほか */
        this.drawCones(state);
        this.drawBridgeShadow();
        this.drawEntityLayer(state, ents, 'under', gt);
        this.drawTowbar(state, ents, tr);
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
        /* 照明の色（夕方の暖色・雨の寒色）を、動く物の上に1回だけかぶせる。
         * 持ち場の輪とアイコンの所はぬかす（契約の色のまま）。スキルの印・選択・進み具合の輪・文字はこのあと */
        if (F) { this.drawMoveTint(F.fromL, 1 - fk); this.drawMoveTint(L, fk); } else this.drawMoveTint(L, 1);
        this.drawBadges(state, ents);
        this.drawSelection(state, ents, ui);
        this.drawRings(state, tr);
        this.drawPaxCounter(state);
      }
      c.restore();
      /* 雨すじは画面の座標で描く（ズームしても太さ・長さが同じ） */
      if (state) this.drawRain(state, dtReal);
      this.drawLabelsScreen(state, dtReal);
      this.stepBgFade(dtReal);
    },
    /* 背景キャッシュのうち、画面に見えている所だけを貼る（クロスフェード中は前の照明の絵の上に新しい絵を重ねる） */
    drawBgVisible() {
      if (!this.bgCanvas) return;
      const B = this.viewBounds(), k = this._bgK || 2;
      const x0 = Math.max(BG_X0, Math.floor(B.x0) - 2), x1 = Math.min(BG_X1, Math.ceil(B.x1) + 2);
      const y0 = Math.max(0, Math.floor(B.y0) - 2), y1 = Math.min(SCENE_H, Math.ceil(B.y1) + 2);
      if (x1 <= x0 || y1 <= y0) return;
      const c = this.ctx, F = this._bgFade;
      const blit = (cv) => c.drawImage(cv, (x0 - BG_X0) * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k, x0, y0, x1 - x0, y1 - y0);
      if (F && F.from && F.from.width) {
        blit(F.from);
        c.globalAlpha = this.bgFadeK();
        blit(this.bgCanvas);
        c.globalAlpha = 1;
      } else blit(this.bgCanvas);
    },
    /* クロスフェードの進み（0..1。なめらかに） */
    bgFadeK() {
      const F = this._bgFade;
      if (!F) return 1;
      const k = clamp(F.t / F.dur, 0, 1);
      return k * k * (3 - 2 * k);
    },
    stepBgFade(dt) {
      const F = this._bgFade;
      if (!F) return;
      F.t += dt;
      if (F.t < F.dur) return;
      /* おわったら、前の照明の背景を手放す（このステージでもう使わない） */
      this._bgFade = null;
      if (F.from && F.from !== this.bgCanvas) {
        Object.keys(this._bgs || {}).forEach((n) => { if (this._bgs[n] === F.from) delete this._bgs[n]; });
        F.from.width = 0; F.from.height = 0;
      }
    },

    /* いま画面に見えている範囲（シーン座標） */
    viewBounds() {
      const a = this.screenToScene(0, 0), b = this.screenToScene(this.cw, this.ch);
      return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    },
    /* シーンの外（縦長の画面やズームアウトで見える所）: 上は空のつづき、下は誘導路の路肩と芝、左右は背景のはしをのばす。
     * a は不透明度（照明のクロスフェード用）。下の路肩と芝は、照明ごとに1回だけ描いた帯（outsideBand）を貼る */
    drawOutside(L, a) {
      if (!this.bgCanvas) return;
      const c = this.ctx, B = this.viewBounds();
      const x0 = B.x0 - 4, x1 = B.x1 + 4;
      a = a == null ? 1 : a;
      if (a <= 0.001) return;
      c.globalAlpha = a;
      if (B.y0 < 0) {
        const key = 'sky:' + L.name;
        this._grad = this._grad || {};
        if (!this._grad[key]) {
          /* 上が濃く、y=0 で背景の空の色につながる。夕方は青→紫→ばら色→だいだいと、とちゅうの色を入れて茶色にくすませない */
          const g = c.createLinearGradient(0, -620, 0, 0);
          g.addColorStop(0, L.sky[0]);
          (L.skyMid || []).forEach(([p, col]) => g.addColorStop(p, col));
          g.addColorStop(1, L.sky[1]);
          this._grad[key] = g;
        }
        c.fillStyle = this._grad[key];
        c.fillRect(x0, B.y0 - 4, x1 - x0, -B.y0 + 4.5);
      }
      if (B.y1 > SCENE_H) {
        const y1 = B.y1 + 4;
        /* 帯（背景キャッシュと同じ左右のはば）を貼る。帯より左右の外は、その場で描く（機体を追って左のはしの外が見えるときだけ） */
        const band = this.outsideBand(L);
        const bx0 = Math.max(x0, BG_X0), bx1 = Math.min(x1, BG_X1), by1 = Math.min(y1, OUT_BAND_Y1);
        if (bx1 > bx0 && by1 > OUT_BAND_Y0) {
          c.drawImage(band, bx0 - BG_X0, 0, bx1 - bx0, by1 - OUT_BAND_Y0, bx0, OUT_BAND_Y0, bx1 - bx0, by1 - OUT_BAND_Y0);
        }
        if (x0 < BG_X0) this.paintOutsideBottom(c, L, x0, Math.min(x1, BG_X0), Math.min(y1, OUT_BAND_Y1), a, this.noisePat(c));
        if (x1 > BG_X1) this.paintOutsideBottom(c, L, Math.max(x0, BG_X1), x1, Math.min(y1, OUT_BAND_Y1), a, this.noisePat(c));
        /* 帯より下は芝だけ（芝の色とノイズを焼きこんだ小さなタイルのくり返し） */
        if (y1 > OUT_BAND_Y1) {
          c.globalAlpha = a;
          c.fillStyle = this.grassPat(c, L);
          c.fillRect(x0, OUT_BAND_Y1 - 0.5, x1 - x0, y1 - OUT_BAND_Y1 + 0.5);
        }
      }
      const H2 = this.bgCanvas.height, W2 = this.bgCanvas.width;
      const side = (p, q) => {
        c.globalAlpha = a * 0.7; c.fillStyle = this.noisePat(c); c.fillRect(p, 138, q - p, SCENE_H - 138); c.globalAlpha = a;
      };
      c.globalAlpha = a;
      if (x0 < BG_X0) { c.drawImage(this.bgCanvas, 0, 0, 1, H2, x0, 0, BG_X0 - x0 + 0.5, SCENE_H); side(x0, BG_X0); }
      if (x1 > BG_X1) { c.drawImage(this.bgCanvas, W2 - 1, 0, 1, H2, BG_X1 - 0.5, 0, x1 - BG_X1 + 0.5, SCENE_H); side(BG_X1, x1); }
      c.globalAlpha = 1;
    },
    /* ノイズの模様（メインのキャンバスでは1つをおぼえて使う） */
    noisePat(c) {
      if (c === this.ctx && this._noisePat) return this._noisePat;
      const p = c.createPattern(this.noiseTile(), 'repeat');
      if (c === this.ctx) this._noisePat = p;
      return p;
    },
    /* 芝のタイル（芝の色+ノイズ。照明ごと） */
    grassPat(c, L) {
      this._grassPat = this._grassPat || {};
      if (this._grassPat[L.name]) return this._grassPat[L.name];
      const t = document.createElement('canvas');
      t.width = t.height = 96;
      const g = t.getContext('2d');
      g.fillStyle = L.grass; g.fillRect(0, 0, 96, 96);
      g.globalAlpha = 0.9; g.drawImage(this.noiseTile(), 0, 0);
      return (this._grassPat[L.name] = c.createPattern(t, 'repeat'));
    },
    /* 誘導路の下の路肩（舗装。プッシュバックで尾がふれても芝に出ない広さ）→ 芝。x0〜x1、y は SCENE_H〜y1 を描く */
    paintOutsideBottom(c, L, x0, x1, y1, a, noise) {
      if (x1 <= x0) return;
      const sh = SHOULDER_Y1;
      c.globalAlpha = a;
      c.fillStyle = L.shoulder;
      c.fillRect(x0, SCENE_H - 0.5, x1 - x0, sh - SCENE_H + 0.5);
      c.fillStyle = L.grass;
      c.fillRect(x0, sh, x1 - x0, Math.max(0, y1 - sh));
      c.globalAlpha = a * 0.9;
      c.fillStyle = noise;
      c.fillRect(x0, SCENE_H - 0.5, x1 - x0, y1 - SCENE_H + 0.5);
      const h01 = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
      /* 路肩の黄色いしま（使わない路肩のしるし）。誘導灯のあいだに、うすく */
      c.strokeStyle = L.yel; c.globalAlpha = a * 0.42; c.lineWidth = 2.2;
      c.beginPath();
      for (let x = Math.floor((x0 - 90) / 180) * 180 + 90; x < x1; x += 180) { c.moveTo(x, SCENE_H + 4); c.lineTo(x, sh - 7); }
      c.stroke();
      c.globalAlpha = a;
      /* 路肩と芝の境（芝がわに陰） */
      c.fillStyle = 'rgba(30,45,30,.20)';
      c.fillRect(x0, sh, x1 - x0, 2.5);
      c.fillStyle = 'rgba(255,255,255,.10)';
      c.fillRect(x0, sh - 1.5, x1 - x0, 1.2);
      /* ところどころの濃い草（大きさ・向き・位置をばらつかせる） */
      c.fillStyle = 'rgba(40,60,35,.10)';
      for (let x = Math.floor(x0 / 70) * 70; x < x1; x += 70) {
        const i = Math.round(x / 70);
        for (let j = 0; j < 2; j++) {
          const p = h01(i, j + 1), b = h01(i, j + 7), d = h01(i, j + 13);
          c.beginPath();
          c.ellipse(x + p * 70, sh + 18 + b * 64 + j * 30, 14 + d * 30, 4 + p * 6, (b - 0.5) * 0.5, 0, TAU);
          c.fill();
        }
      }
      c.globalAlpha = 1;
    },
    /* 下の路肩と芝の帯（x は BG_X0〜BG_X1、y は OUT_BAND_Y0〜OUT_BAND_Y1）を、照明ごとに1回だけ 1倍で描いておく
     * （中身は低周波なので1倍で足りる。毎フレームは drawImage 1回） */
    outsideBand(L) {
      this._bands = this._bands || {};
      if (this._bands[L.name]) return this._bands[L.name];
      const cv = document.createElement('canvas');
      cv.width = BG_X1 - BG_X0; cv.height = OUT_BAND_Y1 - OUT_BAND_Y0;
      const g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, -BG_X0, -OUT_BAND_Y0);
      this.paintOutsideBottom(g, L, BG_X0, BG_X1, OUT_BAND_Y1, 1, g.createPattern(this.noiseTile(), 'repeat'));
      return (this._bands[L.name] = cv);
    },
    /* 動く物にかぶせる照明の色（夕方・雨・くもり・かみなり）。a は不透明度（クロスフェード用）。
     * 持ち場の輪（drawSoonSpots・drawSpots が _spotDiscs におぼえた円）は、くりぬいて色をかけない（契約の色を守る）。
     * 輪どうしが重なっても、重なった所に色がもどらないよう、輪を1つずつくりぬいた範囲を重ねて clip する（くりぬきの和集合） */
    drawMoveTint(L, a) {
      if (!L.move || a <= 0.001) return;
      const c = this.ctx, B = this.viewBounds();
      const x = B.x0 - 2, y = B.y0 - 2, w = B.x1 - B.x0 + 4, h = B.y1 - B.y0 + 4;
      c.save();
      (this._spotDiscs || []).forEach(([dx, dy, r]) => {
        c.beginPath();
        c.rect(x, y, w, h);
        c.moveTo(dx + r, dy); c.arc(dx, dy, r, 0, TAU);
        c.clip('evenodd');
      });
      c.globalAlpha = a;
      c.fillStyle = L.move;
      c.fillRect(x, y, w, h);
      c.restore();
    },

    /* ============ 背景（照明つき・静的部分はオフスクリーンに1回だけ描く） ============
     * 光源は画面左上で統一し、落ち影・面の明暗・コンクリートの質感を持たせる。
     * 静止要素は bgCanvas にキャッシュ（倍率 bgScale）して毎フレームは1枚絵として貼るだけ。
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

    /* 背景キャッシュの倍率: いちばん大きいズーム(2.6倍)×devicePixelRatio に合わせる（1〜1.93。0.1きざみ）。
     * 幅は (BG_X1−BG_X0)×1.93=4092 で、4096 をこえない（古いスマホの GPU の上限） */
    bgScale() {
      const k = Math.ceil(this.baseScale() * this.dpr * 2.6 * 10) / 10;
      return Math.min(1.93, Math.max(1, k || 1));
    },
    buildBg(L, k) {
      const cv = document.createElement('canvas');
      cv.width = Math.ceil((BG_X1 - BG_X0) * k);
      cv.height = Math.ceil(SCENE_H * k);
      const g = cv.getContext('2d');
      g.setTransform(k, 0, 0, k, -BG_X0 * k, 0);
      const prev = this.ctx;
      this.ctx = g;   // rr()等のヘルパーを使うため一時的に差し替え
      try { this.renderBg(g, L); } finally { this.ctx = prev; }
      return cv;
    },
    /* そのステージで照明が切りかわるか（かみなりのイベントがあるステージは、はれ→かみなり→くもり） */
    weatherLights(st) {
      return st && (st.events || []).some((e) => e.id === 'weather') ? ['storm', 'overcast'] : [];
    },
    ensureBg(state) {
      if (!this.cw) return;
      const L = this.light || lightOf(state);
      const st = state && state.stage, sid = st ? st.id : 0;
      const k = this.bgScale();
      if (this._bgStage !== sid || this._bgK !== k) {
        /* ステージか倍率が変わったら、前の背景を手放して作り直す */
        Object.values(this._bgs || {}).forEach((cv) => { if (cv) { cv.width = 0; cv.height = 0; } });
        if (this._bgFade && this._bgFade.from) { this._bgFade.from.width = 0; this._bgFade.from.height = 0; }
        this._bgs = {};
        this._bgFade = null;
        this.bgCanvas = null;
        this._bgLight = null;
        this._bgStage = sid; this._bgK = k;
      }
      let cur = this._bgs[L.name];
      if (!cur) cur = this._bgs[L.name] = this.buildBg(L, k);
      if (this.bgCanvas && this.bgCanvas !== cur && this._bgLight) {
        /* ステージのとちゅうで照明が切りかわった: 前の背景から約1.5秒でクロスフェード（動きを減らす設定では、すぐ切りかえる）。
         * 前の背景は、このステージではもう使わないので、フェードのあと手放す */
        const old = this.bgCanvas, oldL = this._bgLight;
        if (this._bgFade && this._bgFade.from && this._bgFade.from !== cur && this._bgFade.from !== old) {
          this._bgFade.from.width = 0; this._bgFade.from.height = 0;
        }
        Object.keys(this._bgs).forEach((n) => { if (this._bgs[n] === old) delete this._bgs[n]; });
        if (reduceMotion()) { old.width = 0; old.height = 0; this._bgFade = null; }
        else this._bgFade = { from: old, fromL: oldL, t: 0, dur: 1.5 };
      }
      this.bgCanvas = cur;
      this._bgLight = L;
      /* かみなりのあるステージは、時間が止まっているあいだ（はじめる前）に、かみなりとくもりの背景を先に作っておく
       * （照明が変わるフレームで重い描き直しをしない）。1フレームに1枚ずつ */
      if (st && state.clock === 0 && this.arrivalT == null) {
        const name = this.weatherLights(st).find((n) => !this._bgs[n]);
        if (name) this._bgs[name] = this.buildBg(LIGHT[name], k);
      }
    },

    /* 静的背景（照明のプリセット L で1回だけ描く）。文字はここには描かない（スクリーン層の案内板で描く）。
     * x は BG_X0〜BG_X1（シーンの左右のそと）まで描く */
    renderBg(c, L) {
      const X0 = BG_X0, X1 = BG_X1, W = X1 - X0;
      const shA = L.shadowA, shL = L.shadowL;
      const h01 = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
      /* くり返しの模様（窓・板・誘導灯など）の左はしの開始位置。base を通る step きざみのうち、X0 より左の最初の位置 */
      const from = (base, step) => base - step * Math.ceil((base - X0) / step);
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
        for (let x = from(-280, 44); x < X1 + 40; x += 44) {
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
      for (let x = from(48, 46); x < X1 - 60; x += 46) {
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
      /* 板ごとの明暗のむら（目地と同じ JOINT 単位の格子。エプロンの板は実物で約7m角） */
      const rows = JOINT_ROWS;
      for (let gx = from(JOINT_X, JOINT); gx < X1; gx += JOINT) {
        for (let r = 0; r < rows.length - 1; r++) {
          const h = h01(gx, rows[r]) - 0.5;   // ±3%
          c.fillStyle = h > 0 ? `rgba(255,255,255,${(h * 0.12).toFixed(3)})` : `rgba(20,28,36,${(-h * 0.06).toFixed(3)})`;
          c.fillRect(gx, rows[r], JOINT, rows[r + 1] - rows[r]);
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
      const same = (col) => col;
      this.bgJoints(c, X0, X1, same);
      /* 車と人の通り道の黒ずみ（区画の前のよこの通り道と、車が持ち場へ向かうたての道） */
      const band = c.createLinearGradient(0, 480, 0, 504);
      band.addColorStop(0, 'rgba(36,44,54,0)'); band.addColorStop(0.5, 'rgba(36,44,54,.07)'); band.addColorStop(1, 'rgba(36,44,54,0)');
      c.fillStyle = band; c.fillRect(X0, 480, W, 24);
      [[576, 400], [732, 446], [775, 412], [835, 446], [560, 446]].forEach(([x, y]) => {
        const g = c.createLinearGradient(x - 11, 0, x + 11, 0);
        g.addColorStop(0, 'rgba(36,44,54,0)'); g.addColorStop(0.5, 'rgba(36,44,54,.045)'); g.addColorStop(1, 'rgba(36,44,54,0)');
        c.fillStyle = g; c.fillRect(x - 11, y, 22, 492 - y);
      });
      /* 路面のよごれ（ふちをぼかした、形の不ぞろいなうすいしみ。いくつかの小さなにじみを重ねる）・エンジンの下の油じみ・タイヤあと */
      [[210, 320, 60, 20], [1030, 260, 56, 18], [980, 440, 52, 16], [300, 210, 70, 16]].forEach(([x, y, w, h], i) => {
        for (let j = 0; j < 4; j++) {
          const a = h01(i + 3, j), b = h01(i + 9, j), d = h01(i + 17, j);
          const bx = x + (a - 0.5) * w * 0.9, by = y + (b - 0.5) * h * 0.9, bw = w * (0.35 + d * 0.4);
          c.save();
          c.translate(bx, by); c.rotate(0.3 + (a - 0.5) * 0.6); c.scale(1, (h / w) * (0.8 + b * 0.5));
          const sg = c.createRadialGradient(0, 0, 0, 0, 0, bw);
          sg.addColorStop(0, 'rgba(50,60,70,.045)'); sg.addColorStop(0.55, 'rgba(50,60,70,.025)'); sg.addColorStop(1, 'rgba(50,60,70,0)');
          c.fillStyle = sg;
          c.beginPath(); c.arc(0, 0, bw, 0, TAU); c.fill();
          c.restore();
        }
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
      this.bgApronEdge(c, X0, X1, same);

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
      this.bgTaxiLines(c, L, X0, X1, same);
      const lamp = L.flood || L.name === 'storm';
      for (let x = from(-240, 60); x < X1; x += 60) {
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

      /* --- スタンドの誘導線（前輪の通り道）・停止線・搭乗橋の待機位置・制限区域ライン --- */
      this.bgStandLines(c, L, same);
      this.bgBridgePark(c, same);
      this.bgEra(c, same);

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
      this.bgVehLines(c, same);

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

    /* ---- 地面の線。背景キャッシュ（renderBg）と、大きく拡大したときのくっきり描きなおし（drawGroundLinesSharp）で同じものを描く。
     * T は色の変換（キャッシュでは そのまま。描きなおしでは、キャッシュが線の上にかぶせているエプロンの色を先にまぜる） ---- */
    bgJoints(c, x0, x1, T) {
      const xs = JOINT_X - JOINT * Math.ceil((JOINT_X - x0) / JOINT);
      const y0 = JOINT_ROWS[0], y1 = JOINT_ROWS[JOINT_ROWS.length - 1], ys = JOINT_ROWS.slice(1, -1);
      /* 影の線と、そのとなりの光の線（彫りに見える）。うすく */
      c.strokeStyle = T('rgba(55,65,75,.08)'); c.lineWidth = 1.5; c.beginPath();
      for (let x = xs; x < x1; x += JOINT) { c.moveTo(x, y0); c.lineTo(x, y1); }
      ys.forEach((y) => { c.moveTo(x0, y); c.lineTo(x1, y); });
      c.stroke();
      c.strokeStyle = T('rgba(255,255,255,.07)'); c.lineWidth = 1; c.beginPath();
      for (let x = xs; x < x1; x += JOINT) { c.moveTo(x + 1.5, y0); c.lineTo(x + 1.5, y1); }
      ys.forEach((y) => { c.moveTo(x0, y + 1.5); c.lineTo(x1, y + 1.5); });
      c.stroke();
    },
    bgApronEdge(c, x0, x1, T) {
      c.strokeStyle = T('rgba(255,255,255,.5)'); c.lineWidth = 3;
      c.beginPath(); c.moveTo(x0, 143); c.lineTo(x1, 143); c.stroke();
    },
    /* 誘導路のふちの黄色の2本線と、中心線（黒いふちつき） */
    bgTaxiLines(c, L, x0, x1, T) {
      c.strokeStyle = T(L.yel); c.lineWidth = 1.3;
      c.beginPath();
      [578, 581, 623, 626].forEach((y) => { c.moveTo(x0, y); c.lineTo(x1, y); });
      c.stroke();
      c.strokeStyle = T('rgba(34,36,32,.28)'); c.lineWidth = 4.6;
      c.beginPath(); c.moveTo(x0, TAXI_Y); c.lineTo(x1, TAXI_Y); c.stroke();
      c.strokeStyle = T(L.yel); c.lineWidth = 2.6;
      c.beginPath(); c.moveTo(x0, TAXI_Y); c.lineTo(x1, TAXI_Y); c.stroke();
    },
    /* スタンドの誘導線（前輪の通り道）と停止線。誘導路のセンターラインから分かれ、左から入って機首を右に向けて止まる。黄色の線に黒いふち */
    bgStandLines(c, L, T) {
      const yel = T(L.yel);
      const lead = arrivalPaths().nose.filter((p) => p.s >= ARR_TAXI_L - 4);
      const stopX = NOSE_X - NOSE_GEAR_U * PK;
      const leadLine = (w, col) => {
        c.strokeStyle = col; c.lineWidth = w; c.lineJoin = 'round';
        c.beginPath();
        lead.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
        c.lineTo(stopX + 16, PLANE_CY);
        c.stroke();
      };
      leadLine(5.5, T('rgba(34,36,32,.38)'));
      leadLine(3, yel);
      c.lineJoin = 'miter';
      /* 停止線（A320の前輪が止まる位置）。前脚のところの胴体のはば（約±18）より十分長い ±40 にして、
       * 機首の左右に「地面の線」として見えるようにする（黒いふちを両はしにも回す） */
      c.strokeStyle = T('rgba(34,36,32,.55)'); c.lineWidth = 5.5;
      c.beginPath(); c.moveTo(stopX, PLANE_CY - 41.5); c.lineTo(stopX, PLANE_CY + 41.5); c.stroke();
      c.strokeStyle = yel; c.lineWidth = 3;
      c.beginPath(); c.moveTo(stopX, PLANE_CY - 40); c.lineTo(stopX, PLANE_CY + 40); c.stroke();
    },
    /* 搭乗橋の駆動輪の位置の標示: この機種（A320）のドアにつけたときに駆動輪が止まる所に、赤白のしまの枠を地面にぬる
     * （実際のスポットにも、機種ごとの駆動輪の位置の枠がある）。枠の向きはドアにつけた搭乗橋と同じで、長い辺は通路と直角
     * （駆動輪は通路と直角に2つならぶ）。つけているあいだは、通路の左右からしまの枠のはしがのぞく */
    bgBridgePark(c, T) {
      const D = this.bridgeGeom(1), a = D.a, s0 = BRG.rotR - 2, wx = s0 + (D.L - s0) * 0.6;
      const w = 14, h = 40;
      c.save();
      c.translate(BRG.rot[0] + Math.cos(a) * wx, BRG.rot[1] + Math.sin(a) * wx);
      c.rotate(a);
      c.save();
      c.beginPath(); c.rect(-w / 2, -h / 2, w, h); c.clip();
      c.fillStyle = T('rgba(255,255,255,.24)'); c.fillRect(-w / 2, -h / 2, w, h);
      c.strokeStyle = T('rgba(198,48,48,.40)'); c.lineWidth = 2.2;
      c.beginPath();
      for (let d = -h / 2 - w; d < h / 2; d += 6) { c.moveTo(-w / 2, d); c.lineTo(w / 2, d + w); }
      c.stroke();
      c.restore();
      c.strokeStyle = T('rgba(198,48,48,.55)'); c.lineWidth = 1.6;
      c.strokeRect(-w / 2, -h / 2, w, h);
      c.restore();
    },
    /* 制限区域ライン（赤の実線。白いふちで地面から浮かせる）: 駐機中の機体（翼端・尾翼・機首の車）をぐるりと囲む。
     * 機体が入ってくるまで、車や人はこの中に入らない。上の辺は搭乗橋の固定通路の下をくぐる */
    bgEra(c, T) {
      const E = ZONE.era;
      c.strokeStyle = T('rgba(255,255,255,.32)'); c.lineWidth = 4.4;
      this.rr(E.x0, E.y0, E.x1 - E.x0, E.y1 - E.y0, 26); c.stroke();
      c.strokeStyle = T('rgba(198,48,48,.80)'); c.lineWidth = 2.2;
      this.rr(E.x0, E.y0, E.x1 - E.x0, E.y1 - E.y0, 26); c.stroke();
    },
    /* はたらく車のおきばの白い区切り線（1区画に車1台） */
    bgVehLines(c, T) {
      const V = ZONE.veh;
      c.strokeStyle = T('rgba(255,255,255,.5)'); c.lineWidth = 2;
      c.beginPath();
      VEH_BAY_LINES.forEach((x) => { c.moveTo(x, V.y); c.lineTo(x, V.y + V.h - 2); });
      c.stroke();
    },
    /* 大きく拡大したとき（2.6倍まで）、高DPIの画面では背景キャッシュの線がにじむので、見えている所の地面の線だけを毎フレームのベクターで描きなおす。
     * 色は、キャッシュで線の上にかぶせたエプロンの色（apronTint）を先にまぜる。半透明の線は、にじんだ線の上に重なるぶん、うすめにする */
    drawGroundLinesSharp() {
      if (!this.bgCanvas || this.cam.zoom <= 1.6 || this.dpr <= 1) return;
      const L = this._bgLight || this.light, B = this.viewBounds();
      const x0 = Math.max(BG_X0, B.x0 - 6), x1 = Math.min(BG_X1, B.x1 + 6);
      if (x1 <= x0) return;
      this._sharpMix = this._sharpMix || {};
      const memo = this._sharpMix[L.name] || (this._sharpMix[L.name] = {});
      const tint = L.apronTint ? parseRGBA(L.apronTint) : null;
      const T = (col) => {
        if (memo[col]) return memo[col];
        const q = parseRGBA(col), ta = tint ? tint[3] : 0;
        const ch = (i) => Math.round(q[i] * (1 - ta) + (tint ? tint[i] * ta : 0));
        const a = q[3] >= 0.95 ? q[3] : q[3] * 0.6;
        return (memo[col] = `rgba(${ch(0)},${ch(1)},${ch(2)},${+a.toFixed(3)})`);
      };
      const vis = (ax0, ay0, ax1, ay1) => ax1 > B.x0 && ax0 < B.x1 && ay1 > B.y0 && ay0 < B.y1;
      const c = this.ctx, E = ZONE.era, V = ZONE.veh;
      c.save();
      if (vis(x0, 136, x1, 576)) this.bgJoints(c, x0, x1, T);
      if (vis(x0, 140, x1, 146)) this.bgApronEdge(c, x0, x1, T);
      if (vis(x0, 576, x1, 628)) this.bgTaxiLines(c, L, x0, x1, T);
      if (vis(-80, 280, NOSE_X, 606)) this.bgStandLines(c, L, T);
      if (vis(BRG.rot[0] - 10, BRG.rot[1] - 10, BRG.rot[0] + 60, BRG.rot[1] + 90)) this.bgBridgePark(c, T);
      if (vis(E.x0 - 4, E.y0 - 4, E.x1 + 4, E.y1 + 4)) this.bgEra(c, T);
      if (vis(V.x - 2, V.y, V.x + V.w + 2, V.y + V.h)) this.bgVehLines(c, T);
      c.restore();
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
        const fg = this.gradOf('flag|' + fx, (g) => {
          const lg = g.createLinearGradient(fx, 0, fx + 15, 0);
          lg.addColorStop(0, 'rgba(0,0,0,.22)'); lg.addColorStop(0.35, 'rgba(0,0,0,0)');
          return lg;
        });
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
      /* 出発: 誘導路を左へ走り去る（ゆっくり動き出して加速）。カメラはとちゅうで止まり、機体が自分で画面の左へ出ていく。
       * 半透明にはしない。機体（影・タキシーライトもふくむ）の外形の箱がキャンバスの外に全部出たら描かない */
      if (dep.status === 'active' || dep.status === 'done') {
        const p = dep.status === 'done' ? 1 : clamp(dep.progress / G.effDur(dep), 0, 1);
        const path = departPath();
        pose = poseAt(path, path[path.length - 1].s * p * p);
        alpha = this.planeOffCanvas(pose) ? 0 : 1;
      }
      return out(pose, alpha);
    },
    /* 主脚が pose（{x,y,h}）にある機体の外形の箱（機体スプライトの範囲に余白 m をつけたもの）を、いまの画角の画面座標で返す */
    planeScreenBox(pose, m) {
      const cs = Math.cos(pose.h), sn = Math.sin(pose.h);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      [[SPR.x0 - m, SPR.y0 - m], [SPR.x0 + SPR.w + m, SPR.y0 - m], [SPR.x0 + SPR.w + m, SPR.y0 + SPR.h + m], [SPR.x0 - m, SPR.y0 + SPR.h + m]].forEach(([lx, ly]) => {
        const p = this.sceneToScreen(pose.x + lx * cs - ly * sn, pose.y + lx * sn + ly * cs);
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      });
      return { x0, y0, x1, y1 };
    },
    /* 主脚が pose（{x,y,h}）にある機体の外形の箱（影・灯火のぶんの余白つき）が、キャンバスの外に全部出ているか */
    planeOffCanvas(pose) {
      if (!this.cw || !this.ch) return false;
      const b = this.planeScreenBox(pose, 80);
      return b.x1 < 0 || b.x0 > this.cw || b.y1 < 0 || b.y0 > this.ch;
    },

    /* ============ 機体（上から見たA320） ============
     * 形・塗装・陰影・パネルライン・窓・航行灯は、オフスクリーンに高解像度で1回だけ描いてキャッシュする。
     * 毎フレームは「影・機体の絵を回して貼る」「ドアの開閉」「衝突防止灯の点滅」だけを描く。
     * 光源は画面の左上で固定。機体が向きを変えると光の当たる側が変わるので、絵は2通りキャッシュする:
     *   lit=-1 … 機体の左側（ポート）が光の側（駐機中・到着・プッシュバックの前半）
     *   lit=+1 … 機体の右側（スターボード）が光の側（プッシュバックの終わり〜出発で、機首が左を向いたとき） */
    /* 機体の絵の解像度: いちばん大きいズーム(2.6倍)×devicePixelRatio に合わせた hi（2〜4）と、その半分の lo（1〜2）。
     * ふだん（いまの S×dpr が lo 以下）は lo の絵だけを持ち、それより拡大したときだけ hi の絵を少しおくれて作る（メモリと縮小のむだをへらす） */
    planeQ() {
      const hi = clamp(Math.ceil(this.baseScale() * this.dpr * 2.6 - 0.15), 2, 4);
      return { hi, lo: Math.max(1, Math.ceil(hi / 2)) };
    },
    /* 落ち影と接地の陰（シルエットをぼかした絵）。色は決まっていて照明によらないので、1回だけ作る（ぼかした絵なので1倍で足りる） */
    planeShadows() {
      if (this._planeSh) return this._planeSh;
      const G = planeGeometry(), B = SPR_SH, FAR = 3000;
      const soft = (shape, blur) => {
        const cv = document.createElement('canvas');
        cv.width = SPR.w + 2 * B; cv.height = SPR.h + 2 * B;
        const sg = cv.getContext('2d');
        sg.setTransform(1, 0, 0, 1, -SPR.x0 + B - FAR, -SPR.y0 + B);
        sg.shadowColor = '#101a28'; sg.shadowBlur = blur; sg.shadowOffsetX = FAR;
        sg.fillStyle = '#101a28';
        sg.fill(shape);
        return cv;
      };
      return (this._planeSh = { shadow: soft(G.silhouette, 6), ao: soft(G.aoShape, 3.5) });
    },
    /* 機体の絵（光の側 L・解像度 q・照明 light の ぬれ/夕日の色ごとにおぼえる。いちどに使うのは数枚なので、6枚をこえたら古いものから手放す） */
    planeBody(L, q, light) {
      const Lt = light || this.light, wet = !!Lt.wet, tint = Lt.planeTint || null;
      const key = (wet ? 1 : 0) + '|' + (tint || '') + '|' + L + '|' + q;
      const M = this._bodies || (this._bodies = new Map());
      let body = M.get(key);
      if (body) { M.delete(key); M.set(key, body); return body; }
      body = document.createElement('canvas');
      body.width = Math.ceil(SPR.w * q); body.height = Math.ceil(SPR.h * q);
      const g = body.getContext('2d');
      g.setTransform(q, 0, 0, q, -SPR.x0 * q, -SPR.y0 * q);
      this.renderPlaneBody(g, planeGeometry(), wet, L);
      if (tint) {
        /* 夕方: 機体の絵（不透明な所だけ）に夕日の色を1回だけかさねる */
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = tint;
        g.fillRect(0, 0, body.width, body.height);
        g.globalCompositeOperation = 'source-over';
      }
      M.set(key, body);
      while (M.size > 6) {
        const [k0, cv0] = M.entries().next().value;
        M.delete(k0); cv0.width = 0; cv0.height = 0;
      }
      return body;
    },
    planeSprites(state, lit) {
      const L = lit > 0 ? 1 : -1, Q = this.planeQ(), Lt = this.light;
      const wet = !!Lt.wet, tint = Lt.planeTint || null;
      const M = this._bodies || (this._bodies = new Map());
      let body = null;
      if (this.scale() * this.dpr > Q.lo + 0.01) {
        /* 拡大している: hi の絵があれば使う。なければ lo で描いておき、hi はつぎのすきまに作る */
        body = M.get((wet ? 1 : 0) + '|' + (tint || '') + '|' + L + '|' + Q.hi) || null;
        if (body) this._hiUsedAt = this.time;
        else if (!this._hiQueued) {
          this._hiQueued = true;
          setTimeout(() => { this._hiQueued = false; this._hiUsedAt = this.time; this.planeBody(L, Q.hi, Lt); }, 0);
        }
      } else if (this._hiUsedAt != null && this.time - this._hiUsedAt > 3) {
        /* 3秒より長く拡大していなければ、hi の絵を手放す */
        this._hiUsedAt = null;
        [...M.keys()].forEach((k) => { if (k.endsWith('|' + Q.hi)) { const cv = M.get(k); M.delete(k); cv.width = 0; cv.height = 0; } });
      }
      if (!body) body = this.planeBody(L, Q.lo, Lt);
      const sh = this.planeShadows();
      return { body, shadow: sh.shadow, ao: sh.ao };
    },
    /* 駐機中（向き0・不透明）の地面の影: 落ち影・垂直尾翼の影・接地の陰を、照明ごとに1枚の絵にまとめておく（毎フレームは drawImage 1回）。
     * 重ねる順・濃さは、動いているときの drawPlane と同じ */
    planeGround(Lt) {
      if (this._ground && this._ground.key === Lt.name) return this._ground;
      if (this._ground) { this._ground.cv.width = 0; this._ground.cv.height = 0; }
      const sh = this.planeShadows(), B = SPR_SH, sA = Lt.shadowA, sL = Lt.shadowL, gq = 1.5;
      const x0 = SPR.x0 - B - 4, y0 = SPR.y0 - B - 4;
      const x1 = SPR.x0 + SPR.w + B + Math.max(8 * sL, 23.6 * sL + 1.3, 1.5) + 4;
      const y1 = SPR.y0 + SPR.h + B + Math.max(11 * sL, 32.5 * sL + 1.3, 2.5) + 4;
      const cv = document.createElement('canvas');
      cv.width = Math.ceil((x1 - x0) * gq); cv.height = Math.ceil((y1 - y0) * gq);
      const g = cv.getContext('2d');
      g.setTransform(gq, 0, 0, gq, -x0 * gq, -y0 * gq);
      let a = clamp(0.27 * sA, 0, 0.4);
      g.globalAlpha = a;
      g.drawImage(sh.shadow, SPR.x0 - B + 8 * sL, SPR.y0 - B + 11 * sL, SPR.w + 2 * B, SPR.h + 2 * B);
      /* 垂直尾翼の影（drawPlane と同じ。globalAlpha は 1 をこえる値をうけつけないので、そのときは前の値のまま） */
      const fa = clamp(sA, 0, 1.2);
      if (fa <= 1) a = fa;
      g.globalAlpha = a;
      g.fillStyle = 'rgba(16,26,40,.075)';
      [[0, 0], [1.3, 1.3], [-1.3, -1.3]].forEach(([dx, dy]) => {
        g.fill(toPath([
          [PX(28.7) + 8.8 * sL + dx, 12.1 * sL + dy], [PX(35.3) + 8.8 * sL + dx, 12.1 * sL + dy],
          [PX(37.3) + 23.6 * sL + dx, 32.5 * sL + dy], [PX(34.8) + 23.6 * sL + dx, 32.5 * sL + dy],
        ]));
      });
      g.globalAlpha = Lt.wet ? 0.3 : 0.38;
      g.drawImage(sh.ao, SPR.x0 - B + 1.5, SPR.y0 - B + 2.5, SPR.w + 2 * B, SPR.h + 2 * B);
      return (this._ground = { key: Lt.name, cv, x0, y0, w: x1 - x0, h: y1 - y0 });
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
      if (tr.alpha >= 1 && tr.x === 0 && tr.y === 0 && tr.rot === 0) {
        /* 駐機中: 落ち影・垂直尾翼の影・接地の陰は、照明ごとに1枚にまとめた絵を貼るだけ（planeGround） */
        const gr = this.planeGround(Lt);
        c.globalAlpha = 1;
        c.drawImage(gr.cv, px + gr.x0, py + gr.y0, gr.w, gr.h);
      } else {
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
      }
      /* 出発の地上走行中: 前脚のタキシーライトが機首の前の地面をうすく照らす（点滅しない。胴体の下の所は機体にかくれる） */
      if (state.tasks.depart.status === 'active') {
        c.globalAlpha = tr.alpha;
        c.save(); c.translate(px, py); c.rotate(tr.rot); c.translate(PX(NOSE_GEAR_U), 0);
        c.fillStyle = this.gradOf('taxiLight', (g) => {
          const lg = g.createRadialGradient(0, 0, 0, 0, 0, 125);
          lg.addColorStop(0, 'rgba(255,250,232,.30)'); lg.addColorStop(0.45, 'rgba(255,250,232,.18)'); lg.addColorStop(1, 'rgba(255,250,232,0)');
          return lg;
        });
        c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 125, -0.26, 0.26); c.closePath(); c.fill();
        c.restore();
      }
      /* 下面の衝突防止灯が地面を赤く照らす（灯っているときだけ） */
      if (beacon > 0.02) {
        const [gx, gy] = W(PX(15.5), 0, 0, 0);
        c.globalAlpha = tr.alpha * beacon;
        c.save(); c.translate(gx, gy);
        c.fillStyle = this.gradOf('beaconGround', (g) => {
          const rg = g.createRadialGradient(0, 0, 0, 0, 0, 44);
          rg.addColorStop(0, 'rgba(255,70,60,.24)'); rg.addColorStop(1, 'rgba(255,70,60,0)');
          return rg;
        });
        c.beginPath(); c.arc(0, 0, 44, 0, TAU); c.fill();
        c.restore();
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
    /* 機体の灯火（機体ローカル座標）: 上面の衝突防止灯（消えているときは暗い赤の小さい点）。
     * 航法灯（左翼=赤・右翼=緑）は機体の絵にある。白いストロボは滑走路に入るときに点けるので、地上走行（出発）では点けない
     * （かわりに drawPlane が前脚のタキシーライトを描く） */
    drawPlaneLights(state, beacon) {
      const c = this.ctx;
      const bx = PX(16.8);
      if (beacon > 0.02) {
        const a0 = c.globalAlpha;
        c.globalAlpha = a0 * beacon;
        c.fillStyle = this.gradOf('beaconTop', (g) => {
          const bg = g.createRadialGradient(bx, 0, 0, bx, 0, 7);
          bg.addColorStop(0, 'rgba(255,86,72,.6)'); bg.addColorStop(1, 'rgba(255,86,72,0)');
          return bg;
        });
        c.beginPath(); c.arc(bx, 0, 7, 0, TAU); c.fill();
        c.globalAlpha = a0;
      }
      c.fillStyle = beacon > 0.02 ? `rgba(255,66,58,${(0.35 + 0.65 * beacon).toFixed(3)})` : '#7a2b2b';
      c.beginPath(); c.arc(bx, 0, 1.4, 0, TAU); c.fill();
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
        /* 開いたドアから機内のあかりがこぼれる（ドアごとに位置は決まっているので、グラデーションはおぼえておく） */
        const gx = x0 + ww / 2, gy = s * hw, r = 6 + ww * 0.4;
        c.fillStyle = this.gradOf(`door|${u}|${s}`, (g) => {
          const gl = g.createRadialGradient(gx, gy, 0, gx, gy, r);
          gl.addColorStop(0, 'rgba(255,212,140,.6)'); gl.addColorStop(1, 'rgba(255,212,140,0)');
          return gl;
        });
        c.beginPath(); c.arc(gx, gy, r, 0, TAU); c.fill();
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
      /* 影の形は、搭乗橋がのびちぢみしているときと照明が変わったときだけ作り直す */
      const key = this.bridge.toFixed(4) + '|' + Lt.shadowL;
      if (!this._brSh || this._brSh.key !== key) {
        const sh = new Path2D();
        toPath(boxPts(B.rx + ox, B.ry + oy, B.a, P.s0, B.L, -10, 10), sh);
        toPath(boxPts(B.ex + ox, B.ey + oy, B.phi, -1, 24, -15, 15), sh);
        sh.moveTo(B.rx + ox + BRG.rotR, B.ry + oy); sh.arc(B.rx + ox, B.ry + oy, BRG.rotR, 0, TAU);
        this._brSh = { key, path: sh };
      }
      c.fillStyle = `rgba(16,26,40,${clamp(0.17 * Lt.shadowA, 0, 0.24).toFixed(3)})`;
      c.fill(this._brSh.path);
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
        c.fillStyle = this.gradOf(`brFloor|${w}|${lit}`, (g) => {
          const gr = g.createLinearGradient(0, lit * w / 2, 0, -lit * w / 2);
          gr.addColorStop(0, '#b4bfca'); gr.addColorStop(1, '#8796a4');
          return gr;
        });
        c.fillRect(a0, -w / 2, a1 - a0, w);
        c.fillStyle = 'rgba(60,72,86,.22)'; c.fillRect(a0, -w / 2 + 3, a1 - a0, w - 6);   // 床のじゅうたん
        c.restore();
      });
      /* キャブの床 */
      c.save(); c.translate(B.ex, B.ey); c.rotate(B.phi);
      c.fillStyle = '#9aa7b3'; c.fillRect(-1, -15, 21, 30);
      c.fillStyle = 'rgba(60,72,86,.22)'; c.fillRect(2, -12, 15, 24);
      c.restore();
      /* ロタンダの床（ロタンダは動かないので、グラデーションはおぼえておく） */
      c.fillStyle = this.gradOf('rotFloor', (g) => {
        const rgd = g.createRadialGradient(B.rx - 4, B.ry - 4, 2, B.rx, B.ry, BRG.rotR);
        rgd.addColorStop(0, '#c9d2da'); rgd.addColorStop(1, '#98a4af');
        return rgd;
      });
      c.beginPath(); c.arc(B.rx, B.ry, BRG.rotR, 0, TAU); c.fill();
    },
    /* 搭乗橋のガラスの屋根（寒色・うすい）とリブ。中の人ははっきり見えたまま「中にいる」と分かる */
    drawBridgeRoof() {
      const c = this.ctx, P = this.bridgeParts(), B = P.B;
      const lit = Math.sin(B.a) - Math.cos(B.a) >= 0 ? 1 : -1;
      P.sects.forEach(([f0, f1, w]) => {
        const a0 = P.s0 + P.len * f0, a1 = P.s0 + P.len * f1;
        c.save(); c.translate(B.rx, B.ry); c.rotate(B.a);
        c.fillStyle = this.gradOf(`brRoof|${w}|${lit}`, (g) => {
          const gr = g.createLinearGradient(0, lit * w / 2, 0, -lit * w / 2);
          gr.addColorStop(0, 'rgba(227,234,240,.42)'); gr.addColorStop(1, 'rgba(169,184,198,.32)');
          return gr;
        });
        c.fillRect(a0, -w / 2, a1 - a0, w);
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
      c.fillStyle = this.gradOf('cabRoof', (g) => {
        const cg = g.createLinearGradient(0, -15, 0, 15);
        cg.addColorStop(0, 'rgba(178,192,206,.45)'); cg.addColorStop(1, 'rgba(230,236,242,.45)');
        return cg;
      });
      c.fillRect(-1, -15, 21, 30);
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
      c.fillStyle = this.gradOf('rotRoof', (g) => {
        const rgd = g.createRadialGradient(B.rx - 4, B.ry - 4, 2, B.rx, B.ry, BRG.rotR);
        rgd.addColorStop(0, 'rgba(232,238,243,.78)'); rgd.addColorStop(1, 'rgba(160,174,186,.7)');
        return rgd;
      });
      c.beginPath(); c.arc(B.rx, B.ry, BRG.rotR, 0, TAU); c.fill();
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
      c.fillStyle = this.gradOf(`spotIcon|${r}|${disc}|${hi}`, (g) => {
        const rg = g.createRadialGradient(-4, -4, 1, 0, 0, r);
        rg.addColorStop(0, hi); rg.addColorStop(1, disc);
        return rg;
      });
      c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      const nm = window.Icons && window.Icons.task(id);
      if (nm) window.Icons.draw(c, nm, 0, 0, size, '#ffffff');
    },
    /* 状態の印（色だけにたよらない）: はじめられる=▶ / あつまり中=… / まだ=かぎ。s は大きさの倍率（小さい画面で大きく） */
    spotMark(x, y, kind, s) {
      const c = this.ctx, C = SPOT_COL;
      const col = kind === 'ready' ? C.ready : kind === 'gather' ? C.gather : C.locked;
      c.save();
      c.translate(x, y);
      if (s && s !== 1) c.scale(s, s);
      c.fillStyle = '#ffffff'; c.beginPath(); c.arc(0, 0, 6.3, 0, TAU); c.fill();
      c.fillStyle = col; c.beginPath(); c.arc(0, 0, 5, 0, TAU); c.fill();
      c.fillStyle = '#ffffff';
      if (kind === 'ready') {
        c.beginPath(); c.moveTo(-1.5, -2.7); c.lineTo(2.9, 0); c.lineTo(-1.5, 2.7); c.closePath(); c.fill();
      } else if (kind === 'gather') {
        [-2.2, 0, 2.2].forEach((d) => { c.beginPath(); c.arc(d, 0, 0.95, 0, TAU); c.fill(); });
      } else if (window.Icons) {
        window.Icons.draw(c, 'lock', 0, 0, 7.4, '#ffffff');
      }
      c.restore();
    },
    /* 小さい画面（S<0.6）では、輪の外形はそのままで、中のアイコンと状態の印を大きくする（小学2年生にも絵が分かるように）。
     * 印の丸は画面で直径10px以上（r8.5 × S×k の下限0.6） */
    spotInner() {
      return this.scale() < 0.6
        ? { r: 15, size: 21, soonR: 13.6, soonSize: 19, mark: 8.5 / 6.3, mx: 12.5, my: 12, smx: 9.5, smy: 9 }
        : { r: 11, size: 16, soonR: 10, soonSize: 14, mark: 1, mx: 9, my: 8.5, smx: 9, smy: 8.5 };
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
        (this._spotDiscs || (this._spotDiscs = [])).push([a[0], a[1], 21.5 * k]);
        const In = this.spotInner();
        c.save();
        c.translate(a[0], a[1]); c.scale(k, k);
        this.spotRing(18.5, C.soon, true, 'rgba(255,255,255,.55)', 3);
        this.spotIcon(t.id, In.soonR, '#5f6f82', '#8796a8', In.soonSize);
        this.spotMark(In.smx, In.smy, 'lock', In.mark);
        c.restore();
        this.pushLabel({ prio: 4, sx: a[0], sy: a[1] + 23 * k, ay: 't', dy: 3, parts: [{ t: `あと${rest}${funPun(rest)}` }], base: 10, style: 'soon', minS: 0.55, ring: [a[0], a[1], 21.5 * k] });
      });
    },

    /* 作業の持ち場（はじめられる=青緑の点線・あつまり中=こはくの点線）。
     * 人をえらんでいるときは、送れる持ち場を太い実線の輪（SPOT_COL.accept = --st-target）にする（大きさは変えない・脈打たない） */
    drawSpots(state, ui) {
      const c = this.ctx, G = window.Game, C = SPOT_COL, k = this.spotK(), In = this.spotInner();
      const selected = ui ? ui.selected : null;
      state.taskList.forEach((t) => {
        if (t.status !== 'ready' && t.status !== 'gathering') return;
        const a = this.anchorOf(t.id);
        if (!a) return;
        const acceptable = selected && G.canAccept(t.id, selected);
        (this._spotDiscs || (this._spotDiscs = [])).push([a[0], a[1], 26 * k]);
        c.save();
        c.translate(a[0], a[1]); c.scale(k, k);
        if (acceptable) this.spotRing(23, C.accept, false, 'rgba(255,255,255,.6)', 4);
        else if (selected) { c.globalAlpha = 0.6; this.spotRing(23, '#8a96a3', true, 'rgba(255,255,255,.35)', 2.5); c.globalAlpha = 1; }
        else this.spotRing(23, t.status === 'gathering' ? C.gather : C.ready, true, 'rgba(255,255,255,.55)', 3);
        if (acceptable) { c.fillStyle = rgbaOf(C.accept, 0.16); c.beginPath(); c.arc(0, 0, 21, 0, TAU); c.fill(); }
        this.spotIcon(t.id, In.r, '#1e3a5f', '#3e6592', In.size);
        this.spotMark(In.mx, In.my, t.status === 'gathering' ? 'gather' : 'ready', In.mark);
        c.restore();
        /* あと何人・何台（アイコン+数字） */
        if (t.status === 'gathering') {
          const missing = G.missingIcons(t.id);
          if (missing) this.pushLabel({ prio: 3, sx: a[0], sy: a[1] + 27 * k, ay: 't', dy: 2, parts: this.iconTextParts('あと ' + missing), base: 10, style: 'gather', ring: [a[0], a[1], 26 * k] });
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
      /* 文字の区切り（Intl.Segmenter は1つだけ作って使いまわす） */
      if (this._seg === undefined) this._seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
      const segs = this._seg ? [...this._seg.segment(String(str))].map((s) => s.segment) : Array.from(String(str));
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
    /* 案内板（看板・ゲート・スポット番号・区画の名前）。小さすぎる画面（S<0.55）では描かない。
     * スマホでは、待機所と車のおきばの2つの看板だけ S≥0.28 でも出す（どこで待っているかの見当がつくように）。
     * 区画の看板は、安全な範囲からはみ出すときは区画（zone）の画面上のはばの中で左右にずらす */
    addSignLabels(state) {
      const Z = ZONE.staff, E = ZONE.era, V = ZONE.veh;
      const signS = isNarrowView() ? 0.28 : 0.55;
      this.pushLabel({ prio: 9, sx: 10, sy: 45, ax: 'l', parts: [{ i: 'plane' }, { t: 'そらみなと こくさいくうこう' }], base: 13, style: 'airport', minS: 0.55 });
      this.pushLabel({ prio: 9, sx: BRG.x, sy: 112, parts: [{ t: 'GATE 7' }], base: 13, style: 'gate', minS: 0.55 });
      if (!state || this._planeHome) this.pushLabel({ prio: 9, sx: 439, sy: PLANE_CY, parts: [{ t: 'S7' }], base: 13, style: 'spotno', minS: 0.55 });
      /* 区画の看板（zone: 区画の左右のはし、zoneBelow: 区画の下はし。上に置けないときは 区画の下に置く） */
      this.pushLabel({ prio: 8, sx: Z.x + 2, sy: Z.y - 17, ax: 'l', parts: [{ t: 'スタッフのまちあい' }], base: 13, style: 'board', minS: signS, zone: [Z.x, Z.x + Z.w], zoneBelow: Z.y + Z.h, zoneH: Z.h });
      this.pushLabel({ prio: 8, sx: E.x1 + 12, sy: V.y - 19, ax: 'l', parts: [{ t: 'はたらく くるまの おきば' }], base: 13, style: 'board', minS: signS, zone: [V.x, V.x + V.w], zoneBelow: V.y + V.h, zoneH: V.h });
    },
    drawLabelsScreen(state, dt) {
      const c = this.ctx;
      if (!c || !this.cw) return;
      const S = this.scale(), I = this.insets;
      /* 安全な範囲（キャンバスから DOM の欄をのぞいた所）。札はこの中に描く（欄の下に半分かくれない） */
      const SR = { l: I.l, t: I.t, r: Math.max(I.l + 40, this.cw - I.r), b: Math.max(I.t + 40, this.ch - I.b) };
      /* 知らせの札（到着・出発）と、かんりょうの札（上へは動かさない） */
      this.fx.floats = this.fx.floats.filter((f) => (f.age += dt) < f.life);
      this.fx.floats.forEach((f) => {
        const a = clamp((f.life - f.age) / 0.5, 0, 1);
        if (f.scr) {
          /* 出発の札: 安全な範囲のまん中より少し上（カメラが動いてもずれない） */
          const hh = SR.b - SR.t;
          this.pushLabel({ prio: 0, scr: true, sx: (SR.l + SR.r) / 2, sy: SR.t + hh / 2 - Math.min(60 * S, hh * 0.18), parts: [{ t: f.text }], base: 16, min: 15, style: 'float', alpha: a });
        } else {
          this.pushLabel({ prio: 0, sx: f.x, sy: f.y, parts: [{ t: f.text }], base: 16, min: 15, style: 'float', alpha: a });
        }
      });
      this.doneTags = this.doneTags.filter((d) => (d.age += dt) < d.life);
      if (state) {
        const k = this.spotK();
        this.doneTags.forEach((d) => {
          const a = clamp((d.life - d.age) / 0.4, 0, 1);
          /* ほかの作業の 進み具合の輪・バッジ・持ち場の輪に かかるときは、上 → 下 → 右 → 左 の順に よける。どこもだめなら出さない */
          this.pushLabel({ prio: 2.5, sx: d.x, sy: d.y - 30 * k, ay: 'b', tx: d.x, ty: d.y, parts: [{ i: 'check' }, { t: 'かんりょう' }], base: 11, style: 'done', alpha: a,
            avoid: true,
            alt: [
              { sy: d.y + 30 * k, ay: 't' },
              { sx: d.x + 26 * k, sy: d.y, ax: 'l', ay: 'm' },
              { sx: d.x - 26 * k, sy: d.y, ax: 'r', ay: 'm' },
            ] });
        });
      }
      const list = (this._labels || []).slice().sort((p, q) => p.prio - q.prio);
      const placed = [];
      const outOf = (q, m) => q.x < SR.l - m || q.x > SR.r + m || q.y < SR.t - m || q.y > SR.b + m;
      /* ときどき出る DOM（ストップ中の札・ヒント・知らせなど）の下に入る札は描かない（半分かくれた札を出さない） */
      const covered = (Q) => (this._covers || []).some((q) => Q.l < q.r && Q.r > q.l && Q.t < q.b && Q.b > q.t);
      /* 持ち場の輪（はじめられる・あつまり中・もうすぐ）と進み具合の輪（画面座標の円）。案内板と、えらんだ人の札はこれにかからない所に出す */
      const discs = (this._spotDiscs || []).concat(this._ringDiscs || []).map(([x, y, r]) => { const q = this.sceneToScreen(x, y); return [q.x, q.y, r * S]; });
      const onDisc = (R, m) => discs.some(([x, y, r]) => { const qx = clamp(x, R.l, R.r), qy = clamp(y, R.t, R.b), rr = r + (m || 0); return (x - qx) * (x - qx) + (y - qy) * (y - qy) < rr * rr; });
      /* 区画の看板がよける物: 駐機スポットの赤い枠（制限区域ライン。線と その中。区画の看板を枠の中に置かない）と、機体の翼の先（画面座標） */
      const E = ZONE.era, e0 = this.sceneToScreen(E.x0, E.y0), e1 = this.sceneToScreen(E.x1, E.y1);
      const onFrame = (R, m) => R.l - m < e1.x && R.r + m > e0.x && R.t - m < e1.y && R.b + m > e0.y;
      const tipDiscs = [];
      if (state && this._lastTr && this._lastTr.alpha > 0.05) {
        const tipX = (ux(W_TIP_LE) + ux(W_TIP_TE)) / 2, tipR = 14;
        [PLANE_CY - W_TIP * PK, PLANE_CY + W_TIP * PK].forEach((ty) => {
          const p = this.transformPoint(tipX, ty, this._lastTr), q = this.sceneToScreen(p.x, p.y);
          tipDiscs.push([q.x, q.y, tipR * S]);
        });
      }
      const onTip = (R, m) => tipDiscs.some(([x, y, r]) => { const qx = clamp(x, R.l, R.r), qy = clamp(y, R.t, R.b), rr = r + m; return (x - qx) * (x - qx) + (y - qy) * (y - qy) < rr * rr; });
      /* 区画（まちあい・車のおきば）の中に とまっている人・車の矩形（画面の座標。区画の看板を 区画の中に置くときに よける）。
       * いるときだけ1回 計算する */
      let _parked = null;
      const parkedBoxes = () => {
        if (_parked) return _parked;
        _parked = [];
        const inZ = (Z, x, y) => x >= Z.x - 4 && x <= Z.x + Z.w + 4 && y >= Z.y - 4 && y <= Z.y + Z.h + 4;
        const pk = PERSON_K * this.personK();
        (this._ents || []).forEach((it) => {
          if (!inZ(ZONE.staff, it.x, it.y) && !inZ(ZONE.veh, it.x, it.y)) return;
          let x0, x1, y0, y1;
          if (it.e.kind === 'vehicle') {
            const X = VEH_EXT[it.e.type] || [-45, 45, -15, 15];
            const hx = Math.max(-X[0], X[1]), hy = Math.max(-X[2], X[3]), ca = Math.abs(Math.cos(it.ang || 0)), sa = Math.abs(Math.sin(it.ang || 0));
            const ex = hx * ca + hy * sa, ey = hx * sa + hy * ca;
            x0 = it.x - ex; x1 = it.x + ex; y0 = it.y - ey; y1 = it.y + ey;
          } else { x0 = it.x - 8 * pk; x1 = it.x + 8 * pk; y0 = it.y - 27 * pk; y1 = it.y + 3; }
          const a = this.sceneToScreen(x0, y0), b = this.sceneToScreen(x1, y1);
          _parked.push({ l: a.x, t: a.y, r: b.x, b: b.y });
        });
        return _parked;
      };
      /* 1枚の札を置く場所を決める（置けないときは null） */
      const place = (L) => {
        if (L.minS && S < L.minS) return null;
        const p = L.edge === 'top' ? { x: (SR.l + SR.r) / 2, y: SR.t + 4 } : L.edge === 'bottom' ? { x: (SR.l + SR.r) / 2, y: SR.b - 4 }
          : L.scr ? { x: L.sx, y: L.sy } : this.sceneToScreen(L.sx, L.sy);
        /* 札が指す物（持ち場・人・人数の看板）が欄の下にあるときは、札も出さない（はしへ寄せて、物とはなれた所に出さない） */
        if ((!L.scr || L.edge) && L.prio > 0 && L.prio < 8) {
          const tp = L.ring ? this.sceneToScreen(L.ring[0], L.ring[1]) : L.tx != null ? this.sceneToScreen(L.tx, L.ty) : p;
          if (outOf(tp, 2)) return null;
        }
        /* 文字の大きさ: 13px 以上（L.min があればそれ以上）で、大きい画面でも 18px まで（DOM の文字より大きくしない） */
        const fs = clamp(L.base * S, L.min || 13, Math.max(L.min || 13, 18));
        c.font = `bold ${fs.toFixed(1)}px ${CF}`;
        const pad = fs * 0.55, gap = fs * 0.22, isz = fs * 1.08;
        let w = 0;
        L.parts.forEach((q, i) => { w += q.i ? isz : c.measureText(q.t).width; if (i) w += gap; });
        const bw = w + pad * 2, bh = Math.round(fs * 1.55);
        const x = p.x + (L.dx || 0), y = p.y + (L.dy || 0);
        const left = L.ax === 'l' ? x : L.ax === 'r' ? x - bw : x - bw / 2;
        const top = L.ay === 't' ? y : L.ay === 'b' ? y - bh : y - bh / 2;
        const R = { l: left, t: top, r: left + bw, b: top + bh };
        if (!L.zone && (R.r < SR.l || R.l > SR.r || R.b < SR.t || R.t > SR.b)) return null;
        const out = R.l < SR.l + 2 || R.t < SR.t + 2 || R.r > SR.r - 2 || R.b > SR.b - 2;
        /* 赤い枠とは 8px 以上あける（線の外がわの白いふちまで。くっついて見えないように） */
        const free0 = (Q) => !covered(Q) && !onDisc(Q, 6) && !onFrame(Q, 8 + 2.2 * S) && !onTip(Q, 3) && !placed.some((q) => Q.l < q.r && Q.r > q.l && Q.t < q.b && Q.b > q.t);
        if (L.prio >= 8 && L.zone) {
          /* 区画の看板: 区画の上（決めた高さ）→ 区画の下 → 区画の箱の中 の順に、区画の画面上のはば（はしから 看板の はばの 3わりまでは
           * はみ出してよい）の中で左右にずらして、DOM の欄と知らせ・持ち場の輪と進み具合の輪（6px あける）・
           * 駐機スポットの赤い枠（線と その中）・翼の先・ほかの札に かからない所に置く。
           * 安全な範囲（insets）の外でも、キャンバスの中で DOM が のっていない所（スマホの ズームのボタンの左など）なら置ける。
           * どこにも置けないときは描かない */
          const CB = { l: 2, t: 2, r: this.cw - 2, b: this.ch - 2 };
          const overlaid = (Q) => (this._overlays || []).some((q) => Q.l < q.r && Q.r > q.l && Q.t < q.b && Q.b > q.t);
          const freeZ = (Q) => Q.l >= CB.l && Q.t >= CB.t && Q.r <= CB.r && Q.b <= CB.b && !overlaid(Q) && free0(Q);
          const onParked = (Q) => parkedBoxes().some((q) => Q.l < q.r + 3 && Q.r > q.l - 3 && Q.t < q.b + 2 && Q.b > q.t - 2);
          const zl = this.sceneToScreen(L.zone[0], 0).x, zr = this.sceneToScreen(L.zone[1], 0).x;
          const oh = Math.min(bw * 0.3, 80);
          const lo = Math.max(CB.l, zl - oh), hi = Math.min(CB.r - bw, Math.max(zl, zr - bw) + oh);
          /* まず決めた位置のまま */
          if (freeZ(R)) return { R, fs, pad, gap, isz };
          if (hi < lo) return null;
          const tops = [R.t];
          if (L.zoneBelow != null) tops.push(this.sceneToScreen(0, L.zoneBelow).y + 3);
          /* さいごに 区画の箱の中（たての まんなか。とまっている人・車に かからない所だけ）。
           * スマホで 区画の上は赤い枠・下はズームのボタンや一時停止の札で ふさがるときの置き場 */
          const zt = this.sceneToScreen(0, L.zoneBelow != null ? L.zoneBelow : 0).y, zh = L.zoneH ? L.zoneH * this.scale() : 0;
          const inTop = zh >= bh + 2 ? Math.round(zt - zh / 2 - bh / 2) : null;
          if (inTop != null) tops.push(inTop);
          for (const t of tops) {
            if (t < CB.t || t + bh > CB.b) continue;
            const inside = t === inTop;
            const want = clamp(R.l, lo, hi), lefts = [want];
            for (let d = 6; d <= hi - lo + 6; d += 6) { if (want - d >= lo) lefts.push(want - d); if (want + d <= hi) lefts.push(want + d); }
            for (const l of lefts) {
              const Q = { l, t, r: l + bw, b: t + bh };
              if (freeZ(Q) && !(inside && onParked(Q))) return { R: Q, fs, pad, gap, isz };
            }
          }
          return null;
        }
        if (L.prio >= 8) {
          /* 案内板は、安全な範囲に全部入らなければ描かない */
          if (out) return null;
          if (covered(R) || onDisc(R)) return null;
        } else if (out) {
          /* ほかの札は安全な範囲の中へずらす */
          const dx = R.l < SR.l + 4 ? SR.l + 4 - R.l : R.r > SR.r - 4 ? Math.max(SR.l + 4 - R.l, SR.r - 4 - R.r) : 0;
          const dy = R.t < SR.t + 4 ? SR.t + 4 - R.t : R.b > SR.b - 4 ? Math.max(SR.t + 4 - R.t, SR.b - 4 - R.b) : 0;
          R.l += dx; R.r += dx; R.t += dy; R.b += dy;
          /* ずらした札が自分の持ち場の輪にかかるときは、輪の上へ置き直す（輪とアイコンをかくさない） */
          if (L.ring) {
            const rc = this.sceneToScreen(L.ring[0], L.ring[1]), rr = L.ring[2] * S;
            if (R.l < rc.x + rr && R.r > rc.x - rr && R.t < rc.y + rr && R.b > rc.y - rr) {
              R.t = rc.y - rr - 3 - bh; R.b = R.t + bh;
              if (R.t < SR.t + 2) return null;
            }
          }
        }
        if (L.prio > 0 && covered(R)) return null;
        if (L.avoid && onDisc(R)) return null;
        if (placed.some((q) => R.l < q.r && R.r > q.l && R.t < q.b && R.b > q.t)) return null;
        return { R, fs, pad, gap, isz };
      };
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      /* 粒（クリアのときだけ）は札の下に */
      this.drawFxScreen(dt);
      c.textBaseline = 'middle'; c.textAlign = 'left';
      list.forEach((L) => {
        let got = place(L);
        /* 置けないときは、ほかの置き場（L.alt）を順にためす。えらんだ人・車の札は、持ち場の輪にかかるなら
         * えらんだ物の下 → 安全な範囲の上のはしの中央 → 下のはしの中央 の順。どこもだめなら出さない */
        for (let i = 0; !got && L.alt && i < L.alt.length; i++) got = place(Object.assign({}, L, L.alt[i]));
        if (!got) return;
        placed.push(got.R);
        this.drawLabelBox(c, L, got.R, got.fs, got.pad, got.gap, got.isz);
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

    /* ローカル座標で値のかわらないグラデーションを、キーごとにおぼえておく（キャンバスごと。毎フレーム作り直さない）。
     * mk(g) は、まだないときに g（いまのキャンバスの 2D コンテキスト）で作る関数 */
    gradOf(key, mk) {
      const c = this.ctx;
      if (!this._gcache) this._gcache = new WeakMap();
      let m = this._gcache.get(c);
      if (!m) { m = new Map(); this._gcache.set(c, m); }
      let g = m.get(key);
      if (!g) {
        if (m.size > 600) m.clear();
        g = mk(c);
        m.set(key, g);
      }
      return g;
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
    /* 車の窓ガラス。光の向きは litGrad と同じく約3°きざみにして、グラデーションをおぼえておく */
    glass(x, y, w, h, r) {
      const Lv = this._vl || [-0.7071, -0.7071];
      const qa = Math.round(Math.atan2(Lv[1], Lv[0]) * 20);
      this.ctx.fillStyle = this.gradOf(`glass|${x}|${y}|${w}|${h}|${qa}`, (c) => {
        const a = qa / 20, lx = Math.cos(a), ly = Math.sin(a);
        const g = c.createLinearGradient(x + w / 2 + lx * w / 2, y + h / 2 + ly * h / 2, x + w / 2 - lx * w / 2, y + h / 2 - ly * h / 2);
        g.addColorStop(0, '#a9c3d6'); g.addColorStop(0.5, '#56718a'); g.addColorStop(1, '#2d4052');
        return g;
      });
      this.rr(x, y, w, h, r); this.ctx.fill();
    },

    /* 車両の絵（車両ローカル座標。キャブは -x 側）。ずかんからも呼ぶので、引数の形は変えない。
     * 光の向きは this._vl（drawVehicleEnt が車の向きから決める。ないときは左上）。キャッシュせずにベクターで描く */
    vehicleBody(type, active, gt, reverse) {
      const c = this.ctx;
      switch (type) {
        case 'beltloader': {
          /* 全長は実物（約8m）に合わせる: 車台 −26..8・ベルト +2..+52 で 78（約8.5m）、はば 20（約2.2m）。
           * ベルトの先（+52）が貨物ドアの敷居にとどく（回さない） */
          this.tires([[-20, -12.2], [-20, 8.2], [3, -12.2], [3, 8.2]], 8, 4);
          this.litBox(-26, -10, 34, 20, 3.5, '#5f6c79');
          c.fillStyle = shadeHex('#5f6c79', -0.12); this.rr(-26, -10, 12, 20, 3.5); c.fill();   // キャブ
          this.glass(-24, -6.5, 7, 13, 2);
          c.strokeStyle = 'rgba(30,38,48,.35)'; c.lineWidth = 0.8; c.beginPath();
          for (let x = -10; x <= 5; x += 4) { c.moveTo(x, -7.5); c.lineTo(x, 7.5); }     // エンジンカバーのすきま
          c.stroke();
          c.save();
          c.translate(2, 0);
          /* ベルトの枠（左右のレール） */
          c.fillStyle = '#6f7a86'; this.rr(0, -5.5, 50, 11, 2.5); c.fill();
          c.strokeStyle = shadeHex('#6f7a86', -0.2); c.lineWidth = 1; c.stroke();
          /* ベルトの面: 作業中は先が持ち上がる（地上側が暗く、先端が明るい） */
          c.fillStyle = this.gradOf('belt|' + (active ? 1 : 0), (g) => {
            const bg = g.createLinearGradient(0, 0, 50, 0);
            if (active) { bg.addColorStop(0, '#9aa6b1'); bg.addColorStop(1, '#e3e8ec'); } else { bg.addColorStop(0, '#a9b3bd'); bg.addColorStop(1, '#b8c1ca'); }
            return bg;
          });
          c.fillRect(1.5, -3.8, 47, 7.6);
          /* ベルトの横の板（作業中は流れる） */
          const off = active ? (((gt * 0.7 * 37) % 4.5) * (reverse ? -1 : 1) + 4.5) % 4.5 : 0;
          c.strokeStyle = 'rgba(70,82,96,.30)'; c.lineWidth = 0.6; c.beginPath();
          for (let x = 2 + off; x < 48.5; x += 4.5) { c.moveTo(x, -3.6); c.lineTo(x, 3.6); }
          c.stroke();
          c.fillStyle = '#3b4550'; c.fillRect(47, -5, 3, 10);                       // 先のローラー
          if (active) {
            const cols = ['#2f3640', '#c96f5c', '#4a5563'];                         // 差し色の荷物は1つだけ
            for (let i = 0; i < 3; i++) {
              let p = (gt * 0.7 + i / 3) % 1;
              if (reverse) p = 1 - p;
              const bx = 5 + p * 37;
              c.fillStyle = cols[i]; this.rr(bx, -3.4, 8, 6.8, 1.4); c.fill();
              c.fillStyle = 'rgba(255,255,255,.22)'; c.fillRect(bx + 1, -3.4, 6, 1);   // 上面のハイライト
              c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(bx + 1, 2.4, 6, 1);
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
          c.fillStyle = this.gradOf('tank|' + s, (g) => {
            const tg = g.createLinearGradient(0, s * 13, 0, -s * 13);
            tg.addColorStop(0, '#b9c1c9'); tg.addColorStop(0.22, '#f4f6f8'); tg.addColorStop(0.6, '#cfd5db'); tg.addColorStop(1, '#8f99a3');
            return tg;
          });
          this.rr(-26, -13, 74, 26, 4); c.fill();
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
        const k = (lx) => 1 + 2.2 * (lx - 2) / 50;
        c.beginPath();
        [W(2, -5, k(2)), W(52, -5, k(52)), W(52, 5, k(52)), W(2, 5, k(2))].forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
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

    /* トーバー: 押す車の牽引フックから前脚（前輪）までの棒（長さ約6m・はば約0.3m）。押す車が持ち場についているあいだと、押しているあいだ。
     * 機体より先に描くので、胴体の下にかかる所は機体にかくれ、機首の前に出ている所だけが見える */
    drawTowbar(state, ents, tr) {
      const it = ents.find((v) => v.e.kind === 'vehicle' && v.e.type === 'pushback' && v.e.status === 'working' && v.e.taskId === 'pushback');
      if (!it || tr.alpha <= 0.02) return;
      const c = this.ctx, Lt = this.light, sL = Lt.shadowL;
      const a = it.ang, hx = it.x + Math.cos(a) * 29.5, hy = it.y + Math.sin(a) * 29.5;   // 牽引フック（車両ローカル +29.5）
      const g = this.transformPoint(ux(NOSE_GEAR_U), PLANE_CY, tr);
      const bar = (ox, oy, w, col) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(hx + ox, hy + oy); c.lineTo(g.x + ox, g.y + oy); c.stroke(); };
      c.save();
      c.lineCap = 'round';
      bar(2.2 * sL, 3 * sL, 2.8, `rgba(${Lt.shadowCol},${clamp(0.22 * Lt.shadowA, 0, 0.3).toFixed(3)})`);   // 地面に落ちる影
      bar(0, 0, 2.8, '#3a414a');
      bar(-0.5, -0.5, 0.9, 'rgba(160,170,182,.55)');   // 上面の光
      /* 前脚につなぐ金具と、フック側の輪 */
      c.fillStyle = '#2d343d';
      c.beginPath(); c.arc(g.x, g.y, 2.2, 0, TAU); c.fill();
      c.beginPath(); c.arc(hx, hy, 2, 0, TAU); c.fill();
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
        scale: PERSON_K * this.personK(),
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
        const top = it.top != null ? it.top : it.y - 24 * PERSON_K * this.personK();
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
        const pk = this.personK();
        cx = it.x; cy = it.y - PERSON_MID * pk; r = 12.5 * pk;
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
      /* ふつうは えらんだ物の上。行き先の持ち場の輪（・進み具合の輪）にかかるなら、えらんだ物の下 → 安全な範囲の上のはしの中央
       * → 下のはしの中央。どこでもかかるなら札は出さない（持ち場の輪をかくさない） */
      this.pushLabel({
        prio: 1, sx: cx, sy: cy - r - 3, ay: 'b', dy: -3, tx: cx, ty: cy, parts, base: 11, style: 'sel', avoid: true,
        alt: [{ sy: cy + r + 3, ay: 't', dy: 3 }, { edge: 'top', scr: true, ay: 't', dy: 0 }, { edge: 'bottom', scr: true, ay: 'b', dy: 0 }],
      });
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
      const L = { prio: 2, sx: PAX_SIGN[0], sy: PAX_SIGN[1], parts, base: 12, style: 'pax' };
      /* 降機・搭乗の進み具合の輪（drawRings が先に置いた所）に かかるときは、輪の左 → 下 → 右 → 上 の順に よける
       * （スマホでは輪が大きく、決めた位置の札が 輪と右下のバッジを かくす）。輪のまわりが ほかの輪や知らせで うまっているとき
       * （せまい画面）は、安全な範囲の下のはし → 上のはしの まんなか（人数は どこにあっても読める）。どこにも置けないときは 出さない */
      const pr = this._paxRing;
      if (pr) {
        const S = this.scale(), kr = pr[2];
        const gd = 13.5 * kr * S + 5, gb = 19.5 * kr * S + 4;   // 輪のふち / 右下のバッジの外がわ（画面の px）
        L.avoid = true;
        L.alt = [
          { sx: pr[0], sy: pr[1], ax: 'r', dx: -gd },
          { sx: pr[0], sy: pr[1], ay: 't', dy: gb },
          { sx: pr[0], sy: pr[1], ax: 'l', dx: gb },
          { sx: pr[0], sy: pr[1], ay: 'b', dy: -gd },
          { edge: 'bottom', scr: true, ay: 'b', dy: 0 },
          { edge: 'top', scr: true, ay: 't', dy: 0 },
        ];
      }
      this.pushLabel(L);
    },

    /* 作業の進み具合の輪（人の頭の上。小さい画面では k 倍）。かみなりでおやすみ中は --st-paused の色。
     * まんなかに作業のアイコン、右下に状態の印（おしごと中=青緑に working / おやすみ=灰青に pause）のバッジ。
     * 小さい画面（S<0.6）では、輪を画面で直径25px ほどまで大きくして（ふだんは最大2.2倍。大きくした分は上へのばし、輪の下はしは同じ高さ）、
     * 作業のアイコンを 紺の円に白抜きで出す（何の作業か わかるように）。
     * たて向きのスマホで とても小さく うつしているとき（S<0.43。小さいスマホ）は 2.2倍より大きくして、画面で 直径 約24px・アイコン 約10.5px を保つ */
    drawRings(state, trIn) {
      const c = this.ctx;
      const G = window.Game, k = this.spotK(), S = this.scale(), small = S < 0.6;
      const kr = small ? clamp(1 / S, k, isNarrowView() ? Math.max(2.2, 0.95 / S) : 2.2) : k;
      const lift = 40 * k + 12.5 * (kr - k);
      const paused = G.outdoorPaused && G.outdoorPaused();
      /* 輪（右下のバッジもふくむ）が、キャンバスの上にのる DOM（知らせ・ヒント・トースト = _covers、コーチ・欄 = _overlays）の下や
       * キャンバスの上はしの外に かかるときは、頭の上ではなく 足もとの下に出す（輪とアイコンを かくさない）。
       * スマホは 安全な範囲の上はし（上の知らせの下はし。知らせが消えても 1.5秒は そのまま）より上も「かかる」にする
       * （その上にある輪のそばには、人数の札などを置けない）。
       * 下に出しても かかるとき・下に出すと 持ち場の輪や ほかの輪に かさなるときは 上のまま。
       * もどすのは、上に出しても 6px 以上 あくようになってから（出たり入ったり しない） */
      const covers = (this._covers || []).concat(this._overlays || []);
      const topY = isNarrowView() ? ((this.insets && this.insets.t) || 0) : 0;
      /* キャンバスの下はしより下に かかるときも「かかる」（下に出した輪が キャンバスの外で 切れない）。
       * キャンバスの上にのる 下の欄（ズームのボタン・一時停止の札など）は covers で よける（insets.b は 下の列の はばぜんぶに なるので使わない） */
      const botY = this.ch;
      const ringHit = (x, cy, m) => {
        const q = this.sceneToScreen(x, cy), r = 19.5 * kr * S + m;
        if (q.y - r < topY || q.y + r > botY) return true;
        return covers.some((b) => q.x + r > b.l && q.x - r < b.r && q.y + r > b.t && q.y - r < b.b);
      };
      /* その位置の輪が ほんとうに かくれるか（DOM の下・キャンバスの外。安全な範囲の上はしの すきまは 数えない） */
      const ringHidden = (x, cy) => {
        const q = this.sceneToScreen(x, cy), r = 19.5 * kr * S;
        if (q.y - r < 0 || q.y + r > this.ch) return true;
        return covers.some((b) => q.x + r > b.l && q.x - r < b.r && q.y + r > b.t && q.y - r < b.b);
      };
      /* その位置の輪（右下のバッジもふくむ）が、持ち場の輪（先に描いた _spotDiscs）・先に置いた 進み具合の輪とバッジに かからないか（シーンの座標） */
      const discFree = (x, cy) => {
        const bx = x + 9.5 * kr, by = cy + 9 * kr, br = 6.3 * kr;
        return (this._spotDiscs || []).concat(this._ringDiscs || [])
          .every(([dx, dy, dr]) => Math.hypot(dx - x, dy - cy) >= dr + 13.5 * kr && Math.hypot(dx - bx, dy - by) >= dr + br);
      };
      const flips = this._ringFlip || (this._ringFlip = {});
      this._paxRing = null;
      state.taskList.forEach((t) => {
        if (t.status !== 'active' || t.id === 'depart') { delete flips[t.id]; return; }
        const anchor = this.anchorOf(t.id);
        if (!anchor) return;
        let [x, y] = anchor;
        if (t.id === 'pushback') {
          const p = this.transformPoint(TUG_SLOT[0], TUG_SLOT[1], trIn || this.planeTransform(state));
          x = p.x; y = p.y;
        }
        const pct = clamp(t.progress / G.effDur(t), 0, 1);
        const rest = paused && t.def.outdoor;
        const upY = y - lift, downY = y + 6 * k + 19.5 * kr;
        let flip = !!flips[t.id];
        /* 頭の上が 先に置いた輪・バッジに かかるときも、下に出す（小さいスマホでは 輪が大きく、となりの輪に バッジが かかる） */
        const upFree = discFree(x, upY);
        const downOk = !ringHit(x, downY, 0) && discFree(x, downY);
        if (!flip && (ringHit(x, upY, 0) || !upFree) && downOk) flip = true;
        else if (flip && ((!ringHit(x, upY, 6) && upFree) || !downOk)) flip = false;
        flips[t.id] = flip;
        let ry = flip ? downY : upY;
        /* 上も下も だめなとき（小さいスマホで コーチの下にかかる・となりの輪や持ち場の輪に かかる など）: 足もとの下から すこしずつ下げて、
         * DOM にも キャンバスの下はしにも ほかの輪・バッジにも かからない高さが あれば そこに出す（かくれた輪を 出さない）。
         * 頭の上と足もとの あいだ（人の体に かかる高さ）は、頭の上だと 輪が ほんとうに かくれる（DOM の下・キャンバスの外）ときだけ、
         * さいごに ためす（人の体に すこし かかっても、輪が 見えないよりは よい） */
        if (!flip && (ringHit(x, upY, 0) || !upFree)) {
          let found = false;
          for (let yy = downY + 3 * kr; yy <= downY + 24 * kr; yy += 3 * kr) {
            if (!ringHit(x, yy, 0) && discFree(x, yy)) { ry = yy; found = true; break; }
          }
          if (!found && ringHidden(x, upY)) {
            for (let yy = upY + 3 * kr; yy < downY; yy += 3 * kr) {
              if (!ringHit(x, yy, 0) && discFree(x, yy)) { ry = yy; break; }
            }
          }
        }
        /* 輪と 右下のバッジを おぼえる（札・人数の札・あとの輪が よける） */
        (this._ringDiscs || (this._ringDiscs = [])).push([x, ry, 13.5 * kr], [x + 9.5 * kr, ry + 9 * kr, 6.3 * kr]);
        /* 降機・搭乗の人数の札は、この輪（右下のバッジもふくむ）を よけて置く（drawPaxCounter） */
        if (t.id === 'deboard' || t.id === 'board') this._paxRing = [x, ry, kr];
        c.save();
        c.translate(x, ry); c.scale(kr, kr);
        c.fillStyle = 'rgba(16,26,40,.25)'; c.beginPath(); c.arc(1, 1.8, 12.5, 0, TAU); c.fill();
        c.fillStyle = 'rgba(255,255,255,.95)';
        c.beginPath(); c.arc(0, 0, 12.5, 0, TAU); c.fill();
        c.strokeStyle = '#d5dbe1'; c.lineWidth = 2.4;
        c.beginPath(); c.arc(0, 0, 10.6, 0, TAU); c.stroke();
        const col = rest ? SPOT_COL.paused : SPOT_COL.ready;
        c.strokeStyle = col; c.lineWidth = 3;
        c.beginPath(); c.arc(0, 0, 10.6, -Math.PI / 2, -Math.PI / 2 + pct * TAU); c.stroke();
        const nm = window.Icons && window.Icons.task(t.id);
        if (small) {
          /* 小さい画面: 紺の円に 白抜きの作業アイコン */
          c.fillStyle = '#1e3a5f'; c.beginPath(); c.arc(0, 0, 8.4, 0, TAU); c.fill();
          if (nm) window.Icons.draw(c, nm, 0, 0, 11, '#ffffff');
        } else if (nm) window.Icons.draw(c, nm, 0, 0, 13, '#1e3a5f');
        /* 状態の印（右下のバッジ） */
        c.fillStyle = '#ffffff'; c.beginPath(); c.arc(9.5, 9, 6.3, 0, TAU); c.fill();
        c.fillStyle = col; c.beginPath(); c.arc(9.5, 9, 5, 0, TAU); c.fill();
        if (window.Icons) window.Icons.draw(c, rest ? 'pause' : 'working', 9.5, 9, 7.6, '#ffffff');
        c.restore();
      });
    },

    /* 雨（雷雨イベント中はつよく、雨のステージはずっとよわく）。すじは動く向き（右下へ）にそろえ、
     * 画面に見えている範囲ぜんぶに降らせる。地面の波紋は drawRainGround（地面の層）で描く */
    rainMode(state) {
      const storm = state.outdoorPauseUntil != null && state.clock < state.outdoorPauseUntil;
      const always = !!(state.stage && state.stage.rainAll);
      return storm ? 'storm' : always ? 'rain' : null;
    },
    /* 雨の濃さ（0..1）: ずっと雨のステージはすぐ 1。かみなりの雨は 1.5秒でフェードイン・アウト（背景のクロスフェードと同じ長さ） */
    rainLevel(state, dt) {
      const mode = this.rainMode(state);
      if (mode) this._rainMode = mode;
      if (mode === 'rain' || reduceMotion()) this._rainA = mode ? 1 : 0;
      else this._rainA = clamp((this._rainA || 0) + (mode ? 1 : -1) * (dt || 0) / 1.5, 0, 1);
      return this._rainA;
    },
    /* 地面の波紋（20個。広がりながらうすくなる）。機体・車・人・持ち場の輪より前（下）に描くので、それらの上には出ない */
    drawRainGround(state, dt) {
      const ra = this.rainLevel(state, dt);
      if (ra <= 0.001) return;
      const storm = this._rainMode === 'storm';
      const c = this.ctx, B = this.viewBounds(), T = this.time;
      const gy0 = Math.max(150, B.y0), gy1 = Math.min(SCENE_H, B.y1);
      if (gy1 <= gy0) return;
      c.save();
      c.globalAlpha = ra;
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
      c.restore();
    },
    /* 雨すじ: 画面の座標で描く（ズームしても長さ 14〜20px・太さ 1.2〜1.6px のまま）。本数はキャンバスの面積で決める */
    drawRain(state) {
      const ra = this._rainA || 0;
      if (ra <= 0.001 || !this.cw) return;
      const storm = this._rainMode === 'storm';
      const c = this.ctx, T = this.time, cw = this.cw, ch = this.ch;
      const W = cw + 80, H = ch + 60;
      const L = storm ? 19 : 15;
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.beginPath(); c.rect(0, 0, cw, ch); c.clip();
      c.globalAlpha = ra;
      c.strokeStyle = storm ? 'rgba(210,228,246,.72)' : 'rgba(210,228,246,.5)';
      c.lineWidth = storm ? 1.6 : 1.2;
      c.lineCap = 'round';
      c.beginPath();
      const n = Math.round((storm ? 80 : 52) * clamp((cw * ch) / (1280 * 720), 0.3, 2.4));
      for (let i = 0; i < n; i++) {
        const x = -40 + ((((i * 149 + T * 340) % W) + W) % W);
        const y = -30 + ((((i * 97 + T * 700) % H) + H) % H);
        c.moveTo(x, y);
        c.lineTo(x - 0.44 * L, y - 0.9 * L);
      }
      c.stroke();
      c.restore();
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
        /* 出発中の広い画面では 開かない（syncDrawer）。押しても何も起きないと こわれたように見えるので、わけを 短く知らせる */
        if (!this.isNarrow() && this.departing()) {
          this.showDrawerNudge(0, `${this.ico('list')} しゅっぱつ ちゅうは とじているよ`);
          return;
        }
        this.els['panel-tasks'].classList.toggle('closed');
      });
      this.els['btn-log-toggle'].addEventListener('click', () => {
        const open = this.els['panel-status'].classList.toggle('log-open');
        this.setLogToggle(open);
        /* スマホ: きろくを開いたら、出ているトーストを片づける（同じことは きろくに のっている）。
         * 開いている間は、画面の どこに出しても 見えている きろくの行に かかるときだけ ためて（holdToasts の 'log'）、とじたら出す
         * （ゲームの知らせは きろくに のっているので すて、作業カードを押した こたえ だけ出す。flushToastQ） */
        if (open && (this.isNarrow() || this.shortWide())) this.els['toast-area'].innerHTML = '';
        if (!open && this._toastQ && this._toastQ.length) this.flushToastQ();
        /* ページの長さが かわる（スクロールの位置も かわる）ので、出ているトーストの置き場を えらびなおす */
        this.placeToast();
      });

      /* ズーム（持ち場のポップを開いていたら、持ち場のそばへ置きなおす） */
      this.els['btn-zoom-in'].addEventListener('click', () => { Sfx.play('click'); Scene.zoomAt(1.3); this.updateTouchAction(); this.followSpotPop(true); });
      this.els['btn-zoom-out'].addEventListener('click', () => { Sfx.play('click'); Scene.zoomAt(1 / 1.3); this.updateTouchAction(); this.followSpotPop(true); });
      this.els['btn-zoom-reset'].addEventListener('click', () => { Sfx.play('click'); Scene.resetCam(); this.updateTouchAction(); this.followSpotPop(true); });

      /* タイトルの説明文・注意書き（静的なルビ）も、ルビの前後のすきまを つめる（何回かけても同じ結果） */
      document.querySelectorAll('#screen-title .title-desc, #screen-title .title-foot').forEach((el) => { el.innerHTML = this.tightRuby(el.innerHTML); });

      this.initGameUi();
      this.bindCanvasInput();

      this.els['modal-backdrop'].addEventListener('click', (ev) => {
        if (ev.target === this.els['modal-backdrop'] && this.modalKind && this.modalDismissible) this.closeModal();
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        if (this.modalKind) { if (this.modalDismissible) this.closeModal(); return; }
        /* モーダルがないとき: 持ち場のポップ（スマホのシート）・人のリスト・リボンの吹き出し・えらんでいる人を とじる */
        const popOpen = !!this.spotPopTask;
        const back = this._popOpener;
        this.closeSpotPop();
        this.closeStaffPick();
        this.hideRibbonTip();
        this.selected = null;
        if (popOpen && back && back.isConnected && typeof back.focus === 'function' && back !== document.body) {
          try { back.focus({ preventScroll: true }); } catch (e) { /* フォーカスできない要素は そのまま */ }
        }
      });
      document.addEventListener('pointerdown', () => Sfx.ensure(), { once: true });
    },

    /* ゲーム画面の部品の登録（上の知らせ・ドロワー・スタッフ帯・リボン・ポップ） */
    initGameUi() {
      ['game-main', 'top-rail', 'coach-bubble', 'pause-chip', 'hud-remain-box', 'hud-remain-label', 'drawer-badge', 'drawer-nudge',
        'res-scroll', 'btn-res-more', 'staff-pick', 'toast-global', 'panel-resources', 'zoom-ctrl', 'hud-paused', 'btn-rib-more'].forEach((id) => {
        this.els[id] = document.getElementById(id);
      });
      this.els['hint-banner'].addEventListener('click', () => { Sfx.play('click'); this.onHintTap(); });
      /* コーチのふきだしは押せる（下の駐機場へ タップを通さない）。押したら とじる（下の駐機場が見えるように） */
      this.els['coach-bubble'].addEventListener('click', (ev) => {
        if (ev.target.closest && ev.target.closest('.cb-close')) return;   // × は自分で とじる
        Sfx.play('click');
        this.hideCoach();
      });
      /* 持ち場のポップを ゆびで押している間は、カメラが動いても ポップを動かさない */
      const pop = this.els['spot-pop'];
      pop.addEventListener('pointerdown', () => { this._popPressed = true; });
      document.addEventListener('pointerup', () => { this._popPressed = false; }, true);
      document.addEventListener('pointercancel', () => { this._popPressed = false; }, true);
      /* ドロワーの開閉（つまみ・自動でとじる・テストのどれでも）にあわせる */
      new MutationObserver(() => this.syncDrawer()).observe(this.els['panel-tasks'], { attributes: true, attributeFilter: ['class'] });
      /* モーダルが開いたら、その場でゲーム画面のトーストを片づける（幕の下に残さない。閉じたあとの1枚は frame が出す） */
      new MutationObserver(() => {
        if (!this.els['modal-backdrop'].classList.contains('hidden')) this.els['toast-area'].innerHTML = '';
      }).observe(this.els['modal-backdrop'], { attributes: true, attributeFilter: ['class'] });
      /* スタッフ帯の高さ → --res-h */
      if (window.ResizeObserver) {
        new ResizeObserver(() => { this.measureResH(); this.updateResMore(); this.applyViewInsets(); }).observe(this.els['panel-resources']);
        new ResizeObserver(() => { this.placeRail(); this.applyViewInsets(); }).observe(this.els['panel-status']);
        /* 上の知らせが出た・消えた・行数がかわった → 駐機場の見える範囲（上）を知らせなおす */
        const railRO = new ResizeObserver(() => this.applyViewInsets());
        ['event-banner', 'coach-bubble', 'hint-banner', 'pause-chip'].forEach((id) => railRO.observe(this.els[id] || document.getElementById(id)));
      }
      this._lastW = window.innerWidth;
      window.addEventListener('scroll', () => this.onPageScroll(), { passive: true });
      window.addEventListener('resize', () => {
        /* 高さだけの変化（スマホのアドレスバーの出し入れ。スクロールのとちゅうで おきる）では、スクロールと同じく ついていくだけ */
        this.placeToast(this._lastW === window.innerWidth);
        this.syncDrawer(); this.updateTouchAction(); this.updateRibbonMore(); this.updateResMore(); this.measureResH(); this.placeStartCard();
        if (this.spotPopTask) {
          if (this.isNarrow()) {
            /* 横向き → 縦向き: 広い画面で決めた位置・高さを消して、下からのシートにもどす */
            const pop = this.els['spot-pop'];
            pop.style.left = ''; pop.style.top = ''; pop.style.maxHeight = '';
            pop.classList.remove('sp-arrow-left', 'sp-arrow-right', 'sp-arrow-up');
          } else this.placeSpotPop(this.spotPopTask);
        }
        /* 画面の幅がかわったら（向きをかえたなど）: だれをえらぶかのリストは位置がずれるので閉じる。
         * リボンは いまのステップへ寄せなおす（スマホのアドレスバーの出し入れのような高さだけの変化では動かさない） */
        if (this._lastW !== window.innerWidth) {
          this._lastW = window.innerWidth;
          this.closeStaffPick();
          if (this._ribbonWant) { this._ribbonFront = null; this.updateRibbon(); }
        }
      });
      /* リボン: 手で動かした時刻（自動スクロールを3秒ひかえる）・続きの合図・吹き出しを閉じる */
      const rib = this.els['flow-ribbon'];
      const touched = () => { this._ribbonUserTs = performance.now(); };
      ['wheel', 'touchstart', 'pointerdown'].forEach((t) => rib.addEventListener(t, touched, { passive: true }));
      rib.addEventListener('scroll', () => { this.updateRibbonMore(); this.hideRibbonTip(); }, { passive: true });
      /* リボンの「›」: 右で切れている つぎのステップが ぜんぶ見えるところまで動かす（自動で寄せるのは3秒ひかえる） */
      if (this.els['btn-rib-more']) {
        this.els['btn-rib-more'].addEventListener('click', () => {
          Sfx.play('click');
          touched();
          const wl = rib.getBoundingClientRect();
          const edge = wl.right - 52;   // 「›」ボタンの左はし（ここより右は見えていないものとする）
          const steps = [...rib.querySelectorAll('.fr-step')];
          const next = steps.find((el) => el.getBoundingClientRect().right > edge + 1);
          let to = rib.scrollLeft + Math.max(120, rib.clientWidth * 0.5);
          if (next) {
            const r = next.getBoundingClientRect();
            to = rib.scrollLeft + Math.max(r.right - edge + 8, 40);
          }
          rib.scrollLeft = Math.min(to, rib.scrollWidth - rib.clientWidth);
          this.updateRibbonMore();
        });
      }
      /* スタッフ帯: 横スクロール（ホイールを横に）と「›」ボタン */
      const rs = this.els['res-scroll'];
      rs.addEventListener('scroll', () => this.updateResMore(), { passive: true });
      rs.addEventListener('wheel', (ev) => {
        if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && rs.scrollWidth > rs.clientWidth + 1) {
          rs.scrollLeft += ev.deltaY;
          ev.preventDefault();
        }
      }, { passive: false });
      this.els['btn-res-more'].addEventListener('click', () => {
        Sfx.play('click');
        rs.scrollBy({ left: Math.max(120, rs.clientWidth * 0.7), behavior: this.motionOk() ? 'smooth' : 'auto' });
      });
      /* スマホのシート・重なったスタッフのリスト: 外を押したら閉じる（開いた直後のイベントは無視） */
      document.addEventListener('pointerdown', (ev) => {
        const tgt = ev.target;
        if (tgt === this.els['apron']) return;
        if (this.spotPopTask && this.isNarrow() && performance.now() - (this._popOpenedAt || 0) > 350 &&
            !this.els['spot-pop'].contains(tgt)) this.closeSpotPop();
        if (!this.els['staff-pick'].contains(tgt)) this.closeStaffPick();
      }, true);
    },

    /* ---------------- キャンバス入力（タップ/ドラッグ/ズーム） ---------------- */
    bindCanvasInput() {
      const cv = this.els['apron'];
      const pointers = new Map();
      let dragMoved = false;
      let tapCancelled = false;
      let dragTh = 5;
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
        tapCancelled = false;
        pinchDist = null;
        /* 子どもの指は少し動くので、タッチは 10px・マウスは 5px まではタップとみなす */
        dragTh = ev.pointerType === 'touch' ? 10 : 5;
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
            this.updateTouchAction();
          }
          pinchDist = d;
          dragMoved = true;
          return;
        }
        const prev = pointers.get(ev.pointerId);
        const dx = p.x - prev.x, dy = p.y - prev.y;
        if (!dragMoved && Math.hypot(dx, dy) > dragTh) {
          /* パンできないとき（ぜんたいが見えている）はドラッグにしない。大きく動いたらタップにもしない */
          const canPan = Scene.canPan ? Scene.canPan() : true;
          if (canPan) dragMoved = true;
          else if (Math.hypot(dx, dy) > dragTh * 3) tapCancelled = true;
        }
        if (dragMoved) {
          Scene.panBy(dx, dy);
          pointers.set(ev.pointerId, p);
          cv.classList.add('dragging');
          this.closeSpotPop();
          this.closeStaffPick();
        }
      });
      const up = (ev) => {
        const wasTap = pointers.has(ev.pointerId) && !dragMoved && !tapCancelled && pointers.size === 1;
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
        this.updateTouchAction();
      }, { passive: false });
    },

    handleTap(sx, sy) {
      const s = this.state;
      if (!s || s.ended) return;
      this.closeStaffPick();
      /* 701〜1099px: 駐機場をさわったらドロワーをとじる（ドロワーの下の持ち場を押せるように） */
      this.autoCloseDrawer();
      const hit = Scene.hitTest(s, sx, sy);

      if (hit && hit.type === 'entity') {
        const e = s.entities.find((x) => x.id === hit.id);
        this.closeSpotPop();
        if (e.taskId === null && (e.status === 'idle' || e.status === 'returning')) {
          /* スマホ: まちあいの人が重なっているときは、だれをえらぶかのリストを出す */
          if (e.kind === 'staff' && this.els['apron'].clientWidth < 600) {
            const near = this.staffNear(s, sx, sy, 26);
            if (near.length >= 2) { this.openStaffPick(near, sx, sy); return; }
          }
          this.selected = (this.selected === e.id) ? null : e.id;
          Sfx.play('click');
        } else if (e.taskId) {
          /* おしごと中・あつまり中の人: その持ち場へ送れる人をえらんでいたら送る。そうでなければ持ち場のポップを開く */
          if (this.selected && window.Game.canAccept(e.taskId, this.selected)) {
            this.cb.onAssignEntity(this.selected, e.taskId);
            this.selected = null;
            return;
          }
          const task = s.tasks[e.taskId];
          const doing = task && task.status === 'active' ? 'を しているよ' : 'に むかっているよ';
          this.openSpotPop(e.taskId, { note: `${this.gx(e.label)}は いま この おしごと${doing}` });
        }
        return;
      }
      if (hit && hit.type === 'spot') {
        const t = s.tasks[hit.id];
        if (this.selected) {
          /* 人をえらんでいるとき: 行ける持ち場なら送る。行けない持ち場なら、理由（Game.assignEntity の文）をトーストで出して、えらびを とく。
           * ポップは開かない（だまって ちがう画面が出ないように） */
          const sel = this.selected;
          this.selected = null;
          this.cb.onAssignEntity(sel, t.id);
          return;
        }
        this.openSpotPop(t.id);
        return;
      }
      this.selected = null;
      this.closeSpotPop();
    },

    /* タップした点の近くにいる、えらべるスタッフ（まちあい中・もどり中） */
    staffNear(s, sx, sy, r) {
      return s.entities.filter((e) => {
        if (e.kind !== 'staff' || e.taskId !== null || (e.status !== 'idle' && e.status !== 'returning')) return false;
        const rec = Scene.ent && Scene.ent[e.id];
        if (!rec) return false;
        const sp = Scene.sceneToScreen(rec.pos.x, rec.pos.y - 9);
        return Math.hypot(sp.x - sx, sp.y - sy) <= r;
      });
    },
    openStaffPick(list, sx, sy) {
      const box = this.els['staff-pick'];
      /* タップした点に近い人から ならべる（入りきらないときは リストの中を スクロール） */
      const dist = (e) => { const p = Scene.sceneToScreen(Scene.ent[e.id].pos.x, Scene.ent[e.id].pos.y - 9); return Math.hypot(p.x - sx, p.y - sy); };
      list = list.slice().sort((a, b) => dist(a) - dist(b));
      box.innerHTML = '<div class="sk-head">だれを えらぶ？</div>' + list.map((e) => {
        const meta = window.RES_META.staff[e.type];
        const skill = e.skill === 'vet' ? this.ico('vet') : e.skill === 'rookie' ? this.ico('rookie') : '';
        return `<button class="sk-row" type="button" role="menuitem" data-id="${e.id}"><span class="rc-ico" style="--c:${meta.color}">${this.resIco(e.type)}</span>${skill}${this.resName(e.label)}</button>`;
      }).join('');
      /* 開いた直後（350ms）のクリックは無視する（タッチの互換クリックが、指の下に開いた行に当たって ねらっていない人が えらばれないように） */
      this._pickOpenedAt = performance.now();
      box.querySelectorAll('.sk-row').forEach((b) => {
        b.addEventListener('click', () => {
          if (performance.now() - (this._pickOpenedAt || 0) < 350) return;
          Sfx.play('click');
          this.selected = b.dataset.id;
          this.closeStaffPick();
        });
      });
      box.classList.remove('hidden');
      /* リストを開いている間は コーチのふきだしを かくす（リストのうしろに 文が半分 見えないように。12秒のタイマーは止めない） */
      if (this.els['top-rail']) this.els['top-rail'].classList.add('pick-open');
      const wrap = this.els['apron-wrap'];
      const w = box.offsetWidth, h = box.offsetHeight;
      box.style.left = clamp(sx - w / 2, 8, Math.max(8, wrap.clientWidth - w - 8)) + 'px';
      box.style.top = clamp(sy + 14, 8, Math.max(8, wrap.clientHeight - h - 8)) + 'px';
    },
    closeStaffPick() {
      const box = this.els['staff-pick'];
      if (box && !box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; }
      if (this.els['top-rail']) this.els['top-rail'].classList.remove('pick-open');
    },

    /* ---------------- ながれリボン（常時表示の進行バー） ----------------
     * 12の作業を「ステップ1〜7」の順に並べ、いまどこまで進んだかを一目で見せる。
     * 同じまるの中に入っている作業は「同時にできる仲間」。 */
    buildRibbon() {
      const wrap = this.els['flow-ribbon'];
      if (!wrap) return;
      this.ribbonChips = {};
      this.ribbonSteps = [];
      this._ribbonFront = null;
      this._ribbonWant = null;
      cancelAnimationFrame(this._ribbonTw);
      this._ribbonTw = 0;
      wrap.scrollLeft = 0;
      const rows = window.FLOW_ROWS;
      wrap.innerHTML = '<span class="fr-lead" aria-hidden="true">ながれ</span>' + rows.map((row, i) => {
        const chips = row.tasks.map((id) => {
          const d = window.TASK_MAP[id];
          /* title（マウスを乗せると出る文字）にはルビが振れないので、かなで書く。aria-label は読み上げ用なので漢字のまま */
          return `<button class="fr-chip" data-task="${id}" title="${this.kana(d.name)}" aria-label="${d.name}">${this.taskIco(id)}<span class="fr-mark"></span></button>`;
        }).join('');
        return `<span class="fr-step" data-step="${row.step}">` +
          `<button class="fr-num" data-step="${row.step}" aria-label="ステップ${row.step}">${row.step}</button>` +
          chips + '</span>' +
          (i < rows.length - 1 ? '<span class="fr-arrow" aria-hidden="true">›</span>' : '');
      }).join('');

      wrap.querySelectorAll('.fr-chip').forEach((b) => {
        this.ribbonChips[b.dataset.task] = b;
        b.addEventListener('click', () => { Sfx.play('click'); this.onRibbonChip(b.dataset.task, b); });
      });
      wrap.querySelectorAll('.fr-num').forEach((b) => {
        const row = rows[Number(b.dataset.step) - 1];
        b.addEventListener('click', () => {
          Sfx.play('click');
          this.ribbonTip(b, `<strong>ステップ${row.step}</strong>: ${this.gx(row.cond)}`);
        });
      });
      rows.forEach((row) => {
        this.ribbonSteps.push({ row, el: wrap.querySelector(`.fr-step[data-step="${row.step}"]`) });
      });
      this.updateRibbon();
    },

    /* リボンのタップ: いまの状態におうじて「次にすること」へ案内する（答えは押したチップの真下に出す） */
    onRibbonChip(id, el) {
      const s = this.state;
      if (!s) return;
      const t = s.tasks[id];
      /* はじめる前・とうちゃく中は、ポップを開かずに 案内だけ（スタートの幕のうしろに ポップが残らないように） */
      const before = !this.els['start-overlay'].classList.contains('hidden');
      if (before || Scene.arrivalT != null) {
        const msg = before ? 'まずは「▶ はじめる」を おしてね' : '✈ いま とうちゃくしているよ。とまったら はじめよう';
        if (el) this.ribbonTip(el, this.gx(msg)); else this.toast(msg, 'info');
        return;
      }
      if (t.status === 'locked') {
        this.ribbonTip(el, this.ico('lock') + ' ' + this.gx(window.Game.lockReason(id)));
      } else if (t.status === 'done') {
        this.ribbonTip(el, this.ico('check') + ' ' + this.gx(`「${t.def.name}」は もう おわったよ`));
      } else {
        this.openSpotPop(id);
      }
    },

    /* 押した部品の真下に出す小さな吹き出し（3.5秒で消える。リボンを横にスクロールしたら消える） */
    ribbonTip(el, html) {
      /* 押した部品が見えていない（ながれマップから来た・とじた など）ときは、吹き出しにしない */
      if (!el || !el.isConnected || !el.getClientRects().length) { this.pushToast(html, 'info'); return; }
      let tip = this._frTip;
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'fr-tip hidden';
        tip.setAttribute('role', 'status');
        this.els['screen-game'].appendChild(tip);
        this._frTip = tip;
      }
      /* 消すタイマーは 位置をはかる前に置く（とちゅうで止まっても 3.5秒で消える） */
      clearTimeout(this._frTipTimer);
      this._frTipTimer = setTimeout(() => this.hideRibbonTip(), 3500);
      this.clearUnderTip();
      tip.innerHTML = html;
      tip.classList.remove('hidden', 'no-tail');
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const x = clamp(r.left + r.width / 2 - w / 2, 8, Math.max(8, window.innerWidth - w - 8));
      let top = r.bottom + 9;
      /* スマホでコーチが出ているときは、コーチの下に出す（コーチの文と×を かくさない）。チップから はなれるので しっぽは出さない */
      const coach = this.els['coach-bubble'];
      if (this.isNarrow() && coach && !coach.classList.contains('hidden')) {
        const cb = coach.getBoundingClientRect();
        if (cb.height > 0 && cb.bottom + 6 > top) { top = cb.bottom + 6; tip.classList.add('no-tail'); }
      }
      tip.style.left = x + 'px';
      tip.style.top = top + 'px';
      tip.style.setProperty('--tip-x', clamp(r.left + r.width / 2 - x, 14, w - 14) + 'px');
      /* 吹き出しと重なる 上の知らせは、出ている間だけ うすくする（文と文が ぶつかって 読めなくならないように。位置は動かさない） */
      const tr = tip.getBoundingClientRect();
      if (this.els['top-rail']) {
        [...this.els['top-rail'].children].forEach((c) => {
          if (c.classList.contains('hidden')) return;
          const q = c.getBoundingClientRect();
          if (q.width < 1 || q.height < 1) return;
          if (Math.min(q.right, tr.right) - Math.max(q.left, tr.left) > 2 && Math.min(q.bottom, tr.bottom) - Math.max(q.top, tr.top) > 2) c.classList.add('under-tip');
        });
      }
    },
    hideRibbonTip() {
      clearTimeout(this._frTipTimer);
      if (this._frTip) this._frTip.classList.add('hidden');
      this.clearUnderTip();
    },
    clearUnderTip() {
      if (this.els['top-rail']) this.els['top-rail'].querySelectorAll('.under-tip').forEach((c) => c.classList.remove('under-tip'));
    },

    updateRibbon() {
      const s = this.state;
      if (!s || !this.ribbonChips) return;
      const MARK = { 'fr-ready': 'play', 'fr-gathering': 'dots', 'fr-active': 'working', 'fr-done': 'check', 'fr-paused': 'storm' };
      Object.keys(this.ribbonChips).forEach((id) => {
        const el = this.ribbonChips[id];
        const t = s.tasks[id];
        const st = t.status;
        /* かみなりで止まっている外の作業は、カードと同じ「かみなりで おやすみ」（灰青+かみなり） */
        const cls = this.isPausedTask(t) ? 'fr-paused' : 'fr-' + (st === 'moving' ? 'gathering' : st);
        if (el.dataset.st === cls) return;
        el.dataset.st = cls;
        el.title = this.kana(t.def.name) + (cls === 'fr-paused' ? '（かみなりで おやすみ）' : '');
        el.classList.remove('fr-locked', 'fr-ready', 'fr-gathering', 'fr-active', 'fr-done', 'fr-paused');
        el.classList.add(cls);
        el.querySelector('.fr-mark').innerHTML = MARK[cls] ? this.ico(MARK[cls]) : '';
      });
      let front = null, first = null;
      this.ribbonSteps.forEach(({ row, el }) => {
        if (!el) return;
        const sts = row.tasks.map((id) => s.tasks[id].status);
        const done = sts.every((x) => x === 'done');
        const now = !done && sts.some((x) => x === 'ready' || x === 'gathering' || x === 'active');
        el.classList.toggle('fr-sdone', done);
        el.classList.toggle('fr-snow', now);
        if (now) {
          if (first == null) first = row.step;   // まだ おしごとが のこっている、いちばん前のステップ
          front = row.step;                      // いま進められる中で、いちばん先のステップ
        }
      });
      const key = front == null ? null : first + '-' + front;
      if (key != null && key !== this._ribbonFront) {
        this._ribbonFront = key;
        this._ribbonWant = { first, front };
        this.queueRibbonScroll();
      }
      this.updateRibbonMore();
    },
    /* 同じ処理の中で何度かわっても、動かすのは その処理が終わったあとの1回だけ
     * （描画を待たずに始める。画面の更新がおそい端末でも、動きはじめが おくれない） */
    queueRibbonScroll() {
      if (this._ribbonQ) return;
      this._ribbonQ = true;
      Promise.resolve().then(() => { this._ribbonQ = false; this.scrollRibbonTo(this._ribbonWant); });
    },
    /* リボンの見せたい位置（scrollLeft）。いまの要素の位置から毎回はかる（終わったステップがたたまれても ずれない）。
     * いちばん前のステップから いちばん先のステップまでが入るなら、前から見せる。
     * 入らないなら、いちばん先のステップを右がわに ぜんぶ見せて、その左に まだ おしごと中のステップを できるだけ見せる */
    ribbonTarget(want) {
      const wrap = this.els['flow-ribbon'];
      const elOf = (step) => { const r = this.ribbonSteps && this.ribbonSteps.find((x) => x.row.step === step); return r && r.el; };
      const a = elOf(want.first), b = elOf(want.front);
      if (!wrap || !a || !b) return null;
      const wl = wrap.getBoundingClientRect().left, sl = wrap.scrollLeft;
      const fr = b.getBoundingClientRect();
      const x0 = sl + a.getBoundingClientRect().left - wl - 8;
      const xf = sl + fr.left - wl - 8;
      const xfEnd = sl + fr.right - wl + 8;
      /* 右はしは「続きがある」印で うすくなるので、9わりの幅に入るかで決める */
      const span = wrap.clientWidth * 0.9;
      const x = (xfEnd - x0 <= span) ? x0 : Math.min(xf, xfEnd - span);
      return clamp(x, 0, Math.max(0, wrap.scrollWidth - wrap.clientWidth));
    },
    /* いまのステップが見えるところへ、リボンだけを横に動かす（ページは動かさない。手で動かした直後の3秒は動かさない）。
     * ブラウザの smooth スクロールは、とちゅうで もう一度動かすと行きすぎるので使わない。
     * 毎フレーム scrollLeft を自分で書き、最後のフレームで目標に ぴったり止める */
    scrollRibbonTo(want) {
      const wrap = this.els['flow-ribbon'];
      if (!wrap || !want) return;
      const since = performance.now() - (this._ribbonUserTs || -1e9);
      if (since < 3000) {
        /* 手で動かした直後: 3秒たってから、もう一度ためす（そのときも さわっていれば、また まつ） */
        clearTimeout(this._ribbonRetry);
        this._ribbonRetry = setTimeout(() => { if (this._ribbonWant === want) this.queueRibbonScroll(); }, 3000 - since + 50);
        return;
      }
      cancelAnimationFrame(this._ribbonTw);
      this._ribbonTw = 0;
      if (wrap.scrollWidth <= wrap.clientWidth + 1) return;
      const to0 = this.ribbonTarget(want);
      if (to0 == null) return;
      if (!this.motionOk() || Math.abs(to0 - wrap.scrollLeft) < 2) { this._ribbonTok = null; wrap.scrollLeft = to0; return; }
      const from = wrap.scrollLeft, t0 = performance.now(), dur = 380, userTs = this._ribbonUserTs;
      const step = (now) => {
        if (this._ribbonUserTs !== userTs) { this._ribbonTw = 0; return; }   // 手で動かしたら、そこでやめる
        const k = clamp((now - t0) / dur, 0, 1), e = 1 - Math.pow(1 - k, 3);
        const to = this.ribbonTarget(want);
        if (to == null) { this._ribbonTw = 0; return; }
        wrap.scrollLeft = from + (to - from) * e;
        this._ribbonTw = k < 1 ? requestAnimationFrame(step) : 0;
      };
      this._ribbonTw = requestAnimationFrame(step);
      /* 画面の更新が とちゅうで止まっても（おそい端末・うしろのタブ）、終わるはずの時刻に1回だけ ぴったり目標へ。
       * ブラウザのアニメは使っていないので、ここで scrollLeft を書いても行きすぎない */
      const tok = {};
      this._ribbonTok = tok;
      clearTimeout(this._ribbonFix);
      this._ribbonFix = setTimeout(() => {
        if (this._ribbonTok !== tok || this._ribbonUserTs !== userTs) return;
        cancelAnimationFrame(this._ribbonTw);
        this._ribbonTw = 0;
        const to = this.ribbonTarget(want);
        if (to != null && Math.abs(wrap.scrollLeft - to) > 1) wrap.scrollLeft = to;
      }, dur + 250);
    },
    updateRibbonMore() {
      const w = this.els['flow-ribbon'];
      if (!w) return;
      const more = w.scrollLeft + w.clientWidth < w.scrollWidth - 2;
      if (w.classList.contains('has-more') !== more) w.classList.toggle('has-more', more);
      const b = this.els['btn-rib-more'];
      if (b && b.classList.contains('hidden') === more) b.classList.toggle('hidden', !more);
    },

    /* ---------------- 作業スポットのポップオーバー ---------------- */
    openSpotPop(taskId, opt) {
      const s = this.state;
      const t = s && s.tasks[taskId];
      if (!t) return;
      opt = opt || {};
      /* opt.refresh = 中身を新しくするための開き直し（利用者が開いたのではない）。ドロワー・ほかの部品は そのまま */
      if (!opt.refresh) {
        /* Esc で とじたとき、フォーカスを もどす先（リボンのチップ・ヒント・カードのボタンなど） */
        const ae = document.activeElement;
        this._popOpener = ae && ae !== document.body && !this.els['spot-pop'].contains(ae) ? ae : null;
        this.autoCloseDrawer();
        /* ドロワーを とじたら、その場で 駐機場の見える範囲を知らせなおす（カメラの行き先が決まってから ポップを置く） */
        this.syncDrawer();
        this.closeStaffPick();
        this.hideRibbonTip();
        this._popOpenedAt = performance.now();
        this._popSide = null;
        if (this.spotPopTask !== taskId) this._spPaceOpen = false;
      }
      this.spotPopTask = taskId;
      const pop = this.els['spot-pop'];
      const G = window.Game;
      const rubi = window.rubi;

      let info = '';
      let extra = '';
      const btns = [];
      const cancellable = t.id !== 'pushback' && t.id !== 'depart';
      if (t.status === 'ready' || t.status === 'gathering') {
        const miss = this.missingHtml(t.id);
        if (t.status === 'ready') {
          info = (miss ? `ひつよう: ${miss}<br>` : '') +
            `${this.ico('play')} はじめる で、あいている なかまが じどうで むかうよ`;
          btns.push({ html: `${this.ico('play')}はじめる`, cls: 'btn-primary btn-sm', act: () => this.cb.onStartTask(t.id) });
        } else {
          info = miss ? `あと ${miss}` : 'みんな そろったよ。つくのを まってね';
          if (miss) btns.push({ html: `${this.ico('play')}のこりを よぶ`, cls: 'btn-primary btn-sm', act: () => this.cb.onStartTask(t.id) });
          if (cancellable) btns.push({ html: `${this.ico('stop')}ストップ`, cls: 'btn-warnghost btn-sm', act: () => this.cb.onCancelTask(t.id) });
        }
      } else if (t.status === 'active') {
        info = this.gx(`のこり 約${Math.max(1, Math.ceil(G.effDur(t) - t.progress))}分`);
        if (cancellable) btns.push({ html: `${this.ico('stop')}ストップ`, cls: 'btn-warnghost btn-sm', act: () => this.cb.onCancelTask(t.id) });
      } else if (t.status === 'locked') {
        info = this.ico('lock') + ' ' + this.gx(G.lockReason(t.id));
        /* つぎにすることへ進めるように: 前の作業がはじめられるなら、その作業を開くボタン。進んでいるなら進みぐあい */
        const depId = G.lockDep ? G.lockDep(t.id) : null;
        const dep = depId && s.tasks[depId];
        if (dep && dep.status === 'ready') {
          /* 文字は1つの <span> に（ボタンは inline-flex なので、ばらばらだと「「」「乗客」「の」… のあいだに すき間が入る） */
          btns.push({ html: `${this.taskIco(dep.id)}<span>「${rubi(dep.def.name)}」を みる</span>`, cls: 'btn-primary btn-sm', act: () => this.openSpotPop(dep.id) });
        } else if (dep && dep.status === 'active') {
          const pct = clamp((dep.progress / G.effDur(dep)) * 100, 0, 100);
          extra = `<div class="sp-dep"><span class="sp-ticon">${this.taskIco(dep.id)}</span><div class="tc-bar"><div class="tc-fill" style="width:${pct.toFixed(0)}%"></div></div></div>`;
        }
      } else if (t.status === 'done') {
        info = this.ico('check') + ' ' + this.gx(`${window.fmtClock(t.doneAt)}に かんりょう！`);
      }
      const opens = G.nextOpens(t.id);
      const next = (t.status !== 'done' && t.status !== 'locked' && opens.length)
        ? `<div class="sp-next">${this.ico('unlock')} おわると → ${opens.map((d) => `${this.taskIco(d.id)}${rubi(d.name)}`).join('・')}</div>`
        : '';
      btns.push({ html: 'くわしく', cls: 'btn-ghost btn-sm', act: () => this.openTaskDetail(t.id) });
      /* ストップはいちばん右へ（くわしく のとなりに置かない） */
      btns.sort((a, b) => (a.cls.includes('btn-warnghost') ? 1 : 0) - (b.cls.includes('btn-warnghost') ? 1 : 0));

      let paceHtml = t.status !== 'done' && t.status !== 'locked' ? this.paceHtml(t) : '';
      /* 背の低い画面（横向きのスマホなど）: すすめかたは「すすめかたを かえる」で開く（ボタンの列が ポップの下に おしだされないように）。
       * えらべる値・ペースの操作は かえない */
      if (paceHtml && window.matchMedia('(max-height: 500px)').matches) {
        const now = rubi(window.PACE[t.pace] ? window.PACE[t.pace].label : 'ふつう');
        paceHtml = `<details class="sp-pace-more"${this._spPaceOpen ? ' open' : ''}><summary>${this.ico('chevron-right')}すすめかたを かえる<span class="sp-pace-now">（いま: ${now}）</span></summary>${paceHtml}</details>`;
      }

      /* ボタンの列は 本文（スクロールする所）の外に置き、いつも ポップの下はしに見せる */
      pop.innerHTML = `
        <div class="sp-body">
          <div class="sp-title"><span class="sp-step" data-step="${t.def.step || ''}">ステップ${t.def.step || '-'}</span><span class="sp-ticon">${this.taskIco(t.id)}</span><span class="sp-name">${rubi(t.def.name)}</span></div>
          ${opt.note ? `<div class="sp-note">${opt.note}</div>` : ''}
          <div class="sp-info">${info}</div>
          ${extra}
          ${paceHtml}
          ${next}
        </div>
        <div class="sp-btns"></div>
        <button class="sp-close" type="button" aria-label="とじる">${this.ico('close')}</button>`;
      const det = pop.querySelector('.sp-pace-more');
      if (det) {
        det.addEventListener('toggle', () => {
          this._spPaceOpen = det.open;
          const body = pop.querySelector('.sp-body');
          /* 開いたら、3つのボタンが見えるところまで 本文を動かす（ページは動かさない） */
          const pc = det.open && det.querySelector('.pace-ctrl');
          if (pc && body) {
            const d = pc.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 8;
            if (d > 0) body.scrollTop += d;
          }
          this.updateScrollMore(body);
        });
      }
      const btnWrap = pop.querySelector('.sp-btns');
      btns.forEach((b) => {
        const el = document.createElement('button');
        el.className = 'btn ' + b.cls;
        el.innerHTML = b.html;
        el.addEventListener('click', () => { Sfx.play('click'); this.closeSpotPop(); b.act(); });
        btnWrap.appendChild(el);
      });
      pop.querySelector('.sp-close').addEventListener('click', () => { Sfx.play('click'); this.closeSpotPop(); });
      pop.querySelectorAll('.pace-btn').forEach((el) => {
        el.addEventListener('click', () => {
          Sfx.play('click');
          const p = el.dataset.pace;
          this.cb.onSetPace(t.id, p);
          if (!this.spotPopTask) return;   // おしごと中になって とじた
          this.openSpotPop(taskId, Object.assign({}, opt, { refresh: true })); // 表示更新
          /* 作りなおしたので、押したボタンへ フォーカスを もどす（キーボードで つづけて えらべるように） */
          const nb = this.els['spot-pop'].querySelector(`.pace-btn[data-pace="${p}"]`);
          if (nb) { try { nb.focus({ preventScroll: true }); } catch (e) { nb.focus(); } }
        });
      });
      const body = pop.querySelector('.sp-body');
      body.addEventListener('scroll', () => this.updateScrollMore(body), { passive: true });

      pop.classList.remove('hidden', 'sp-arrow-left', 'sp-arrow-right', 'sp-arrow-up');
      if (this.isNarrow()) {
        /* スマホは下からのシート（位置・高さは CSS が決める） */
        pop.style.left = '';
        pop.style.top = '';
        pop.style.maxHeight = '';
        this.updateScrollMore(body);
        /* 開いたら、出ているトーストを片づける（モーダル・きろくと同じ。シートを見せるために ページが動くと、
         * HUD の下に固定したトーストが シートの上はしに かかる。開いている間の知らせは ためて、とじたら出す） */
        if (!opt.refresh) { this.els['toast-area'].innerHTML = ''; this.revealSpotAboveSheet(t.id); }
        return;
      }
      /* 背の低い横長の画面も、開いたら 出ているトーストを片づける（ポップが 駐機場の ほとんどを おおう。開いている間は ためる） */
      if (!opt.refresh && this.shortWide()) this.els['toast-area'].innerHTML = '';
      /* 持ち場が 安全な範囲の外（画面の外・ドロワーやスコア板の下）なら、カメラを持ち場へ動かしてから置く
       * （プッシュバック中に 自分でズームしたあとなど。押す車から はなれた所や ドロワーのカードの上に 出さない） */
      if (!opt.refresh) {
        const sp = this.spotScreenPos(t.id), f = Scene.safeRectAt ? Scene.safeRectAt() : null;
        const a = Scene.anchorOf(t.id);
        if (f && a && Scene.focusOn && (sp.x < f.l || sp.x > f.r || sp.y < f.t || sp.y > f.b)) Scene.focusOn(a[0], a[1]);
      }
      this.placeSpotPop(t.id);
      this.updateScrollMore(body);
    },

    /* 持ち場の画面上の位置（キャンバスの左上から）。カメラが補間で動いている間は、動き終わったときの位置
     * （開いた瞬間から 正しい所に置き、補間のあいだ ポップを ゆらさない）。余白だけを補間しているとき（機体を追っているあいだ）は、
     * カメラは今の値のまま（Scene.sceneToScreenAt が決める）。Scene の値は かえない */
    spotScreenPos(taskId) {
      const a = Scene.anchorOf(taskId) || [615, 320];
      return Scene.sceneToScreenAt ? Scene.sceneToScreenAt(a[0], a[1]) : Scene.sceneToScreen(a[0], a[1]);
    },
    /* 広い画面: カメラが動いたら（ドロワーの開け閉め・ズーム・機体を追う など）、ポップを持ち場のそばへ置きなおす。
     * 4px 以上動いたときだけ。ゆびで ポップを押している間は動かさない。持ち場が画面の外・ドロワーの下へ出たら とじる */
    followSpotPop(force) {
      const id = this.spotPopTask;
      if (!id || this.isNarrow() || this._popPressed) return;
      const wrap = this.els['apron-wrap'];
      if (!wrap || !wrap.clientWidth) return;
      const sp = this.spotScreenPos(id);
      const last = this._popAt;
      if (!force && last && Math.abs(sp.x - last.x) < 4 && Math.abs(sp.y - last.y) < 4) return;
      if (sp.x < -4 || sp.y < -4 || sp.x > wrap.clientWidth + 4 || sp.y > wrap.clientHeight + 4) { this.closeSpotPop(); return; }
      /* 持ち場が 開いたドロワーの下（安全な範囲の左はしより左）に入ったら とじる（ポップを ドロワーのカードの上に 出さない） */
      const f = Scene.safeRectAt ? Scene.safeRectAt() : null;
      if (f && f.l > 0 && sp.x < f.l - 8) { this.closeSpotPop(); return; }
      this.placeSpotPop(id);
    },
    /* スマホ: 下からのシートの うしろに 押した持ち場が かくれるときは、ページを その分だけ 下へスクロールする
     * （持ち場が シートの上に見えるように。上の HUD の下には 入れない） */
    revealSpotAboveSheet(taskId) {
      const pop = this.els['spot-pop'], cv = this.els['apron'];
      if (!pop || !cv) return;
      const a = Scene.anchorOf(taskId);
      if (!a) return;
      const sp = Scene.sceneToScreen(a[0], a[1]);
      const c = cv.getBoundingClientRect();
      const y = c.top + sp.y;
      const sheetTop = pop.getBoundingClientRect().top;
      const hud = document.getElementById('hud');
      const hudB = hud ? hud.getBoundingClientRect().bottom : 0;
      const want = y - (sheetTop - 34);   // 持ち場の輪（半径 約20px）まで シートの上に出す（出てくる動きの 4px もふくめる）
      if (want <= 0) return;
      const room = y - (hudB + 30);       // HUD の下に入れない
      const d = Math.min(want, Math.max(0, room));
      if (d > 1) window.scrollBy(0, d);
    },
    /* 中身が下へ続くとき（スクロールできるとき）だけ、下はしを うすくして「▼ したに つづくよ」を出す。いちばん下まで来たら消す */
    updateScrollMore(el) {
      if (!el) return;
      const more = el.scrollHeight > el.clientHeight + 2 && el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      if (el.classList.contains('scroll-more') !== more) el.classList.toggle('scroll-more', more);
      const hint = el.parentElement && el.parentElement.querySelector(':scope > .more-hint');
      if (hint) hint.classList.toggle('hidden', !more);
    },

    /* 持ち場のそばに置く。ドロワー・スコア板・スタッフ帯・ズーム・上の知らせをよけて、右 → 左 → 下 の順にためす */
    placeSpotPop(taskId) {
      const pop = this.els['spot-pop'];
      const wrap = this.els['apron-wrap'];
      const W = wrap.clientWidth, H = wrap.clientHeight;
      if (Scene.resize && (Scene.cw !== W || Scene.ch !== H)) Scene.resize();   // 画面を出した直後でも、いまの大きさで計算する
      const sp = this.spotScreenPos(taskId);
      this._popAt = { x: sp.x, y: sp.y };
      pop.classList.remove('sp-arrow-left', 'sp-arrow-right', 'sp-arrow-up');
      const wr = wrap.getBoundingClientRect();
      /* 上下は スタッフ帯の上まで。入らないときはポップの中をスクロールする */
      const resR = this.els['panel-resources'].getBoundingClientRect();
      const bandB = Math.min(H, resR.top - wr.top) - 8;
      pop.style.maxHeight = Math.max(160, bandB - 8) + 'px';
      const w = pop.offsetWidth, h = pop.offsetHeight;
      const rel = (el) => {
        if (!el || el.classList.contains('hidden')) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return null;
        return { x: r.left - wr.left, y: r.top - wr.top, w: r.width, h: r.height };
      };
      const pt = this.els['panel-tasks'];
      const boxes = [
        pt.classList.contains('closed') ? rel(this.els['btn-drawer-tasks']) : rel(pt),
        rel(this.els['panel-status']), rel(this.els['panel-resources']), rel(this.els['zoom-ctrl']),
        ...[...this.els['top-rail'].children].map(rel),
      ].filter(Boolean);
      const cover = (x, y) => boxes.reduce((sum, b) => {
        const ix = Math.min(x + w, b.x + b.w) - Math.max(x, b.x);
        const iy = Math.min(y + h, b.y + b.h) - Math.max(y, b.y);
        return sum + (ix > 0 && iy > 0 ? ix * iy : 0);
      }, 0);
      const fit = (x, y) => [clamp(x, 8, Math.max(8, W - w - 8)), clamp(y, 8, Math.max(8, bandB - h))];
      /* 上の知らせの下はし（そこより下に置けば、知らせにかからない） */
      const railB = [...this.els['top-rail'].children].map(rel).filter(Boolean).reduce((m, b) => Math.max(m, b.y + b.h), 0);
      const cands = [
        { side: 'right', x: sp.x + 24, y: sp.y - 44 },
        { side: 'right', x: sp.x + 24, y: railB + 8 },
        { side: 'right', x: sp.x + 24, y: sp.y - h + 44 },
        { side: 'left', x: sp.x - 24 - w, y: sp.y - 44 },
        { side: 'left', x: sp.x - 24 - w, y: railB + 8 },
        { side: 'left', x: sp.x - 24 - w, y: sp.y - h + 44 },
        { side: 'below', x: sp.x - w / 2, y: sp.y + 28 },
      ];
      let best = null;
      /* 置きなおすときは、前と同じ側が まだ何にも かからないなら その側を使う（左右に 行ったり来たり させない） */
      const prefer = this._popSide;
      const order = prefer ? [...cands.filter((c) => c.side === prefer), ...cands.filter((c) => c.side !== prefer)] : cands;
      for (const c of order) {
        const [x, y] = fit(c.x, c.y);
        const onAnchor = sp.x > x - 6 && sp.x < x + w + 6 && sp.y > y - 6 && sp.y < y + h + 6;
        const score = cover(x, y) + (onAnchor ? 1e7 : 0);
        if (!best || score < best.score) best = { side: c.side, x, y, score };
        if (score === 0) break;
      }
      this._popSide = best.side;
      pop.style.left = best.x + 'px';
      pop.style.top = best.y + 'px';
      /* しっぽ（置いた側に、持ち場を指す三角。持ち場の高さにとどくときだけ） */
      const reachY = sp.y >= best.y + 12 && sp.y <= best.y + h - 12;
      if (best.side === 'right' && best.x >= sp.x && reachY) {
        pop.classList.add('sp-arrow-left');
        pop.style.setProperty('--ay', clamp(sp.y - best.y, 18, h - 18) + 'px');
      } else if (best.side === 'left' && best.x + w <= sp.x && reachY) {
        pop.classList.add('sp-arrow-right');
        pop.style.setProperty('--ay', clamp(sp.y - best.y, 18, h - 18) + 'px');
      } else if (best.side === 'below' && best.y >= sp.y) {
        pop.classList.add('sp-arrow-up');
        pop.style.setProperty('--ax', clamp(sp.x - best.x, 18, w - 18) + 'px');
      }
    },
    closeSpotPop() {
      const was = !!this.spotPopTask;
      this.spotPopTask = null;
      this._popAt = null;
      const pop = this.els['spot-pop'];
      pop.classList.add('hidden');
      pop.style.maxHeight = '';
      /* スマホのシートを開いている間に ためていたトーストを、閉じたら 1枚だけ出す（モーダルと同じ。まだ ためておく間なら 出さない）。
       * シートの「はじめる」などは 閉じてから作業を動かすので、その処理が すんでから（はじめた作業を のぞいて）出す */
      if (was && this._toastQ && this._toastQ.length) Promise.resolve().then(() => this.flushToastQ());
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
      /* スタートの案内のカードは、画面を出した その場で 帯の あいだに置く */
      if (name === 'game') this.placeStartCard();
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
        const sky = skyOf(st.weather.icon);
        /* 空の枠の印: 「はれ→かみなりくるかも」は 太陽 → かみなり の2つで見せる（くもりと同じ印にしない） */
        const skyIco = sky === 'storm'
          ? `${ic('sun', { cls: 'sky-from' })}${ic('chevron-right', { cls: 'sky-arrow' })}${ic('storm', { cls: 'sky-to' })}`
          : ic(wx);
        const pb = (s) => this.tightRuby(this.phraseBreaks(rubi(s)));
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
          <span class="sc-sky sky-${sky}" aria-hidden="true">${skyIco}</span>
          <span class="sc-body">
            <span class="sc-row1">
              <span class="sc-name"><span class="sc-num">${num}</span><span class="sc-title">${pb(title)}</span></span>
              ${unlocked ? `<span class="sc-diff diff-${diff[1]}">${diff[0]}</span>` : `<span class="sc-lockbadge" aria-hidden="true">${ic('lock')}</span>`}
            </span>
            <span class="sc-sub">${pb(st.subtitle)}</span>
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
      this.closeStaffPick();
      this.hideCoach();
      this.hideRibbonTip();
      this._toastQ = [];
      this._openToast = null;
      this._lastReady = null;
      this._wxPaused = null;
      this._lastHint = null;
      this._railT = 0;
      clearTimeout(this._railTimer); this._railTimer = 0;

      /* 「ステージ」と番号を わけておく（幅 374px 以下では「ステージ」を小さい見出しにして 番号の上に出す。「ス…」と切らない） */
      const sn = String(state.stage.shortName || '');
      const snm = sn.match(/^(\D+?)(\d+)$/);
      this.els['hud-stage-name'].innerHTML = snm ? `<span class="sn-k">${snm[1]}</span><span class="sn-n">${snm[2]}</span>` : window.rubi(sn);
      this.updateWeatherHud();
      this.els['hud-std'].textContent = window.fmtClock(state.stage.std);
      /* きろくが まだ 1行もないときは、空欄だけに しない */
      this.els['game-log'].innerHTML = `<li class="lg-empty">${window.rubi('まだ きろくは ないよ')}</li>`;
      this.els['event-banner'].classList.add('hidden');
      this.els['screen-game'].classList.remove('has-event');
      this.els['toast-area'].innerHTML = '';

      /* ドロワーの初期状態: 広い画面ではひらく（ステージの始めは すべらせずに置く） */
      const pt = this.els['panel-tasks'];
      pt.classList.add('no-anim');
      pt.classList.toggle('closed', window.innerWidth < 1100);
      void pt.offsetWidth;
      pt.classList.remove('no-anim');
      this.els['panel-status'].classList.remove('log-open');
      this.setLogToggle(false);

      const rubi = window.rubi;
      this.els['start-overlay'].classList.remove('hidden');
      /* 見出しは「ステージ1」と題名の2行（「ステージ1　は／じめての…」のように ことばの途中で折れないように） */
      const nm = String(state.stage.name).split('　');
      this.els['start-overlay-title'].innerHTML = nm.length > 1
        ? `<span class="sh-num">${this.gx(nm[0])}</span><span class="sh-title">${this.gx(nm.slice(1).join('　'))}</span>`
        : this.gx(state.stage.name);
      this.els['start-overlay-text'].innerHTML = this.gx(state.stage.intro).replace(/\n/g, '<br>');
      document.getElementById('start-trivia').innerHTML = this.ico('info') + ' まめちしき: ' + this.gx(pickTrivia());
      this.placeStartCard();
      this.els['pause-chip'].classList.add('hidden');
      this.prevMetrics = { safety: 100, punct: 100, sat: 100, cost: 100 };

      const list = this.els['task-list'];
      list.innerHTML = '';
      state.taskList.forEach((t) => {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.id = 'card-' + t.id;
        const reqs = window.taskReqList(t.def).map((r) =>
          `<span class="req-chip" data-req="${r.kind === 'staff' ? 'staff' : 'vehicle'}:${r.type}" style="--c:${r.color}">${this.resIco(r.type)}${this.resName(r.label)}×${r.n}<span class="req-x hidden">${this.ico('close')}</span></span>`).join('');
        card.innerHTML = `
          <div class="tc-head">
            <span class="tc-step" data-step="${t.def.step || ''}">ステップ${t.def.step || '-'}</span>
            <span class="tc-icon">${this.taskIco(t.id)}</span>
            <span class="tc-name">${rubi(t.def.name)}</span>
            <span class="tc-state"></span>
          </div>
          <div class="tc-reqs">${reqs || '<span class="req-chip req-none">だれも いらない</span>'}</div>
          <div class="tc-short"></div>
          <div class="tc-bar"><div class="tc-fill"></div></div>
          <div class="tc-foot">
            <span class="tc-time"></span>
            <span class="tc-extra"></span>
            ${t.def.priority === 'high' ? `<span class="tc-prio prio-high">だいじ</span>` : ''}
          </div>
          ${this.paceHtml(t)}
          <div class="tc-lockmsg"></div>
          <div class="tc-unlocks"></div>
          <div class="tc-btns">
            <button class="btn btn-sm btn-primary tc-start">${this.ico('play')}<span class="tc-start-txt">はじめる</span></button>
            <button class="btn btn-sm btn-primary tc-issue hidden">${this.ico('alert')}どうする？ えらぶ</button>
            <button class="btn btn-sm btn-ghost tc-info">くわしく</button>
            <button class="btn btn-sm btn-warnghost tc-cancel hidden">${this.ico('stop')}ストップ</button>
          </div>`;
        card.querySelector('.tc-start').addEventListener('click', () => this.cb.onStartTask(t.id));
        card.querySelector('.tc-issue').addEventListener('click', () => { Sfx.play('click'); this.openEventModal(); });
        card.querySelector('.tc-info').addEventListener('click', () => { Sfx.play('click'); this.openTaskDetail(t.id); });
        card.querySelector('.tc-cancel').addEventListener('click', () => {
          /* 「ストップ」が出てから 0.6秒は 押しても むし（「はじめる」の2度押しで すぐ止めてしまわないように） */
          if (performance.now() - (card._cancelShownAt || 0) < 600) return;
          Sfx.play('click');
          this.cb.onCancelTask(t.id);
        });
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
        const skillMark = e.skill === 'vet' ? this.ico('vet') : e.skill === 'rookie' ? this.ico('rookie') : '';
        if (e.skill === 'vet') chip.dataset.skill = 'ベテラン（おしごとが はやい）';
        if (e.skill === 'rookie') chip.dataset.skill = 'ルーキー（おしごとが ゆっくり）';
        chip.innerHTML = `<span class="rc-ico">${this.resIco(e.type)}</span><span class="rc-name">${skillMark}${this.resName(e.label)}</span><span class="rc-st"></span>`;
        (e.kind === 'staff' ? sStrip : vStrip).appendChild(chip);
        this.chipEls[e.id] = chip;
      });
      this.els['res-scroll'].scrollLeft = 0;
      this.buildRibbon();
      this.updateResources();
      this.updateMetrics();
      this.updateUnfinished();
      this.updateHint(true);
      this.updateClock(true);
      this.syncDrawer();
      this.updateTouchAction();
      requestAnimationFrame(() => { this.measureResH(); this.updateResMore(); this.updateRibbonMore(); this.applyViewInsets(); this.placeStartCard(); });
      setTimeout(() => { if (this.state === state) this.applyViewInsets(); }, 300);
    },

    hideStartOverlay() {
      this.els['start-overlay'].classList.add('hidden');
      this.els['screen-game'].classList.remove('start-cover');
      this.closeSpotPop();   // はじめる前に開いていたポップを、何もない駐機場の上に残さない
    },
    /* スタートの案内のカードを、上の HUD・ながれリボンと 下のスタッフ帯の あいだに置く（カードが帯・リボンに かからない）。
     *  ・入るとき: そのあいだの まんなか
     *  ・入らないが、幕の下の HUD・リボン・スタッフ帯を かくして 幕の高さいっぱいを使えば まるごと入るとき（スマホの縦向きなど）:
     *    かくして、カードの中を スクロールしない形（まめちしきまで スクロールせずに読める）
     *  ・それでも入らないとき: カードの高さを そのあいだに おさえて、カードの中を スクロールする（「はじめる」は まめちしきより上にして、いつも見える）
     *  ・そのあいだに「はじめる」まで入らない 背の低い画面（スマホの横向きなど）: 幕の下の HUD・リボン・スタッフ帯を かくして、
     *    カードは画面の高さいっぱいまで使う（文は へらさない） */
    placeStartCard() {
      const ov = this.els['start-overlay'], sg = this.els['screen-game'];
      if (!ov || ov.classList.contains('hidden') || !sg.classList.contains('active')) return;
      const card = ov.querySelector('.start-card');
      if (!card._scrollBound) { card._scrollBound = true; card.addEventListener('scroll', () => this.updateScrollMore(card), { passive: true }); }
      ov.style.paddingTop = ''; ov.style.paddingBottom = '';
      card.style.maxHeight = '';
      card.classList.remove('sc-tight', 'scroll-more');
      sg.classList.remove('start-cover');
      const o = ov.getBoundingClientRect();
      if (o.height < 1) return;
      const box = (id) => {
        const el = this.els[id] || document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width >= 1 && r.height >= 1 ? r : null;
      };
      let top = o.top + 16, bot = o.bottom - 16;
      ['hud', 'flow-ribbon'].forEach((id) => { const r = box(id); if (r && r.bottom > o.top && r.top < o.top + o.height / 2) top = Math.max(top, r.bottom + 8); });
      const st = box('panel-resources');
      if (st && st.top < o.bottom && st.bottom > o.top + o.height / 2) bot = Math.min(bot, st.top - 8);
      const room = Math.floor(bot - top);
      const pad = () => { ov.style.paddingTop = Math.round(top - o.top) + 'px'; ov.style.paddingBottom = Math.round(o.bottom - bot) + 'px'; };
      if (card.offsetHeight <= room) { pad(); return; }
      /* 入らない: 幕の下の HUD・リボン・スタッフ帯を かくして 幕の高さいっぱいを使えば、カードが まるごと入るか
       * （入るなら、カードの中を スクロールしない形にする。まめちしきまで スクロールせずに読める） */
      sg.classList.add('start-cover');
      if (card.offsetHeight <= Math.floor(ov.getBoundingClientRect().height - 32)) { this.updateScrollMore(card); return; }
      sg.classList.remove('start-cover');
      /* それでも入らない: 「はじめる」を まめちしきより上にした形で、「はじめる」の下はしまでが入るか */
      card.classList.add('sc-tight');
      const need = Math.ceil(this.els['btn-begin'].getBoundingClientRect().bottom - card.getBoundingClientRect().top + parseFloat(getComputedStyle(card).paddingBottom));
      if (need <= room) {
        pad();
        card.style.maxHeight = room + 'px';
      } else {
        sg.classList.add('start-cover');
        const r2 = ov.getBoundingClientRect();
        card.style.maxHeight = Math.max(200, Math.floor(r2.height - 32)) + 'px';
      }
      this.updateScrollMore(card);
    },
    /* スタートの案内を出したら「はじめる」へフォーカス（キーボードで すぐ はじめられる） */
    focusBegin() {
      const b = this.els['btn-begin'];
      if (!b || this.els['start-overlay'].classList.contains('hidden') || !b.getClientRects().length) return;
      try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); }
    },

    /* ---- 作業カード・持ち場ポップの部品 ---- */
    /* 采配レバー（すすめかた）: 見出し + 3つのボタン + えらんだ方の効果の1行 */
    paceHtml(t) {
      if (!window.PACE_ALLOWED.has(t.id)) return '';
      const ICO = { careful: 'gauge-slow', normal: 'gauge-mid', rush: 'gauge-fast' };
      const btns = ['careful', 'normal', 'rush'].map((p) =>
        `<button class="pace-btn pace-${p}${t.pace === p ? ' on' : ''}" data-pace="${p}" aria-pressed="${t.pace === p}" title="${this.paceEffText(t.id, p)}">${this.ico(ICO[p])}${window.rubi(window.PACE[p].label)}</button>`).join('');
      const eff = this.paceEffText(t.id, t.pace);
      return `<div class="pace-wrap"><div class="pace-head">すすめかた</div>` +
        `<div class="pace-ctrl" role="group" aria-label="すすめかた">${btns}</div>` +
        `<div class="pace-eff${t.pace !== 'normal' ? ' show' : ''}">${t.pace !== 'normal' ? eff : ''}</div></div>`;
    },
    /* 効果の文（はやさは PACE、まんぞく・あんぜんの数は Game.paceEffect から作る。かなだけなので title にも使える） */
    paceEffText(id, pace) {
      const P = window.PACE[pace];
      if (!P || pace === 'normal') return 'ふつうの はやさ';
      const eff = window.Game.paceEffect ? window.Game.paceEffect(pace, id) : { sat: 0, safety: 0 };
      const num = (n) => (n > 0 ? '＋' : '−') + Math.abs(n);
      return (P.f > 1 ? 'ゆっくり' : 'はやい') +
        (eff.sat ? '・まんぞく ' + num(eff.sat) : '') + (eff.safety ? '・あんぜん ' + num(eff.safety) : '');
    },
    isPausedTask(t) {
      return window.Game.outdoorPaused() && t.def.outdoor && (t.status === 'active' || t.status === 'gathering');
    },
    /* 状態ピルの中身（アイコン+ことば。色だけにしない） */
    stateHtml(t, paused, issue) {
      const CHU = '<ruby>中<rt>ちゅう</rt></ruby>';
      if (issue) return this.ico('alert') + 'トラブル！';
      if (paused) {
        const s = this.state;
        const rest = Math.max(1, Math.ceil(s.outdoorPauseUntil - s.clock));
        return this.ico('storm') + this.gx(`かみなりで おやすみ（あと約${rest}分）`);
      }
      switch (t.status) {
        case 'locked': return this.ico('lock') + 'まだ';
        case 'ready': return this.ico('play') + 'はじめられる';
        case 'gathering': case 'moving': return this.ico('dots') + 'あつまり' + CHU;
        case 'active': return this.ico('working') + 'おしごと' + CHU;
        case 'done': return this.ico('check') + 'かんりょう！';
        default: return '';
      }
    },
    /* カードの下の1行（かかる時間・のこり・あと何が足りないか） */
    timeHtml(t, paused) {
      const G = window.Game;
      if (t.status === 'done') return `かんりょう ${window.fmtClock(t.doneAt)}`;
      if (t.status === 'active') return this.gx(`のこり 約${Math.max(1, Math.ceil(G.effDur(t) - t.progress))}分`);
      if (t.status === 'gathering') {
        if (paused) return this.gx('天気が よくなるまで まってね');
        const miss = this.missingHtml(t.id);
        return miss ? 'あと ' + miss : 'メンバーが むかっているよ';
      }
      return this.gx(`かかる時間 約${Math.ceil(G.effDur(t) - t.progress)}分`);
    },
    /* まだ そろっていない人・車（「[職種アイコン]ゲート×1」の形。職種・車の絵は Icons.res で出す） */
    missingHtml(id) {
      const G = window.Game;
      if (!G.availableFor) return window.rubi(G.missingSummary(id));
      return G.availableFor(id).map((r) => {
        const m = r.kind === 'staff' ? window.RES_META.staff[r.type] : window.RES_META.vehicles[r.type];
        return `${this.resIco(r.type)}${this.resName(m.short)}×${r.need}`;
      }).join('・');
    },
    /* いま空いている人・車が足りない種類: チップを灰色+✕にし、はじめられるカードには「給油車が あと1だい たりない」を出す */
    updateShortage(id) {
      const s = this.state;
      const card = this.cardEls[id];
      if (!s || !card || !window.Game.availableFor) return;
      const t = s.tasks[id];
      const list = (t.status === 'ready' || t.status === 'gathering') ? window.Game.availableFor(id) : [];
      const short = list.filter((r) => r.have < r.need);
      card.querySelectorAll('.req-chip[data-req]').forEach((c) => {
        const on = short.some((r) => `${r.kind}:${r.type}` === c.dataset.req);
        if (c.classList.contains('req-short') !== on) {
          c.classList.toggle('req-short', on);
          c.querySelector('.req-x').classList.toggle('hidden', !on);
        }
      });
      const line = t.status === 'ready' ? short.map((r) => {
        const m = r.kind === 'staff' ? window.RES_META.staff[r.type] : window.RES_META.vehicles[r.type];
        return `${this.resIco(r.type)}${this.resName(m.label)}が あと${this.countKana(r.kind, r.need - r.have)} たりない`;
      }).join('、') : '';
      const el = card.querySelector('.tc-short');
      this.setHtml(el, line);
      el.classList.toggle('show', !!line);
    },
    updateShortages() {
      const s = this.state;
      if (!s) return;
      s.taskList.forEach((t) => { if (t.status !== 'done' && t.status !== 'locked') this.updateShortage(t.id); });
    },
    /* 人は「ひとり・ふたり」、車は「Nだい」（漢字の読みがゆれないよう、かなで書く） */
    countKana(kind, n) {
      if (kind === 'staff') return n === 1 ? ' ひとり' : n === 2 ? ' ふたり' : `${n}にん`;
      return `${n}だい`;
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
      const paused = this.isPausedTask(t);
      const issue = this.issueTask === id && t.status !== 'done';
      if (paused) card.classList.add('st-paused');
      if (issue) card.classList.add('st-issue');
      const rubi = window.rubi;
      this.setHtml(card.querySelector('.tc-state'), this.stateHtml(t, paused, issue));

      const G = window.Game;
      this.setHtml(card.querySelector('.tc-time'), this.timeHtml(t, paused));
      this.setHtml(card.querySelector('.tc-extra'), this.gx(t.extra || ''));

      const fill = card.querySelector('.tc-fill');
      fill.style.width = `${clamp((t.progress / G.effDur(t)) * 100, 0, 100)}%`;

      const lockEl = card.querySelector('.tc-lockmsg');
      if (t.status === 'locked') {
        this.setHtml(lockEl, this.ico('lock') + ' ' + this.gx(G.lockReason(id)));
        lockEl.classList.add('show');
      } else {
        this.setHtml(lockEl, '');
        lockEl.classList.remove('show');
      }

      /* この作業がおわると、つぎに何が開くか（順番のつながりを見せる） */
      const unEl = card.querySelector('.tc-unlocks');
      if (unEl) {
        const opens = G.nextOpens(id).filter((d) => !d.auto);
        if (opens.length && t.status !== 'done' && t.status !== 'locked') {
          this.setHtml(unEl, this.ico('unlock') + ' おわると → ' + opens.map((d) => `${this.taskIco(d.id)}${rubi(d.name)}`).join('・'));
          unEl.classList.add('show');
        } else {
          unEl.classList.remove('show');
        }
      }

      /* ペースの選択状態と効果の1行 */
      card.querySelectorAll('.pace-btn').forEach((el) => {
        const on = el.dataset.pace === t.pace;
        el.classList.toggle('on', on);
        el.setAttribute('aria-pressed', String(on));
      });
      const effEl = card.querySelector('.pace-eff');
      if (effEl) {
        const show = t.pace !== 'normal';
        this.setHtml(effEl, show ? this.paceEffText(id, t.pace) : '');
        effEl.classList.toggle('show', show);
      }

      this.updateShortage(id);

      const btnStart = card.querySelector('.tc-start');
      const btnCancel = card.querySelector('.tc-cancel');
      const gatherFilled = t.status === 'gathering' && !(G.availableFor ? G.availableFor(id).length : G.missingSummary(id));
      btnStart.classList.toggle('hidden', t.status === 'active' || t.status === 'done' || t.status === 'locked' || gatherFilled);
      this.setHtml(btnStart.querySelector('.tc-start-txt'), t.status === 'gathering' ? 'のこりを よぶ' : 'はじめる');
      btnStart.disabled = false;
      card.querySelector('.tc-issue').classList.toggle('hidden', !issue);
      const cancellable = (t.status === 'active' || t.status === 'gathering') && id !== 'pushback' && id !== 'depart';
      if (cancellable && btnCancel.classList.contains('hidden')) card._cancelShownAt = performance.now();
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
        `<span class="req-chip" style="--c:${r.color}">${I.svg(I.res(r.type))}<span>${rubi(r.label)}×${r.n}</span></span>`).join('') || 'なし';
      /* はじめられる作業は「▶ はじめる」。あつまり中は、まだ たりない人や車が いるときだけ「▶ のこりを よぶ」
       * （ぜんいん むかっているときは出さない。押しても「到着を待ちましょう」になるだけなので）。ボタンで閉じてから onStartTask */
      const gathering = t.status === 'gathering';
      const canStart = t.status === 'ready' || (gathering && !window.Game.reqsFilled(t));
      const buttons = [{ label: 'とじる', cls: 'btn-ghost' }];
      if (canStart) buttons.push({ label: `${I.svg('play')} ${gathering ? 'のこりを よぶ' : 'はじめる'}`, cls: 'btn-primary', onClick: () => this.cb.onStartTask(t.id) });
      this.openModal({
        kind: 'detail',
        title: `${I.svg(I.task(t.id))} ${rubi(t.def.name)}`,
        body: `
          <p>${this.phraseBreaks(rubi(t.def.desc))}</p>
          <dl class="td-kv">
            <dt>かかる${rubi('時間')}</dt><dd>${rubi(`約${Math.max(1, Math.ceil(window.Game.effDur(t)))}分`)}</dd>
            <dt>ひつような<ruby>人<rt>ひと</rt></ruby>と<ruby>車<rt>くるま</rt></ruby></dt><dd>${reqs}</dd>
            <dt>はじめられるのは</dt><dd>${this.gx(t.def.depNote)}</dd>
          </dl>
          ${t.def.why ? `<p class="zk-why">${I.svg('info')} <strong>なぜ やるの？</strong> ${this.phraseBreaks(rubi(t.def.why))}</p>` : ''}
          ${t.def.note ? `<p class="modal-note">${I.svg('shield')} <strong>${rubi('安全')}メモ</strong> ${this.phraseBreaks(rubi(t.def.note))}</p>` : ''}`,
        buttons,
        dismissible: true,
      });
    },

    /* ---------------- リソース・指標・ログ ---------------- */
    updateWeatherHud() {
      const s = this.state;
      if (!s) return;
      const w = s.weatherNow || s.stage.weather;
      const paused = window.Game.outdoorPaused();
      this._wxPaused = paused;
      const el = this.els['hud-weather'];
      /* かみなりで そとの おしごとが止まっている間だけ、こはく色の札+かみなりのアイコン */
      const name = paused ? 'storm' : (window.Icons.emojiName(w.icon) || ({ '\u{1F325}': 'cloud' })[String(w.icon).replace(/\uFE0F/g, '')] || 'sun');
      const label = paused ? 'そとの おしごとは おやすみ' : w.label;
      this.setHtml(el, this.ico(name) + `<span class="wx-label">${this.gx(label)}</span>`);
      el.classList.toggle('wx-storm', paused);
    },

    updateResources() {
      const s = this.state;
      if (!s) return;
      const CHU = '<ruby>中<rt>ちゅう</rt></ruby>';
      const ST = { moving: 'いどう' + CHU, working: 'おしごと' + CHU, returning: 'もどり' + CHU };
      /* title（マウスを乗せると出る文字）はルビが振れないので かなで書く */
      const TITLE = { idle: 'まちあいちゅう', moving: 'いどうちゅう', working: 'おしごとちゅう', returning: 'もどりちゅう' };
      s.entities.forEach((e) => {
        const chip = this.chipEls[e.id];
        if (!chip) return;
        const task = e.taskId ? s.tasks[e.taskId] : null;
        /* かみなりで止まっている外の作業の人・車は「おやすみ」（カード・リボンと同じ 灰青+かみなり） */
        const paused = !!task && (e.status === 'working' || e.status === 'moving') && this.isPausedTask(task);
        const st = paused ? 'paused' : e.status;
        chip.classList.remove('rs-idle', 'rs-moving', 'rs-working', 'rs-returning', 'rs-paused');
        chip.classList.add('rs-' + st);
        /* まちあい中はピルを出さない（名前だけ） */
        const html = e.status === 'idle' ? '' : paused ? this.ico('storm') + 'おやすみ' + (task ? this.taskIco(task.id) : '')
          : (ST[e.status] || '') + (task ? this.taskIco(task.id) : '');
        this.setHtml(chip.querySelector('.rc-st'), html);
        chip.title = (chip.dataset.skill ? chip.dataset.skill + '・' : '') + (paused ? 'かみなりで おやすみ' : (TITLE[e.status] || ''));
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
      this.updateShortages();
      this.updateResMore();
    },
    /* スタッフ帯: 右に続きがあるときだけ、右はしを うすくして「›」ボタンを出す */
    updateResMore() {
      const rs = this.els['res-scroll'];
      if (!rs) return;
      const more = rs.scrollLeft + rs.clientWidth < rs.scrollWidth - 2;
      rs.classList.toggle('has-more', more);
      this.els['btn-res-more'].classList.toggle('hidden', !more);
    },
    /* スタッフ帯の高さを測って、ドロワー・ズーム・トーストの位置（--res-h）に使う */
    measureResH() {
      const p = this.els['panel-resources'];
      if (!p || !p.offsetHeight || this.isNarrow()) return;
      const h = p.offsetHeight + 'px';
      if (this._resH !== h) { this._resH = h; this.els['game-main'].style.setProperty('--res-h', h); }
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
          (bar.closest('.metric') || bar.parentElement).appendChild(span);
          setTimeout(() => span.remove(), 1500);
          bar.classList.remove('hit');
          void bar.offsetWidth;
          bar.classList.add('hit');
        }
        if (Math.abs(v - prev) >= 1) this.prevMetrics[key] = v;
        /* 40 未満は、数字も赤くして前に ⚠（色だけにしない） */
        const low = v < 40;
        this.setHtml(num, (low ? this.ico('alert') : '') + v);
        num.classList.toggle('low', low);
        bar.style.width = v + '%';
        bar.classList.toggle('low', low);
      };
      upd('safety', m.safety); upd('punct', m.punct); upd('sat', m.sat); upd('cost', m.cost);
    },

    updateUnfinished() {
      const s = this.state;
      if (!s) return;
      const n = s.taskList.filter((t) => t.status !== 'done').length;
      this.els['unfinished-count'].textContent = String(n);
      /* ドロワーのバッジ: いま開始できる作業の数（「▶4」） */
      const ready = s.taskList.filter((t) => t.status === 'ready').length;
      const badge = this.els['drawer-badge'] || document.getElementById('drawer-badge');
      this.setHtml(badge, this.ico('play') + `<b>${ready}</b>`);
      badge.classList.toggle('hidden', ready === 0);
      /* 閉じている間に、はじめられる数が増えたら、つまみの横に1回だけ知らせる */
      const closed = this.els['panel-tasks'].classList.contains('closed') && !this.isNarrow();
      if (this._lastReady != null && ready > this._lastReady && closed) this.showDrawerNudge(ready);
      else if (ready !== this._lastReady && this.els['drawer-nudge'] && !this.els['drawer-nudge'].classList.contains('hidden')) {
        /* 出ている吹き出しの数を いまの数にあわせる（0 になったら消す） */
        if (ready > 0) this.els['drawer-nudge'].innerHTML = this.nudgeHtml(ready);
        else this.els['drawer-nudge'].classList.add('hidden');
      }
      this._lastReady = ready;
    },
    /* 上の知らせの置き場に出すので、つまみを ことばで指す（しっぽは つけない） */
    nudgeHtml(n) {
      return `${this.ico('list')} ひだりの『おしごと』に はじめられる おしごとが ${n}こ`;
    },
    showDrawerNudge(n, html) {
      const el = this.els['drawer-nudge'];
      if (!el) return;
      el.innerHTML = html || this.nudgeHtml(n);
      el.classList.remove('hidden');
      clearTimeout(this._nudgeTimer);
      this._nudgeTimer = setTimeout(() => el.classList.add('hidden'), 4000);
    },

    /* 一時停止の帯 */
    setPausedIndicator(show) {
      const el = this.els['pause-chip'];
      /* 背の低い横長の画面では、上の知らせの札のかわりに HUD の「とめているよ」で知らせる（CSS が どちらを出すか決める） */
      const hp = this.els['hud-paused'];
      if (hp && hp.classList.contains('hidden') === show) hp.classList.toggle('hidden', !show);
      const hud = document.getElementById('hud');
      if (hud) hud.classList.toggle('is-paused', !!show);
      if (el.classList.contains('hidden') === !show) return;
      el.classList.toggle('hidden', !show);
      this.queueInsets();
    },

    updateHint(force) {
      if (!this.state) return;
      const now = performance.now();
      if (!force && now - this.hintThrottle < 800) return;
      this.hintThrottle = now;
      const el = this.els['hint-banner'];
      const wasHidden = el.classList.contains('hidden');
      /* イベント・コーチを出している間、せまいタブレットでドロワーを開いている間は、ヒントを出さない */
      const coachOn = this.els['coach-bubble'] && !this.els['coach-bubble'].classList.contains('hidden');
      const drawerOver = window.matchMedia('(min-width: 701px) and (max-width: 1099px)').matches &&
        !this.els['panel-tasks'].classList.contains('closed');
      let changed = false;
      const hint = (this.state.activeEvent || coachOn || drawerOver) ? null : window.Game.getHint();
      if (hint) {
        if (this._lastHint !== hint) {
          this._lastHint = hint;
          el.innerHTML = `<span class="hb-text">${this.ico('info')} ${this.gx(hint)}</span>`;
          changed = true;
        }
        el.classList.remove('hidden');
      } else {
        if (!(this.state.activeEvent || coachOn || drawerOver)) this._lastHint = null;
        el.classList.add('hidden');
      }
      /* 出た・消えた・文がかわった（行の数がかわるかもしれない）ときは、駐機場の見える範囲を知らせなおす */
      if (changed || wasHidden !== el.classList.contains('hidden')) this.queueInsets();
    },
    /* ヒントを押したら、おすすめの作業を開く（はじめられるならポップ、そうでなければカード） */
    onHintTap() {
      const G = window.Game;
      const id = G.getHintTarget ? G.getHintTarget() : null;
      const t = id && this.state && this.state.tasks[id];
      if (!t) return;
      if (t.status === 'ready') { this.openSpotPop(id); return; }
      const card = this.cardEls[id];
      if (!card) return;
      if (!this.isNarrow() && this.els['panel-tasks'].classList.contains('closed')) this.els['panel-tasks'].classList.remove('closed');
      card.scrollIntoView({ block: 'nearest', behavior: this.motionOk() ? 'smooth' : 'auto' });
      card.classList.remove('just-open');
      void card.offsetWidth;
      card.classList.add('just-open');
    },

    addLog(entry) {
      const li = document.createElement('li');
      li.className = 'lg-' + entry.cls;
      const msg = String(entry.msg);
      /* 色だけで見分けないよう、記号のない文には先頭に記号を足す */
      const mark = /^\p{Extended_Pictographic}/u.test(msg) ? null : ({ warn: 'alert', bad: 'alert', ok: 'check' })[entry.cls];
      li.innerHTML = `<span class="lg-t">${window.fmtClock(entry.t)}</span>${mark ? this.ico(mark) + ' ' : ''}${this.gx(msg)}`;
      const ul = this.els['game-log'];
      const empty = ul.querySelector('.lg-empty');
      if (empty) empty.remove();
      ul.prepend(li);
      while (ul.children.length > 40) ul.removeChild(ul.lastChild);
    },

    /* トースト: 情報（紺）・注意（こはく）・トラブル（赤）。コーチの文はふきだしに出す。
     * logged: 同じ文が きろくにも のる知らせ（ゲームが出す知らせ）。作業カードを押した こたえ などは のらない */
    toast(msg, type, logged) {
      type = type || 'info';
      if (type === 'coach') { this.showCoach(msg); return; }
      this.pushToast(this.gx(msg), type, null, logged);
    },
    /* トーストを ためておく間: モーダルを開いている間・スマホで持ち場のシートを開いている間
     * （シートの うしろに かくれて 見えないまま 消えないように）・スマホで「きろく」を開いて、画面の どこに出しても
     * 見えている きろくの行に かかるとき（toastSpot。きろくの箱の中で 見えている行だけを数える。スクロールして 置ける場所が
     * できるか、きろくを とじたら出す）。ためる わけ（'modal' / 'sheet' / 'log'）を返す。ためないときは false */
    holdToasts() {
      if (!this.els['screen-game'].classList.contains('active')) return false;
      if (this.modalKind) return 'modal';
      /* 背の低い横長の画面: 持ち場のポップは 駐機場の ほとんどを おおい、きろくは 画面いっぱいの シート（トーストは その下に かくれる）。
       * どちらも 開いている間は ためて、とじたら出す（スマホと同じ） */
      if (!this.isNarrow()) {
        if (!this.shortWide()) return false;
        if (this.spotPopTask) return 'sheet';
        return this.els['panel-status'].classList.contains('log-open') ? 'log' : false;
      }
      if (this.spotPopTask) return 'sheet';
      if (this.els['panel-status'].classList.contains('log-open')) {
        const c = this.els['apron'].getBoundingClientRect();
        const p = this.toastSpot(44, c.width - 16);
        if (p && p.hits.log) return 'log';
      }
      return false;
    },
    /* 「はじめられるよ！」だけを ためておく間: スマホ・背の低い横長の画面で 駐機場が低い（320px 未満）画面に コーチを出している間
     * （コーチが 同じことを言っている。コーチとトーストで 駐機場の上下を かくして、機体と持ち場の輪が見えなくならないように）。
     * コーチが消えたら、まだ はじめられる作業だけで 1枚 出す。注意・トラブルは ためない */
    holdOpenToasts() {
      if (!this.isNarrow() && !this.shortWide()) return false;
      const cb = this.els['coach-bubble'];
      if (!cb || cb.classList.contains('hidden')) return false;
      if (this.els['apron'].getBoundingClientRect().height >= 320) return false;
      /* コーチが 追従する HUD の下に かくれている・画面の外にある・ドロワーを開いて ひかえているときは ためない
       * （コーチも トーストも 見えなくなるので） */
      const r = cb.getBoundingClientRect();
      if (r.height < 1 || r.bottom <= this.hudBottom() + 20 || r.top >= window.innerHeight) return false;
      return 'coach';
    },
    /* 追従する HUD の下はし（画面の座標。HUD が 画面の上に出ていないときは 0） */
    hudBottom() {
      const hud = this.els['hud'] || (this.els['hud'] = document.getElementById('hud'));
      return Math.max(0, hud ? hud.getBoundingClientRect().bottom : 0);
    },
    /* ids: 「はじめられるよ！」('open') の作業の id。ためたあと出すときに、まだ はじめられるかを 確かめなおす。
     * logged: 同じ文が きろくにも のる知らせ（toast） */
    pushToast(html, type, ids, logged) {
      const gameOn = this.els['screen-game'].classList.contains('active');
      /* ためておく間は、閉じたあとで1枚だけ出す */
      const hold = gameOn && (this.holdToasts() || (type === 'open' && this.holdOpenToasts()));
      if (hold) {
        this._toastQ = this._toastQ || [];
        this._toastQ.push({ html, type, ids: ids ? ids.slice() : null, why: hold, logged: !!logged });
        if (this._toastQ.length > 8) this._toastQ.shift();
        return null;
      }
      const area = gameOn ? this.els['toast-area'] : this.els['toast-global'];
      if (!area) return null;
      [...area.children].forEach((n) => { if (n.classList.contains('out')) n.remove(); });
      const life = 3400;
      const arm = (el) => {
        clearTimeout(el._tOut); clearTimeout(el._tRm);
        el._tOut = setTimeout(() => { el.classList.add('out'); }, life);
        el._tRm = setTimeout(() => { el.remove(); }, life + 500);
      };
      /* いま出ている いちばん新しい1枚と同じ文なら、ふやさずに 出している時間だけ のばす（同じ文が2枚 かさならない） */
      const lastEl = area.lastElementChild;
      if (lastEl && lastEl._html === html && lastEl.classList.contains('toast-' + type)) { arm(lastEl); return lastEl; }
      /* 同時に出すのは 広い画面で2枚・スマホと 背の低い横長の画面で1枚まで（古いものから消す） */
      const max = this.isNarrow() || this.shortWide() ? 1 : 2;
      while (area.children.length >= max) area.firstElementChild.remove();
      const div = document.createElement('div');
      div.className = 'toast toast-' + type;
      div.innerHTML = html;
      div._html = html;
      area.appendChild(div);
      if (gameOn) this.placeToast();
      /* スコア板の下に出すときは、入る高さまで（入らないときは 新しい1枚だけ） */
      while (area.children.length > 1 && area.scrollHeight > area.clientHeight + 1) area.firstElementChild.remove();
      arm(div);
      return div;
    },
    /* 「〜が はじめられるよ！」: 1.5秒以内に続いたら、前の1枚に足す */
    toastOpen(ids) {
      const now = performance.now();
      const o = this._openToast;
      /* もう はじめた・おわった作業は 名前に入れない（まだ「はじめられる」ものだけ） */
      const stillReady = (id) => { const t = this.state && this.state.tasks[id]; return !t || t.status === 'ready'; };
      if (o && now - o.t < 1500 && o.el && o.el.isConnected && !o.el.classList.contains('out')) {
        o.ids = o.ids.filter(stillReady);
        ids.forEach((id) => { if (!o.ids.includes(id)) o.ids.push(id); });
        o.el.innerHTML = this.openToastHtml(o.ids);
        o.t = now;
        this.placeToast();
        return;
      }
      const el = this.pushToast(this.openToastHtml(ids), 'open', ids);
      this._openToast = el ? { el, ids: ids.slice(), t: now } : null;
    },
    /* 「はじめられるよ！」を先に言い、名前は アイコン+名前 を「・」でつなぐ。スマホは2つ・広い画面は3つまで（のこりは「ほか Nこ」） */
    openToastHtml(ids) {
      /* スマホは1行（44px）にするので 名前は1つだけ、短い名前で（「機内食・飲料の積み込み」→「機内食」。作業の名前はリボンでも見える） */
      const narrow = this.isNarrow();
      const max = narrow ? 1 : 3;
      const nameOf = (id) => (narrow && this.SHORT_NAMES[id]) || window.TASK_MAP[id].name;
      /* アイコンと名前は1つのかたまりにして、アイコンだけが 行末に のこらないようにする（コーチの .cb-term と同じ） */
      /* 区切りの「・」は前のかたまりの中に入れ、かたまりのあいだは <wbr> で折り返す（「・」だけが1行にならない） */
      const shown = ids.slice(0, max);
      const names = shown.map((id, i) => `<span class="to-item">${this.taskIco(id)}${window.rubi(nameOf(id))}${i < shown.length - 1 ? '・' : ''}</span>`).join('<wbr>');
      /* スマホは1行なので、入らないときは 名前のほうを「…」で切り、「ほか Nこ」は いつも出す（styles.css の .to-*） */
      const more = ids.length > max ? ` <span class="to-more">ほか ${ids.length - max}こ</span>` : '';
      return `<span class="to-lead">${this.ico('unlock')} はじめられるよ！</span> <span class="to-names">${names}</span>${more}`;
    },
    /* ためていたトーストを1枚だけ出す（まだ ためておく間なら 何もしない）。
     * 「はじめられるよ！」は、ためた間に はじめた・おわった作業を のぞいて1枚にまとめなおす（のこりが なければ 出さない）。
     * コーチを出している間は「はじめられるよ！」を ためたままにする（holdOpenToasts）。
     * 「きろく」を読んでいたせいで ためた ゲームの知らせ（注意・トラブルなど。logged）は 出さない（同じ文が きろくの
     * いちばん上の行に のっていて、あとで出すと「のこりの作業 8件」のような数が 古いまま 出る）。
     * 作業カードを押した こたえ（きろくに のらない）は すてずに、置ける場所が できたら出す */
    flushToastQ() {
      if (this.holdToasts()) return;
      let q0 = this._toastQ || [];
      const keepOpen = !!this.holdOpenToasts();
      this._toastQ = keepOpen ? q0.filter((x) => x.type === 'open') : [];
      q0 = q0.filter((x) => (x.type === 'open' ? !keepOpen : !(x.why === 'log' && x.logged)));
      if (!q0.length) return;
      const ready = (id) => { const t = this.state && this.state.tasks[id]; return !!t && t.status === 'ready'; };
      const openIds = [];
      q0.forEach((x) => { if (x.type === 'open') (x.ids || []).forEach((id) => { if (ready(id) && !openIds.includes(id)) openIds.push(id); }); });
      let lastOpen = -1;
      q0.forEach((x, i) => { if (x.type === 'open') lastOpen = i; });
      const q = q0.filter((x, i) => x.type !== 'open' || (i === lastOpen && openIds.length));
      if (!q.length) return;
      const pick = [...q].reverse().find((x) => x.type === 'bad') || [...q].reverse().find((x) => x.type === 'warn') || q[q.length - 1];
      if (pick.type === 'open') {
        const el = this.pushToast(this.openToastHtml(openIds), 'open', openIds);
        this._openToast = el ? { el, ids: openIds.slice(), t: performance.now() } : null;
        return;
      }
      this.pushToast(pick.html, pick.type, null, pick.logged);
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
      let raw, html, late = false;
      const split = (str) => {
        /* 数字は大きく、単位（分・分遅れ）はルビつきで小さく */
        const r = window.rubi(str);
        const mm = r.match(/^(\+?\d+)([\s\S]*)$/);
        return mm ? `<span class="rem-v">${mm[1]}</span><span class="rem-u">${mm[2]}</span>` : `<span class="rem-v">${r}</span>`;
      };
      const rem = s.stage.std - s.clock;
      if (s.stats.blockOff != null) {
        raw = 'go';
        html = '<span class="rem-done">しゅっぱつ！</span>';
      } else if (rem >= 0) {
        raw = 'r' + Math.ceil(rem);
        html = split(`${Math.ceil(rem)}分`);
      } else {
        late = true;
        raw = 'l' + Math.ceil(-rem);
        html = split(`+${Math.ceil(-rem)}分遅れ`);
      }
      if (force || raw !== this.lastRemainText) {
        this.lastRemainText = raw;
        const el = this.els['hud-remain'];
        el.innerHTML = html;
        el.classList.toggle('late', late);
        const soon = !late && s.stats.blockOff == null && rem <= 10;
        el.classList.toggle('soon', soon);
        this.els['hud-remain-box'].classList.toggle('soon', soon);
        this.els['hud-remain-label'].textContent = soon ? 'のこり わずか' : 'のこり';
      }
    },

    setSpeedUI(n) {
      this.speedNow = n;
      document.querySelectorAll('.speed-btn').forEach((b) => {
        const on = Number(b.dataset.speed) === n;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    },

    /* ---- ゲーム画面の小さな道具 ---- */
    /* 表示する日本語: ルビ → 絵文字をアイコンに。▶ もアイコンにそろえる */
    gx(text) {
      if (text == null || text === '') return '';
      const fixed = String(text)
        .replace(/([ぁ-ゖ])車(?!両)/g, '$1<ruby>車<rt>くるま</rt></ruby>')
        .replace(/([ァ-ヺー])車(?!両)/g, '$1<ruby>車<rt>しゃ</rt></ruby>');   // 中黒「・」（U+30FB）は ふくめない（rubi と同じ）
      return window.Icons.iconize(window.rubi(fixed))
        .replace(/\u25B6\uFE0F?/g, this.ico('play'))
        /* 「▶ はじめる」「▶ のこりを よぶ」は とちゅうで改行しない（「は／じめる」にしない） */
        .replace(/([「『（]?)(<svg class="ico ico-play"[^>]*>[\s\S]*?<\/svg>)\s*(はじめる|のこりを よぶ)([」』）]?)/g, '<span class="nw">$1$2 $3$4</span>')
        .replace(/\u23F0\uFE0F?/g, this.ico('hourglass'))
        .replace(/\u{1F325}\uFE0F?/gu, this.ico('cloud'))
        /* ルビの語と、すぐあとの ひらがな（送りがな・助詞）・すぐ前の数字は1つのかたまりにして、そのあいだで改行しない
         * （「時間ど／おり」「作業／が」「12／分」にしない）。すぐあとの 句読点・とじかっこ（。、！？」』））も 同じかたまりに入れる
         * （nowrap の かたまりの きわでは ブラウザが改行してしまい、行のはじめに「、」「。」が来るため）。となりに何もないルビは そのまま */
        .replace(/([0-9０-９]+)?(<ruby>(?:(?!<\/ruby>)[\s\S])*<\/ruby>)([\u3041-\u3096\u30FC]{1,8})?([。、！？」』）]{1,3})?/g,
          (m, d, r, h, p) => ((d || h || p) ? `<span class="nb">${d || ''}${r}${h || ''}${p || ''}</span>` : m));
    },
    ico(name) { return window.Icons.svg(name); },
    taskIco(id) { return window.Icons.svg(window.Icons.task(id)); },
    resIco(type) { return window.Icons.svg(window.Icons.res(type)); },
    /* 職種・車の名前（「押す車」の車は くるま、「ケータリング車」の車は しゃ） */
    resName(label) { return this.gx(label); },
    /* title 属性（ルビが振れない）用の かな書き: rubi の読みを、語ごとに 半角スペースで区切って つなぐ */
    kana(text) {
      return String(window.rubi(String(text || '')))
        .replace(/<ruby>[\s\S]*?<rt[^>]*>([\s\S]*?)<\/rt><\/ruby>/g, ' $1 ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([・、。（）「」『』！？])\s*/g, '$1')
        .trim()
        .replace(/"/g, '&quot;');
    },
    /* 中身が変わったときだけ書きかえる（250ms ごとの更新でルビが ちらつかないように） */
    setHtml(el, html) {
      if (el && el._raw !== html) { el._raw = html; el.innerHTML = html; }
    },
    isNarrow() { return window.matchMedia('(max-width: 700px)').matches; },
    /* 背の低い横長の画面（スマホの横向き 701px 以上・高さ 500px 以下）。駐機場は 200px ほどしかない */
    shortWide() { return window.matchMedia('(min-width: 701px) and (max-height: 500px)').matches; },
    motionOk() { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; },
    setLogToggle(open) {
      const b = this.els['btn-log-toggle'];
      b.innerHTML = `${this.ico('log')}<span class="lt-txt">${open ? 'きろくを とじる' : 'きろく'}</span><span class="lt-caret" aria-hidden="true">${open ? '▴' : '▾'}</span>`;
      b.setAttribute('aria-expanded', String(open));
      if (this.els['game-main']) this.els['game-main'].classList.toggle('log-open', open);
      this.placeRail();
    },
    /* ドロワーの開閉にあわせて: 知らせの左の空き・とじている間はカードに入れない・駐機場の見える範囲 */
    syncDrawer() {
      const pt = this.els['panel-tasks'];
      if (!pt || !this.els['game-main']) return;
      const open = !pt.classList.contains('closed');
      const wide = !this.isNarrow();
      /* 出発中（もう する おしごとは ない）は、広い画面では ドロワーを開かない（つまみを押しても すぐ とじる）。
       * 開くと、カメラは誘導路の左はしで とまり、出ていく機体が ドロワーの下に入る */
      const dep = wide && this.departing();
      this.lockDrawerTab(dep);
      if (open && dep) { pt.classList.add('closed'); return; }
      this.els['game-main'].classList.toggle('drawer-open', open && wide);
      this.els['task-list'].inert = wide && !open;
      this.placeRail();
      if (open && this.els['drawer-nudge']) this.els['drawer-nudge'].classList.add('hidden');
      this.applyViewInsets();
      if (this.state) this.updateHint(true);
      /* 背の低い横長の画面で ドロワーを開くと、コーチを ひかえる（CSS）。コーチの間 ためていた「はじめられるよ！」を出す */
      if (open && this._toastQ && this._toastQ.length) Promise.resolve().then(() => this.flushToastQ());
    },
    /* 縦長のタブレット（701〜1099px）でドロワーを開いているときは、上の知らせをスコア板の下に出す（ドロワーとスコア板のあいだは せますぎる）。
     * ただし、スコア板の下に出すと 知らせが スタッフ帯まで落ちるとき（背の低い画面）は、上にもどす（スコア板は 情報だけの欄なので、そこに かぶるのはよい）。
     * あわせて、1024px 以上で きろくを とじているときは、トーストをスコア板の下に出す（--status-b） */
    placeRail() {
      const gm = this.els['game-main'], ps = this.els['panel-status'];
      if (!gm || !ps) return;
      const psB = ps.offsetTop + ps.offsetHeight;
      let under = window.matchMedia('(min-width: 701px) and (max-width: 1099px) and (orientation: portrait)').matches &&
        !this.els['panel-tasks'].classList.contains('closed') && !ps.classList.contains('log-open');
      if (under) {
        const rail = this.els['top-rail'], res = this.els['panel-resources'];
        let h = 0, n = 0;
        if (rail) {
          for (const c of rail.children) {
            if (c.classList.contains('hidden') || c.id === 'drawer-nudge') continue;
            const ch = c.offsetHeight;
            if (ch > 0) { h += ch; n++; }
          }
        }
        if (n) h += 6 * (n - 1);
        if (res && psB + 10 + h > res.offsetTop - 8) under = false;
      }
      const t = under ? psB + 'px' : '0px';
      if (gm.style.getPropertyValue('--rail-t') !== t) gm.style.setProperty('--rail-t', t);
      const sb = psB + 'px';
      if (gm.style.getPropertyValue('--status-b') !== sb) gm.style.setProperty('--status-b', sb);
      let toastUnder = window.matchMedia('(min-width: 1024px)').matches && !ps.classList.contains('log-open') && !under && !this.isNarrow();
      if (gm.classList.contains('toast-under') !== toastUnder) gm.classList.toggle('toast-under', toastUnder);
      /* 背の低い画面（1366x657 など）では、スコア板の下の箱が 4行のトーストより低く、下の行が切れる。
       * そのときは スコア板の下をやめて、ふだんの置き場（駐機場の左下・ズームの左）に出す */
      if (toastUnder) {
        /* max-height は calc(100% …) の式のまま返るので、いったん高くして 上限で止まった高さを測る */
        const ta = this.els['toast-area'];
        let mh = NaN;
        if (ta) { const h0 = ta.style.height; ta.style.height = '9999px'; mh = ta.offsetHeight; ta.style.height = h0; }
        if (isFinite(mh) && mh < 170) { toastUnder = false; gm.classList.remove('toast-under'); }
      }
    },
    applyViewInsets() {
      /* 上の知らせの高さが かわると、スコア板の下に出せるかも かわる */
      this.placeRail();
      /* スマホ: トーストの置き場（駐機場の上はし・上の知らせの下。placeToast） */
      this.placeToast();
      if (!Scene.setViewInsets) return;
      const pt = this.els['panel-tasks'], aw = this.els['apron-wrap'];
      const open = !pt.classList.contains('closed');
      /* 左: ひらいたドロワーの右はし（すべっている途中でも、とまったときの位置で測る） */
      const l = (!this.isNarrow() && open) ? Math.max(0, pt.offsetLeft + pt.offsetWidth - aw.offsetLeft + 8) : 0;
      /* 上: 上の知らせ（コーチ・ヒント・一時停止・イベント）の下はし。持ち場や機体が知らせの下にかくれないように。
       * ふえたときは すぐ、へったときは 1.5秒 そのままのときだけ（知らせが入れかわるたびに カメラが動かないように） */
      const want = this.railInset();
      if (want >= (this._railT || 0) - 2) {
        this._railT = want;
        clearTimeout(this._railTimer); this._railTimer = 0;
      } else if (!this._railTimer) {
        this._railTimer = setTimeout(() => { this._railTimer = 0; this._railT = this.railInset(); this.applyViewInsets(); }, 1500);
      }
      /* 右・下（スコア板・スタッフ帯・ズーム）は わたさない。Scene が DOM の欄を測りつづける
       * （Scene の約束: わたした辺だけを その値にし、わたさない辺は 0.4秒ごとに測る。ドロワーは GAME が知らせる）。
       * 上をわたすときは、Scene が測った上の欄（縦長の画面のスコア板など）より小さくしない */
      const ins = { l };
      if (this._railT > 0) {
        const f = Scene.freeRect && Scene.cw ? Scene.freeRect(true) : null;
        let t = Math.max(this._railT, f ? f.t : 0);
        /* Scene は 上下の余白で見える高さが キャンバスの35%より せまくなると、上下とも余白をあきらめる。
         * 低い画面（スマホの横向き）で下のスタッフ帯の余白まで なくならないよう、そこまでの大きさにおさえる */
        if (f && Scene.ch) t = Math.min(t, Math.max(f.t, Math.floor(f.b - Scene.ch * 0.37)));
        if (t > 0) ins.t = t;
      }
      Scene.setViewInsets(ins);
    },
    /* スマホ: ページをスクロールしたら、トーストを ページといっしょに動かす（placeToast の follow。置き場は えらびなおさない）。
     * きろく・コーチを読んでいる間 ためていた トーストは、かからない場所が できたら出す */
    onPageScroll() {
      this.placeToast(true);
      if (this._toastQ && this._toastQ.length && this.isNarrow()) this.flushToastQ();
    },
    /* スマホ: トーストは 画面に固定（styles.css の position:fixed）し、その位置を JS で決める。
     * 置き場を えらぶ（toastSpot）のは、出したとき・中身・上の知らせ・シート・画面の大きさが かわったときだけ。
     * スクロールでは（follow）えらびなおさず、えらんだ場所を ページといっしょに動かして、HUD の下〜画面の下に おさえる
     * （スクロールのたびに 候補を えらびなおすと、トーストが ぴょんと とんで、にげていくように見える）。
     * 動いた先で かくしてはいけない部品（ズームのボタン・コーチ・きろくの行 など）に 新しく かかるときは、とぶかわりに 早めに消す */
    placeToast(follow) {
      const ta = this.els['toast-area'];
      if (!ta) return;
      const st = ta.style;
      if (!this.isNarrow() || !this.els['screen-game'].classList.contains('active')) {
        this._toastAt = null;
        if (ta._fx) { ta._fx = ''; st.top = ''; st.bottom = ''; st.left = ''; st.right = ''; }
        return;
      }
      const c = this.els['apron'].getBoundingClientRect();
      if (c.height < 1) return;
      const tl = ta.lastElementChild;
      const h = ta.offsetHeight || 44, tw = tl ? tl.offsetWidth : c.width - 16;
      const at = this._toastAt;
      let p;
      if (follow && tl && at && at.el === tl) {
        p = this.toastSpot(h, tw, c.top + at.dy);
        if (!p) return;
        if (p.hard > at.hard + 0.5) this.fadeToasts();
      } else {
        p = this.toastSpot(h, tw);
        if (!p) return;
        /* くらべる もとは、えらんだ場所で 本当に かかる量（どこにも入らないときの HUD の下も 数えなおす） */
        this._toastAt = tl ? { el: tl, dy: p.top - c.top, hard: this.toastSpot(h, tw, p.top).hard } : null;
      }
      const vw = document.documentElement.clientWidth;
      const fx = [Math.round(p.top) + 'px', 'auto', Math.round(c.left + 8) + 'px', Math.round(vw - c.right + 8) + 'px'].join(' ');
      if (ta._fx === fx) return;
      ta._fx = fx;
      [st.top, st.bottom, st.left, st.right] = fx.split(' ');
    },
    /* 出ているトーストを いま消しはじめる（0.45秒で うすくなって消える。.toast.out） */
    fadeToasts() {
      [...this.els['toast-area'].children].forEach((el) => {
        if (el.classList.contains('out')) return;
        clearTimeout(el._tOut); clearTimeout(el._tRm);
        el.classList.add('out');
        el._tRm = setTimeout(() => { el.remove(); }, 500);
      });
    },
    /* スマホのトーストの置き場（画面の座標で 上はしの y）。h = トーストの高さ、tw = 幅。
     * 候補のうち、HUD の下はし +8px 〜 画面の下はし（画面の下に イベントの知らせが出ていれば その上）に 全部 入り、
     * かくしてはいけない部品（コーチ・ヒント・ズームのボタン・一時停止の札・持ち場のシート・イベントの知らせ・きろくの行）に
     * かかる高さが いちばん少ない場所にする（押す部品に かかるのは 10倍に数える）。同じなら、4px の すきまが とれる・
     * 持ち場の輪を かくさない（駐機場が低い画面で コーチを出している間だけ 数える）ほう。それも同じなら 先の候補。
     *   1) 駐機場が低い（320px 未満）画面で コーチを出している間: 駐機場の下はし（ズームのボタンの上）
     *      （コーチとトーストで 駐機場の上の6わりを かくして、機体と持ち場の輪が見えなくならないように）
     *   2) ふだん: 駐機場の上はし（上の知らせ＝コーチ・ヒントが出ていれば その下）。ページを下へスクロールしたら HUD の下
     *   3) ズームのボタン・一時停止の札の すぐ上・すぐ下  4) コーチの すぐ上  5) 画面の下はし  6) HUD の すぐ下
     * hits は えらんだ場所で 本当に かかる部品と その高さ（きろくの行に かかるなら holdToasts が ためる）。駐機場が ないときは null。
     * at を わたすと、候補を えらばず、その場所（HUD の下〜画面の下に おさえる）で かかる量だけを返す（スクロールで ついていくとき） */
    toastSpot(h, tw, at) {
      const c = this.els['apron'].getBoundingClientRect();
      if (c.height < 1) return null;
      const rectOf = (el) => {
        if (!el || el.classList.contains('hidden')) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? r : null;
      };
      const minTop = this.hudBottom() + 8;
      const vh = window.innerHeight;
      const coach = rectOf(this.els['coach-bubble']), zc = rectOf(this.els['zoom-ctrl']), pc = rectOf(this.els['pause-chip']);
      const ev = rectOf(this.els['event-banner']);
      const vb = (ev && ev.top > vh / 2 ? ev.top : vh) - 8;
      const keep = [['coach', coach], ['hint', rectOf(this.els['hint-banner'])], ['zoom', zc], ['pause', pc],
        ['sheet', this.spotPopTask ? rectOf(this.els['spot-pop']) : null], ['event', ev]].filter((o) => o[1]);
      /* きろくの行は、きろくの箱（高さに かぎりがあり、中で スクロールする）の中で 見えている部分だけ */
      if (this.els['panel-status'].classList.contains('log-open')) {
        const box = this.els['game-log'].getBoundingClientRect();
        const bt = Math.max(box.top, 0), bb = Math.min(box.bottom, vh);
        if (bb - bt > 1) {
          for (const li of this.els['game-log'].children) {
            const r = li.getBoundingClientRect();
            const t = Math.max(r.top, bt), b = Math.min(r.bottom, bb);
            if (b - t > 1) keep.push(['log', { top: t, bottom: b, left: r.left, right: r.right }]);
          }
        }
      }
      const PRESS = { zoom: 1, pause: 1, sheet: 1, event: 1 };
      const lowCoach = c.height < 320 && !!coach;
      /* 持ち場の輪（キャンバスに描いた輪の中心。画面の座標） */
      const rings = lowCoach && Scene._spotDiscs && Scene.sceneToScreen
        ? Scene._spotDiscs.map(([x, y]) => { const q = Scene.sceneToScreen(x, y); return [c.left + q.x, c.top + q.y]; }) : [];
      const x0 = (c.left + c.right) / 2 - tw / 2, x1 = x0 + tw;
      const score = (top) => {
        const out = {};
        let hard = 0, soft = 0;
        keep.forEach(([k, r]) => {
          if (x1 <= r.left || x0 >= r.right) return;
          const v = Math.min(top + h, r.bottom) - Math.max(top, r.top);
          if (v > 0) { out[k] = (out[k] || 0) + v; hard += v * (PRESS[k] ? 10 : 1); }
          const m = Math.min(top + h + 4, r.bottom) - Math.max(top - 4, r.top) - Math.max(0, v);
          if (m > 0) soft += m;
        });
        rings.forEach(([rx, ry]) => { if (rx > x0 && rx < x1 && ry > top && ry < top + h) soft += 12; });
        return { out, hard, soft };
      };
      if (at != null) {
        const top = Math.max(minTop, Math.min(at, vb - h));
        const r = score(top);
        return { top, hits: r.out, hard: r.hard, soft: r.soft };
      }
      const cands = [];
      if (lowCoach) cands.push(Math.min((zc ? zc.top : c.bottom - 52) - 8, vb) - h);
      cands.push(Math.max(c.top + (this.railInset() || 8), minTop));
      [zc, pc].forEach((o) => { if (o) cands.push(o.top - 8 - h, o.bottom + 8, o.top - 4 - h); });
      if (coach) cands.push(coach.top - 8 - h);
      cands.push(vb - h, minTop);
      let best = null;
      for (const top of cands) {
        if (top < minTop - 0.5 || top + h > vb + 0.5) continue;
        const r = score(top);
        if (!best || r.hard < best.hard - 0.5 || (r.hard < best.hard + 0.5 && r.soft < best.soft - 0.5)) best = { top, hits: r.out, hard: r.hard, soft: r.soft };
      }
      /* 画面に入らないほど 高いときは HUD の下（上から読める） */
      return best || { top: minTop, hits: {}, hard: 0, soft: 0 };
    },
    /* 出発中の広い画面: ドロワーの つまみを うすくする（押すと「しゅっぱつ ちゅうは とじているよ」） */
    lockDrawerTab(on) {
      const b = this.els['btn-drawer-tasks'];
      if (!b || b.classList.contains('dt-off') === !!on) return;
      b.classList.toggle('dt-off', !!on);
      if (on) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    },
    departing() {
      const s = this.state;
      return !!(s && !s.ended && s.tasks.depart && s.tasks.depart.status === 'active');
    },
    /* 上の知らせのうち、駐機場の上半分に出ているものの下はし（キャンバスの上からの px。ないときは 0）。
     * スマホのイベント帯（画面の下に固定）・一時停止（左下）は数えない */
    railInset() {
      const rail = this.els['top-rail'], cv = this.els['apron'];
      if (!rail || !cv) return 0;
      const c = cv.getBoundingClientRect();
      if (c.height < 1) return 0;
      let b = 0;
      for (const el of rail.children) {
        /* 「はじめられる おしごとが Nこ」は 4秒で消える押せない札なので、カメラを動かさない */
        if (el.classList.contains('hidden') || el.id === 'drawer-nudge') continue;
        /* 画面に固定した札（スマホのイベント帯）は 駐機場の上の知らせではない。駐機場が 画面の下へ はみ出す横向きでも 数えない */
        if (getComputedStyle(el).position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.height < 1 || r.top - c.top > c.height / 2 || r.bottom < c.top) continue;
        b = Math.max(b, r.bottom - c.top);
      }
      return b > 0 ? Math.ceil(b + 6) : 0;
    },
    /* 上の知らせを出した・消した・書きかえた: 同じ処理の中の変化をまとめて、1回だけ見える範囲を知らせなおす
     * （ResizeObserver は画面の更新を待つので、時間を止めている間でも すぐ届くように こちらからも呼ぶ） */
    queueInsets() {
      if (this._insetsQ) return;
      this._insetsQ = true;
      Promise.resolve().then(() => { this._insetsQ = false; this.applyViewInsets(); });
    },
    /* 701〜1099px: 駐機場をさわったとき・持ち場ポップを開いたときは、ドロワーをとじる */
    autoCloseDrawer() {
      if (window.matchMedia('(min-width: 701px) and (max-width: 1099px)').matches) {
        const pt = this.els['panel-tasks'];
        if (!pt.classList.contains('closed')) pt.classList.add('closed');
      }
    },
    /* スマホ: パンできないとき（ぜんたいが見えている）は、駐機場の上の縦スワイプでページを動かす */
    updateTouchAction() {
      const cv = this.els['apron'];
      if (!cv) return;
      if (!this.isNarrow()) { cv.style.touchAction = ''; return; }
      const canPan = Scene.canPan ? Scene.canPan() : true;
      cv.style.touchAction = canPan ? 'none' : 'pan-y';
    },

    /* ---------------- イベントUI ---------------- */
    showEventBanner(def) {
      const b = this.els['event-banner'];
      b._raw = null;
      this._evTs = 0;
      this.renderEventBanner(def);
      b.classList.remove('hidden');
      this.els['screen-game'].classList.add('has-event');
      this.updateHint(true);
      this.queueInsets();
    },
    /* 題名 + 「えらぶ」。期限が「N分後」のものは細いバー、作業の終わりが期限のものは「（あと約N分）」 */
    renderEventBanner(def) {
      const s = this.state;
      const ev = s && s.activeEvent;
      const d = (ev && ev.def) || def;
      if (!d) return;
      const G = window.Game;
      let extra = '';
      const dt = d.deadlineTask && s && s.tasks[d.deadlineTask];
      if (dt && dt.status === 'active') extra = `（あと約${Math.max(1, Math.ceil(G.effDur(dt) - dt.progress))}分）`;
      const timer = d.deadlineAfter != null;
      const b = this.els['event-banner'];
      this.setHtml(b, this.ico('alert') + `<span class="ev-title">${this.gx(d.title + extra)}</span><span class="ev-cta">えらぶ</span>` +
        (timer ? '<span class="ev-timer" aria-hidden="true"><i></i></span>' : ''));
      if (timer && ev) {
        const p = clamp(1 - (s.clock - ev.firedAt) / d.deadlineAfter, 0, 1);
        const bar = b.querySelector('.ev-timer i');
        if (bar) bar.style.width = (p * 100).toFixed(1) + '%';
      }
    },
    hideEventBanner() {
      this.els['event-banner'].classList.add('hidden');
      this.els['screen-game'].classList.remove('has-event');
      this.queueInsets();
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
          <span class="ec-top"><span class="ec-label">${this.phraseBreaks(rubi(ch.label))}</span>${i === def.defaultChoice ? `<span class="ec-default">${I.svg('hourglass')} えらばないと これ</span>` : ''}</span>
          <span class="ec-hint">${rubi(ch.hint)}</span>
          ${ch.critical ? `<span class="ec-crit">${I.svg('alert')}<span>${rubi('大きなペナルティ')}</span></span>` : ''}
          ${this.eventChoiceGrid(ch)}
        </button>`).join('');
      /* 期限: 時間で決まるイベントは「あと約N分」、作業で決まるイベントは「〇〇が おわるまで」（その作業がおしごと中なら のこりの分も）。
       * 開いている間も ゲームの時間は進むので、下の setInterval で 書きなおす */
      const deadlineOf = () => {
        const st = this.state;
        if (!st || !st.activeEvent || st.activeEvent.def !== def) return '';
        if (def.deadlineAfter != null) {
          const left = Math.max(1, Math.ceil(def.deadlineAfter - (st.clock - st.activeEvent.firedAt)));
          return `えらべるのは あと約${left}分`;
        }
        if (def.deadlineTask && st.tasks[def.deadlineTask]) {
          const dt = st.tasks[def.deadlineTask];
          let d = `「${dt.def.name}」が おわるまでに えらんでね`;
          if (dt.status === 'active') d += `（あと約${Math.max(1, Math.ceil(window.Game.effDur(dt) - dt.progress))}分）`;
          return d;
        }
        return '';
      };
      const deadline = deadlineOf();
      /* 見出しの印: かみなり（天気のイベント）は storm。データの絵文字（🌧）は雨なので、id で決める */
      const nm = def.id === 'weather' ? 'storm' : I.emojiName(def.icon);
      const titleIcon = nm && !/^(task|staff|veh)-/.test(nm) ? nm : 'alert';
      this.openModal({
        kind: 'event',
        title: `${I.svg(titleIcon)} ${rubi(def.title)}`,
        body: `<p>${rubi(def.desc)}</p>
               <p class="ev-legend" aria-hidden="true"><span><b class="up">▲</b> よくなる</span><span><b class="down">▼</b> わるくなる</span><span>— かわらない</span></p>
               <div class="event-choices">${choicesHtml}</div>
               <p class="modal-info" style="margin-top:8px;">${I.svg('info')} よんでいる あいだも じかんは すすむよ。とめたいときは『あとで きめる』で とじて ${I.svg('pause')} を おしてね</p>`,
        /* 期限の文は 本文の外（「あとで きめる」の よこ）に置き、本文をスクロールしても いつも見えるようにする */
        lead: deadline ? `<p class="modal-note modal-lead ev-deadline">${I.svg('hourglass')} <span class="ev-dl">${rubi(deadline)}</span></p>` : '',
        buttons: [{ label: 'あとで きめる', cls: 'btn-ghost' }],
        dismissible: true,
      });
      this.els['modal'].querySelectorAll('.event-choice').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.closeModal();
          this.cb.onEventChoice(Number(btn.dataset.i));
        });
      });
      /* 期限の文を、開いている間も 0.5秒ごとに書きなおす（変わったときだけ）。closeModal で止める */
      let last = deadline;
      if (this._evTimer) clearInterval(this._evTimer);
      this._evTimer = setInterval(() => {
        const el = this.els['modal'].querySelector('.ev-dl');
        const now = this.modalKind === 'event' && el ? deadlineOf() : '';
        if (!now) { clearInterval(this._evTimer); this._evTimer = null; return; }
        if (now !== last) { last = now; el.innerHTML = I.iconize(rubi(now)); }
      }, 500);
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
      let better = false, worse = false;
      Object.entries(ch.taskDelta || {}).forEach(([id, d]) => {
        if (!d) return;
        const nm = SHORT[id] || (window.TASK_MAP[id] ? window.TASK_MAP[id].name : id);
        tparts.push(`${rubi(nm)} ${d > 0 ? '+' : '-'}${rubi(Math.abs(d) + '分')}`);
        if (d > 0) worse = true; else better = true;
      });
      if (ch.pauseOutdoor) { tparts.push(`そとの おしごと ${rubi(ch.pauseOutdoor + '分')} おやすみ`); worse = true; }
      /* よくなる所と わるくなる所が まざるときは、両方の記号を出す（どちらか1つに まとめない） */
      const tdir = better && worse ? ['mix', '<b class="up">▲</b><b class="down">▼</b>', 'よくなる ところと わるくなる ところが ある']
        : better ? ['up', '▲', 'よくなる'] : ['down', '▼', 'わるくなる'];
      const timeCell = tparts.length
        ? cell('clock', 'じかん', tdir[0], `<span class="sym" aria-label="${tdir[2]}">${tdir[1]}</span> ${tparts.join('・')}`)
        : cell('clock', 'じかん', 'none', '—');
      return `<span class="ec-grid">${metric('shield', 'あんぜん', 'safety')}${timeCell}${metric('smile', 'まんぞく', 'sat')}${metric('coin', 'おかね', 'cost')}</span>`;
    },

    /* ---------------- モーダル共通 ---------------- */
    /* openModal({kind, title, body, buttons, dismissible, cls, foot})
     *   ・見出し・本文・ボタンの3段（本文だけスクロール）。dismissible なら見出しの右に「とじる」(44x44)
     *   ・cls と data-kind は毎回付け直す（前のモーダルのクラスを残さない）
     *   ・buttons[].silent=true のボタンは、閉じても onModalClosed を呼ばない（チュートリアルのページ送りなど）
     *   ・開いている間は、うしろの画面を inert にして、閉じたら元のボタンへフォーカスを戻す */
    openModal({ kind, title, body, buttons, dismissible, cls, foot, lead }) {
      /* ルビをふってから、親文字より広いルビのすきまを つめる（tightRuby） */
      const rubi = (h) => this.tightRuby(window.rubi(h));
      const ize = (h) => (window.Icons ? window.Icons.iconize(h) : h);
      const m = this.els['modal'];
      const wasOpen = !!this.modalKind;
      if (!wasOpen && !this._modalReturn) this._modalReturn = document.activeElement;
      if (this._evTimer) { clearInterval(this._evTimer); this._evTimer = null; }
      /* Tab でモーダルの外へ出ない（最後の部品の次は最初へ、最初の前は最後へ）。登録は1回だけ */
      if (!this._trapBound) {
        this._trapBound = true;
        m.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Tab' || !this.modalKind) return;
          const f = [...m.querySelectorAll('button:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])')]
            .filter((el) => el.getClientRects().length > 0);
          if (!f.length) return;
          const first = f[0], last = f[f.length - 1];
          if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
          else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
        });
      }
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
        <div class="more-hint hidden" aria-hidden="true"><span>▼ したに つづくよ</span></div>
        ${foot ? `<div class="modal-foot">${ize(rubi(foot))}</div>` : ''}
        <div class="modal-btns">${lead ? ize(rubi(lead)) : ''}${btns}</div>`;
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
      if (bodyEl) {
        bodyEl.scrollTop = 0;
        /* 本文が下へ続くときは、下はしを うすくして「▼ したに つづくよ」（いちばん下まで来たら消す） */
        bodyEl.addEventListener('scroll', () => this.updateScrollMore(bodyEl), { passive: true });
        this.updateScrollMore(bodyEl);
        requestAnimationFrame(() => { if (bodyEl.isConnected) this.updateScrollMore(bodyEl); });
      }
      /* うしろの画面は操作できないようにする（Tab でモーダルの外へ出ない） */
      const scr = document.querySelector('.screen.active');
      if (scr) { scr.inert = true; this._inertEl = scr; }
      /* 最初の選択肢か主ボタンへフォーカス（ずかんのタブを切りかえたときは、えらんだタブへ） */
      const first = m.querySelector('.zk-tab.on') || m.querySelector('.event-choice') ||
        m.querySelector('.modal-btns .btn-primary') || m.querySelector('.modal-btns .btn') || xb;
      if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
    },
    /* closeModal({silent}): silent のときは onModalClosed を呼ばず、フォーカスの戻り先も覚えたまま（つぎのモーダルへ移るとき）。
     *   silent のときは幕（backdrop）を すぐには消さない。すぐに つぎのモーダルが開くと、板は出てくる動き（modal-rise）を
     *   やりなおさず、その場で中身だけ かわる（チュートリアルのページ送りで ボタンが動かない・板がすけない）。
     *   つぎが開かなかったときだけ、マイクロタスクで幕を消して、戻り先も わすれる */
    closeModal(opts) {
      const silent = !!(opts && opts.silent === true);
      const m = this.els['modal'];
      if (this._evTimer) { clearInterval(this._evTimer); this._evTimer = null; }
      if (!silent) this.els['modal-backdrop'].classList.add('hidden');
      m.innerHTML = '';
      m.className = 'modal';
      delete m.dataset.kind;
      if (this._inertEl) { this._inertEl.inert = false; this._inertEl = null; }
      const k = this.modalKind;
      this.modalKind = null;
      if (silent) {
        queueMicrotask(() => {
          if (this.modalKind) return;
          this.els['modal-backdrop'].classList.add('hidden');
          this._modalReturn = null;
        });
        return;
      }
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
        /* 文字とルビは1つの <span> に（flex の gap が 語のあいだに入らないように） */
        const name = `${I.svg(I.task(id))}<span>${rubi(def.name)}</span>`;
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
          else if (i < front && sts.some((x) => x === 'active')) tags += `<span class="flow-tag ft-working">${I.svg('working')}<span>おしごと<ruby>中<rt>ちゅう</rt></ruby></span></span>`;
        }
        const note = String(r.note || '').replace(/^\u{1F447}\s*/u, '');   // 先頭の「下をさす手」の絵文字は出さない（データは変えない）
        return `<div class="flow-step${cls}"><span class="flow-stepnum" style="--sc:var(--s${r.step})">${r.step}</span><div class="flow-note">${rubi(note)}</div>${tags}</div>`;
      };
      const legend = s ? '<div class="flow-legend">' +
        [ST.done, ST.active, ST.ready, ST.gathering, ST.locked].map((x) => `<span class="${x[0]}">${I.svg(x[1])}<span>${x[2]}</span></span>`).join('') +
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
            /* どの状態でも 持ち場のポップで答える（まだ=理由と前の作業へのボタン / かんりょう=時刻） */
            this.openSpotPop(b.dataset.task);
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
      /* ⏱・🛡 のように「ふだんは白黒の文字の形」の絵文字には U+FE0F（絵文字の形で出す印）を足して、ほかのバッジと同じカラーの形にそろえる */
      const chars = Array.from(String(str || ''));
      const out = [];
      chars.forEach((ch, i) => {
        out.push(ch);
        if (/\p{Extended_Pictographic}/u.test(ch) && !/\p{Emoji_Presentation}/u.test(ch) && chars[i + 1] !== '️') out.push('️');
      });
      return out.map((ch) => `&#x${ch.codePointAt(0).toString(16)};`).join('');
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
          const head = `<h3 class="zk-stephead"><span class="flow-stepnum" style="--sc:var(--s${r.step})">${r.step}</span><span>${rubi(r.title)}</span></h3>`;
          return head + r.tasks.map((id) => {
            const d = window.TASK_MAP[id];
            const desc = String(d.desc || '');
            const cut = desc.indexOf('。');
            const lead = cut >= 0 && cut < desc.length - 1 ? desc.slice(0, cut + 1) : desc;
            const rest = lead.length < desc.length ? desc.slice(lead.length) : '';
            const open = first ? ' open' : '';
            first = false;
            /* データの文は文節で折り返す（「（ボーディングブリッジ）｜を」のように 助詞から行がはじまらない） */
            const pb = (t) => this.phraseBreaks(rubi(t));
            /* 作業が1つだけのステップは、2列の表で 右を空けないよう 1行ぜんぶを使う */
            return `<div class="zk-item${r.tasks.length === 1 ? ' zk-solo' : ''}">
              <div class="zk-head">${I.svg(I.task(id))}<span>${rubi(d.name)}</span></div>
              <p>${pb(lead)}</p>
              <details class="zk-more"${open}><summary>${I.svg('chevron-right')}くわしく</summary>
                ${rest ? `<p>${pb(rest)}</p>` : ''}
                <p class="zk-why">${I.svg('info')} <strong>なぜ やるの？</strong> ${pb(d.why)}</p>
                ${d.note ? `<p class="zk-note">${I.svg('shield')} <strong>${rubi('安全')}メモ</strong> ${pb(d.note)}</p>` : ''}
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
        /* なかまたち: 駐機場と同じ絵 + 見た目の手がかり（描いた服・車の色と合わせる。「めじるし：」のあとに もう一度「めじるし」と書かない）
         *   人: ランプ=きいろのベスト・手荷物=オレンジのベスト（どちらも白いヘルメット）・清掃=みどりのベストと帽子・
         *       整備=紺のつなぎに 胸の赤い帯・ゲート=あおいベストと紺の帽子（Scene.drawPerson の職種の描き分け） */
        const LOOK = {
          ramp: 'きいろの ベスト', baggage: 'オレンジの ベスト', cleaning: 'みどりの ベストと ぼうし',
          maintenance: 'こんいろの つなぎに あかい せん', gate: 'あおい ベストと こんいろの ぼうし',
          beltloader: 'ながい ベルトが ついている', cart: 'にもつを のせた だいしゃを つなげて ひっぱる',
          fuel: 'しろい タンクに あかい せん', catering: 'しろい はこの 荷台', pushback: 'きいろで ひくく、ひらべったい',
        };
        const item = (kind, type, m) => {
          const url = this.crewArt(kind, type);
          return `<div class="zk-item crew">${url ? `<img class="zk-art" src="${url}" width="72" height="72" alt="">` : '<span class="zk-art"></span>'}
            <div><div class="zk-head">${I.svg(I.res(type))}<span>${rubi(m.label)}${m.short && !String(m.label).includes(m.short) ? `（${this.gx(m.short)}）` : ''}</span></div>
            <p>${this.phraseBreaks(rubi(m.desc))}</p>${LOOK[type] ? `<p class="zk-look">めじるし：${this.phraseBreaks(rubi(LOOK[type]))}</p>` : ''}</div></div>`;
        };
        body = '<div class="zk-list zk-cards"><h3 class="zk-cat">スタッフ</h3>' +
          Object.keys(window.RES_META.staff).map((k) => item('staff', k, window.RES_META.staff[k])).join('') +
          '<h3 class="zk-cat">はたらく <ruby>車<rt>くるま</rt></ruby></h3>' +
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

    coach(msg) { this.showCoach(msg); },
    /* コーチのふきだし: 上の知らせの置き場に出す。新しい文は前の文を置きかえる（積み上げない）。
     * 文の中の {clean} などは、その作業のアイコンにする（リボン・カードの絵とむすびつける） */
    showCoach(msg) {
      const el = this.els['coach-bubble'];
      if (!el) return;
      const text = String(msg).replace(/^\s*\u{1F468}\u200D\u2708\uFE0F?\s*/u, '');
      /* 『アイコン 作業名』は1つのかたまりにして、行のとちゅうで切らない */
      const body = this.gx(text)
        .replace(/『\{([a-z]+)\}([\s\S]*?)』/g, (m, id, name) => `<span class="cb-term">『${this.taskIco(id) || ''}${name}』</span>`)
        .replace(/\{([a-z]+)\}/g, (m, id) => this.taskIco(id) || '');
      el.innerHTML = `<span class="cb-avatar" aria-hidden="true">${this.ico('headset')}</span>` +
        `<span class="cb-text"><span class="cb-who">コーチ</span>${body}</span>` +
        `<button class="cb-close" type="button" aria-label="とじる">${this.ico('close')}</button>`;
      el.querySelector('.cb-close').addEventListener('click', () => { Sfx.play('click'); this.hideCoach(); });
      el.classList.remove('hidden');
      this._coachLeft = 12;   // 秒（時間を止めている間は数えない）
      this.updateHint(true);
      this.queueInsets();
    },
    hideCoach() {
      const el = this.els['coach-bubble'];
      this._coachLeft = 0;
      if (!el || el.classList.contains('hidden')) return;
      el.classList.add('hidden');
      this.updateHint(true);
      this.queueInsets();
      /* コーチを出している間 ためていた「はじめられるよ！」を出す（holdOpenToasts） */
      if (this._toastQ && this._toastQ.length) Promise.resolve().then(() => this.flushToastQ());
    },
    coachBegin() {
      if (this.state && this.state.stage.hints === true) {
        this.coach('リーダー、とうちゃくだ！ まずは『{deboard}降機』と『{unload}取り降ろし』。『{refuel}給油』と『{inspect}点検』も 同時に はじめよう！');
      }
    },
    checkCoach() {
      const s = this.state;
      if (!s || s.ended || s.stage.hints !== true) return;
      for (const r of COACH_RULES) {
        if (!this.coachShown.has(r.id) && r.when(s)) {
          this.coachShown.add(r.id);
          this.coach(r.msg);
          /* 同じ処理の中で来る「はじめられるよ！」のトーストは出さない（コーチが同じことを言うため） */
          this._coachTick = true;
          setTimeout(() => { this._coachTick = false; }, 0);
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
                 <div class="tut-timeline" aria-hidden="true">
                   <span class="tl-ico tl-arr">${I.svg('plane')}</span><span class="tl-bar"></span><span class="tl-ico tl-dep">${I.svg('plane')}</span>
                   <span class="tl-lbl">とうちゃく</span><span class="tl-lbl tl-len">45分</span><span class="tl-lbl">出発</span>
                 </div>
                 <p>きみの しごとは、スタッフと <ruby>車<rt>くるま</rt></ruby>に おしごとを わりあてて、<strong>45分 あとの 出発</strong>に まにあわせること！</p>
                 <div class="tut-crew" aria-hidden="true">
                   <span class="tc-group"><span class="tc-icons">${Object.keys(window.RES_META.staff).map((k) => I.svg(I.res(k))).join('')}</span><span class="tc-cap">スタッフ</span></span>
                   <span class="tc-group"><span class="tc-icons">${Object.keys(window.RES_META.vehicles).map((k) => I.svg(I.res(k))).join('')}</span><span class="tc-cap">はたらく <ruby>車<rt>くるま</rt></ruby></span></span>
                 </div>`,
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
                 <li><span class="tut-where">うえ</span><span>じこくと はやさ<span class="nb">（<span class="nw">${I.svg('flow')}＝ながれ</span></span> <span class="nb"><span class="nw">${I.svg('gear')}＝せってい</span>）</span></span></li>
                 <li><span class="tut-where">まんなか</span><span>駐機場（ゆびで うごかせるよ）</span></li>
                 <li><span class="tut-where">その した</span><span>スコアと スタッフ</span></li>
                 <li><span class="tut-where">さらに した</span><span>作業カード（したに スクロール）</span></li></ul>`
            : `<ul class="tut-list">
                 <li><span class="tut-where">${I.svg('list')} ひだり</span><span>おしごと タブ（作業カード）</span></li>
                 <li><span class="tut-where">みぎうえ</span><span>スコアのもと</span></li>
                 <li><span class="tut-where">した</span><span>スタッフと <ruby>車<rt>くるま</rt></ruby></span></li></ul>`) +
            `<h3 class="tut-sub">ながれバーの しるし</h3>
             <ul class="tut-list tut-marks"><li><span class="tut-mark ready">${I.svg('play')}</span><span>の わく ＝ いま はじめられる</span></li><li><span class="tut-mark done">${I.svg('check')}</span><span>＝ おわった</span></li></ul>
             <h3 class="tut-sub">駐機場の 持ち場の いろ</h3>
             <div class="tut-swatches" aria-hidden="true">
               <span class="tut-sw"><span class="tsw tsw-ready"><span class="tsw-badge">${I.svg('play')}</span></span><span>はじめられる</span></span>
               <span class="tut-sw"><span class="tsw tsw-wait"></span><span>あつまり<ruby>中<rt>ちゅう</rt></ruby></span></span>
               <span class="tut-sw"><span class="tsw tsw-target"></span><span>えらんだ <ruby>人<rt>ひと</rt></ruby>が いける ところ</span></span>
               <span class="tut-sw"><span class="tsw tsw-soon"></span><span>もうすぐ</span></span>
             </div>`,
        },
        {
          title: `${I.svg('list')} おしごとの すすめかた`,
          body: `<p><strong>① おまかせ</strong>：作業カードの<span class="nb">「${I.svg('play')} はじめる」</span>を おすと、ひつような 人と車が じぶんで うごくよ。</p>
                 <p><strong>② 自分で 配置</strong>：駐機場の スタッフや <ruby>車<rt>くるま</rt></ruby>を タップして えらび、<strong>あかむらさきの ふとい わ</strong>の 持ち場を タップ。そろうと はじまるよ。</p>
                 <p>${I.svg('vet')} ベテランは はやい、${I.svg('rookie')} 新人は ゆっくり。だれを おくるかも 作戦だよ。</p>
                 <p>${I.svg('lock')} は まだ はじめられない しるし。${I.svg('unlock')}「はじめられるよ！」の おしらせが 合図だよ。</p>`,
        },
        {
          title: `${I.svg('clock')} 時間と すすめかた`,
          body: `<p>うえの ボタンで 時間の はやさを かえられるよ。まよったら とめて 作戦タイム！</p>
                 <div class="tut-ex" aria-hidden="true"><span class="tut-ex-cap">れい</span>${phone
                   ? `<div class="tut-hudrow"><span class="thk"><span class="thk-ico">${I.svg('pause')}</span><span class="thk-cap">とめる</span></span><span class="thk on"><span class="thk-ico">${I.svg('play')}</span><span class="thk-cap">ふつう</span></span><span class="thk"><span class="thk-ico">${I.svg('fast')}</span><span class="thk-cap">はやい</span></span></div>`
                   : `<div class="tut-fig hud"><span class="tut-key">${I.svg('pause')} とめる</span><span class="tut-key on">${I.svg('play')} ふつう</span><span class="tut-key">${I.svg('fast')} はやい</span></div>`}</div>
                 <p>おしごとごとに <strong>すすめかた</strong>を えらべるよ。いそぐと はやいけど、まんぞくや 安全が 下がることも。</p>
                 <div class="tut-scale" aria-hidden="true"><span class="ts-pt">${I.svg('gauge-slow')}<span>ていねい</span></span><span class="ts-pt">${I.svg('gauge-mid')}<span>ふつう</span></span><span class="ts-pt">${I.svg('gauge-fast')}<span>いそぐ</span></span></div>
                 <p>ここぞ という ときだけ いそぐのが コツ！</p>`,
        },
        {
          title: `${I.svg('shield')} 安全が いちばん！`,
          body: `<p>とちゅうで <strong>トラブル</strong>が おきたら、${phone ? 'したの' : 'うえの'} きいろい おしらせを タップして、どうするか えらぼう。</p>
                 <div class="tut-ex" aria-hidden="true"><span class="tut-ex-cap">れい</span><span class="tut-evb">${I.svg('alert')}<span class="tut-evb-t">手荷物が 1個 見つからない</span><span class="tut-evb-cta">えらぶ</span></span></div>
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
          body: `<div class="tut-page">${this.rubyWords(rubi(st.body))}</div>`,
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
            /* silent: 閉じたときに速度を元にもどさない（すぐにステージえらびへ移るので） */
            { label: 'やめて ステージえらびへ', cls: 'btn-danger', silent: true, onClick: () => this.cb.onGotoSelect() },
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
          title: 'かくにん', body: '<p>クリアの きろく・ベストスコア・スター・バッジを ぜんぶ けしますか？ もとには もどせないよ。</p>',
          buttons: [
            /* 「やめる」は ゲーム中の「このステージを やめる」と まぎれるので、ここは「けさない」 */
            { label: 'けす', cls: 'btn-danger', onClick: () => this.cb.onResetData() },
            { label: 'けさない', cls: 'btn-primary' },
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
     * 1つずつ <span class="phr"> で包む。「定刻ど｜おり」「急｜いで」のような語の途中の改行をなくす
     * （body の word-break:auto-phrase はルビの入った文では効かず、ルビの前後はいつでも改行できてしまうため）。
     * .phr は inline-block（nowrap にすると、Chrome が「出発まで｜40分しかない！」のように 入るはずの文節まで次の行へ送るため）。
     * 文節が 欄より長いときだけ、その中で折り返す（はみ出さない）。
     * 入力は rubi()・iconize() のあとの HTML。<ruby> と <svg> はまるごと1つの文節の中に入れる。
     *   ・「、。！？・…」のあとで切れる。とじかっこ「」』）」のあとの ひらがな（助詞）は はなさない（「（ランプ）｜で」にしない）
     *   ・ルビの語が 助詞で終わるとき（中での）は、つぎの漢字の前で切れる（少ない・大きな は つぎの語と はなさない）
     *   ・漢字・カタカナのあとの「を・が・は」は、うしろに ひらがなが3字以上つづくとき、そのあとで切れる（作業が｜ゆっくり） */
    phraseBreaks(html) {
      const HIRA = /[ぁ-ゖ]/;
      const PUNCT = /[、。！？・…]/;
      const CLOSE = /[」』）]/;
      const OPEN = /[「『（]/;
      const WORD = /[一-鿿々ァ-ヺ0-9A-Za-z０-９]/;
      const SPACE = /[\s　]/;
      const PARTICLE = /[をがは]/;
      let prev = '';
      let out = '';
      let cur = '';
      const flush = () => { if (cur) out += `<span class="phr">${cur}</span>`; cur = ''; };
      String(html).split(/(<ruby>[\s\S]*?<\/ruby>|<[^>]+>)/g).forEach((seg) => {
        if (!seg) return;
        if (seg.startsWith('<ruby>')) {
          if (prev === 'H' || prev === 'P') flush();
          cur += seg;
          const base = seg.replace(/<rt[\s\S]*?<\/rt>/g, '').replace(/<[^>]+>/g, '');
          prev = /[のでにをがはともて]$/.test(base) ? 'H' : 'W';   // 助詞で終わる語（中での）は つぎの漢字の前で切る。少ない・大きな は つぎの語と はなさない
          return;
        }
        if (seg.startsWith('<')) { cur += seg; return; }   // svg などのタグは、いまの文節に入れる
        const chars = [...seg];
        chars.forEach((c, i) => {
          if (SPACE.test(c)) { flush(); out += c; prev = 'S'; return; }
          let cls = 'X';
          if (HIRA.test(c)) cls = 'H';
          else if (PUNCT.test(c)) cls = 'P';
          else if (CLOSE.test(c)) cls = 'C';
          else if (OPEN.test(c)) cls = 'O';
          else if (WORD.test(c)) cls = 'W';
          else if (c === 'ー') cls = prev;                       // のばす音は前の字と同じあつかい
          if (((prev === 'H' || prev === 'P' || prev === 'C') && (cls === 'W' || cls === 'O')) || (prev === 'P' && cls === 'H')) flush();
          cur += c;
          /* 漢字・カタカナのすぐあとの助詞「を・が・は」: うしろに ひらがなが3字以上あれば、そこで切る（がんばる・がっかり は切らない） */
          if (cls === 'H' && prev === 'W' && PARTICLE.test(c) && !(c === 'が' && /[んっ]/.test(chars[i + 1] || ''))) {
            let n = 0;
            while (HIRA.test(chars[i + 1 + n] || '')) n++;
            if (n >= 3) flush();
          }
          prev = cls;
        });
      });
      flush();
      return out;
    },

    /* わかち書きの文（チュートリアル）で、ルビの語と、空白までの となりの字を 1つの <span class="phr"> にまとめる。
     * keep-all でも Chrome はルビの前後で改行してしまう（「作戦｜タイム！」「時間｜の」）ため。タグはまたがない。
     * 入力は rubi() のあとの HTML */
    rubyWords(html) {
      const RB = '<ruby>[\\s\\S]*?<\\/ruby>';
      const re = new RegExp(`[^\\s<>　]*${RB}(?:[^\\s<>　]*${RB})*[^\\s<>　]*`, 'g');
      return String(html).replace(re, (m) => `<span class="phr">${m}</span>`);
    },

    /* ルビが親文字より広いとき、となりが かな・記号（ルビのない字）なら、ルビを そちらへ少し はみ出させて、
     * 親文字のまわりの すきま（「おしごと 中」「定刻出発 を」）をなくす。はみ出しは 片がわ ルビ1字ぶんまで。
     * となりが ルビの語・アイコン・改行・文のはじめ/おわり なら、そちらへは はみ出さない（ルビどうしが重ならない）。
     * 文節の <span>・<strong> などのタグは とびこえて、となりの字を見る。
     * 入力は rubi() のあとの HTML。<rt> に margin を足すだけなので、rubi()・phraseBreaks() に もう一度とおしても こわれない */
    tightRuby(html) {
      const NB = /[ぁ-ゖァ-ヺー、。！？・…「」『』（）]/;
      const STOP = /^<\/?(ruby|rt|svg|img|br|use|p|div|li|ul|ol|h\d|dt|dd)\b/i;   // ここで止める（となりの字とは みなさない）
      const wid = (s) => [...s].reduce((a, c) => a + (/[\x20-\x7e]/.test(c) ? 0.5 : 1), 0);
      const before = (str, i) => {
        let j = i - 1;
        while (j >= 0 && str[j] === '>') {
          const k = str.lastIndexOf('<', j);
          if (k < 0 || STOP.test(str.slice(k, j + 1))) return '';
          j = k - 1;
        }
        return j >= 0 ? str[j] : '';
      };
      const after = (str, i) => {
        let j = i;
        while (j < str.length && str[j] === '<') {
          const k = str.indexOf('>', j);
          if (k < 0 || STOP.test(str.slice(j, k + 1))) return '';
          j = k + 1;
        }
        return j < str.length ? str[j] : '';
      };
      return String(html).replace(/<ruby>([^<]+)<rt>([^<]+)<\/rt><\/ruby>/g, (m, base, read, off, str) => {
        const ex = wid(read) - 2 * wid(base);          // ルビ1字 = 親文字の半分。はみ出す幅（ルビの字数）
        if (ex <= 0) return m;
        const L = NB.test(before(str, off));
        const R = NB.test(after(str, off + m.length));
        if (!L && !R) return m;
        const l = L ? Math.min(R ? ex / 2 : ex, 1) : 0;
        const r = R ? Math.min(L ? ex / 2 : ex, 1) : 0;
        return `<ruby>${base}<rt style="margin-left:${-l}em;margin-right:${-r}em">${read}</rt></ruby>`;
      });
    },

    /* ---------------- 結果画面 ---------------- */
    renderResult(res, isBest, nextStageId, prevBest, extras) {
      extras = extras || { stars: 0, newBadges: [], nextGoal: '' };
      const rubi = window.rubi;
      const I = window.Icons;
      const ize = (h) => I.iconize(h);
      const pb = (s) => this.tightRuby(this.phraseBreaks(ize(rubi(s))));
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
        /* 見出しの印は SVG のメダル（カラーの絵文字はバッジそのものだけにする） */
        badgeEl.innerHTML = `<span class="rb-title">${fail ? 'バッジを ゲットしたよ' : `${I.svg('medal')} あたらしいバッジ！`}</span>` +
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
          (fix.length ? `<div class="adv-group adv-fix"><h4>${I.svg('alert')}<span>つぎに <ruby>気<rt>き</rt></ruby>を つけること</span></h4>${list(fix)}</div>` : '') +
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
        /* ほんとうの出発（プッシュバックを はじめた時刻）。てんせんで 出す（出発の行の バーは そのあとに つづく） */
        const offPct = res.blockOff != null ? pct(res.blockOff) : null;
        res.timeline.forEach((t) => {
          const row = document.createElement('div');
          row.className = 'gr';
          const stp = (window.TASK_MAP[t.id] && window.TASK_MAP[t.id].step) || 0;
          const short = this.SHORT_NAMES[t.id] || t.name;
          const label = `<span class="gr-label" title="${this.kana(t.name)}">` +
            (stp ? `<span class="gr-step" style="--sc:var(--s${stp})">${stp}</span>` : '') +
            `${I.svg(I.task(t.id))}<span>${rubi(short)}</span></span>`;
          if (t.startedAt == null) {
            row.innerHTML = label + '<span class="gr-none">はじめられなかった</span>';
          } else {
            let bars = `<i class="gr-stdline" style="left:${stdPct}%"></i>` +
              (offPct != null ? `<i class="gr-offline" style="left:${offPct}%"></i>` : '');
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
        lg.innerHTML = this.tightRuby('<span class="lg"><i class="lg-sw lg-steps"></i>いろ＝ステップ1〜7</span>' +
          '<span class="lg"><i class="lg-sw lg-gather"></i><span>しましま＝あつまり<ruby>中<rt>ちゅう</rt></ruby></span></span>' +
          `<span class="lg"><i class="lg-sw lg-std"></i><span>あかい せん＝${rubi('出発予定')}</span></span>` +
          (res.blockOff != null ? `<span class="lg"><i class="lg-sw lg-off"></i><span>てんせん＝ほんとうの ${rubi('出発')}</span></span>` : ''));
        gantt.appendChild(lg);
      }
      document.getElementById('result-trivia').innerHTML = pb('💡 まめちしき: ' + pickTrivia());
    },

    /* ---------------- 毎フレーム ---------------- */
    frame(dtReal) {
      const s = this.state;
      Scene.draw(s, dtReal, this);
      if (!s) return;
      /* カメラが動いたら（補間・ズーム・機体を追う）持ち場のポップを置きなおす */
      if (this.spotPopTask) this.followSpotPop(false);
      this.updateClock();
      /* コーチのふきだしは12秒で消す（時間を止めている間は数えない） */
      if (this._coachLeft > 0 && (this.speedNow || 0) > 0 && this.els['coach-bubble'].getClientRects().length) {
        /* 見えていない間（背の低い画面でドロワーを開いている など）は 数えない */
        this._coachLeft -= dtReal;
        if (this._coachLeft <= 0) this.hideCoach();
      }
      /* モーダルを開いた瞬間にトーストを片づけ、閉じたら ためていた最新の1枚を出す */
      const mk = this.modalKind || null;
      if (mk !== this._prevModal) {
        if (mk && !this._prevModal) this.els['toast-area'].innerHTML = '';
        else if (!mk && this._prevModal) this.flushToastQ();
        this._prevModal = mk;
      }
      const now = performance.now();
      if (now - this.domThrottle > 250) {
        this.domThrottle = now;
        const G = window.Game;
        s.taskList.forEach((t) => {
          const card = this.cardEls[t.id];
          if (!card) return;
          if (t.status === 'active') {
            card.querySelector('.tc-fill').style.width = `${clamp((t.progress / G.effDur(t)) * 100, 0, 100)}%`;
            this.setHtml(card.querySelector('.tc-time'), this.timeHtml(t, this.isPausedTask(t)));
          } else if (t.status === 'locked') {
            /* 「あと約N分でおわったら〜」のカウントダウンを更新 */
            this.setHtml(card.querySelector('.tc-lockmsg'), this.ico('lock') + ' ' + this.gx(G.lockReason(t.id)));
          }
          if (t.status === 'active' || t.status === 'gathering') {
            /* かみなりで おやすみ（あと約N分）の札を更新 */
            const paused = this.isPausedTask(t);
            if (card.classList.contains('st-paused') !== paused) card.classList.toggle('st-paused', paused);
            this.setHtml(card.querySelector('.tc-state'), this.stateHtml(t, paused, this.issueTask === t.id && t.status !== 'done'));
          }
        });
        if (this._wxPaused !== G.outdoorPaused()) {
          /* かみなりで止まった・また動いた: 天気の札・リボン・スタッフ帯をいっしょに かえる */
          this.updateWeatherHud();
          this.updateRibbon();
          this.updateResources();
        }
        if (s.activeEvent && now - (this._evTs || 0) > 500) { this._evTs = now; this.renderEventBanner(); }
        this.updateHint();
      }
    },

    /* ---------------- Game からの通知 ---------------- */
    handleEmit(type, payload) {
      switch (type) {
        case 'task':
          /* 出発がはじまったら（もう する おしごとは ない）、広い画面では作業カードのドロワーを とじる。
           * 機体が 見えている地面の上で ドロワーの下へ すべりこまない（つぎのステージは いつもどおり 開いて はじまる） */
          if (payload.id === 'depart' && !this.isNarrow() && this.state && this.state.tasks.depart.status === 'active') {
            const pt = this.els['panel-tasks'];
            if (pt && !pt.classList.contains('closed')) pt.classList.add('closed');
          }
          if (payload.id === 'depart') this.lockDrawerTab(!this.isNarrow() && this.departing());
          this.updateCard(payload.id);
          this.updateRibbon();
          this.updateUnfinished();
          this.updateHint(true);
          this.checkCoach();
          if (this.spotPopTask === payload.id) {
            const t = this.state.tasks[payload.id];
            if (!t || t.status === 'done' || t.status === 'active') this.closeSpotPop();
            else this.openSpotPop(payload.id, { refresh: true });  // ロック解除などで内容がかわったら開き直す
          }
          break;
        case 'unlocked':
          /* 次に進めるようになった瞬間を、音+トースト+カード/リボン/持ち場の光りで知らせる（光りは1〜2回だけ） */
          Sfx.play('unlock');
          if (!this._coachTick) this.toastOpen(payload.ids);
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
        case 'toast': this.toast(payload.msg, payload.type, true); break;   // ゲームの知らせは きろくにも のる（Game.log）
        case 'sfx': Sfx.play(payload); break;
        case 'weather': this.updateWeatherHud(); this.updateRibbon(); this.updateResources(); break;
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
          /* かみなりで外の作業が止まったかもしれない: 天気の札・リボン・スタッフ帯をいっしょに かえる */
          this.updateWeatherHud();
          this.updateRibbon();
          this.updateResources();
          this.updateHint(true);
          break;
        }
        case 'stage-end':
          this.selected = null;
          this.closeSpotPop();
          this.closeStaffPick();
          this.hideEventBanner();
          this.hideCoach();
          this.hideRibbonTip();
          this._toastQ = [];
          this.setPausedIndicator(false);
          if (this.modalKind && this.modalKind !== 'tutorial') this.closeModal();
          break;
      }
    },
  };

  window.UI = UI;
})();
