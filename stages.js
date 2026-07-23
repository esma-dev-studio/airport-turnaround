/* =========================================================
 * stages.js — ステージ設定データ
 * リソース数・制限時間・イベントをここで調整する。
 * ステージ2以降は前のステージをクリアすると遊べる。
 * events[]: at=到着からの経過分で発生 / when={task,pct}=作業の進捗で発生
 * hints: true=常時ヒント / 'limited'=序盤のみ / false=なし
 * ========================================================= */

const STAGES = [
  {
    id: 1,
    name: 'ステージ1　はじめての出発準備',
    shortName: 'ステージ1',
    subtitle: '晴天・大きなトラブルなし。基本操作をおぼえよう。',
    difficulty: '初級',
    weather: { icon: '☀', label: '晴れ' },
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
    intro: 'あおぞら航空123便が到着しました。出発予定は45分後の10:45。\nスタッフと車両に作業をわりあてて、安全に・時間どおりの出発をめざしましょう！\n左の作業カードの「開始」ボタンで作業が始まります。',
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
      { id: 'cleaning_delay', at: 5 },
      { id: 'minor_defect', when: { task: 'inspect', pct: 0.6 } },
    ],
    intro: '今日は人も車両も少ないシフト。特にランプスタッフは1人だけ！\n給油・機内食・プッシュバックはぜんぶこの1人が担当します。\n作業の順番と並行作業をうまく組み立てて、定刻出発をめざそう！',
    clearNote: '',
  },
  {
    id: 3,
    name: 'ステージ3　消えた手荷物',
    shortName: 'ステージ3',
    subtitle: '積み込む手荷物が1個足りない！？捜索と出発判断。',
    difficulty: '中級',
    weather: { icon: '🌦', label: 'はれ・雷雲接近中' },
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
      { id: 'late_pax', at: 26 },
    ],
    intro: '雷雲が近づく中でのターンアラウンド。さらに「手荷物が1個見つからない」との連絡が…。\n捜索・乗客対応・出発判断、リーダーの腕の見せどころ！',
    clearNote: '',
  },
];

const STAGE_MAP = {};
STAGES.forEach((s) => { STAGE_MAP[s.id] = s; });

window.STAGES = STAGES;
window.STAGE_MAP = STAGE_MAP;
