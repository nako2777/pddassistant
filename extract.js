// 商品数据提取核心。由 background.js 用 chrome.scripting.executeScript({files, world:'MAIN'})
// 按需注入到拼多多商品页的主世界，挂成 window.__mmPddExtract，采集和下架核查共用。
//
// 为什么单独一个文件：executeScript 的 func 是 toString 序列化后注入的，外面定义的
// 辅助函数带不进页面；而采集和核查必须用同一套找数据的逻辑——以前核查只认
// window.rawData 一条路径，采集那边修了它没跟上，结果在售商品被判成下架。
//
// 只读页面，不改任何东西（不包 fetch、不动 XHR）：拼多多有反爬脚本，
// 改原生函数能被检测到，犯不上拿账号冒险。
(() => {
  const extract = async function () {
    try {
      // 用 URLSearchParams 取，别用 /goods_id=(\d+)/：那个会误中 refer_goods_id= 之类的参数
      const urlId = (new URLSearchParams(location.search).get('goods_id') || '').trim();
      const str = v => (v == null ? '' : String(v));
      const pick = (o, keys) => {
        for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k];
        return undefined;
      };
      const NAME = ['goodsName', 'goods_name'];
      const ID = ['goodsID', 'goodsId', 'goods_id'];
      const SKUS = ['skus', 'skuList', 'sku_list', 'sku'];
      const GALS = ['topGallery', 'top_gallery', 'gallery', 'viewImageData', 'view_image_data',
                    'detailGallery', 'detail_gallery'];

      // ---- 候选收集 ----
      // 同一个页面的内存里可能躺着几十个商品对象：从搜索页点进来时，搜索结果、推荐位
      // 里的商品卡片都带 goods_name + goods_id。只认「第一个像商品的对象」会把别人的
      // 商品推上去，所以全收集起来，goods_id 跟地址栏对不上的一律不要。
      const cands = [];
      const candSet = new Set();               // 同一个商品对象可能被挖到多次，只记一次
      // 记的不是「见过没有」，而是「上次见到它时还剩几层可挖」。
      // 真实的 React 里，根节点 state.element.props 和子 fiber 的 memoizedProps 是同一个对象：
      // 从根挖过来时它已经在第 2 层，够不着第 7 层的商品；要是一见过就拉黑，
      // 等轮到从它自己挖（商品就在第 5 层）的时候反而直接跳过了。
      const seen = new Map();
      let needLoginFlag = false;
      let budget = 400000;                     // 访问对象数上限，防止在巨型状态树里卡死
      const SKIP = { _owner: 1, return: 1, child: 1, sibling: 1, alternate: 1, stateNode: 1,
                     _debugOwner: 1, _debugSource: 1, ownerDocument: 1, parentNode: 1,
                     _reactInternals: 1, _reactInternalFiber: 1, pendingProps: 1, updateQueue: 1 };
      // MobX 4 的 observable 数组不是真数组（Array.isArray 为假），但有 length 和 slice
      // TypedArray 也有 length 和 slice，但那是二进制数据（图片缓存之类），几十 MB 的别去拷
      const asList = v => (Array.isArray(v) ? v
        : (v && typeof v === 'object' && typeof v.length === 'number' && typeof v.slice === 'function'
           && !ArrayBuffer.isView(v)) ? Array.from(v.slice()) : null);
      const isGoods = o => {
        const n = pick(o, NAME);
        return typeof n === 'string' && n.length > 1
          && (pick(o, ID) != null || SKUS.some(k => asList(o[k])));
      };
      const dig = (root, from, maxDepth) => {
        let layer = [{ o: root, parent: null }];
        for (let d = 0; d <= maxDepth && layer.length; d++) {
          const next = [];
          for (const { o, parent } of layer) {
            if (!o || typeof o !== 'object' || budget-- <= 0) continue;
            const left = maxDepth - d;
            if (seen.has(o) && seen.get(o) >= left) continue;   // 上次挖得不比这次浅，才跳过
            seen.set(o, left);
            try {
              if (o.nodeType || o === window) continue;        // DOM 节点 / window 不进
              // 二进制数据（图片缓存之类）直接跳过：光是 Object.keys 一个 30MB 的
              // Uint8Array 就要枚举三千万个下标，页面会卡死好几秒
              if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer) continue;
              if (o.needLogin === true) needLoginFlag = true;   // 没登录时 initDataObj 里只有这一项
              if (isGoods(o) && !candSet.has(o)) {
                candSet.add(o);
                cands.push({ g: o, init: parent || {}, from, depth: d });
              }
              // 拼多多的商品数据存在 MobX store 里，store 自己的可枚举属性未必是数据，
              // 但它有 toJSON()，吐出来的形状跟老页面的 rawData.store 一模一样
              if (typeof o.toJSON === 'function' && !Array.isArray(o)) {
                try {
                  const plain = o.toJSON();
                  if (plain && typeof plain === 'object') next.push({ o: plain, parent });
                } catch (e) {}
              }
              const lst = asList(o);
              const keys = lst ? lst.slice(0, 60).map((_, i) => i) : Object.keys(o);
              for (const k of keys) {
                if (SKIP[k]) continue;
                let v; try { v = o[k]; } catch (e) { continue; }   // 个别 getter 会抛
                if (v && typeof v === 'object') next.push({ o: v, parent: lst ? parent : o });
              }
            } catch (e) { /* 跨域对象之类的，跳过 */ }
          }
          layer = next;
        }
      };
      const matched = () => cands.some(c => urlId && str(pick(c.g, ID)) === urlId && hasDetail(c));
      const skuListOf = c => SKUS.map(k => asList(c.g[k])).concat(SKUS.map(k => asList(c.init[k]))).find(Boolean);
      // 「详情级」数据才算数：列表卡片只有名字、缩略图、价格，没有规格和相册
      const hasDetail = c => !!(skuListOf(c) || GALS.some(k => asList(c.g[k]) || asList(c.init[k])));

      // ---- 来源 1：全局变量（服务端渲染的老页面）----
      for (const k of ['rawData', '__INITIAL_STATE__', '__NEXT_DATA__', '__PRELOADED_STATE__']) {
        if (window[k]) dig(window[k], 'window.' + k, 8);
      }

      // ---- 来源 2：内联脚本（全局变量渲染完被清掉的页面）----
      const BS = String.fromCharCode(92), QT = String.fromCharCode(34);
      const WS = ' ' + String.fromCharCode(10) + String.fromCharCode(13) + String.fromCharCode(9);
      const cutJson = (text, start) => {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (inStr) { if (esc) esc = false; else if (ch === BS) esc = true; else if (ch === QT) inStr = false; continue; }
          if (ch === QT) inStr = true;
          else if (ch === '{') depth++;
          else if (ch === '}' && --depth === 0) {
            try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
          }
        }
        return null;
      };
      const objectsIn = text => {
        const out = []; let from = 0;
        while (out.length < 8) {
          const eq = text.indexOf('=', from); if (eq < 0) break;
          let k = eq + 1;
          while (k < text.length && WS.indexOf(text[k]) >= 0) k++;
          if (text[k] === '{') { const o = cutJson(text, k); if (o) out.push(o); }
          from = eq + 1;
        }
        return out;
      };
      const tried = { scripts: 0, fiber: '' };
      if (!matched()) {
        for (const sc of document.scripts) {
          const t = sc.textContent || '';
          if (t.indexOf('goodsName') < 0 && t.indexOf('goods_name') < 0) continue;
          tried.scripts++;
          for (const o of objectsIn(t)) dig(o, '内联脚本', 8);
        }
      }

      // ---- 来源 3：React 组件内部状态（纯客户端渲染的页面）----
      // 这类页面的数据走接口拿、只存在组件的 props/state 里。实测现场：rawData 不存在、
      // 内联脚本不含 goodsName、重新请求 HTML（47KB）也不含——全局变量和 HTML 里都没有。
      // React 在每个 DOM 节点上挂了 __reactFiber$xxx 指回 fiber，顺着爬到根，
      // 再整棵树扫一遍 memoizedProps / memoizedState。
      if (!matched()) {
        let walked = 0;
        const roots = new Set();
        const els = document.querySelectorAll('body, body *');
        for (let i = 0; i < els.length && i < 1500; i++) {
          const key = Object.keys(els[i]).find(k => k.indexOf('__reactFiber$') === 0
            || k.indexOf('__reactInternalInstance$') === 0 || k.indexOf('__reactContainer$') === 0);
          if (!key) continue;
          let f = els[i][key];
          while (f && f.return) f = f.return;
          // DOM 上缓存的 fiber 可能属于上一轮渲染留下的 alternate 树，current 才是现在这棵
          if (f && f.stateNode && f.stateNode.current) f = f.stateNode.current;
          if (f) roots.add(f);
          if (roots.size >= 4) break;
        }
        if (!roots.size) tried.fiber = '页面上没找到 React';
        else {
          const stack = [...roots];
          while (stack.length && walked < 20000) {
            const f = stack.pop(); walked++;
            if (f.memoizedProps) dig(f.memoizedProps, 'React props', 6);
            // 类组件的 state 是普通对象；函数组件的 hooks 是 memoizedState → next 链表
            let st = f.memoizedState, hops = 0;
            while (st && typeof st === 'object' && hops++ < 60) {
              if ('memoizedState' in st && 'next' in st) { dig(st.memoizedState, 'React hook', 6); st = st.next; }
              else { dig(st, 'React state', 6); break; }
            }
            // redux 一类的 store 挂在 Provider 的 props 上
            const store = f.memoizedProps && f.memoizedProps.store;
            if (store && typeof store.getState === 'function') {
              try { dig(store.getState(), 'redux store', 8); } catch (e) {}
            }
            if (f.sibling) stack.push(f.sibling);
            if (f.child) stack.push(f.child);
          }
          tried.fiber = '扫了 ' + walked + ' 个组件';
        }
      }

      // ---- 选最可信的候选 ----
      const idOf = c => str(pick(c.g, ID));
      // 接口形状里 sku[] 是 goods 的兄弟节点，同一个父级下的任何同号摘要（分享信息之类）
      // 都能沾到 init.sku 的光。所以相册、价格、描述这些「长在自己身上」的才是硬证据，
      // 分不出高下就挑字段多的那个——摘要只有三五个字段，详情有几十个。
      const PRICE_KEYS = ['minOnSaleGroupPriceInCent', 'minGroupPriceInCent',
                          'minOnSaleGroupPrice', 'minGroupPrice', 'minOnSaleNormalPrice', 'minNormalPrice',
                          'maxOnSaleGroupPrice', 'min_on_sale_group_price', 'min_group_price',
                          'min_on_sale_normal_price', 'min_normal_price', 'max_on_sale_group_price'];
      const score = c => (skuListOf(c) && skuListOf(c).length ? 100 : 0)
        + (GALS.some(k => asList(c.g[k])) ? 30 : 0)
        + (PRICE_KEYS.some(k => Number(c.g[k]) > 0) ? 10 : 0)
        + (pick(c.g, ['goodsDesc', 'goods_desc']) ? 5 : 0)
        + Math.min(Object.keys(c.g).length, 60) / 100 - c.depth / 1000;
      // 地址栏有 goods_id 就必须对上；地址栏没有（极少见）才退而求其次
      const usable = cands.filter(c => hasDetail(c) && (urlId ? idOf(c) === urlId : true));
      usable.sort((a, b) => score(b) - score(a));
      const best = usable[0];

      // 「商品已下架」通常是底部那条固定栏里的一行短字，排在 DOM 末尾，只看开头会漏；
      // 而长文本（评价、详情）里碰巧出现这几个字不算数，所以只认不到 20 字的短行。
      const GONE_RE = /商品已下架|该商品已下架|商品不存在|商品已被删除|已停止销售/;
      const goneLine = str(document.body && document.body.innerText).split(String.fromCharCode(10))
        .map(l => l.trim()).find(l => l.length > 0 && l.length < 20 && GONE_RE.test(l)) || '';
      const goneText = goneLine ? (goneLine.match(GONE_RE) || [''])[0] : '';

      if (!best) {
        // 标题里带 login 的商品（"…login tee"）数据还没加载完时，光看标题会误报未登录
        const onGoodsPath = /[/]goods[0-9]*[.]html$/.test(location.pathname || '');
        const needLogin = needLoginFlag
          || (!onGoodsPath && /登录|登錄|log ?in/i.test(str(document.title)));
        const sameId = cands.filter(c => urlId && idOf(c) === urlId);
        let seenMsg = '一个商品对象都没找到';
        if (sameId.length) {
          // id 对上了但只有列表卡片那种摘要：把它的字段名带回去，好补字段映射
          seenMsg = '找到当前商品但只有摘要（没有规格/相册）。字段：'
            + Object.keys(sameId[0].g).slice(0, 24).join(',')
            + '｜父级：' + Object.keys(sameId[0].init).slice(0, 16).join(',');
        } else if (cands.length) {
          seenMsg = '找到 ' + cands.length + ' 个商品对象，但 goods_id 都不是 ' + urlId
            + '（是 ' + [...new Set(cands.map(idOf))].slice(0, 4).join(',') + '）';
        }
        return {
          err: needLogin ? 'need-login' : 'no-data',
          goneText,
          probe: {
            url: location.href.slice(0, 120), title: str(document.title).slice(0, 40),
            seen: seenMsg,
            tried: '内联脚本含商品名的 ' + tried.scripts + ' 个｜React:' + (tried.fiber || '没用上'),
            stores: Object.keys(window).filter(k => /data|state|store|init|props/i.test(k)
              && window[k] && typeof window[k] === 'object').slice(0, 10).join(',') || '(无)',
          },
        };
      }

      // ---- 统一字段：老页面是 camelCase，接口响应是 snake_case，两套都认 ----
      const g = best.g, init = best.init;
      const rawSkus = skuListOf(best) || [];

      // 价格单位在这里定死，统一发整数「分」给服务端。**逐个值判断，不搞整页一刀切**：
      //   · 字符串（"19.3"、"46"、"128"）= 元。老页面/MobX store 里的价格是格式化好的元；
      //   · 数字带小数 = 元；数字整数 = 分（接口给的 1930，以及实测见过的 4760、990）；
      //   · 键名以 InCent 结尾的 = 分，不管什么类型。
      // 同一件商品里「45.9 元」和「4760 分」确实会同时出现，整页统一换算必错一个；
      // 而只靠大小猜（<100 算元）会把 "128" 元当成 1.28 元，直接按地板价挂出去。
      const SKU_PRICE_KEYS = ['groupPrice', 'group_price', 'normalPrice', 'normal_price', 'price', 'skuPrice'];
      const toFen = (v, key) => {
        const n = Number(v);
        if (!(n > 0)) return 0;
        if (/InCent$/.test(str(key))) return Math.round(n);
        const yuan = typeof v === 'string' || n % 1 !== 0;
        return Math.round(yuan ? n * 100 : n);
      };
      const goodsFens = [];
      for (const bag of [g, init, init.price, g.price]) {
        if (!bag || typeof bag !== 'object') continue;
        for (const k of PRICE_KEYS) { const f = toFen(bag[k], k); if (f) goodsFens.push(f); }
      }
      const skuFen = sk => { for (const k of SKU_PRICE_KEYS) { const f = toFen(sk && sk[k], k); if (f) return f; } return 0; };
      const skuFens = rawSkus.map(skuFen).filter(Boolean);
      const cents = (goodsFens.length ? goodsFens : skuFens).reduce((a, b) => (a && a < b ? a : b), 0);
      // 验算：规格价和商品最低价差出两个数量级，只可能是单位认错了。
      // 宁可报错让人来看，也不能把一个错一百倍的价格悄悄推上去。
      const off = skuFens.find(f => cents && (f / cents > 60 || f / cents < 0.5));
      if (off) {
        return { err: 'price-unit', probe: { url: location.href.slice(0, 120), title: '', stores: '',
          seen: '价格单位对不上：商品最低价 ' + cents + ' 分，却有规格价 ' + off + ' 分',
          tried: '原始值 商品:' + [g, init.price].filter(Boolean).map(bag => PRICE_KEYS.filter(k => bag[k] != null)
            .map(k => k + '=' + JSON.stringify(bag[k])).join(',')).filter(Boolean).join(';').slice(0, 160)
            + ' 规格:' + rawSkus.slice(0, 3).map(sk => SKU_PRICE_KEYS.filter(k => sk && sk[k] != null)
              .map(k => k + '=' + JSON.stringify(sk[k])).join(',')).join(';').slice(0, 120) } };
      }

      const gal = [];
      const fixUrl = u => (u.indexOf('//') === 0 ? 'https:' + u : u);   // 协议相对地址服务端下不动
      const addImgs = src0 => {
        let src = asList(src0);
        if (!src) return;
        if (src.some(it => it && typeof it === 'object' && it.type != null)) {
          const top = t => (t === 1 || t === 13 ? 0 : 1);
          src = src.filter(it => it && it.type !== 6 && it.type !== 9)
            .sort((a, b) => top(a.type) - top(b.type) || (a.priority || 0) - (b.priority || 0));
        }
        for (const it of src) {
          let u = typeof it === 'string' ? it : (it && (it.url || it.imgUrl || it.img_url));
          if (!u || typeof u !== 'string') continue;
          u = fixUrl(u);
          if (gal.indexOf(u) < 0) gal.push(u);
        }
      };
      for (const k of GALS) { addImgs(g[k]); addImgs(init[k]); }
      if (!gal.length) {
        const t = pick(g, ['hdThumbUrl', 'hd_thumb_url', 'thumbUrl', 'thumb_url']);
        if (t) gal.push(fixUrl(str(t)));
      }

      const specPairs = sk => (asList(sk.specs || sk.specList || sk.spec_list || sk.spec) || [])
        .filter(Boolean).map(sp => ({
          k: str(sp.spec_key || sp.specKey || sp.key).trim(),
          v: str(sp.spec_value || sp.specValue || sp.value || sp.name).trim(),
        })).filter(x => x.v);
      const skus = rawSkus.filter(Boolean).map(sk => ({
        id: str(sk.skuId || sk.sku_id || sk.skuID || sk.id),
        name: specPairs(sk).map(x => x.v).join(' ').trim(),
        specs: specPairs(sk),
        price: skuFen(sk),
        img: fixUrl(str(sk.thumbUrl || sk.thumb_url || sk.image || '')),
        qty: sk.quantity != null ? Number(sk.quantity) : null,
      })).filter(x => x.id && x.name);

      const mallBags = [init.mall, g.mall, init.mall_entrance && init.mall_entrance.mall_data,
                        init.mallEntrance && init.mallEntrance.mallData].filter(Boolean);
      // 下架标记：老页面/接口在商品下架后仍会带着完整的 goods 对象，光看「有商品名」会误判在售
      // 真实页面上的在售标记有好几个（实测：isOnSale=true, isGoodsOnSale=true, status=1），
      // 任何一个明确为否就算下架；全是「是」才算明确在售
      const flags = ['isOnSale', 'isGoodsOnSale', 'isOnsale', 'is_onsale', 'is_on_sale', 'is_goods_on_sale']
        .map(k => g[k]).filter(v => v != null);
      const isNo = v => v === false || v === 0 || v === '0';
      const saleFlag = flags.length ? !flags.some(isNo) : undefined;
      return {
        goodsId: str(pick(g, ID) || urlId),
        name: str(pick(g, NAME)), cents, images: gal.slice(0, 20),
        mall: str(mallBags.map(m => m.mallName || m.mall_name).find(Boolean) || ''),
        desc: str(pick(g, ['goodsDesc', 'goods_desc']) || '').slice(0, 4000),
        // 存干净的地址。拼多多会自动往地址栏里加 uin=（账号标识）和一堆来源追踪参数，
        // 这些没必要跟着商品记录存一辈子，核查下架时也只需要商品号
        url: location.origin + location.pathname + '?goods_id=' + str(pick(g, ID) || urlId),
        skus, from: best.from,
        offSale: saleFlag === false,
        // 数据里明确标着在售，页面文字里碰巧出现「已下架」就不算数
        goneText: saleFlag === true ? '' : (goneText || str(g.statusExplain).slice(0, 20)),
        // 万一规格字段名对不上，把第一个 sku 的键名带回去，日志里一看便知该怎么改。
        // 单规格商品（sku 没有 specs）不算对不上，别误报。
        skuShape: rawSkus.length > 1 && !skus.length ? Object.keys(rawSkus[0]).slice(0, 25).join(',') : '',
      };
    } catch (e) {
      return { err: 'parse:' + e.message };
    }
  };
  try {
    Object.defineProperty(window, '__mmPddExtract', { value: extract, configurable: true, enumerable: false });
  } catch (e) { window.__mmPddExtract = extract; }
})();
