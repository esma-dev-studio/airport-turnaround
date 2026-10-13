/* =========================================================
 * browser.mjs — ヘッドレスブラウザでの検証ヘルパー(このPC = Windows の Edge・実GPU / クラウド = Linux の Chromium・ソフトウェア描画)
 *   puppeteer-core の在りか(上から順に探す): このリポジトリの node_modules → 環境変数 FO_PUPPETEER_DIR
 *   → /tmp/node_modules(クラウドでは `cd /tmp && npm i puppeteer-core@23`)→ 隣のプロジェクト(アプリ開発㉒_LumiIsland)。
 *   ブラウザ: Windows で msedge.exe があれば Edge(spawn→connect・実GPU)。それ以外は Chromium を puppeteer.launch する。
 *     Chromium の場所: 環境変数 FO_CHROME → /opt/pw-browsers/chromium-(版)/chrome-linux/chrome(クラウド)→ /usr/bin/chromium など。
 *     クラウドの描画は SwiftShader(ソフトウェア)。見た目は撮れるが重く、fps の測定には使えない。
 *
 * ライブラリとして:
 *   import { launchEdge, openPage, keepAlive } from './browser.mjs';
 *   const browser = await launchEdge();            // --enable-gpu --use-angle=d3d11 で実GPU描画
 *   const { page, errors } = await openPage(browser, url, { width:1280, height:720 });
 *   ... page.evaluate(...) / page.screenshot({ path }) ...
 *   await browser.close();
 *
 * CLIとして(1枚撮る):
 *   node tools/browser.mjs shot <url> <out.png> [--w 1280] [--h 720] [--dpr 1]
 *        [--wait "window.__ready===true"] [--eval "js"] [--delay 1500] [--timeout 60000]
 *   → 終了時に console error / pageerror / requestfailed を標準出力へ出す。
 *
 * 注意(教訓): 長時間走行は keepAlive(page) で15秒ごとに前面化+フォーカス偽装をかけ直す。
 *            並列作業では自分専用ポートの serve.mjs を使い、他人のEdgeを殺さない。
 * ========================================================= */
import { createRequire } from 'node:module';
import { readdirSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

/* puppeteer-core を探して読む(最初に使うときに1回だけ) */
let _pup = null;
function puppeteer() {
  if (_pup) return _pup;
  const bases = [join(HERE, '..', 'package.json')];
  if (process.env.FO_PUPPETEER_DIR) bases.push(join(process.env.FO_PUPPETEER_DIR, 'package.json'));
  bases.push('/tmp/package.json');
  try {
    const PRIVATE = resolve(HERE, '..', '..');
    const lumi = readdirSync(PRIVATE).find((d) => d.includes('LumiIsland'));
    if (lumi) bases.push(join(PRIVATE, lumi, 'package.json'));
  } catch { /* 親フォルダが読めない(クラウドなど) */ }
  for (const b of bases) {
    try { _pup = createRequire(b)('puppeteer-core'); return _pup; } catch { /* 次を探す */ }
  }
  throw new Error('puppeteer-core が見つかりません。クラウドでは `cd /tmp && npm i puppeteer-core@23` を実行してください');
}

export const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/* Linux(クラウド)の Chromium を探す */
export function findChromium() {
  const env = process.env.FO_CHROME || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env && existsSync(env)) return env;
  const cands = [];
  try {
    for (const d of readdirSync('/opt/pw-browsers').filter((n) => n.startsWith('chromium')).sort().reverse()) {
      cands.push(join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'), join('/opt/pw-browsers', d, 'chrome-linux64', 'chrome'));
    }
  } catch { /* 無い */ }
  cands.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
  return cands.find((p) => existsSync(p)) || null;
}

/* Linux(クラウド): Chromium をソフトウェア描画(SwiftShader)で起動する */
async function launchChromium({ extraArgs = [] } = {}) {
  const exe = findChromium();
  if (!exe) throw new Error('Chromium が見つかりません(FO_CHROME で場所を指定できます)');
  const args = [
    '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', ...extraArgs,
  ];
  return puppeteer().launch({ executablePath: exe, headless: true, args, defaultViewport: null, protocolTimeout: 600000 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDevTools(port, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return true; } catch { /* まだ */ }
    await sleep(150);
  }
  return false;
}

/* コマンドラインに印(user-data-dir)を含む msedge だけを止める(他人のEdgeは殺さない) */
function killByMarker(marker) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  } catch { /* 残っていない */ }
}

