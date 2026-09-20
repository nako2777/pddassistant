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

const PROBE_TIMEOUT = 5000;
const PUSH_TIMEOUT = 20000;

// 选一个能用的管理台地址：并发探测，谁先通用谁，并记住下次直接用。
// 记住的地址失效时会自动重新选，所以换网络（家里/异地）不用手动改。
async function pickServer(diag) {
  const cfg = await chrome.storage.local.get(['server', 'lastGood']);
  const candidates = [...new Set([cfg.server, cfg.lastGood, ...DEFAULT_SERVERS]
    .filter(Boolean))];
  const probes = candidates.map(base =>
    fetch(base + '/api/state', { signal: AbortSignal.timeout(PROBE_TIMEOUT) })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return base;
      })
      .catch(e => {
        diag.push(short(base) + '=' + reason(e));
        throw e;
      }));
  try {
    const good = await Promise.any(probes);
    await chrome.storage.local.set({ lastGood: good });
    return good;
  } catch {
    return null;
  }
}

function short(base) {
  return base.replace(/^https?:\/\//, '').replace(/:8791$/, '')
    .replace(/\.tail\w+\.ts\.net$/, '(tailscale)');
}

function reason(e) {
  const m = String(e && e.message || e);
  if (/timed out|aborted/i.test(m)) return '超时';
  if (/Failed to fetch|NetworkError/i.test(m)) return '不可达';
  return m.slice(0, 20);
}

async function pushToServer(goods) {
  const diag = [];
  const base = await pickServer(diag);
  if (!base) {
    return { ok: false, err: '连不上管理台 [' + diag.join(' ') + ']' };
  }
  try {
    const r = await fetch(base + '/api', {
      method: 'POST',
      body: JSON.stringify({ action: 'pdd_push', goods }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT),
    });
    const j = await r.json();
    if (j.ok) return { ok: true, server: base };
    return { ok: false, err: '管理台拒绝: ' + (j.error || '未知') };
  } catch (e) {
    await chrome.storage.local.remove('lastGood');
    return { ok: false, err: short(base) + ' 推送失败: ' + reason(e) };
  }
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
