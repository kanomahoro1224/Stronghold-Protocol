// community/public/js/boot-guard.js — 一个**普通脚本**（不是 module），所以即使整个模块图都没跑起来它也一定会执行。
//
// 为什么需要它：社区站是纯前端渲染，页面本身只有 <div id="app"></div>。旧 iPhone（iOS 16.4 以下不支持
// import map）或任何模块加载失败时，用户看到的是「一片深色空页」——既不知道坏了，也不知道为什么。
// 这里把任何启动失败变成页面上看得见的一句话，附带 UA，方便客服一眼定位。
//
// 依赖：main.js 渲染成功后设置 document.documentElement.dataset.appReady = '1'。
(function () {
  var shown = false;

  function ready() { return document.documentElement.dataset.appReady === '1'; }

  function show(reason, detail) {
    if (shown || ready()) return;
    shown = true;
    var box = document.getElementById('boot-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'boot-error';
      box.setAttribute('style', 'position:fixed;left:0;right:0;top:0;padding:14px 16px;' +
        'background:#3a1414;color:#ffd7d7;font:14px/1.6 -apple-system,system-ui,sans-serif;' +
        'z-index:99999;white-space:pre-wrap;word-break:break-all');
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = '页面脚本没能启动（' + reason + '）。\n' +
      '如果这台 iPhone / iPad 的系统低于 iOS 16.4，请先更新系统；也可以换用 Chrome 或电脑浏览器打开。\n' +
      (detail ? '详情：' + detail + '\n' : '') +
      'UA：' + navigator.userAgent;
  }

  window.__spBootFail = show;

  // 模块加载 / 解析失败：资源级错误不冒泡，但会在 window 上以捕获阶段触发。
  window.addEventListener('error', function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === 'SCRIPT' || tag === 'LINK') return show('资源加载失败', (e.target.src || e.target.href || ''));
    if (e.filename) return show('脚本错误', e.message + ' @ ' + e.filename + ':' + e.lineno);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    show('脚本异常', (e.reason && (e.reason.message || e.reason)) || '');
  });

  // 模块图整体 link 失败时，有的浏览器既不报 error 也不 reject —— 用「#app 一直是空的」兜底。
  window.setTimeout(function () {
    var app = document.getElementById('app');
    if (app && app.childElementCount === 0) show('8 秒内没有渲染出任何内容');
  }, 8000);
})();
