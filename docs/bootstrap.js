(() => {
  const { api, base } = window.PROACTIVE_WEB;
  const service = document.currentScript.dataset.app;
  const token = sessionStorage.getItem('proactive-web-session');
  const originalFetch = window.fetch.bind(window);
  const expire = () => { sessionStorage.removeItem('proactive-web-session'); location.replace(`${base}?v=live`); };
  if (!token) { document.documentElement.style.visibility = 'hidden'; expire(); return; }
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${token}`);
    const response = await originalFetch(`${api}/${service}${url.pathname}${url.search}`, { ...init, headers });
    if (response.status === 401) expire();
    return response;
  };
  // The original notification page uses EventSource; fetch carries the session in a header.
  class AuthenticatedEvents {
    constructor(path) { this.path = path; this.closed = false; this.connect(); }
    async connect() {
      this.controller = new AbortController();
      try {
        const response = await window.fetch(this.path, { signal: this.controller.signal });
        if (!response.ok || !response.body) throw new Error('流式连接暂不可用');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!this.closed) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) this.onmessage?.(new MessageEvent('message', { data }));
          }
        }
      } catch (error) { if (!this.closed && error.name !== 'AbortError') this.onerror?.(error); }
      if (!this.closed) this.timer = setTimeout(() => this.connect(), 3000);
    }
    close() { this.closed = true; clearTimeout(this.timer); this.controller?.abort(); }
  }
  if (service.startsWith('notification')) window.EventSource = AuthenticatedEvents;
  document.addEventListener('click', async event => {
    if (!event.target.closest('[data-demo-logout]')) return;
    event.preventDefault();
    try { await originalFetch(`${api}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch {}
    expire();
  });
})();
