// 后台：从拼多多商品页取商品数据（逻辑在 extract.js），推送给管理台
// 自动尝试顺序：同机 → Tailscale（异地/不同局域网，走 tailscale serve）→ 同局域网。
// 连不上的地址会立刻 connection refused，不会拖慢。
const DEFAULT_SERVERS = [
  'http://127.0.0.1:8791',
  'http://desktop-ooetfht.tail9ddcd0.ts.net:8791',
  'http://100.72.139.109:8791',
  'http://192.168.3.5:8791',
];

// 在商品页里取数据。真正的逻辑在 extract.js（采集和下架核查共用一份）：
// 先把文件注入页面主世界，再调它挂出来的 window.__mmPddExtract。
// 用 files 注入而不是在 manifest 里声明 content script，是为了对已经开着的
// 旧标签页也生效——装完新版不用挨个刷新页面。
async function runExtract(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', files: ['extract.js'],
  });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => {
      const f = window.__mmPddExtract;
      if (!f) return { err: 'no-extractor' };
      try { delete window.__mmPddExtract; } catch (e) {}     // 用完即删，页面上不留痕迹
      return f();
    },
  });
  return result || { err: 'no-result' };
}

const PROBE_TIMEOUT = 5000;
const PUSH_TIMEOUT = 20000;

