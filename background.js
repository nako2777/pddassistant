// 后台：从页面主世界提取 window.rawData 里的商品数据，推送给管理台
// 自动尝试顺序：同机 → Tailscale（异地/不同局域网，走 tailscale serve）→ 同局域网。
// 连不上的地址会立刻 connection refused，不会拖慢。
const DEFAULT_SERVERS = [
  'http://127.0.0.1:8791',
  'http://desktop-ooetfht.tail9ddcd0.ts.net:8791',
  'http://100.72.139.109:8791',
  'http://192.168.3.5:8791',
];

// 在页面主世界执行（能读到 window.rawData）
function extractGoods() {
  try {
    const s = window.rawData && window.rawData.store;
    const init = s && s.initDataObj;
    const g = init && init.goods;
    if (!g || !g.goodsName) {
      return { err: init && init.needLogin ? 'need-login' : 'no-data' };
    }
    const cands = ['minOnSaleGroupPrice', 'minGroupPrice', 'minOnSaleNormalPrice',
                   'minNormalPrice', 'maxOnSaleGroupPrice'];
    let cents = 0;
    for (const k of cands) {
      const v = Number(g[k]);
      if (v > 0 && (!cents || v < cents)) cents = v;
    }
    const gal = [];
    for (const src of [g.topGallery, g.viewImageData, g.detailGallery]) {
      if (!Array.isArray(src)) continue;
      for (const it of src) {
        const u = typeof it === 'string' ? it : (it && (it.url || it.imgUrl));
        if (u && !gal.includes(u)) gal.push(u);
      }
    }
    return {
      goodsId: String(g.goodsID || g.goodsId || g.goods_id ||
        (location.href.match(/goods_id=(\d+)/) || [])[1] || ''),
      name: g.goodsName, cents, images: gal.slice(0, 12),
      mall: (init.mall || {}).mallName || '', desc: g.goodsDesc || '',
      url: location.href.slice(0, 200),
    };
  } catch (e) {
    return { err: 'parse:' + e.message };
  }
}

async function pushToServer(goods) {
  const cfg = await chrome.storage.local.get('server');
  const servers = cfg.server ? [cfg.server, ...DEFAULT_SERVERS] : DEFAULT_SERVERS;
  let lastErr = '';
  for (const base of [...new Set(servers)]) {
    try {
      const r = await fetch(base + '/api', {
        method: 'POST',
        body: JSON.stringify({ action: 'pdd_push', goods }),
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json();
      if (j.ok) return { ok: true, server: base };
      lastErr = j.error || 'server error';
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ok: false, err: '连不上管理台（' + lastErr + '）。确认服务在运行，或点插件图标填服务器地址' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'grab') return;
  (async () => {
    try {
      const [{ result: goods }] = await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id }, world: 'MAIN', func: extractGoods,
      });
      if (!goods || goods.err) {
        const why = { 'need-login': '拼多多没登录', 'no-data': '页面上没读到商品数据（等页面加载完再点）' };
        sendResponse({ ok: false, err: why[goods && goods.err] || (goods && goods.err) || '提取失败' });
        return;
      }
      if (!goods.goodsId) { sendResponse({ ok: false, err: '没拿到商品ID' }); return; }
      const pushed = await pushToServer(goods);
      sendResponse(pushed.ok
        ? { ok: true, msg: `已推送「${goods.name.slice(0, 12)}…」¥${(goods.cents / 100).toFixed(2)}` }
        : { ok: false, err: pushed.err });
    } catch (e) {
      sendResponse({ ok: false, err: e.message });
    }
  })();
  return true;  // 异步 sendResponse
});
