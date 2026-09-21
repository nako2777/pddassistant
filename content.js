// 商品页悬浮按钮：点一下推送到管理台
(() => {
  let btn = null;
  let busy = false;          // 推送进行中，挡住连点
  let resetTimer = null;
  let shownFor = '';         // 按钮上的结果是给哪个商品的

  const goodsId = () => new URLSearchParams(location.search).get('goods_id') || '';
  // 只在商品详情页出按钮。以前只看地址里有没有 goods_id=，评价页
  // （goods_comments.html?goods_id=…）也会冒出按钮来，点了必然读不到数据。
  const onGoodsPage = () => /\/goods\d*\.html$/.test(location.pathname) && !!goodsId();

  function idle() {
    if (!btn) return;
    clearTimeout(resetTimer);
    btn.textContent = '搬到管理台';
    btn.style.background = '#e05d44';
    btn.title = '';
    btn.style.maxWidth = '';
    btn.style.whiteSpace = 'nowrap';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }

  function fail(err) {
    btn.textContent = '✗ ' + err.slice(0, 60);
    btn.title = err;                       // 悬停看完整信息
    btn.style.background = '#8d6e63';
    btn.style.maxWidth = '340px';
    btn.style.whiteSpace = 'normal';
    console.warn('[搬到管理台] 推送失败:', err);
  }

  function ensureButton() {
    if (!onGoodsPage()) { if (btn) { btn.remove(); btn = null; } return; }
    // 拼多多是单页应用：换了商品但按钮上还留着上一件的「✓ 已进采集箱」，
    // 会让人以为这件也推过了
    if (btn && shownFor && shownFor !== goodsId() && !busy) { shownFor = ''; idle(); }
    if (btn && document.body.contains(btn)) return;
    btn = document.createElement('div');
    btn.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:120px', 'z-index:2147483647',
      'background:#e05d44', 'color:#fff', 'padding:10px 14px',
      'border-radius:24px', 'font-size:14px', 'font-weight:700',
      'box-shadow:0 2px 10px rgba(0,0,0,.3)', 'cursor:pointer',
      'user-select:none', 'font-family:sans-serif',
    ].join(';');
    idle();
    btn.onclick = () => {
      // 连点两下会推两次，管理台每次都要先花钱调 AI 翻译才发现是重复的
      if (busy) return;
      busy = true;
      clearTimeout(resetTimer);
      shownFor = goodsId();
      btn.textContent = '推送中…';
      btn.style.opacity = '.7';
      btn.style.cursor = 'wait';
      const done = (res) => {
        busy = false;
        if (!btn) return;                  // 等结果的工夫人已经跳到别的页面，按钮被收走了
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        if (res && res.ok) {
          btn.textContent = '✓ 已进采集箱';
          btn.style.background = '#2e7d32';
        } else {
          fail((res && res.err) || '失败');
        }
        resetTimer = setTimeout(() => { shownFor = ''; idle(); }, 8000);
      };
      try {
        chrome.runtime.sendMessage({ type: 'grab' }, (res) => {
          if (chrome.runtime.lastError) {
            done({ ok: false, err: '扩展没响应：' + chrome.runtime.lastError.message });
          } else done(res);
        });
      } catch (e) {
        // 扩展重新加载/更新之后，已经开着的页面里这份脚本就成了孤儿，
        // sendMessage 会直接抛异常——以前按钮会永远卡在「推送中…」
        done({ ok: false, err: '扩展已更新，请刷新这个页面再点' });
      }
    };
    document.body.appendChild(btn);
  }

  ensureButton();
  // 拼多多是 SPA，路由变化时重挂按钮
  setInterval(ensureButton, 1500);
})();
