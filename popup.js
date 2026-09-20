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
  const list = [...new Set([custom, ...AUTO].filter(Boolean))];
  say('测试中…');
  // 并发测，逐个报结果，一眼看出是哪条路不通
  const lines = await Promise.all(list.map(async base => {
    try {
      const n = await probe(base);
      return { base, txt: `✓ ${base}（${n} 个账号）`, ok: true };
    } catch (e) {
      const m = String(e.message || e);
      const why = /timed out|aborted/i.test(m) ? '超时'
        : /Failed to fetch|NetworkError/i.test(m) ? '不可达（没权限或网络不通）' : m.slice(0, 24);
      return { base, txt: `✗ ${base} — ${why}`, ok: false };
    }
  }));
  const good = lines.find(l => l.ok);
  $('msg').innerHTML = lines.map(l =>
    `<div class="${l.ok ? 'ok' : 'bad'}">${l.txt}</div>`).join('');
  if (good) await chrome.storage.local.set({ lastGood: good.base });
};

// 显示当前版本，方便确认有没有加载到最新代码
document.addEventListener('DOMContentLoaded', () => {
  const v = chrome.runtime.getManifest().version;
  const el = document.getElementById('ver');
  if (el) el.textContent = 'v' + v;
});
