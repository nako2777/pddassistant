const AUTO = [
  'http://127.0.0.1:8791',
  'http://desktop-ooetfht.tail9ddcd0.ts.net:8791',
  'http://100.72.139.109:8791',
  'http://192.168.3.5:8791',
];
const $ = id => document.getElementById(id);
const say = (text, cls) => { $('msg').textContent = text; $('msg').className = cls || ''; };

chrome.storage.local.get('server').then(c => { $('server').value = c.server || ''; });

function normalize(v) {
  v = (v || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  return v;
}

async function probe(base) {
  const r = await fetch(base + '/api/state', { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return (j.accounts ? j.accounts.length : 0);
}

$('save').onclick = async () => {
  const addr = normalize($('server').value);
  if (addr) {
    // 自定义地址必须先拿到该域名的访问权限，否则 Chrome 会直接拦掉请求
    let granted = true;
    try {
      granted = await chrome.permissions.request({ origins: [addr + '/*'] });
    } catch (e) { granted = false; }
    if (!granted) { say('没有授予该地址的访问权限，保存取消', 'bad'); return; }
  }
  await chrome.storage.local.set({ server: addr });
  say(addr ? '已保存：' + addr : '已保存（自动选择）', 'ok');
};

$('test').onclick = async () => {
  const custom = normalize($('server').value);
  const list = custom ? [custom, ...AUTO] : AUTO;
  say('测试中…');
  for (const base of list) {
    try {
      const n = await probe(base);
      say(`✓ 连通：${base}（${n} 个账号）`, 'ok');
      return;
    } catch (e) { /* 换下一个 */ }
  }
  say('✗ 都连不上。确认管理台在运行、Tailscale 两端在线；'
      + '自定义地址记得先点「保存」授权', 'bad');
};
