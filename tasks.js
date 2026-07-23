/* =========================================================
 * tasks.js — 作業（タスク）とリソースの定義データ
 * ゲームロジックは持たない。定義の追加・調整はこのファイルだけで行う。
 * ========================================================= */

/* ---- スタッフ・車両の種類 ---- */
const RES_META = {
  staff: {
    ramp:        { label: 'ランプスタッフ',     short: 'ランプ', color: '#e8a921', icon: '🦺', desc: '駐機場（ランプ）で給油の見守りや車両の誘導など、地上作業ぜんぱんを担当します。' },
    baggage:     { label: '手荷物スタッフ',     short: '手荷物', color: '#e2711d', icon: '🧳', desc: '手荷物のつみおろし・つみこみ・照合を担当します。' },
    cleaning:    { label: '清掃スタッフ',       short: '清掃',   color: '#2f9e63', icon: '🧹', desc: '機内の座席やトイレをきれいにします。' },
    maintenance: { label: '整備スタッフ',       short: '整備',   color: '#d64545', icon: '🔧', desc: '機体に異常がないか点検します。' },
    gate:        { label: '搭乗ゲートスタッフ', short: 'ゲート', color: '#2b6cb0', icon: '💁', desc: '乗客の降機・搭乗の案内とドアの操作を担当します。' },
  },
  vehicles: {
    beltloader: { label: 'ベルトローダー',       short: 'ベルト', color: '#5a6b7b', icon: '🛗', desc: '動くベルトで手荷物を貨物室へ運ぶ車です。' },
    cart:       { label: '手荷物カート',         short: 'カート', color: '#8a765a', icon: '🚛', desc: '手荷物をのせて運ぶ台車つきの車です。' },
    fuel:       { label: '給油車',               short: '給油',   color: '#b8434e', icon: '⛽', desc: '飛行機に燃料を入れるタンクを積んだ車です。' },
    catering:   { label: 'ケータリング車',       short: '機内食', color: '#3f9bb8', icon: '🍱', desc: '機内食や飲み物を荷台ごと持ち上げて積みこむトラックです。' },
    pushback:   { label: 'プッシュバック車両',   short: '押す車', color: '#4a5568', icon: '🚜', desc: '自分では下がれない飛行機を、後ろへ押し出す力もちの車です。' },
  },
};

/* ---- 作業定義 ----
 * dur: 必要時間（ゲーム内の分）
 * staff / vehicles: 必要リソース {種類: 人数・台数}
 * deps: 開始条件（先に完了が必要な作業id）
 * depNote: 開始条件の説明（ロック理由の表示に使う）
 * note: 安全上の注意・まめ知識
 * priority: 優先度表示（high/mid）
 */
