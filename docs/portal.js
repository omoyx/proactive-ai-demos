const { api } = window.PROACTIVE_WEB;
const $ = selector => document.querySelector(selector);
const storage = 'proactive-web-session';
function show(ready) { $('#demos').hidden = !ready; $('#logout').hidden = !ready; $('#login').hidden = ready; }
async function request(path, data, token) {
  const response = await fetch(`${api}${path}`, { method: data ? 'POST' : 'GET', headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '暂时无法连接，请稍后重试');
  return result;
}
$('#login').addEventListener('submit', async event => {
  event.preventDefault(); $('#submit').disabled = true; $('#status').textContent = '正在解锁…';
  try { const { token } = await request('/auth/login', { password: $('#password').value }); sessionStorage.setItem(storage, token); $('#password').value = ''; $('#status').textContent = ''; show(true); }
  catch (error) { $('#status').textContent = error.message === 'Failed to fetch' ? '暂时无法连接，请检查网络后重试' : error.message; }
  finally { $('#submit').disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  const token = sessionStorage.getItem(storage); sessionStorage.removeItem(storage);
  show(false); $('#password').value = ''; $('#status').textContent = ''; $('#password').focus();
  try { await request('/auth/logout', {}, token); } catch {}
});
const token = sessionStorage.getItem(storage);
if (token) request('/auth/me', undefined, token).then(() => show(true)).catch(() => { sessionStorage.removeItem(storage); show(false); });