/**
 * ヘッドレスEdgeを起こして puppeteer の Browser を返す。
 * この機のEdge(151系)は puppeteer.launch() が「Failed to launch」になる(起動検知が空振りする)ため、
 * 自分で msedge を spawn → /json/version を待って connect する(アプリ開発㉒ launch_browser.mjs と同じ方式)。
 * close() で CDP の Browser.close+印つきプロセスの掃除までする。
 */
export async function launchEdge({ gpu = true, extraArgs = [] } = {}) {
  if (!IS_WIN || !existsSync(EDGE_PATH)) return launchChromium({ extraArgs });
  const port = 9500 + Math.floor(Math.random() * 400);
  const dir = mkdtempSync(join(tmpdir(), 'fo-edge-'));
  const marker = dir.split(/[\\/]/).pop();
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-gpu-vsync', '--disable-frame-rate-limit', '--autoplay-policy=no-user-gesture-required',
    ...(gpu ? ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] : ['--enable-unsafe-swiftshader']),
    ...extraArgs, 'about:blank',
  ];
  const child = spawn(EDGE_PATH, args, { stdio: 'ignore', windowsHide: true });
  if (!(await waitDevTools(port))) { killByMarker(marker); throw new Error(`Edge が起動しない (port ${port})`); }
  const browser = await puppeteer().connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 600000 });
  const origNewPage = browser.newPage.bind(browser);
  let blankClosed = false;
  browser.newPage = async () => {
    const page = await origNewPage();
    if (!blankClosed) {
      blankClosed = true;
      for (const p of await browser.pages()) if (p !== page && p.url() === 'about:blank') await p.close().catch(() => {});
    }
    await page.bringToFront().catch(() => {});
    try { const s = await page.createCDPSession(); await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* 未対応 */ }
    return page;
  };
  const origClose = browser.close.bind(browser);
  browser.close = async () => {
    try { await Promise.race([origClose(), sleep(5000)]); } catch { /* 閉じ済み */ }
    try { child.kill('SIGKILL'); } catch { /* 終了済み */ }
    killByMarker(marker);
    await sleep(300);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 使用中なら残す */ }
  };
  return browser;
}

export async function openPage(browser, url, { width = 1280, height = 720, dpr = 1, isMobile = false, hasTouch = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile, hasTouch });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() ? r.failure().errorText : '')));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  return { page, errors };
}

/* 長時間走行用: 15秒ごとに前面化+フォーカス偽装(rAFの間引き防止) */
export function keepAlive(page) {
  const tick = async () => {
    try {
      await page.bringToFront();
      const s = await page.target().createCDPSession();
      await s.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await s.detach();
    } catch (e) { /* ページが閉じた */ }
  };
  tick();
  const id = setInterval(tick, 15000);
  return () => clearInterval(id);
}

/* ---------------- CLI ---------------- */
function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'shot') {
  const url = process.argv[3];
  const out = process.argv[4];
  const w = Number(argOf('w', 1280)), h = Number(argOf('h', 720)), dpr = Number(argOf('dpr', 1));
  const wait = argOf('wait', null), evalJs = argOf('eval', null), delay = Number(argOf('delay', 1500));
  const timeout = Number(argOf('timeout', 90000));
  const browser = await launchEdge();
  let code = 0;
  try {
    const { page, errors } = await openPage(browser, url, { width: w, height: h, dpr });
    const stop = keepAlive(page);
    await page.evaluate(() => document.fonts && document.fonts.ready);
    if (wait) await page.waitForFunction(wait, { timeout, polling: 250 });
    if (evalJs) console.log('eval:', JSON.stringify(await page.evaluate(evalJs)));
    await new Promise((r) => setTimeout(r, delay));
    mkdirSync(dirname(resolve(out)), { recursive: true });
    await page.screenshot({ path: out });
    const gpu = await page.evaluate(() => {
      try {
        const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      } catch (e) { return 'unknown'; }
    });
    stop();
    console.log('saved', out, '| gpu:', gpu);
    console.log('errors:', errors.length ? '\n  ' + errors.join('\n  ') : 0);
    if (errors.length) code = 2;
  } catch (e) {
    console.error('shot failed:', e.message); code = 1;
  }
  await browser.close();
  process.exit(code);
}
