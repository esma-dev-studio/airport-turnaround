/* =========================================================
 * events.js — 突発イベントの定義データ
 * 発生タイミングはステージ設定（stages.js）側で指定する。
 * choices[].effects: 指標への加減（0〜100スケール）
 * choices[].taskDelta: {taskId: 追加分数} 作業時間への影響
 * ========================================================= */

const EVENT_DEFS = {
  /* --- ステージ1で使用 --- */
  late_pax: {
    id: 'late_pax',
    icon: '🏃',
    title: '搭乗に遅れている乗客',
    desc: '搭乗予定の乗客1名が、まだ保安検査場（手荷物検査の場所）にいるようです。搭乗のしめきりに間に合わないかもしれません。どうしますか？',
    deadlineHint: '「乗客の搭乗」が終わるまでに選んでください（選ばない場合は「しめきりまで待つ」になります）',
    /* 期限: boardタスク完了まで。未選択なら choices[defaultChoice] を自動適用 */
    deadlineTask: 'board',
    affectedTask: 'board',
    defaultChoice: 0,
    choices: [
      {
        label: 'しめきりまで待つ',
        hint: 'その乗客も乗れるが、搭乗が少し長引く',
        tags: ['😊満足度アップ', '⏱少し時間がかかる'],
        effects: { sat: +5 },
        taskDelta: { board: +2 },
        log: '遅れている乗客をしめきりまで待つことにした（搭乗+2分）',
      },
      {
        label: '呼び出し放送で急いでもらう',
        hint: '放送と案内スタッフの手配にコストがかかるが、遅れは小さい',
        tags: ['💰コスト小', '⏱ほぼ遅れなし'],
        effects: { sat: +2, cost: -6 },
        taskDelta: { board: +1 },
        log: '呼び出し放送を実施。乗客は急いでゲートへ向かっている（搭乗+1分）',
      },
      {
        label: '搭乗をしめきる（この乗客は乗せない）',
        effects: { sat: -14, cost: -4 },
        hint: '定刻を最優先。ただし乗らない人の荷物は安全のため降ろす必要がある',
        tags: ['😞満足度ダウン', '✅照合に+3分'],
        taskDelta: { bagmatch: +3 },
        log: '搭乗をしめきった。乗らない乗客の手荷物を貨物室から探して降ろす（照合+3分）',
      },
    ],
  },

  /* --- 以下はステージ2・3用の定義（データのみ先行実装） --- */
  lost_bag: {
    id: 'lost_bag',
    icon: '🧳',
    title: '手荷物が1個見つからない',
    desc: '積み込む予定の手荷物が1個足りません。カートの間か、ターミナルのどこかにあるはずです。',
    deadlineHint: '「手荷物照合」が終わるまでに選んでください',
    deadlineTask: 'bagmatch',
    affectedTask: 'bagmatch',
    defaultChoice: 0,
    choices: [
      {
        label: 'スタッフを増やして探す',
        hint: '見つかる可能性が高いが、人手と時間がかかる',
        tags: ['🧳照合+3分', '💰コスト小'],
        effects: { cost: -6 },
        taskDelta: { bagmatch: +3 },
        log: 'スタッフを増やして手荷物を捜索中（照合+3分）',
      },
      {
        label: '次の便で送ることにして出発を優先',
        hint: '遅れは出ないが、荷物の持ち主はがっかり',
        tags: ['😞満足度ダウン'],
        effects: { sat: -10, cost: -3 },
        taskDelta: {},
        log: '見つからない手荷物は次の便で送ることにした',
      },
      {
        label: '照合をやり直して数え直す',
        hint: '確実だが時間がかかる',
        tags: ['✅安全・確実', '⏱照合+5分'],
        effects: { safety: +0, sat: -2 },
        taskDelta: { bagmatch: +5 },
        log: '手荷物の数をはじめから数え直している（照合+5分）',
      },
    ],
  },
  cleaning_delay: {
    id: 'cleaning_delay',
    icon: '🚌',
    title: '清掃スタッフの到着遅延',
    desc: '前の便の作業が長引き、清掃スタッフの到着が遅れています。',
    deadlineHint: '「機内清掃」が終わるまでに選んでください',
    deadlineTask: 'clean',
    affectedTask: 'clean',
    defaultChoice: 0,
    choices: [
      {
        label: '到着まで待つ',
        hint: '清掃の開始が遅れる',
        tags: ['⏱清掃+3分'],
        effects: {},
        taskDelta: { clean: +3 },
        log: '清掃スタッフの到着を待っている（清掃+3分）',
      },
      {
        label: '他部署から応援を呼ぶ',
        hint: 'コストはかかるが遅れを取り戻せる',
        tags: ['💰コスト小'],
        effects: { cost: -8 },
        taskDelta: {},
        log: '応援スタッフを手配して清掃を予定どおり進める',
      },
      {
        label: '簡易清掃に切りかえる',
        hint: '早いが機内の快適さは下がる',
        tags: ['😞満足度ダウン', '⏱清掃-3分'],
        effects: { sat: -8 },
        taskDelta: { clean: -3 },
        log: '今回は簡易清掃に切りかえた（清掃-3分）',
      },
    ],
  },
  minor_defect: {
    id: 'minor_defect',
    icon: '🔧',
    title: '機体点検で軽微な異常を発見',
    desc: '整備スタッフがタイヤに小さなキズを見つけました。飛行に影響しないか確認が必要です。',
    deadlineHint: '「機体点検」が終わるまでに選んでください',
    deadlineTask: 'inspect',
    affectedTask: 'inspect',
    defaultChoice: 0,
    choices: [
      {
        label: '整備基準にそってしっかり確認する',
        hint: '点検に時間はかかるが、いちばん確実で安全',
        tags: ['🛡安全', '⏱点検+4分'],
        effects: { safety: +0 },
        taskDelta: { inspect: +4 },
        log: '整備基準にそってキズを確認中（点検+4分）',
      },
      {
        label: '応援の整備士を呼んで同時に確認する',
        hint: 'コストはかかるが時間の遅れをおさえられる',
        tags: ['💰コスト小', '⏱点検+2分'],
        effects: { cost: -8 },
        taskDelta: { inspect: +2 },
        log: '応援整備士と手分けしてキズを確認中（点検+2分）',
      },
      {
        label: '確認を省略して出発を急ぐ',
        hint: '安全確認の省略は重大なルール違反',
        tags: ['⚠大きなペナルティ'],
        effects: { safety: -50, sat: -5 },
        taskDelta: {},
        critical: true,
        log: '⚠ 異常の確認を省略してしまった…（重大な安全問題）',
      },
    ],
  },
  weather: {
    id: 'weather',
    icon: '🌧',
    title: '天候悪化（かみなり注意報）',
    desc: '空港の近くでかみなりが発生。屋外作業は一時中断のルールです。',
    deadlineHint: 'すぐに対応を選んでください（選ばない場合は自動で作業を中断します）',
    deadlineTask: null,
    deadlineAfter: 2.5,   // 未選択なら2.5分後に自動対応
    affectedTask: null,
    defaultChoice: 0,
    choices: [
      {
        label: 'ルールどおり屋外作業を一時中断する',
        hint: '安全第一。屋外の作業が数分止まる',
        tags: ['🛡安全', '⏱屋外作業が停止'],
        effects: {},
        pauseOutdoor: 3,
        taskDelta: {},
        log: 'かみなりのため屋外作業を一時中断（約3分）',
      },
      {
        label: '作業を続けさせる',
        hint: 'スタッフを危険にさらす重大なルール違反',
        tags: ['⚠大きなペナルティ'],
        effects: { safety: -50 },
        taskDelta: {},
        critical: true,
        log: '⚠ かみなりの中、作業を続けさせてしまった…（重大な安全問題）',
      },
    ],
  },
};

window.EVENT_DEFS = EVENT_DEFS;
