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
    // 拼多多不同页面版本把商品数据塞在不同地方，只认 rawData.store.initDataObj
    // 会在某些商品页直接扑空（实测有的页面就是这样，页面明明加载好了）。
    // 先按已知路径挨个试，都不中就在几个根对象里广度搜「带 goodsName 的对象」。
    const roots = [
      ['window.rawData.store.initDataObj', window.rawData && window.rawData.store
        && window.rawData.store.initDataObj],
      ['window.rawData.initDataObj', window.rawData && window.rawData.initDataObj],
      ['window.rawData', window.rawData],
      ['window.__INITIAL_STATE__', window.__INITIAL_STATE__],
      ['window.__NEXT_DATA__.props.pageProps', window.__NEXT_DATA__
        && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps],
    ];
    // 广度搜：找第一个既有 goodsName 又有 goodsID/skus 的对象，同时把它的
    // 父对象也带出来（mall 信息在父级 initDataObj 上）
    const dig = (root, maxDepth) => {
      const seen = new Set();
      let layer = [{ o: root, parent: null }];
      for (let d = 0; d <= maxDepth && layer.length; d++) {
        const next = [];
        for (const { o, parent } of layer) {
          if (!o || typeof o !== 'object' || seen.has(o)) continue;
          seen.add(o);
          if (o.goodsName && (o.goodsID || o.goodsId || o.goods_id || o.skus)) {
            return { g: o, init: parent || {} };
          }
          for (const k of Object.keys(o)) {
            const v = o[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) next.push({ o: v, parent: o });
          }
        }
        layer = next;
      }
      return null;
    };
    let init = null, g = null, from = '';
    for (const [label, root] of roots) {
      if (!root) continue;
      if (root.goods && root.goods.goodsName) { init = root; g = root.goods; from = label + '.goods'; break; }
      const hit = dig(root, 6);
      if (hit) { init = hit.init; g = hit.g; from = label + '（深搜）'; break; }
    }
    if (!g || !g.goodsName) {
      const needLogin = roots.some(([, r]) => r && r.needLogin)
        || /登录|登錄|log ?in/i.test(String(document.title));
      // 失败时把现场带回去：页面上到底有哪些全局对象，免得只能靠猜
      const present = ['rawData', '__INITIAL_STATE__', '__NEXT_DATA__', '_oak_page_id']
        .filter(k => window[k] != null);
      return {
        err: needLogin ? 'need-login' : 'no-data',
        probe: { globals: present.join(',') || '(一个都没有)',
                 rawDataKeys: window.rawData ? Object.keys(window.rawData).slice(0, 12).join(',') : '',
                 url: location.href.slice(0, 120), title: String(document.title).slice(0, 40) },
      };
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
    // 规格要按维度结构化传回去：服装类常见「颜色 × 尺码」两个维度，
    // 按组合拆会变成几十件（同款刷屏），服务端需要知道哪个维度是尺码才好归并。
    const specPairs = (sk) => {
      const specs = sk.specs || sk.specList || sk.spec_list || [];
      return specs.map(sp => ({
        k: String(sp.spec_key || sp.specKey || sp.key || '').trim(),
        v: String(sp.spec_value || sp.specValue || sp.value || sp.name || '').trim(),
      })).filter(x => x.v);
    };
    const specName = (sk) => specPairs(sk).map(x => x.v).join(' ').trim();
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
      specs: specPairs(sk),
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
      skus, from,
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
        const why = { 'need-login': '拼多多没登录', 'no-data': '页面上没读到商品数据' };
        const p = goods && goods.probe;
        // 页面明明加载好了还是读不到，光说「等加载完再点」没用。
        // 把现场（页面上有哪些全局对象）一起带出来，才好定位是哪个版本的页面。
        const detail = p ? `｜页面上有：${p.globals}`
          + (p.rawDataKeys ? `｜rawData 里：${p.rawDataKeys}` : '') : '';
        sendResponse({ ok: false,
          err: (why[goods && goods.err] || (goods && goods.err) || '提取失败') + detail });
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

// 核查一个商品是否还在。**只在有明确证据时才判下架**——
// 实测普通 fetch 拿到的仍是壳页面（拼多多对非浏览器上下文不给数据），
// 早期版本在"读不到商品名"时默认判下架，把三个在售商品全冤枉了。
// 所以这里开真实标签页读 window.rawData，读不到就老实报 unknown。
async function checkOne(goodsId) {
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://mobile.yangkeduo.com/goods.html?goods_id=${goodsId}`,
      active: false,
    });
    // 等页面把 rawData 填好
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          const s = window.rawData && window.rawData.store;
          const init = s && s.initDataObj;
          if (!init) return { state: 'loading' };
          if (init.needLogin) return { state: 'need-login' };
          const g = init.goods;
          if (g && g.goodsName) return { state: 'alive', name: g.goodsName.slice(0, 20) };
          const txt = (document.body.innerText || '').slice(0, 500);
          if (/已下架|商品不存在|已售罄|停止销售|该商品已下架/.test(txt)) {
            return { state: 'gone', note: '页面提示已下架' };
          }
          return { state: 'loading' };
        },
      });
      if (!result || result.state === 'loading') continue;
      if (result.state === 'alive') return { alive: true, note: result.name };
      if (result.state === 'gone') return { alive: false, note: result.note };
      if (result.state === 'need-login') {
        return { alive: null, note: '拼多多未登录，无法核查' };
      }
    }
    return { alive: null, note: '页面一直没加载出商品数据，无法判断' };
  } catch (e) {
    return { alive: null, note: String(e.message || e).slice(0, 40) };
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
  }
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