// 选一个能用的管理台地址：并发探测，谁先通用谁，并记住下次直接用。
// 记住的地址失效时会自动重新选，所以换网络（家里/异地）不用手动改。
async function pickServer(diag) {
  const cfg = await chrome.storage.local.get(['server', 'lastGood']);
  const probe1 = base => fetch(base + '/api/state', { signal: AbortSignal.timeout(PROBE_TIMEOUT) })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return base; });
  // 自己在设置里填过地址的，先单独试它：并发抢答的话，它会输给碰巧也开着的本机实例
  if (cfg.server) {
    try { return await probe1(cfg.server); }
    catch (e) { diag.push(short(cfg.server) + '=' + reason(e)); }
  }
  const candidates = [...new Set([cfg.lastGood, ...DEFAULT_SERVERS]
    .filter(x => x && x !== cfg.server))];
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
      const goods = await runExtract(sender.tab.id);
      if (!goods || goods.err) {
        const why = { 'need-login': '拼多多没登录', 'no-data': '页面上没读到商品数据',
                      'no-extractor': '取数脚本没注入进去，刷新页面再试',
                      'price-unit': '价格单位认不准，没推（推上去价格可能差一百倍）' };
        const p = goods && goods.probe;
        // 读不到的时候把现场带出来：找到了什么、试了哪几条路、页面上有哪些像数据的变量。
        // 靠这个才定位出「纯客户端渲染页 rawData=null」这个病因的。
        const detail = p ? `｜${p.seen}｜${p.tried}｜疑似数据变量：${p.stores}` : '';
        sendResponse({ ok: false,
          err: (why[goods && goods.err] || (goods && goods.err) || '提取失败') + detail });
        return;
      }
      // 只认数据里明确的下架标记。页面文字里碰巧出现「已下架」不拦——
      // 人正看着这个页面点的按钮，数据也读全了，没道理替他做主不推。
      if (goods.offSale) { sendResponse({ ok: false, err: '这个商品已经下架了，不推' }); return; }
      if (!goods.cents && !(goods.skus || []).some(x => x.price > 0)) {
        sendResponse({ ok: false, err: '读到了商品但没读到价格，不推了（推上去会按最低价挂）' });
        return;
      }
      if (!goods.images || !goods.images.length) {
        sendResponse({ ok: false, err: '读到了商品但一张图都没有，不推了（管理台没图会直接丢弃）' });
        return;
      }
      if (!goods.goodsId) { sendResponse({ ok: false, err: '没拿到商品ID' }); return; }
      const pushed = await pushToServer(goods);
      sendResponse(pushed.ok
        ? { ok: true, msg: `已推送「${String(goods.name).slice(0, 12)}…」¥${(goods.cents / 100).toFixed(2)}` }
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

// 核查一个商品是否还在。**只在有明确证据、且连续两次结论一致时才判下架**——
// 误报的代价是给用户发一封「原链接下架了」的假警报邮件，这事已经发生过一次：
// 早期版本在"读不到商品名"时默认判下架，把三个在售商品全冤枉了。
// 取数走 extract.js，跟采集是同一套逻辑（以前这里只认 window.rawData 一条路径，
// 采集那边适配了新页面它没跟上）。读不到、对不上、没登录，一律老实报 unknown。
async function checkOne(goodsId) {
  let tab;
  try {
    const url = `https://mobile.yangkeduo.com/goods.html?goods_id=${goodsId}`;
    try {
      tab = await chrome.tabs.create({ url, active: false });
    } catch (e) {
      // 没有任何窗口开着（Mac 上关掉最后一个窗口、Chrome 还在后台很常见）：自己开一个不抢焦点的
      const win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
      tab = win.tabs && win.tabs[0];
      if (!tab) throw e;
    }
    let goneVotes = 0, goneNote = '';
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      let r;
      try { r = await runExtract(tab.id); }
      catch (e) { continue; }            // 页面还没提交导航 / 正在跳转，下一轮再试
      // 被带去了验证页、登录页之类的地方：地址里的商品号已经不是要查的那个
      const info = await chrome.tabs.get(tab.id).catch(() => null);
      if (info && info.url && i >= 3) {
        let still = false;
        try {
          const u = new URL(info.url);
          still = /\/goods\d*\.html$/.test(u.pathname) && u.searchParams.get('goods_id') === String(goodsId);
        } catch (e) {}
        if (!still) return { alive: null, note: '页面被带到了别处（登录/验证页？），无法核查' };
      }
      if (r.err === 'need-login') return { alive: null, note: '拼多多未登录，无法核查' };
      if (!r.err && r.goodsId && r.goodsId !== String(goodsId)) continue;   // 不是这件，别信
      const gone = (!r.err && r.offSale) ? '商品数据里的在售标记为否'
        : (r.goneText ? '页面提示：' + r.goneText : '');
      if (gone) {
        goneVotes++; goneNote = gone;
        if (goneVotes >= 2) return { alive: false, note: gone };
        continue;
      }
      goneVotes = 0;
      if (!r.err && r.name) return { alive: true, note: String(r.name).slice(0, 20) };
    }
    return { alive: null, note: goneVotes ? `只有一次迹象显示下架（${goneNote}），不够确定`
                                          : '页面一直没加载出商品数据，无法判断' };
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
  // 每 5 件回传一次：60 件要查十几分钟，service worker 中途被回收的话，
  // 攒到最后一次性回传会把查完的结果全丢掉。
  let results = [];
  const flush = async () => {
    if (!results.length) return;
    const batch = results; results = [];
    try {
      await fetch(base + '/api', { method: 'POST',
        body: JSON.stringify({ action: 'pdd_check_result', results: batch }),
        signal: AbortSignal.timeout(15000) });
    } catch {}
  };
  // 同一个商品拆出来的 20 个款式，原链接是同一个拼多多页面：查一次，结果分给每一行。
  // 挨个查既占满每轮 60 件的额度，又平白多给拼多多的风控递 19 次把柄。
  const byGoods = new Map();
  for (const it of items) {
    if (!byGoods.has(it.goodsId)) byGoods.set(it.goodsId, []);
    byGoods.get(it.goodsId).push(it.id);
  }
  for (const [goodsId, ids] of [...byGoods].slice(0, 60)) {
    let res;
    try { res = await checkOne(goodsId); }
    catch (e) { res = { alive: null, note: String(e.message || e).slice(0, 40) }; }
    for (const id of ids) results.push({ id, ...res });
    if (results.length >= 5) await flush();
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));  // 别太快
  }
  await flush();
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
