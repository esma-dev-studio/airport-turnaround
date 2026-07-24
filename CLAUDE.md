# このフォルダのルール（出発準備45分！ Airport Turnaround）

## 対象ユーザーと文言（最重要）
- このアプリの対象は**小学2年生〜大人**。表示文言は**総ルビ＋やさしい言葉**で書く。
  - DOMに出す日本語は `rubi()`（`tasks.js` の `RUBI_DICT`）を通し、**innerHTMLで挿入**する（textContentにrubiの出力を入れない）。
  - 新しい漢字語を表示文言に使ったら、`RUBI_DICT` に読みを追加する。
  - **Canvasに描く文字はルビが振れないので、かな書き**にする（例:「スタッフのまちあい」「ねんりょう」）。
  - ボタン・状態表示は「はじめる」「ストップ」「かんりょう！」のようなやさしい言葉に統一する。
- 記録・カードなどの文字は小さくしすぎない（記録は開いたとき最低260pxの高さを保つ）。

## 開発メモ
- 構成: エンジン(`game.js`)はDOM非依存。表示は`ui.js`、データは`tasks.js`/`events.js`/`stages.js`。
- 検証: `index.html?debug=1` で `window.__test`（`adv(分)`・`start(id)`など）が使える。デバッグ時は到着シネマティック省略・全ステージ解放。
  リリース前にヘッドレスEdge（puppeteer-core）で3ステージの完走回帰を回し、JSエラー0を確認してからデプロイする。
- デプロイ: `git push origin main` → GitHub Pages（mainブランチ直接公開）が約30秒で反映。
  公開URL: https://esma-dev-studio.github.io/airport-turnaround/
  コミットのメールは noreply（`280012992+esma-dev-studio@users.noreply.github.com`）を使う。
