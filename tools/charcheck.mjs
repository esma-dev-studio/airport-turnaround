/* =========================================================
 * charcheck.mjs — 同形異文字・制御文字の機械検査(コミット前に必ず実行)
 *   キリル文字(e・a・「フ」に似た文字など)・ギリシャ文字・ハングル・生の制御文字・BOM(JS/CSS/HTML)を検出する。
 *   使い方: node tools/charcheck.mjs            … リポジトリ内の全テキストを検査
 *           node tools/charcheck.mjs a.js b.css … 指定ファイルだけ検査
 *   終了コード: 0=問題なし / 1=検出あり
 * ========================================================= */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.md', '.svg', '.txt']);
const SKIP = new Set(['node_modules', '.git', 'vendor', 'shots', 'raw']);
const RANGES = [[0x0370, 0x052F], [0x1100, 0x11FF], [0x3130, 0x318F], [0xAC00, 0xD7AF], [0x200B, 0x200F], [0x2028, 0x2029], [0xFEFF, 0xFEFF],
  [0x0000, 0x0008], [0x000B, 0x000C], [0x000E, 0x001F], [0x007F, 0x007F]];
const isBad = (cp) => RANGES.some(([a, b]) => cp >= a && cp <= b) && cp !== 0x0009;
const vis = (s) => [...s].map((c) => (c.codePointAt(0) < 0x20 ? '?' : c)).join('');

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(extname(name).toLowerCase()) && st.size < 3e6) out.push(p);
  }
  return out;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : walk(ROOT, []);
let hits = 0;
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split(String.fromCharCode(10));
  lines.forEach((line, i) => {
    const chars = [...line];
    chars.forEach((c, k) => {
      const cp = c.codePointAt(0);
      if (cp === 0x000D && k === chars.length - 1) return; // CRLF の CR は許す
      if (!isBad(cp)) return;
      // 絵文字どうしをつなぐ ZWJ(U+200D)は正規の文字なので許す(例: 人+飛行機 = パイロットの絵文字)
      if (cp === 0x200D && k > 0 && chars[k - 1].codePointAt(0) >= 0x1F000) return;
      hits++;
      const ctx = vis(chars.slice(Math.max(0, k - 12), k + 12).join(''));
      console.log(`${relative(ROOT, f)}:${i + 1}:${k + 1}  U+${cp.toString(16).toUpperCase().padStart(4, '0')}  ...${ctx}...`);
    });
  });
}
console.log(hits ? `charcheck: ${hits} 件検出 (${files.length} files)` : `charcheck: OK (${files.length} files)`);
process.exit(hits ? 1 : 0);
