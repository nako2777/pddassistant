// 商品页悬浮按钮：点一下推送到管理台
(() => {
  let btn = null;

  function ensureButton() {
    const onGoods = /goods\d*\.html|goods_id=/.test(location.href);
    if (!onGoods) { if (btn) { btn.remove(); btn = null; } return; }
    if (btn && document.body.contains(btn)) return;
    btn = document.createElement('div');
    btn.textContent = '搬到管理台';
    btn.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:120px', 'z-index:2147483647',
      'background:#e05d44', 'color:#fff', 'padding:10px 14px',
      'border-radius:24px', 'font-size:14px', 'font-weight:700',
      'box-shadow:0 2px 10px rgba(0,0,0,.3)', 'cursor:pointer',
      'user-select:none', 'font-family:sans-serif',
    ].join(';');
    btn.onclick = () => {
      btn.textContent = '推送中…';
      chrome.runtime.sendMessage({ type: 'grab' }, (res) => {
        if (res && res.ok) {
          btn.textContent = '✓ 已进采集箱';
          btn.style.background = '#2e7d32';
        } else {
          const err = (res && res.err) || '失败';
          btn.textContent = '✗ ' + err.slice(0, 60);
          btn.title = err;            // 悬停看完整信息
          btn.style.background = '#8d6e63';
          btn.style.maxWidth = '340px';
          btn.style.whiteSpace = 'normal';
          console.warn('[搬到管理台] 推送失败:', err);
        }
        setTimeout(() => {
          if (!btn) return;
          btn.textContent = '搬到管理台';
          btn.style.background = '#e05d44';
          btn.title = '';
          btn.style.maxWidth = '';
          btn.style.whiteSpace = 'nowrap';
        }, 8000);
      });
    };
    document.body.appendChild(btn);
  }

  ensureButton();
  // 拼多多是 SPA，路由变化时重挂按钮
  setInterval(ensureButton, 1500);
})();
