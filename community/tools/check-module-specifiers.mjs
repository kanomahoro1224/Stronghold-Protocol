// community/tools/check-module-specifiers.mjs — 纯 Node 静态守卫，不需要浏览器。
//
//   node tools/check-module-specifiers.mjs
//
// 它守住这次 iOS 空页事故的根因：社区站曾经用 <script type="importmap"> 把裸模块名（preact / preact/hooks /
// htm）映射到 /vendor/*.js。import map 需要 Safari/iOS 16.4+，更旧的 iPhone 上它被忽略 ⇒ 裸模块名解析失败 ⇒
// 整个 main.js 不执行 ⇒ 只剩一片深色空页（且完全没有任何提示）。所以：
//   1. public 下任何 import/export 的模块名都必须以 `.` 或 `/` 开头；
//   2. index.html 不许再出现 importmap；
//   3. index.html 必须先用**普通脚本**加载 boot-guard.js，再加载 module，且 main.js 要设置 appReady 标记。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const PUB = path.resolve(new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let checks = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}`);
  else { failed += 1; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const jsFiles = walk(PUB).filter((f) => f.endsWith('.js'));
console.log(`1. 扫描 ${jsFiles.length} 个 js 文件里的模块名`);
{
  // 只认真实语句：行首的 import/export … from '…'（允许换行、遇到 ; 停）、副作用 import '…'、动态 import('…')
  const RE_FROM = /(?:^|\n)[ \t]*(?:import|export)\b(?:[^;'"]|'[^']*'|"[^"]*")*?from[ \t]*(['"])([^'"]+)\1/g;
  const RE_SIDE = /(?:^|\n)[ \t]*import[ \t]*(['"])([^'"]+)\1/g;
  const RE_DYN = /\bimport[ \t]*\([ \t]*(['"])([^'"]+)\1/g;
  const bad = [];
  for (const file of jsFiles) {
    const text = readFileSync(file, 'utf8');
    for (const re of [RE_FROM, RE_SIDE, RE_DYN]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const spec = m[2];
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
          const line = text.slice(0, m.index).split('\n').length;
          bad.push(`${path.relative(PUB, file)}:${line}  "${spec}"`);
        }
      }
    }
  }
  ok('没有裸模块名（全部是 ./ 或 / 开头）', bad.length === 0, bad.slice(0, 5).join(' | '));
  ok('vendor/hooks.module.js 用的是相对地址', /from"\.\/preact\.module\.js"/.test(readFileSync(path.join(PUB, 'vendor/hooks.module.js'), 'utf8')));
}

console.log('2. index.html 不再依赖 import map');
const rawHtml = readFileSync(path.join(PUB, 'index.html'), 'utf8');
// 注释里提到这个标签名是允许的（本文档就在提），只认真实标签。
const html = rawHtml.replace(/<!--[\s\S]*?-->/g, '');
{
  ok('没有 importmap 标签', !/<script[^>]*\btype\s*=\s*["']importmap["']/i.test(html));
  ok('用普通脚本先加载 boot-guard.js', /<script\s+src="\/js\/boot-guard\.js">/.test(html));
  const guardAt = html.indexOf('/js/boot-guard.js');
  const moduleAt = html.indexOf('type="module"');
  ok('boot-guard 在 module 之前', guardAt > -1 && moduleAt > -1 && guardAt < moduleAt);
  ok('没有内联事件处理器（CSP 会拦掉）', !/\son(load|error)\s*=/.test(html));
}

console.log('3. 兜底脚本本身');
{
  const guard = path.join(PUB, 'js', 'boot-guard.js');
  ok('boot-guard.js 存在', existsSync(guard));
  const text = existsSync(guard) ? readFileSync(guard, 'utf8') : '';
  ok('是普通脚本（没有 import/export）', !/(?:^|\n)\s*(?:import|export)\b/.test(text));
  ok('导出 window.__spBootFail', text.includes('window.__spBootFail'));
  const main = readFileSync(path.join(PUB, 'js', 'main.js'), 'utf8');
  ok('main.js 渲染后设置 appReady', text.includes('appReady') && main.includes('dataset.appReady'));
}

console.log(`\n${checks - failed}/${checks} 通过`);
if (failed) process.exitCode = 1;
