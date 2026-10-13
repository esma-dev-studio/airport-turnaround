/* =========================================================
 * icons.js — 共通アイコン（絵文字のかわりに使う単色の SVG / Canvas 用の形）
 *   24 のグリッドで描く。文字・漢字は入れない。色は currentColor（Canvas は引数の色）。
 *   ・塗りのアイコン = fill:currentColor / 線のアイコン = fill:none + stroke:currentColor（太さ 1.75・角は丸く）
 *   ・rookie（若葉マーク）だけは固定の 2 色で描く。
 *
 * 使い方（window.Icons）
 *   Icons.svg(name, {cls, size})          … '<svg class="ico ico-NAME"><use href="#i-NAME"></use></svg>' を返す
 *   Icons.draw(ctx, name, cx, cy, size, color) … Canvas に中心 (cx,cy)・一辺 size で描く（Path2D はキャッシュ）
 *   Icons.task(id) / Icons.res(type)      … 作業・スタッフ/車の名前（'task-clean'・'staff-ramp'・'veh-fuel' など）
 *   Icons.emojiName(str)                  … 知っている絵文字なら名前、知らなければ null
 *   Icons.iconize(html)                   … タグの外の文字だけを見て、知っている絵文字を svg() に置きかえる
 *   Icons.names()                         … 名前の一覧
 *   Icons.sheetHtml()                     … 全アイコンの確認用 HTML（SVG と Canvas の両方）
 *
 * 意味の対応表（1つのアイコンに1つの意味）
 *   check     = かんりょう（ここでしか使わない）
 *   shield    = 安全（指標・安全メモ・安全確認・安全のタグ）
 *   clock     = 時間どおり（指標）・時間がふえる/へるタグ
 *   hourglass = 期限（イベントの「〜までにえらんでね」）
 *   flow      = ながれ（ながれリボン・ながれマップ）
 *   list      = 作業カード（ドロワーのつまみ）
 *   log       = きろく
 *   book      = ずかん
 *   help      = あそびかた
 *   star      = ステージのスター（star-outline = まだ取っていないスター）
 *   vet       = ベテラン（金色の袖章 2 本）／ rookie = ルーキー（若葉マーク）
 *   alert     = 注意・トラブル
 *   lock      = まだ ／ unlock = ひらいた
 *   pin       = いまここ
 *   info      = ヒント
 *   headset   = コーチ
 *   play / pause / fast = ふつう / とめる / はやい（速度）、stop = 作業のストップ
 *   gauge-slow / gauge-mid / gauge-fast = すすめかた（ていねい / ふつう / いそぐ）
 *   dots      = あつまり中、gear = おしごと中・せってい
 *   task-*    = 12 の作業、staff-* = 5 つの職種、veh-* = 5 つの車
 *
 * 絵文字 → 名前: 下の EMOJI（操作・指標・天気）と、TASK_DEFS・RES_META（最初に呼ばれたときに作る）。
 *   同じ絵文字が両方にあるときは EMOJI を優先する（例: ✅ は bagmatch ではなく check）。
 *   作業と資源で同じ絵文字（🧹 🍱 ⛽ 🚜）は作業のアイコンに当てる。▶ と ★ は文字のまま残す。
 * ========================================================= */
