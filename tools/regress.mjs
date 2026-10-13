/* =========================================================
 * regress.mjs — 全ステージの完走回帰(貪欲ボット)+画面サイズ別のスクショ
 *   ・index.html?debug=1(全ステージ解放・到着シネマティック省略)を開き、window.__test で操作する
 *   ・ボット: ready の作業を即開始(おまかせ割当)/ 安全確認は「確認する」/ イベントは critical でない選択肢
 *   ・合格条件: 全ステージ「出発」かつ cleared、重大フラグなし、JSエラー・requestfailed 0
 *   ・最後にタイトル・ステージ選択・ゲーム・結果を 390×844 / 1024×768 / 1440×900 で撮る(shots/regress/)
 *
 * 使い方(先に配信: node tools/serve.mjs 8740):
 *   node tools/regress.mjs [--port 8740] [--base http://127.0.0.1:8740/] [--stages 1,2,3,4,5] [--shots 0]
 *   本番URL: --base https://esma-dev-studio.github.io/airport-turnaround/
 *   終了コード: 0=全部合格 / 1=不合格あり
 * ========================================================= */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEdge, openPage, keepAlive } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const argOf = (k, d = null) => { const i = ARGS.indexOf('--' + k); return i >= 0 ? ARGS[i + 1] : d; };
const PORT = Number(argOf('port', 8740));
const BASE = (argOf('base', `http://127.0.0.1:${PORT}/`)).replace(/\/?$/, '/');
const OUT = join(ROOT, 'shots', 'regress');
const WANT_SHOTS = argOf('shots', '1') !== '0';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const ok = (name, pass, note = '') => { rows.push({ name, pass, note }); console.log(`${pass ? '  ok' : '  NG'}  ${name}${note ? '  — ' + note : ''}`); };

/* 1ステージをボットで最後まで進める(ページの中で実行) */
async function playStage(page, id) {
  return page.evaluate(async (stageId) => {
    const T = window.__test;
    const app = T.app;
    app.save.tutorialSeen = true;           // チュートリアルの板を出さない
    app.startStage(stageId);
    app.begin();                            // デバッグではシネマティック省略
    app.setSpeed(0);                        // 実時間のループは止め、こちらで時間を進める
    const G = T.G;
    const s0 = G.state;
    if (!s0 || s0.stage.id !== stageId) return { error: 'stage not started' };
    let steps = 0;
    const log = [];
    while (!G.state.ended && steps < 4000) {
      const s = G.state;
      if (s.pendingSafety) { T.safety(true); log.push(`${s.clock.toFixed(1)} safety`); }
      if (s.activeEvent) {
        const ch = s.activeEvent.def.choices;
        let i = ch.findIndex((c) => !c.critical);
        if (i < 0) i = s.activeEvent.def.defaultChoice || 0;
        log.push(`${s.clock.toFixed(1)} event ${s.activeEvent.def.id} -> ${i}`);
        T.event(i);
      }
      for (const t of s.taskList) {
        if (t.status === 'ready' || (t.status === 'gathering' && !G.reqsFilled(t))) {
          const r = T.start(t.id);
          if (r && r.ok) log.push(`${s.clock.toFixed(1)} start ${t.id}`);
        }
      }
      T.adv(0.25);
      steps++;
    }
    const r = G.state.endResult || null;
    return { steps, clock: G.state.clock, ended: G.state.ended, result: r && { departed: r.departed, cleared: r.cleared, score: r.score, rank: r.rank, critical: r.critical, delay: r.delay }, log: log.slice(-6) };
  }, id);
}

const browser = await launchEdge();
let code = 0;
try {
  const { page, errors } = await openPage(browser, BASE + 'index.html?debug=1', { width: 1280, height: 720 });
  const stopKA = keepAlive(page);
  await page.waitForFunction(() => window.__test && window.__test.app && window.STAGES, { timeout: 120000 });
  const stages = argOf('stages') ? argOf('stages').split(',').map(Number) : await page.evaluate(() => window.STAGES.map((s) => s.id));
  console.log(`stages: ${stages.join(',')}  base: ${BASE}`);

  for (const id of stages) {
    const t0 = Date.now();
    const r = await playStage(page, id);
    if (r.error || !r.result) { ok(`stage ${id}: 完走`, false, JSON.stringify(r).slice(0, 300)); continue; }
    const res = r.result;
    ok(`stage ${id}: 出発して クリア`, res.departed && res.cleared && !res.critical, `score ${res.score} rank ${res.rank} delay ${res.delay} / ${r.clock.toFixed(1)}分・${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await page.waitForFunction(() => document.getElementById('screen-result').classList.contains('active'), { timeout: 20000 }).then(
      () => ok(`stage ${id}: 結果画面`, true), () => ok(`stage ${id}: 結果画面`, false, '表示されない'));
    if (WANT_SHOTS) await page.screenshot({ path: join(OUT, `result_stage${id}_1280x720.png`) });
  }

  if (WANT_SHOTS) {
    for (const [w, h] of [[390, 844], [1024, 768], [1440, 900]]) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.evaluate(() => window.__test.app.gotoTitle()); await sleep(600);
      await page.screenshot({ path: join(OUT, `title_${w}x${h}.png`) });
      await page.evaluate(() => window.__test.app.gotoSelect()); await sleep(600);
      await page.screenshot({ path: join(OUT, `select_${w}x${h}.png`) });
      await page.evaluate(() => { const a = window.__test.app; a.save.tutorialSeen = true; a.startStage(1); a.begin(); a.setSpeed(0); window.__test.adv(6); });
      await sleep(800);
      await page.screenshot({ path: join(OUT, `game_${w}x${h}.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      ok(`${w}x${h}: 横スクロールなし`, !overflow);
    }
  }
  stopKA();
  const errs = errors.filter((e) => !/favicon/.test(e));
  ok('JSエラー・requestfailed 0', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  ok('実行', false, e.message);
}
await browser.close();
const ng = rows.filter((r) => !r.pass).length;
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, rows }, null, 1));
console.log(ng ? `NG ${ng} 件` : `OK (${rows.length} 項目)`);
code = ng ? 1 : 0;
process.exit(code);