const TASK_DEFS = [
  {
    id: 'deboard', order: 1, icon: '🚶',
    name: '乗客の降機', ruby: 'こうき',
    desc: '到着した乗客に飛行機から降りてもらいます。搭乗橋（ボーディングブリッジ）を通ってターミナルへ。',
    why: '到着したお客さんに降りてもらわないと、清掃も次の搭乗も始められないから。',
    dur: 8, staff: { gate: 1 }, vehicles: {}, deps: [],
    depNote: '到着したらすぐに始められます。',
    note: '通路では走らないよう、ゆっくり安全に案内します。',
    priority: 'high',
  },
  {
    id: 'unload', order: 2, icon: '📤',
    name: '到着手荷物の取り降ろし', ruby: 'とりおろし',
    desc: '貨物室から到着した乗客の手荷物を降ろし、ターミナルへ運びます。降機と同時に進められます。',
    why: '到着したお客さんの荷物を、早く受取所（ターンテーブル）へ届けるため。',
    dur: 10, staff: { baggage: 2 }, vehicles: { beltloader: 1, cart: 1 }, deps: [],
    depNote: '到着したらすぐに始められます。',
    note: '荷物の下敷きにならないよう、ベルトローダーのそばでは立ち位置に注意。',
    priority: 'high',
  },
  {
    id: 'clean', order: 3, icon: '🧹',
    name: '機内清掃', ruby: 'きないせいそう',
    desc: '座席・テーブル・トイレをきれいにして、次の乗客をむかえる準備をします。',
    why: '次のお客さんが気持ちよく過ごせるように。わすれ物のチェックも兼ねている。',
    dur: 10, staff: { cleaning: 2 }, vehicles: {},
    deps: ['deboard'],
    depNote: '乗客が全員降りてから（＝降機の完了後）始められます。',
    note: '忘れ物を見つけたらすぐ係へ届けます。',
    priority: 'mid',
  },
  {
    id: 'catering', order: 4, icon: '🍱',
    name: '機内食・飲料の積み込み', ruby: 'きないしょく',
    desc: 'ケータリング車の荷台を持ち上げて、機内食や飲み物を後方ドアから積みこみます。',
    why: '次のフライトで出す食事と飲み物を積んでおくため。',
    dur: 8, staff: { ramp: 1 }, vehicles: { catering: 1 },
    deps: ['deboard'],
    depNote: '乗客の降機が完了すると始められます。',
    note: '荷台を上げている間は車の下に入らないこと。',
    priority: 'mid',
  },
  {
    id: 'refuel', order: 5, icon: '⛽',
    name: '給油', ruby: 'きゅうゆ',
    desc: '給油車のホースを翼の下につないで、次のフライトに必要な燃料を入れます。',
    why: '次の目的地まで飛ぶための燃料を入れるため。',
    dur: 12, staff: { ramp: 1 }, vehicles: { fuel: 1 }, deps: [],
    depNote: '到着したらすぐに始められます。',
    note: '給油中は機体のまわりで火気厳禁。ランプスタッフが必ず見守ります。',
    priority: 'high',
  },
  {
    id: 'inspect', order: 6, icon: '🔍',
    name: '機体点検', ruby: 'きたいてんけん',
    desc: '整備スタッフが機体のまわりを歩いて、タイヤや翼にキズや異常がないか点検します。',
    why: '飛行機が安全に飛べる状態か、出発前に必ず確かめるため。いちばん大事な仕事。',
    dur: 10, staff: { maintenance: 1 }, vehicles: {}, deps: [],
    depNote: '到着したらすぐに始められます。',
    note: '点検が終わらないと飛行機は出発できません。とても大事な作業です。',
    priority: 'high',
  },
  {
    id: 'load', order: 7, icon: '📥',
    name: '出発手荷物の積み込み', ruby: 'つみこみ',
    desc: 'これから乗る乗客の手荷物を貨物室に積みこみます。',
    why: '次に乗るお客さんの荷物を、目的地までいっしょに運ぶため。',
    dur: 10, staff: { baggage: 2 }, vehicles: { beltloader: 1, cart: 1 },
    deps: ['unload'],
    depNote: '貨物室が空いてから（＝取り降ろしの完了後）始められます。',
    note: '重い荷物はバランスを考えて積みます。',
    priority: 'mid',
  },
  {
    id: 'board', order: 8, icon: '🧑‍🤝‍🧑',
    name: '乗客の搭乗', ruby: 'とうじょう',
    desc: '新しい乗客に飛行機へ乗ってもらいます。機内がきれいになってから案内します。',
    why: '準備がととのった機内へ、お客さんに乗ってもらうため。',
    dur: 10, staff: { gate: 1 }, vehicles: {},
    deps: ['clean'],
    depNote: '機内清掃が完了すると始められます。',
    note: '搭乗中も給油や機内食の積み込みは並行してできます。',
    priority: 'mid',
  },
  {
    id: 'bagmatch', order: 9, icon: '✅',
    name: '手荷物照合', ruby: 'しょうごう',
    desc: '積んだ手荷物の数と乗った乗客をつきあわせて、乗らない人の荷物がないか確認します。',
    why: '乗っていない人の荷物を運ばないようにして、安全を守るため。',
    dur: 3, staff: { baggage: 1 }, vehicles: {},
    deps: ['load', 'board'],
    depNote: '手荷物の積み込みと乗客の搭乗が完了すると始められます。',
    note: '持ち主が乗っていない荷物は、安全のため必ず降ろします。',
    priority: 'high',
  },
  {
    id: 'doorclose', order: 10, icon: '🚪',
    name: 'ドアクローズ', ruby: '',
    desc: '全員の搭乗と荷物の確認が終わったらドアを閉め、搭乗橋を外します。',
    why: '出発の準備がぜんぶ終わったしるし。ここからは機内と無線で連絡する。',
    dur: 2, staff: { gate: 1 }, vehicles: {},
    deps: ['board', 'bagmatch', 'catering', 'refuel'],
    depNote: '搭乗・手荷物照合・機内食・給油がすべて完了すると閉められます。',
    note: 'ドアを閉めたら、機内と外の連絡はインターホンで行います。',
    priority: 'high',
  },
  {
    id: 'pushback', order: 11, icon: '🚜',
    name: 'プッシュバック', ruby: '',
    desc: '専用車両で飛行機を後ろへ押し出します。飛行機は自分ではバックできません。',
    why: '飛行機は自分ではバックできないので、車で押して動き出させるため。',
    dur: 3, staff: { ramp: 1 }, vehicles: { pushback: 1 },
    deps: ['doorclose', 'inspect'],
    depNote: 'ドアクローズと機体点検が完了すると始められます。開始前に周辺の安全確認を行います。',
    note: '開始前に、機体のまわりに人や車両が残っていないか必ず確認します。',
    priority: 'high',
    safetyGate: true, // 開始時に安全確認の選択が入る
  },
  {
    id: 'depart', order: 12, icon: '🛫',
    name: '出発', ruby: 'しゅっぱつ',
    desc: 'プッシュバックが終わると、飛行機は自分のエンジンで滑走路へ向かいます。いってらっしゃい！',
    why: 'お客さんと荷物を、時間どおりに目的地へ届けるため。',
    dur: 2, staff: {}, vehicles: {},
    deps: ['pushback'],
    depNote: 'プッシュバックが完了すると自動で出発します。',
    note: '',
    priority: 'high',
    auto: true, // プッシュバック完了で自動開始
  },
];