(function () {
  'use strict';

  /* ---------- 形を作る小さな道具（すべて SVG のパス文字列。Path2D にもそのまま使える） ---------- */
  const f = (n) => String(Math.round(n * 100) / 100);
  const circle = (cx, cy, r) =>
    `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
  const rrect = (x, y, w, h, r) => {
    r = Math.min(r, w / 2, h / 2);
    return `M${f(x + r)} ${f(y)}H${f(x + w - r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}V${f(y + h - r)}` +
      `a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}H${f(x + r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(-r)}` +
      `V${f(y + r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}Z`;
  };
  const poly = (pts) => 'M' + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L') + 'Z';
  const line = (pts) => 'M' + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L');
  /* 点の列を (cx,cy) 中心に deg 度まわし、s 倍して (dx,dy) ずらす */
  const xf = (pts, deg, s = 1, dx = 0, dy = 0, cx = 12, cy = 12) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    return pts.map(([x, y]) => {
      const X = x - cx, Y = y - cy;
      return [cx + (X * c - Y * sn) * s + dx, cy + (X * sn + Y * c) * s + dy];
    });
  };
  const star = (cx, cy, ro, ri) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = (-90 + i * 36) * Math.PI / 180, r = i % 2 ? ri : ro;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return poly(pts);
  };
  const gear = (cx, cy, ro, ri, teeth) => {
    const pts = [], step = (Math.PI * 2) / teeth;
    for (let i = 0; i < teeth; i++) {
      const a = i * step - Math.PI / 2;
      [[-0.30, ri], [-0.17, ro], [0.17, ro], [0.30, ri]].forEach(([k, r]) =>
        pts.push([cx + r * Math.cos(a + k * step * 1.6), cy + r * Math.sin(a + k * step * 1.6)]));
    }
    return poly(pts);
  };
  /* ゲージ: 中心 (12,17)・半径 8.5 の半円 + 針（deg は右=0・上=90） */
  const gauge = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [
      L('M3.5 17a8.5 8.5 0 0 1 17 0'),
      L(line([[12, 17], [12 + 6.4 * Math.cos(a), 17 - 6.4 * Math.sin(a)]])),
      F(circle(12, 17, 1.7)),
    ];
  };

  /* 部品: L=線(1.75) / W=太い線(幅 w。人の手足など) / F=塗り（evenodd で穴をあける） / C=固定色の塗り */
  const L = (d) => ({ m: 'l', d });
  const W = (d, w) => ({ m: 'w', d, w });
  const F = (d, evenodd) => ({ m: 'f', d, r: evenodd ? 'evenodd' : null });
  const C = (d, c) => ({ m: 'f', d, c });

  /* 人のピクトグラム（空港サインふう）。x,y は頭の中心 */
  const walker = (x, y) => [
    F(circle(x, y, 2.1)),
    W(line([[x - 0.8, y + 4.1], [x - 2, y + 9.6]]), 3.6),                       // 胴
    W(line([[x - 2, y + 9.6], [x - 3.6, y + 13], [x - 5.4, y + 16.4]]), 3.1),   // うしろ足
    W(line([[x - 2, y + 9.6], [x + 0.2, y + 12.8], [x + 0.6, y + 16.6]]), 3.1), // まえ足
    W(line([[x - 1.2, y + 5.2], [x - 3.2, y + 7.4], [x - 4.2, y + 9.4]]), 2.4), // うしろ腕
    W(line([[x - 0.6, y + 5.2], [x + 1.4, y + 7.4], [x + 3.2, y + 8.2]]), 2.4), // まえ腕
  ];
  const stander = (x, y) => [
    F(circle(x, y, 2.1)),
    W(line([[x, y + 4], [x, y + 9.6]]), 3.8),
    W(line([[x - 1, y + 10.2], [x - 1.6, y + 16.6]]), 2.9),
    W(line([[x + 1, y + 10.2], [x + 1.6, y + 16.6]]), 2.9),
  ];
  const suitcase = (x, y) => [   // 左上 (x,y)・12x12 くらいのスーツケース
    F(rrect(x, y + 3, 11, 11.5, 1.8) + rrect(x + 2.6, y + 5.2, 1.3, 7.2, 0.6) + rrect(x + 7.1, y + 5.2, 1.3, 7.2, 0.6), true),
    W(`M${f(x + 3.6)} ${f(y + 3)}V${f(y + 1.2)}h${f(3.8)}V${f(y + 3)}`, 1.7),
    F(circle(x + 2.5, y + 15.3, 0.95) + circle(x + 8.5, y + 15.3, 0.95)),
  ];
  const cloudBig = 'M6.5 18.5H17.5a3.75 3.75 0 0 0 .4-7.48A5.5 5.5 0 0 0 7.3 10.3A4.15 4.15 0 0 0 6.5 18.5Z';
  const cloudHigh = 'M5.5 14.5H17.5a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 7.2 6.5A4.1 4.1 0 0 0 5.5 14.5Z';
  /* 機体（上から見た形・機首が上）。右半分の点を左右対称にする */
  const PLANE_R = [[12, 1.8], [12.9, 2.5], [13.3, 4], [13.3, 9.2], [21.6, 13.6], [21.6, 15.4], [13.3, 13.2],
    [13.3, 18.2], [16.6, 20.4], [16.6, 21.8], [12, 20.8]];
  const PLANE = PLANE_R.concat(PLANE_R.slice(1, -1).reverse().map(([x, y]) => [24 - x, y]));

  /* ---------- アイコンの定義 ---------- */
  const DEF = {
    /* ---- 操作（線） ---- */
    'pause': [L(rrect(6, 4.5, 4, 15, 1) + rrect(14, 4.5, 4, 15, 1))],
    'play': [L('M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z')],
    'fast': [L('M3 6.2v11.6L11.4 12Z M12.4 6.2v11.6L20.8 12Z')],
    'gear': [L(gear(12, 12, 9.6, 7.2, 8)), L(circle(12, 12, 3))],
    'flow': [L('M6.9 8.4 10.1 15.6 M13.9 15.6 17.1 8.4'), F(circle(5.5, 6.5, 2.6) + circle(12, 17.5, 2.6) + circle(18.5, 6.5, 2.6))],
    'zoom-in': [L(circle(10.5, 10.5, 6.5) + 'M15.4 15.4 20.5 20.5 M10.5 7.6v5.8 M7.6 10.5h5.8')],
    'zoom-out': [L(circle(10.5, 10.5, 6.5) + 'M15.4 15.4 20.5 20.5 M7.6 10.5h5.8')],
    'zoom-fit': [L('M4 9V5a1 1 0 0 1 1-1h4 M15 4h4a1 1 0 0 1 1 1v4 M20 15v4a1 1 0 0 1-1 1h-4 M9 20H5a1 1 0 0 1-1-1v-4')],
    'close': [L('M6 6 18 18 M18 6 6 18')],
    'chevron-right': [L('M9 5l7 7-7 7')],
    'chevron-left': [L('M15 5l-7 7 7 7')],
    'list': [L(rrect(5, 4.5, 14, 17, 2) + rrect(8.5, 2.5, 7, 4, 1) + 'M8.5 11h7 M8.5 14.5h7 M8.5 18h4')],
    'log': [F(circle(5, 6, 1.4) + circle(5, 12, 1.4) + circle(5, 18, 1.4)), L('M9 6h11 M9 12h11 M9 18h7')],
    'pin': [L('M12 21.5s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z' + circle(12, 10.3, 2.4))],
    'book': [L('M12 6.5C10 5 7 4.5 3.5 4.8v13.5C7 18 10 18.5 12 20c2-1.5 5-2 8.5-1.7V4.8C17 4.5 14 5 12 6.5Z M12 6.5V20')],
    'help': [L(circle(12, 12, 9.5) + 'M9.3 9.4a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4.1'), F(circle(12, 17.4, 1.15))],
    'sound': [L('M4 9.5h3.5L12 5.5v13l-4.5-4H4Z M15.5 9a4 4 0 0 1 0 6 M18 6.5a7.5 7.5 0 0 1 0 11')],
    'music': [L('M9 18V5.5l11-2V16' + circle(6.5, 18, 2.5) + circle(17.5, 16, 2.5))],
    'info': [L(circle(12, 12, 9.5) + 'M12 11v6'), F(circle(12, 7.6, 1.15))],
    'headset': [L('M4.5 14v-2a7.5 7.5 0 0 1 15 0v2' + rrect(3.5, 13, 4, 6.5, 1.5) + rrect(16.5, 13, 4, 6.5, 1.5) + 'M18.5 19.5c0 1.3-1.4 2-3.5 2h-2')],
    'hourglass': [L('M6.5 3h11 M6.5 21h11 M7.5 3v2.5c0 2.5 4.5 4.5 4.5 6.5s-4.5 4-4.5 6.5V21 M16.5 3v2.5c0 2.5-4.5 4.5-4.5 6.5s4.5 4 4.5 6.5V21'),
      F('M9.3 19.6c0-1.5 2.7-2.9 2.7-2.9s2.7 1.4 2.7 2.9Z')],
    'lock': [L(rrect(5, 10.5, 14, 10.5, 2) + 'M8 10.5V7.5a4 4 0 0 1 8 0v3 M12 14.5v3')],
    'unlock': [L(rrect(5, 10.5, 14, 10.5, 2) + 'M8 10.5V7.5a4 4 0 0 1 7.7-1.5 M12 14.5v3')],
    'check': [L('M4.5 12.5l4.8 4.8L19.5 7')],
    'alert': [L('M10.3 4.2 2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z M12 9.5v4.5'), F(circle(12, 17.1, 1.1))],
    'stop': [L(rrect(5.5, 5.5, 13, 13, 1.5))],
    'gauge-slow': gauge(150),
    'gauge-mid': gauge(90),
    'gauge-fast': gauge(30),
    'star': [F(star(12, 12.6, 9.8, 4.2))],
    'star-outline': [L(star(12, 12.6, 9.3, 4))],
    'medal': [L('M8 2.5 11 9 M16 2.5 13 9' + circle(12, 15, 5.8)), F(star(12, 15.3, 3.1, 1.35))],
    'trophy': [L('M7 3.5h10v5.5a5 5 0 0 1-10 0Z M7 5.5H4.5v1.2a3.3 3.3 0 0 0 3 3.3 M17 5.5h2.5v1.2a3.3 3.3 0 0 1-3 3.3 M12 14v3.5' + rrect(8.5, 17.5, 7, 3.5, 1))],
    'dots': [F(circle(5.5, 12, 1.9) + circle(12, 12, 1.9) + circle(18.5, 12, 1.9))],

    /* ---- 指標（塗り） ---- */
    'shield': [F('M12 2.3 4.3 5.4v6.1c0 4.9 3.3 8.8 7.7 10.2 4.4-1.4 7.7-5.3 7.7-10.2V5.4Z' + 'M12 5.2 6.8 7.3v4.3c0 3.4 2.2 6.2 5.2 7.4Z', true)],
    'clock': [F(circle(12, 12, 9.6) + poly([[11.1, 5.8], [12.9, 5.8], [12.9, 11.5], [16.4, 13.5], [15.5, 15.05], [11.1, 12.5]]), true)],
    'smile': [F(circle(12, 12, 9.6) + circle(8.9, 9.6, 1.4) + circle(15.1, 9.6, 1.4) + 'M7.4 13.4h9.2a4.6 4.6 0 0 1-9.2 0Z', true)],
    'coin': [   // おかねの袋
      F('M9.2 8.6h5.6c3.6 2.4 6.4 6 6.4 9.1a3.8 3.8 0 0 1-3.8 3.8H6.6a3.8 3.8 0 0 1-3.8-3.8c0-3.1 2.8-6.7 6.4-9.1Z' +
        circle(12, 15.6, 3) + circle(12, 15.6, 1.5), true),
      F('M8.9 7.4 7.4 3.6c1.5-.9 3-.6 4.6.2 1.6-.8 3.1-1.1 4.6-.2l-1.5 3.8Z'),
    ],

    /* ---- 天気（線） ---- */
    'sun': [L(circle(12, 12, 4) + [0, 45, 90, 135, 180, 225, 270, 315].map((d) => {
      const a = d * Math.PI / 180;
      return line([[12 + 6.8 * Math.cos(a), 12 + 6.8 * Math.sin(a)], [12 + 9.3 * Math.cos(a), 12 + 9.3 * Math.sin(a)]]);
    }).join(' '))],
    'cloud': [L(cloudBig)],
    'sun-cloud': [L(circle(8, 8, 3.2) + [270, 225, 180, 135, 315].map((d) => {
      const a = d * Math.PI / 180;
      return line([[8 + 4.9 * Math.cos(a), 8 + 4.9 * Math.sin(a)], [8 + 6.6 * Math.cos(a), 8 + 6.6 * Math.sin(a)]]);
    }).join(' ') + 'M9 20H19.3a3.2 3.2 0 0 0 .5-6.37A4.6 4.6 0 0 0 11 12.6A3.9 3.9 0 0 0 9 20Z')],
    'storm': [L(cloudHigh + 'M13.2 16.2 10.4 19.4h3.6L11.4 22.6')],
    'rain': [L(cloudHigh + 'M8.5 17.5l-1.2 3 M12.5 17.5l-1.2 3 M16.5 17.5l-1.2 3')],
    'dusk': [L('M2.5 17h19 M6.5 17a5.5 5.5 0 0 1 11 0 M12 9.5V7.5 M17.3 11.7l1.4-1.4 M6.7 11.7 5.3 10.3 M7.5 20.5h9')],

    /* ---- 作業（塗り。空港の案内サインふう） ---- */
    'task-deboard': [W('M3.5 21.2V3.5h7.5v17.7', 1.9)].concat(walker(17.6, 4.4)),
    'task-unload': suitcase(1.8, 5.2).concat([W('M19 3.2v11.2', 2.3), F('M15 12.4 19 17.6l4-5.2Z')]),
    'task-clean': [
      F(poly([[2.2, 4.4], [4.9, 4.2], [6.6, 12.8], [4.1, 13.5]])),         // 座席の背もたれ
      F(rrect(3.4, 12.6, 7.8, 3, 1.3)),                                    // 座面
      W('M7.4 15.6v4.4 M4.4 20.6h6', 1.8),                                 // 脚
      W('M21.2 2.8 17.6 17.6', 1.8), W('M20 2.6h2.6', 2.6),                // 掃除機の柄とにぎり
      F(rrect(17.6, 7.6, 3.6, 7.2, 1.8)),                                  // 本体
      W('M13.4 20.4h5.6', 3), W('M17.6 17.6 16.6 20.2', 1.8),              // 吸いこみ口
    ],
    'task-catering': [
      F(rrect(6, 3.2, 12, 15.8, 1.5) + rrect(8.2, 6, 7.6, 1.4, 0.5) + rrect(8.2, 9.6, 7.6, 1.4, 0.5) + rrect(8.2, 13.2, 7.6, 1.4, 0.5), true),
      W('M7 2.2h10', 1.6),
      F(circle(8.6, 20.6, 1.6) + circle(15.4, 20.6, 1.6)),
    ],
    'task-refuel': [
      F('M6 4.6h8.6l2.6 3.4v2.6H8.8L7.2 8.6H6Z'),                          // ノズルの胴
      W('M6.6 6.6H3.6l-1 2.2', 2.2),                                       // 先っぽ
      W('M15.4 10l2.2 6.2', 3.3),                                          // にぎり
      W('M10.8 10.8c0 2.4 1.7 4 4.2 4.4', 1.6),                            // 引き金のガード
      W('M17 4.8c2.6-2 4.8-.4 4.8 2.6V21', 1.9),                           // ホース
      F('M5.2 13c1.7 2.4 2.6 3.9 2.6 5.2a2.6 2.6 0 0 1-5.2 0c0-1.3.9-2.8 2.6-5.2Z'), // しずく
    ],
    'task-inspect': [
      F(circle(8.6, 14, 6.6) + circle(8.6, 14, 3.4) + circle(8.6, 14, 1.7), true),
      W(circle(16.6, 7.9, 3.3), 2), W('M19 10.3l2.8 2.8', 2.8),
    ],
    'task-load': suitcase(1.8, 5.2).concat([W('M19 20.8V9.6', 2.3), F('M15 11.6 19 6.4l4 5.2Z')]),
    'task-board': [W('M13 21.2V3.5h7.5v17.7', 1.9)].concat(walker(7.4, 4.4)),
    'task-bagmatch': [
      W(rrect(9, 2.5, 12.5, 16, 1.6) + 'M12 7h6.5 M12 10.5h6.5 M12 14h4', 1.8),
      F(poly([[2, 16.5], [6, 12.5], [13.5, 12.5], [13.5, 20.5], [6, 20.5]]) + circle(6.5, 16.5, 1.2), true),
    ],
    'task-doorclose': [
      W(rrect(3, 2.5, 10.5, 19, 4), 1.9),                                  // 機体のドア（角の丸い扉）
      F(rrect(5.9, 5.4, 4.7, 4.4, 2)), W('M5.8 13.6h4.6', 2),              // 窓と取っ手
      F(rrect(12.8, 13.2, 9.2, 8, 1.4) + circle(17.4, 16.6, 1.2) + rrect(16.8, 16.8, 1.2, 2.6, 0.5), true),  // 錠
      W('M14.8 13.2v-2.4a2.6 2.6 0 0 1 5.2 0v2.4', 1.8),
    ],
    'task-pushback': [
      F('M23.5 2.8H12.4C8.4 2.8 5.4 5 4.6 8c-.3 1 .4 2 1.5 2h17.4Z' +           // 機首（左向き）
        poly([[7.2, 6.4], [9.9, 4.9], [10.4, 6.4]]) + circle(13.6, 6, 0.75) + circle(16.4, 6, 0.75) + circle(19.2, 6, 0.75) + circle(22, 6, 0.75), true),
      W('M10.6 10v5', 1.6), F(circle(10.6, 17.6, 2.1)),                         // 前脚
      F(poly([[1, 20], [1, 16.4], [2.6, 14.6], [7.8, 14.6], [8.6, 16.4], [8.6, 20]])),  // トーイングカー（低い）
      F(circle(3, 20.4, 1.5) + circle(6.6, 20.4, 1.5)),
      W('M8.6 17.6h0.6', 1.6),
      W('M14 16.6h6.4', 1.9), L('M18.4 14.2l2.6 2.4-2.6 2.4'),                  // うしろへ押す向き
    ],
    'task-depart': [W('M2.5 21.3h19', 1.8), F(poly(xf(PLANE, 62, 0.82, 0.6, -1.6)))],

    /* ---- スタッフ（塗り） ---- */
    'staff-ramp': [
      F(circle(12, 5, 2.1)),
      W('M12 9v5.6', 3.8), W('M11 15.2 10.4 21.6 M13 15.2l.6 6.4', 2.9),
      W('M10.4 9.6 7.4 7.2 M13.6 9.6l3 -2.4', 2.4),
      W('M7.4 7.2 4.8 3 M16.6 7.2 19.2 3', 1.9),          // 誘導灯
    ],
    'staff-baggage': stander(8.2, 5).concat([
      W('M6.8 9.8 5.2 14.6', 2.4), W('M9.6 9.8l2.8 3.4', 2.4),
      F(rrect(12.8, 12.6, 8.4, 8.6, 1.5)), W('M15.4 12.6v-1.7h3.2v1.7', 1.4),
    ]),
    'staff-cleaning': stander(8.6, 5).concat([
      W('M9.8 9.6 14 11 M9.8 11.6l4.6 2.6', 2.3),
      W('M18 3 14.8 19.6', 1.7), W('M11.8 20.6h6.2', 2.6),
    ]),
    'staff-maintenance': stander(7.6, 5).concat([
      W('M6.2 9.8 4.6 14.6', 2.4), W('M9 9.6l3.6 2.2', 2.4),
      W('M22.28 6.74A2.4 2.4 0 1 1 19.24 5.22', 2.4), W('M18.9 9.7 13.4 13', 2.6),
    ]),
    'staff-gate': [
      F(circle(12, 6, 2.1)),
      F('M9.4 4.4c.2-1.9 1.3-2.7 2.6-2.7s2.4.8 2.6 2.7Z'), W('M8.8 4.5h6.4', 1.4),   // 制帽
      F('M8.4 9.4h7.2l1 6.6H7.4Z'),                                                 // 上着
      W('M10.4 16 10.1 21.6 M13.6 16l.3 5.6', 2.8),
      W('M15.4 10.2 19.2 12.6', 2.3),                                               // 案内する腕
    ],

    /* ---- 車（塗り。横から見た形） ---- */
    'veh-beltloader': [
      F(rrect(2, 14.5, 13, 4, 1)), F(rrect(2.4, 11, 4, 4, 0.8)),
      W('M5.5 13.6 21.8 5.2', 2.6), W('M10 14.5 12.8 10.9', 1.6),
      F(circle(5, 19.4, 1.8) + circle(12, 19.4, 1.8)),
    ],
    'veh-cart': [
      W('M3 7.5h17.5', 1.8), W('M4 7.5v8.4 M19.5 7.5v8.4', 1.6),
      F(rrect(2.5, 15.5, 18.5, 2.2, 0.6)), F(rrect(5.6, 11, 4.2, 4.5, 0.8) + rrect(11, 10, 5.2, 5.5, 0.8)),
      W('M21 16.6h2.2', 1.6), F(circle(6, 19.8, 1.7) + circle(17, 19.8, 1.7)),
    ],
    'veh-fuel': [
      F(rrect(2, 10.5, 5.5, 7.5, 1.2) + rrect(3, 11.6, 3.2, 2.6, 0.5), true),
      F(rrect(8, 8.5, 14, 8, 4)), F(rrect(2, 16.5, 20, 2, 0.6)),
      F(circle(5, 19.8, 1.8) + circle(13, 19.8, 1.8) + circle(18, 19.8, 1.8)),
    ],
    'veh-catering': [
      F(rrect(2, 12.6, 5, 5.4, 1) + rrect(2.9, 13.6, 3.2, 2.2, 0.5), true),
      F(rrect(8.5, 3.5, 13.5, 7.5, 1)), W('M10 11 20 16 M20 11 10 16', 1.4),
      F(rrect(2, 16, 20, 2, 0.6)), F(circle(5, 19.8, 1.8) + circle(17.5, 19.8, 1.8)),
    ],
    'veh-pushback': [
      F(poly([[1.5, 18], [1.5, 14.6], [3.6, 13], [20.4, 13], [22.5, 14.6], [22.5, 18]])),
      F(rrect(5, 8.6, 5.4, 4.6, 1) + rrect(6, 9.6, 3.4, 2.2, 0.5), true),
      F(circle(6, 19, 2) + circle(18, 19, 2)),
    ],

    /* ---- その他 ---- */
    'plane': [F(poly(xf(PLANE, 45, 0.98)))],
    'people': [F(circle(9, 6, 2.4) + 'M4.8 20v-5a4.2 4.2 0 0 1 8.4 0v5Z' + circle(17.3, 7.2, 2.1) + 'M13.8 20v-4.4a3.6 3.6 0 0 1 7.2 0V20Z')],
    'walk': walker(13.4, 3.6),
    'vet': [   // 制服の袖（ななめ）と金の袖章 2 本
      W(poly([[2.5, 7.5], [7.5, 2.5], [21.5, 16.5], [16.5, 21.5]]), 1.6),
      W('M17.1 13.9 13.9 17.1 M14.3 11.1 11.1 14.3', 2.4),
    ],
    'rookie': [C(poly([[5, 2.5], [12, 6.5], [12, 21.5], [5, 15.5]]), '#f2c200'), C(poly([[12, 6.5], [19, 2.5], [19, 15.5], [12, 21.5]]), '#1e9a4b')],
  };

  /* ---------- 絵文字 → 名前 ---------- */
  const EMOJI = {
    '⏸': 'pause', '⏩': 'fast', '⚙': 'gear', '🗺': 'flow', '📋': 'list', '📜': 'log', '👉': 'pin',
    '📖': 'book', '🎮': 'help', '🔊': 'sound', '🎵': 'music', '💡': 'info', '👨‍✈': 'headset',
    '⏳': 'hourglass', '🔒': 'lock', '🔓': 'unlock', '✅': 'check', '⚠': 'alert',
    '🐢': 'gauge-slow', '🚀': 'gauge-fast', '⭐': 'vet', '🔰': 'rookie',
    '🛡': 'shield', '⏱': 'clock', '😊': 'smile', '💰': 'coin',
    '☀': 'sun', '⛅': 'sun-cloud', '🌦': 'sun-cloud', '⛈': 'storm', '🌧': 'rain', '🌇': 'dusk', '✈': 'plane',
  };
  const VS16 = /️/g;
  const norm = (e) => String(e || '').replace(VS16, '');
  let emojiMap = null;   // 最初に呼ばれたときに作る（tasks.js はこのあとで読みこまれるため）
  let emojiRe = null;
  let builtWithData = false;
  function buildEmoji() {
    const map = {};
    const RM = window.RES_META || {};
    Object.keys(RM.staff || {}).forEach((k) => { if (RM.staff[k].icon) map[norm(RM.staff[k].icon)] = 'staff-' + k; });
    Object.keys(RM.vehicles || {}).forEach((k) => { if (RM.vehicles[k].icon) map[norm(RM.vehicles[k].icon)] = 'veh-' + k; });
    (window.TASK_DEFS || []).forEach((t) => { if (t.icon) map[norm(t.icon)] = 'task-' + t.id; });   // 作業を優先
    Object.keys(EMOJI).forEach((k) => { map[norm(k)] = EMOJI[k]; });                              // 操作・指標・天気を最優先
    Object.keys(map).forEach((k) => { if (!DEF[map[k]]) delete map[k]; });
    emojiMap = map;
    const keys = Object.keys(map).sort((a, b) => b.length - a.length);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /* 各コードポイントのあとに U+FE0F があってもよい形にする */
    emojiRe = new RegExp(keys.map((k) => Array.from(k).map((ch) => esc(ch) + '\\uFE0F?').join('')).join('|'), 'gu');
    return map;
  }
  const ready = () => {
    if (!emojiMap || (!builtWithData && window.TASK_DEFS)) { buildEmoji(); builtWithData = !!window.TASK_DEFS; }
    return emojiMap;
  };

  /* ---------- SVG スプライト ---------- */
  const attr = (p) => {
    if (p.m === 'l') return `class="i-l" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"`;
    if (p.m === 'w') return `class="i-w" fill="none" stroke="currentColor" stroke-width="${p.w}" stroke-linecap="round" stroke-linejoin="round"`;
    if (p.c) return `class="i-c" fill="${p.c}"`;   // 固定色（CSS で上書きしない）
    return `class="i-f" fill="currentColor"${p.r ? ' fill-rule="evenodd"' : ''}`;
  };
  function spriteHtml() {
    return '<svg id="icon-sprite" xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' +
      Object.keys(DEF).map((n) => `<symbol id="i-${n}" viewBox="0 0 24 24">` +
        DEF[n].map((p) => `<path d="${p.d}" ${attr(p)}/>`).join('') + '</symbol>').join('') + '</svg>';
  }
  function inject() {
    if (document.getElementById('icon-sprite')) return;
    document.body.insertAdjacentHTML('afterbegin', spriteHtml());
  }
  if (document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject);

  /* ---------- 公開する関数 ---------- */
  const has = (n) => Object.prototype.hasOwnProperty.call(DEF, n);
  function svg(name, opt = {}) {
    if (!has(name)) return '';
    const cls = 'ico ico-' + name + (opt.cls ? ' ' + opt.cls : '');
    const sz = opt.size != null ? (typeof opt.size === 'number' ? opt.size + 'px' : opt.size) : null;
    const st = sz ? ` style="width:${sz};height:${sz}"` : '';
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${st}><use href="#i-${name}"></use></svg>`;
  }

  const pathCache = {};
  function paths(name) {
    if (pathCache[name]) return pathCache[name];
    if (!has(name) || typeof Path2D === 'undefined') return null;
    pathCache[name] = DEF[name].map((p) => ({ p, path: new Path2D(p.d) }));
    return pathCache[name];
  }
  function draw(ctx, name, cx, cy, size, color) {
    const list = paths(name);
    if (!list || !ctx) return false;
    const s = size / 24;
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const { p, path } of list) {
      if (p.m === 'f') {
        ctx.fillStyle = p.c || color || '#000';
        ctx.fill(path, p.r || 'nonzero');
      } else {
        ctx.strokeStyle = color || '#000';
        ctx.lineWidth = p.m === 'w' ? p.w : 1.75;   // 24 グリッドの太さ（scale でいっしょに大きくなる）
        ctx.stroke(path);
      }
    }
    ctx.restore();
    return true;
  }

  function task(id) { return has('task-' + id) ? 'task-' + id : null; }
  function res(type) {
    const RM = window.RES_META || {};
    if (RM.staff && RM.staff[type] && has('staff-' + type)) return 'staff-' + type;
    if (RM.vehicles && RM.vehicles[type] && has('veh-' + type)) return 'veh-' + type;
    if (has('staff-' + type)) return 'staff-' + type;
    if (has('veh-' + type)) return 'veh-' + type;
    return null;
  }
  function emojiName(str) {
    const m = ready();
    const k = norm(str).trim();
    return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
  }
  function iconize(html) {
    if (html == null) return '';
    ready();
    const re = emojiRe;
    return String(html).replace(/(<[^>]*>)|([^<]+)/g, (all, tag, text) => {
      if (tag) return tag;
      return text.replace(re, (e) => { const n = emojiMap[norm(e)]; return n ? svg(n) : e; });
    });
  }
  function names() { return Object.keys(DEF); }
  function sheetHtml() {
    const cvs = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const cell = (n) => {
      let img = '';
      if (cvs && cvs.getContext) {
        cvs.width = 48; cvs.height = 48;
        const c = cvs.getContext('2d');
        c.clearRect(0, 0, 48, 48);
        draw(c, n, 24, 24, 40, '#1e3a5f');
        img = `<img src="${cvs.toDataURL()}" width="40" height="40" alt="" style="display:block">`;
      }
      return '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 2px;border:1px solid #d8e1e9;border-radius:6px;background:#fff">' +
        `<div style="display:flex;align-items:center;gap:6px;color:#1e3a5f">${svg(n, { size: 40 })}${img}${svg(n, { size: 16 })}</div>` +
        `<div style="font:13px/1.4 system-ui,sans-serif;color:#24344a">${n}</div></div>`;
    };
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px">' +
      names().map(cell).join('') + '</div>';
  }

  window.Icons = { svg, draw, task, res, emojiName, iconize, names, sheetHtml };
})();
