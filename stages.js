/* =========================================================
 * stages.js — ステージ設定データ
 * リソース数・制限時間・イベントをここで調整する。
 * ステージ2以降は前のステージをクリアすると遊べる。
 * events[]: at=到着からの経過分で発生 / when={task,pct}=作業の進捗で発生
 * eventPool: {pick:n, list:[...]} → プレイのたびに n 件をぬきだして追加
 *   （リプレイで展開が変わる。?debug=1 のときは先頭から固定で選ぶ）
 * rainAll: true → ずっと雨。屋外作業がすこしゆっくり（×1.12）になる
 * hints: true=常時ヒント / 'limited'=序盤のみ / false=なし（上級）
 * ========================================================= */

const STAGES = [
  {
    id: 1,
    name: 'ステージ1　はじめての出発準備',
    shortName: 'ステージ1',
    subtitle: '晴天・大きなトラブルなし。基本操作をおぼえよう。',
    difficulty: '初級',
    weather: { icon: '☀', label: 'はれ' },
    comingSoon: false,
    /* 時刻はゲーム内の分（10:00 = 600分） */
    arrival: 600,        // 到着 10:00
    std: 645,            // 出発予定 10:45（STD＝予定出発時刻）
    maxOvertime: 30,     // これ以上遅れたらステージ失敗（10:45+30分）
    hints: true,         // 初級はおすすめ作業のヒントを表示
    resources: {
      staff:    { gate: 2, baggage: 3, cleaning: 2, ramp: 2, maintenance: 1 },
      vehicles: { beltloader: 1, cart: 2, fuel: 1, catering: 1, pushback: 1 },
      /* ⭐vet=15%速い / 🔰rookie=15%ゆっくり（並び順はA,B,C…） */
      staffSkills: { gate: ['vet'] },
    },
    /* 発生イベント: atは到着からの経過分 */
    events: [
      { id: 'late_pax', at: 14 },
    ],
    intro: 'あおぞら航空123便が到着しました。\n出発予定は 45分あとの 10:45。\nスタッフと車両に作業をわりあてて、安全に 時間どおりの 出発を めざしましょう！\nひかっている わ を おすか、『おしごと』カードの『▶ はじめる』を おすと、作業が始まります。',
    clearNote: '安全を守って出発できればクリア！',
  },
  {
    id: 2,
    name: 'ステージ2　定刻出発を目指せ',
    shortName: 'ステージ2',
    subtitle: 'スタッフと車両が不足。並行作業の腕が試される。',
    difficulty: '中級',
    weather: { icon: '⛅', label: 'くもり' },
    arrival: 600,
    std: 645,
    maxOvertime: 25,
    hints: 'limited',
    resources: {
      staff:    { gate: 1, baggage: 2, cleaning: 2, ramp: 1, maintenance: 1 },
      vehicles: { beltloader: 1, cart: 1, fuel: 1, catering: 1, pushback: 1 },
      staffSkills: { baggage: ['vet'], cleaning: ['norm', 'rookie'] },
    },
    events: [
      { id: 'minor_defect', when: { task: 'inspect', pct: 0.6 } },
    ],
    /* リプレイで展開が変わるように1件を抽選 */
    eventPool: { pick: 1, list: [
      { id: 'cleaning_delay', at: 5 },
      { id: 'found_item', when: { task: 'clean', pct: 0.5 } },
    ] },
    intro: '今日は人も車両も少ないシフト。特にランプスタッフは1人だけ！\n給油・機内食・プッシュバックはぜんぶこの1人が担当します。\n作業の順番と並行作業をうまく組み立てて、定刻出発をめざそう！',
    clearNote: '',
  },
  {
    id: 3,
    name: 'ステージ3　消えた手荷物',
    shortName: 'ステージ3',
    subtitle: '積み込む手荷物が1個足りない！？捜索と出発判断。',
    difficulty: '中級',
    weather: { icon: '🌦', label: 'はれ→かみなりくるかも' },
    arrival: 600,
    std: 645,
    maxOvertime: 25,
    hints: 'limited',
    resources: {
      staff:    { gate: 2, baggage: 2, cleaning: 2, ramp: 2, maintenance: 1 },
      vehicles: { beltloader: 1, cart: 1, fuel: 1, catering: 1, pushback: 1 },
      staffSkills: { ramp: ['vet'], baggage: ['norm', 'rookie'], cleaning: ['vet'] },
    },
    events: [
      { id: 'weather', at: 7 },
      { id: 'lost_bag', when: { task: 'load', pct: 0.5 } },
    ],
    eventPool: { pick: 1, list: [
      { id: 'late_pax', at: 26 },
      { id: 'found_item', when: { task: 'clean', pct: 0.5 } },
    ] },
    intro: '雷雲が近づく中でのターンアラウンド。さらに「手荷物が1個見つからない」との連絡が…。\n捜索・乗客対応・出発判断、リーダーの腕の見せどころ！',
    clearNote: '',
  },
  {
    id: 4,
    name: 'ステージ4　夕ぐれの上級シフト',
    shortName: 'ステージ4',
    subtitle: '出発まで40分しかない！少ない人数でどうさばく？',
    difficulty: '上級',
    weather: { icon: '🌇', label: 'ゆうがた・はれ' },
    arrival: 600,
    std: 640,            // 40分しかない！
    maxOvertime: 20,
    hints: false,        // 上級はヒントなし
    resources: {
      staff:    { gate: 1, baggage: 2, cleaning: 2, ramp: 1, maintenance: 1 },
      vehicles: { beltloader: 1, cart: 1, fuel: 1, catering: 1, pushback: 1 },
      staffSkills: { ramp: ['vet'], cleaning: ['rookie', 'rookie'], gate: ['vet'] },
    },
    events: [
      { id: 'fuel_delay', at: 3 },
      { id: 'special_assist', at: 16 },
    ],
    eventPool: { pick: 1, list: [
      { id: 'catering_miscount', when: { task: 'catering', pct: 0.6 } },
      { id: 'belt_break', when: { task: 'load', pct: 0.3 } },
      { id: 'late_pax', at: 22 },
    ] },
    intro: '夕ぐれの空港。次の便まで40分しかない特急ターンアラウンド！\n清掃は新人コンビ、ヒントもなし。どの作業を先に始めるか、きみの腕が試される。\nむずかしいときは⏸でとめて、ゆっくり作戦を考えよう。',
    clearNote: '',
  },
  {
    id: 5,
    name: 'ステージ5　雨の日のターンアラウンド',
    shortName: 'ステージ5',
    subtitle: 'ずっと雨。屋外の作業がゆっくりになる中での総力戦。',
    difficulty: '上級',
    weather: { icon: '🌧', label: 'あめ' },
    arrival: 600,
    std: 642,
    maxOvertime: 20,
    hints: false,
    rainAll: true,       // ずっと雨: 屋外作業が×1.12ゆっくり
    resources: {
      staff:    { gate: 1, baggage: 2, cleaning: 2, ramp: 1, maintenance: 1 },
      vehicles: { beltloader: 1, cart: 1, fuel: 1, catering: 1, pushback: 1 },
      staffSkills: { baggage: ['norm', 'rookie'], cleaning: ['rookie', 'rookie'], maintenance: ['vet'] },
    },
    events: [
      { id: 'belt_break', when: { task: 'load', pct: 0.35 } },
    ],
    eventPool: { pick: 2, list: [
      { id: 'late_pax', at: 24 },
      { id: 'found_item', when: { task: 'clean', pct: 0.5 } },
      { id: 'catering_miscount', when: { task: 'catering', pct: 0.6 } },
      { id: 'fuel_delay', at: 4 },
    ] },
    intro: '朝からずっと雨。ぬれた駐機場では、\n屋外の作業が いつもより少し ゆっくりになります。\n雨の日こそ段取りの腕の見せどころ。安全第一で、みんなを時間どおりに送り出そう！',
    clearNote: '',
  },
];

const STAGE_MAP = {};
STAGES.forEach((s) => { STAGE_MAP[s.id] = s; });

window.STAGES = STAGES;
window.STAGE_MAP = STAGE_MAP;