/* 屋外作業（天候イベントで一時停止の対象になる）。
 * 降機・搭乗・ドアクローズは搭乗橋経由、清掃は機内なので屋内扱い。 */
const OUTDOOR_TASKS = new Set(['unload', 'load', 'refuel', 'catering', 'inspect', 'bagmatch', 'pushback']);

/* ---- 作業ペース（采配レバー） ----
 * rush: 2割速いが、完了時に満足度が下がる。安全にかかわる作業は安全性も下がる。
 * careful: 2割ゆっくりだが、完了時に満足度が上がる。 */
const PACE = {
  careful: { f: 1.2, label: 'ていねい', icon: '🐢' },
  normal:  { f: 1.0, label: 'ふつう',   icon: '─' },
  rush:    { f: 0.8, label: '急ぐ',     icon: '🚀' },
};
/* 急がせると安全性に響く作業 */
const SAFETY_SENSITIVE = new Set(['refuel', 'inspect', 'bagmatch']);
/* レバーを出す作業（ドアクローズ以降の短い作業と出発は対象外） */
const PACE_ALLOWED = new Set(['deboard', 'unload', 'clean', 'catering', 'refuel', 'inspect', 'load', 'board', 'bagmatch']);

const TASK_MAP = {};
TASK_DEFS.forEach((t) => {
  t.outdoor = OUTDOOR_TASKS.has(t.id);
  TASK_MAP[t.id] = t;
});

/* リソース要求を「🦺×1」のような表示用配列にする */
function taskReqList(def) {
  const list = [];
  Object.entries(def.staff || {}).forEach(([k, n]) => {
    const m = RES_META.staff[k];
    if (m && n > 0) list.push({ kind: 'staff', type: k, n, label: m.short, icon: m.icon, color: m.color });
  });
  Object.entries(def.vehicles || {}).forEach(([k, n]) => {
    const m = RES_META.vehicles[k];
    if (m && n > 0) list.push({ kind: 'vehicles', type: k, n, label: m.short, icon: m.icon, color: m.color });
  });
  return list;
}

