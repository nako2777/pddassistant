chrome.storage.local.get('server').then(c => {
  document.getElementById('server').value = c.server || '';
});
document.getElementById('save').onclick = async () => {
  await chrome.storage.local.set({ server: document.getElementById('server').value.trim() });
  document.getElementById('ok').textContent = '已保存';
  setTimeout(() => document.getElementById('ok').textContent = '', 1500);
};
