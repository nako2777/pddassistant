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
    // 多规格商品（款式1/款式2…）：煤炉一个链接只能卖一件，所以每个规格
    // 要拆成独立商品。拼多多的字段命名各版本不一，这里几种写法都兼容。
    const rawSkus = g.skus || g.skuList || g.sku_list || [];
    const specName = (sk) => {
      const specs = sk.specs || sk.specList || sk.spec_list || [];
      const parts = [];
      for (const sp of specs) {
        const v = sp.spec_value || sp.specValue || sp.value || sp.name;
        if (v) parts.push(String(v));
      }
      return parts.join(' ').trim();
    };
    const skuPrice = (sk) => {
      for (const k of ['groupPrice', 'group_price', 'normalPrice', 'normal_price',
                       'price', 'skuPrice']) {
        const v = Number(sk[k]);
        if (v > 0) return v;
      }
      return 0;
    };
    const skus = rawSkus.map(sk => ({
      id: String(sk.skuId || sk.sku_id || sk.id || ''),
      name: specName(sk),
      price: skuPrice(sk),
      img: sk.thumbUrl || sk.thumb_url || sk.image || '',
      qty: sk.quantity != null ? Number(sk.quantity) : null,
    })).filter(x => x.id && x.name);

    return {
      goodsId: String(g.goodsID || g.goodsId || g.goods_id ||
        (location.href.match(/goods_id=(\d+)/) || [])[1] || ''),
      name: g.goodsName, cents, images: gal.slice(0, 12),
      mall: (init.mall || {}).mallName || '', desc: g.goodsDesc || '',
      url: location.href.slice(0, 200),
      skus,
      // 万一字段名对不上，把第一个 sku 的键名带回去，日志里一看便知该怎么改
      skuShape: rawSkus.length && !skus.length
        ? Object.keys(rawSkus[0]).slice(0, 25).join(',') : '',
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


// ---------------------------------------------------------------- 原链接核查 ----
// 拼多多不登录时，在售和不存在返回一模一样的壳页面（实测都是 63547 字节），
// 服务端根本查不出来。而这个扩展跑在你已登录的 Chrome 里，带 cookie 去取
// 就能拿到真实的 rawData，所以核查这件事只能放在这边做。
const CHECK_ALARM = 'pdd-linkcheck';

async function checkOne(goodsId) {
  const r = await fetch(
    `https://mobile.yangkeduo.com/goods.html?goods_id=${goodsId}`,
    { credentials: 'include', signal: AbortSignal.timeout(20000) });
  if (!r.ok) return { alive: null, note: 'HTTP ' + r.status };
  const html = await r.text();
  if (/"needLogin"\s*:\s*true/.test(html)) {
    return { alive: null, note: '拼多多未登录，查不了' };
  }
  const m = html.match(/"goodsName"\s*:\s*"([^"]{1,40})/);
  if (m) return { alive: true, note: m[1].slice(0, 20) };
  if (/已下架|商品不存在|该商品已停止销售/.test(html)) {
    return { alive: false, note: '页面显示已下架' };
  }
  // 登录了、也没报下架，却读不到商品名 → 多半是真没了
  return { alive: false, note: '页面上读不到商品信息' };
}

async function runLinkCheck() {
  const diag = [];
  const base = await pickServer(diag);
  if (!base) return;
  let items = [];
  try {
    const r = await fetch(base + '/api', { method: 'POST',
      body: JSON.stringify({ action: 'pdd_check_list' }),
      signal: AbortSignal.timeout(10000) });
    items = (await r.json()).items || [];
  } catch { return; }
  if (!items.length) return;
  const results = [];
  for (const it of items.slice(0, 60)) {
    try {
      const res = await checkOne(it.goodsId);
      results.push({ id: it.id, ...res });
    } catch (e) {
      results.push({ id: it.id, alive: null, note: String(e.message || e).slice(0, 40) });
    }
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));  // 别太快
  }
  try {
    await fetch(base + '/api', { method: 'POST',
      body: JSON.stringify({ action: 'pdd_check_result', results }),
      signal: AbortSignal.timeout(15000) });
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 180, delayInMinutes: 2 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 180, delayInMinutes: 2 });
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === CHECK_ALARM) runLinkCheck();
});