/* ---- ふりがな辞書と自動ルビ ----
 * 小学2年生でも読めるように、表示テキストの漢字語に<ruby>を自動で振る。
 * 長い語から先にマッチさせる（例: 出発準備 → 出発）。
 * 使い方: element.innerHTML = rubi(text)  ※textContentには使わないこと
 */
const RUBI_DICT = {
  出発準備: 'しゅっぱつじゅんび', 出発予定: 'しゅっぱつよてい', 定刻出発: 'ていこくしゅっぱつ',
  出発: 'しゅっぱつ', 到着: 'とうちゃく', 準備: 'じゅんび', 予定: 'よてい', 定刻: 'ていこく',
  乗客: 'じょうきゃく', 'お客さん': 'おきゃくさん', 満足度: 'まんぞくど', 満足: 'まんぞく',
  降機: 'こうき', 搭乗橋: 'とうじょうきょう', 搭乗: 'とうじょう',
  手荷物: 'てにもつ', 荷物: 'にもつ', 荷台: 'にだい', 貨物室: 'かもつしつ', 照合: 'しょうごう',
  機内食: 'きないしょく', 機内: 'きない', 機体: 'きたい', 点検: 'てんけん', 清掃: 'せいそう',
  給油車: 'きゅうゆしゃ', 給油: 'きゅうゆ', 飲料: 'いんりょう', 整備士: 'せいびし', 整備: 'せいび',
  積み込み: 'つみこみ', 積み込む: 'つみこむ', 取り降ろし: 'とりおろし',
  安全確認: 'あんぜんかくにん', 安全性: 'あんぜんせい', 安全: 'あんぜん', 確認: 'かくにん',
  定時性: 'ていじせい', 効率: 'こうりつ', 作業: 'さぎょう', 記録: 'きろく', 車両: 'しゃりょう',
  時刻: 'じこく', 時間: 'じかん', 現在: 'げんざい', 優先度: 'ゆうせんど', 必要: 'ひつよう',
  開始: 'かいし', 中断: 'ちゅうだん', 完了: 'かんりょう', 停止中: 'ていしちゅう', 停止: 'ていし',
  問題発生: 'もんだいはっせい', 問題: 'もんだい', 発生: 'はっせい',
  待機中: 'たいきちゅう', 待機所: 'たいきじょ', 待機: 'たいき',
  移動中: 'いどうちゅう', 移動: 'いどう', 集合中: 'しゅうごうちゅう', 集合: 'しゅうごう',
  天候悪化: 'てんこうあっか', 天候: 'てんこう', 天気: 'てんき', 回復: 'かいふく',
  雷雨: 'らいう', 雷雲: 'らいうん', 雷: 'かみなり', 屋外: 'おくがい', 屋内: 'おくない',
  一時停止: 'いちじていし', 一時中断: 'いちじちゅうだん', 再開: 'さいかい', 省略: 'しょうりゃく',
  燃料: 'ねんりょう', 翼: 'つばさ', 座席: 'ざせき', 保安検査場: 'ほあんけんさじょう',
  放送: 'ほうそう', 案内: 'あんない', 呼び出し: 'よびだし',
  初級: 'しょきゅう', 中級: 'ちゅうきゅう', 捜索: 'そうさく', 判断: 'はんだん',
  応援: 'おうえん', 基準: 'きじゅん', 異常: 'いじょう', 軽微: 'けいび',
  消えた: 'きえた', 目指せ: 'めざせ', 晴天: 'せいてん', 晴れ: 'はれ', 遅延: 'ちえん', 遅れ: 'おくれ',
  飛行機: 'ひこうき', 空港: 'くうこう', 国際: 'こくさい', 航空会社: 'こうくうがいしゃ',
  航空: 'こうくう', 便: 'びん', 滑走路: 'かっそうろ', 駐機場: 'ちゅうきじょう', 駐機: 'ちゅうき',
  誘導路: 'ゆうどうろ', 誘導: 'ゆうどう', 架空: 'かくう',
  持ち主: 'もちぬし', 持ち上げ: 'もちあげ', 忘れ物: 'わすれもの', 係: 'かかり',
  火気厳禁: 'かきげんきん', 立ち位置: 'たちいち', 下敷き: 'したじき', 通路: 'つうろ', 全員: 'ぜんいん',
  目的地: 'もくてきち', 食事: 'しょくじ', 飲み物: 'のみもの', 受取所: 'うけとりじょ',
  状態: 'じょうたい', 大事: 'だいじ', 仕事: 'しごと', 無線: 'むせん', 連絡: 'れんらく',
  合図: 'あいず', 路線: 'ろせん', 坂道: 'さかみち', 短い: 'みじかい', 重い: 'おもい',
  実現: 'じつげん', 減点: 'げんてん', 改善: 'かいぜん', 段取り: 'だんどり', 調整: 'ちょうせい',
  対応: 'たいおう', 選択: 'せんたく', 使い分け: 'つかいわけ', 実施: 'じっし', 実際: 'じっさい',
  更新: 'こうしん', 自己: 'じこ', 運航: 'うんこう', 数え直す: 'かぞえなおす',
  設定: 'せってい', 効果音: 'こうかおん', 画面: 'がめん', 初期化: 'しょきか',
  地上: 'ちじょう', 担当: 'たんとう', 次: 'つぎ', 約: 'やく', 件: 'けん', 個: 'こ',
  状況: 'じょうきょう', 秒: 'びょう', 進行中: 'しんこうちゅう', 進行: 'しんこう',
  今回: 'こんかい', 簡易: 'かんい', 快適: 'かいてき',
  仕上げ: 'しあげ', 両立: 'りょうりつ', 手配: 'てはい', 条件: 'じょうけん', 例: 'れい',
  絶対: 'ぜったい', 突発: 'とっぱつ', 通知: 'つうち', 緑: 'みどり', 指標: 'しひょう',
  /* 単漢字フォールバック（上の複合語が先にマッチする） */
  急: 'いそ', 遅: 'おく', 選: 'えら', 押: 'お', 積: 'つ', 降: 'お', 乗: 'の',
  数: 'かぞ', 直: 'なお', 探: 'さが', 守: 'まも', 運: 'はこ', 客: 'きゃく', 楽: 'らく',
  始: 'はじ', 済: 'す', 終: 'お', 空: 'あ', 待: 'ま', 置: 'お', 動: 'うご',
};
const RUBI_KEYS = Object.keys(RUBI_DICT).sort((a, b) => b.length - a.length);
const RUBI_RE = new RegExp(RUBI_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
/* すでに<ruby>が振られた部分はとばす（二重ルビ防止） */
function rubi(text) {
  if (text == null) return '';
  return String(text).split(/(<ruby>[\s\S]*?<\/ruby>)/g).map((seg) =>
    seg.startsWith('<ruby>') ? seg
      : seg.replace(RUBI_RE, (m) => `<ruby>${m}<rt>${RUBI_DICT[m]}</rt></ruby>`)
  ).join('');
}

/* ---- 「出発準備のながれ」マップの行構成（上から時間の流れ） ---- */
const FLOW_ROWS = [
  { note: '✈ とうちゃく！ この4つは すぐ・同時に始められる', tasks: ['deboard', 'unload', 'refuel', 'inspect'] },
  { note: '👇 お客さんが降りたら', tasks: ['clean', 'catering'] },
  { note: '👇 貨物室が空いたら（取り降ろしのあと）', tasks: ['load'] },
  { note: '👇 機内がきれいになったら', tasks: ['board'] },
  { note: '👇 積み込みと搭乗が終わったら', tasks: ['bagmatch'] },
  { note: '👇 搭乗・照合・機内食・給油が ぜんぶ終わったら', tasks: ['doorclose'] },
  { note: '👇 機体点検もOKなら、いよいよ出発！', tasks: ['pushback', 'depart'] },
];

window.RES_META = RES_META;
window.TASK_DEFS = TASK_DEFS;
window.FLOW_ROWS = FLOW_ROWS;
window.rubi = rubi;
window.TASK_MAP = TASK_MAP;
window.taskReqList = taskReqList;
window.PACE = PACE;
window.SAFETY_SENSITIVE = SAFETY_SENSITIVE;
window.PACE_ALLOWED = PACE_ALLOWED;
