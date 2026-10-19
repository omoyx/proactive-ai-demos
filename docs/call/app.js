import { ConversationMic, blobDataUrl } from '/proactive-ai-demos/memory/audio.js';

const $ = s => document.querySelector(s);
const session = `call-${crypto.randomUUID()}`;
const icons = { contact: 'user-round', event: 'calendar-days', file: 'file-text', note: 'sticky-note', order: 'receipt', id: 'id-card', todo: 'list-todo' };
let cards = [], scripts = [], kinds = {}, shown = [], recalls = [], drafts = [], trace = [];
const seen = new Set();
let speaker = 'peer', previous = '', playing = false, callStart = 0, timer = null, turnQueue = Promise.resolve();

async function api(action, data) {
  const response = await fetch(`/api/call/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, ...data }) });
  const output = await response.json();
  if (!response.ok) throw new Error(output.error || '请求失败');
  return output;
}
async function speech(audio) {
  const response = await fetch('/api/run/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio, language: 'zh', engine: 'paraformer-small' }) });
  const output = await response.json();
  if (!response.ok) throw new Error(output.error || '转写失败');
  return output;
}
const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icon = name => `<i data-lucide="${name}"></i>`;
const paint = () => window.lucide?.createIcons();
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }
const fieldList = fields => Object.keys(fields || {}).length ? `<dl class="fields">${Object.entries(fields).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';

function renderLibrary() {
  $('#card-count').textContent = cards.length;
  const groups = {};
  for (const card of cards) (groups[card.app] ||= []).push(card);
  $('#library').innerHTML = Object.entries(groups).map(([app, list]) => `<div class="group"><h3>${esc(app)}</h3>${list.map(card =>
    `<div class="mini ${shown.includes(card.id) ? 'lit' : ''} ${card.status === 'saved' ? 'new' : ''}" data-id="${card.id}"><b>${esc(card.title)}</b><span>${esc(Object.values(card.fields || {})[0] || card.text)}</span></div>`).join('')}</div>`).join('');
}
function renderAssist() {
  $('#recall-count').textContent = recalls.length;
  $('#recalls').innerHTML = recalls.length ? recalls.map(r => `<article class="card recall" data-id="${r.card.id}">
      <div class="meta"><span>${icon(icons[r.card.kind] || 'square')} ${esc(r.card.app)} · ${esc(kinds[r.card.kind] || '')}</span><em>${r.reason === 'related' ? '与新信息相关' : '对方问到'}</em></div>
      <h4>${esc(r.card.title)}</h4>${fieldList(r.card.fields)}<p>${esc(r.card.text)}</p>
      <div class="why">“${esc(r.trigger)}” · 相似度 ${r.similarity.toFixed(3)} · 突出度 z=${r.z.toFixed(2)}${r.lexical ? ' · 词语命中' : ''}</div></article>`).join('')
    : '<p class="empty">对方问到你手机里已有的信息时，卡片会出现在这里。</p>';
  const visible = drafts.filter(d => d.status !== 'ignored');
  $('#draft-count').textContent = visible.filter(d => d.status === 'draft').length;
  $('#drafts').innerHTML = visible.length ? visible.map(d => `<article class="card draft ${d.status}" data-draft="${d.id}">
      <div class="meta"><span>${icon(icons[d.kind] || 'square')} ${esc(kinds[d.kind] || '备忘')}${d.updates ? ' · 更新已有日程' : ''}</span><em>${d.status === 'saved' ? '已存入' : d.kind_source === 'model' ? 'Julia 建议类型' : '规则识别'}</em></div>
      ${d.status === 'draft' ? `<input value="${esc(d.title)}" aria-label="卡片标题">` : `<h4>${esc(d.title)}</h4>`}
      ${fieldList(d.fields)}<p>原话：“${esc(d.source_quote)}”</p>
      ${d.status === 'draft' ? `<div class="actions"><button class="ok" data-act="save">${d.updates ? '更新日程' : '存入手机'}</button><button data-act="ignore">忽略</button></div>` : ''}</article>`).join('')
    : '<p class="empty">对方说出新时间、号码、取件码等信息时，先存为草稿，由你确认。</p>';
  $('#trace').innerHTML = trace.slice(-30).reverse().map(t => `<div><b>${t.speaker === 'me' ? '我' : '对方'}</b>：${esc(t.text)}<br>
    ${t.recall ? '召回' : ''}${t.recall && t.record ? ' + ' : ''}${t.record ? '记录' : ''}${!t.recall && !t.record ? '不打扰' : ''}
    · 依据 ${t.rules.length ? esc(t.rules.join('、')) : '无规则命中'} · Julia 查找需求 ${t.need == null ? '-' : t.need.toFixed(2)}/2
    · ${t.models.map(m => `${m.model} ${Math.round(m.inference_ms)}ms`).join(' / ')}${t.asr ? ` · ASR ${Math.round(t.asr)}ms` : ''}</div>`).join('');
  // Only cards that just appeared get the entry animation.
  document.querySelectorAll('.card[data-id], .card[data-draft]').forEach(c => { const key = c.dataset.id || c.dataset.draft; if (!seen.has(key)) { c.classList.add('fresh'); seen.add(key); } });
  paint();
}
function peek(items) {
  const box = $('#peek');
  box.innerHTML = items.slice(0, 2).map(x => `<div class="peek-card ${x.rec ? 'rec' : ''}">${icon(x.rec ? 'notebook-pen' : icons[x.kind] || 'sparkles')}<div><b>${esc(x.title)}</b><span>${esc(x.sub)}</span></div></div>`).join('');
  paint(); clearTimeout(peek.t); peek.t = setTimeout(() => (box.innerHTML = ''), 6000);
}
function addLine(who, text, note = '') {
  const line = document.createElement('div');
  line.className = `line ${who} busy`;
  line.innerHTML = `${esc(text)}${note ? `<small>${esc(note)}</small>` : ''}`;
  $('#captions').append(line); $('#captions').scrollTop = 1e6;
  return line;
}

function handleTurn(who, text, line, asr) {
  const prior = previous; previous = text;
  turnQueue = turnQueue.then(async () => {
    try {
      const out = await api('turn', { speaker: who, text, previous: prior, shown });
      line.classList.remove('busy');
      const d = out.decision, items = [];
      if (out.recalls.length) {
        for (const r of out.recalls) {
          if (r.repeat) { document.querySelector(`.card.recall[data-id="${r.card.id}"]`)?.classList.add('pulse'); continue; }
          recalls.unshift({ ...r, trigger: text }); shown.push(r.card.id);
          items.push({ kind: r.card.kind, title: r.card.title, sub: Object.entries(r.card.fields || {}).map(([k, v]) => `${k} ${v}`).join(' · ') });
        }
        const fresh = out.recalls.filter(r => !r.repeat);
        if (fresh.length) line.insertAdjacentHTML('beforeend', `<span class="tag recall">${fresh[0].reason === 'related' ? '相关卡片' : '已召回'}</span>`);
      }
      if (out.draft) {
        drafts.unshift(out.draft);
        items.unshift({ rec: true, title: `记下：${out.draft.title}`, sub: Object.values(out.draft.fields).join(' · ') || '待你确认' });
        line.insertAdjacentHTML('beforeend', '<span class="tag record">已记草稿</span>');
      }
      if (items.length) peek(items);
      trace.push({ speaker: who, text, recall: d.recall, record: d.record, rules: d.rules, need: d.julia_need, models: out.trace.filter(t => !t.cold_start || t.model !== 'embedding'), asr });
      renderAssist(); renderLibrary();
      setTimeout(() => document.querySelectorAll('.card.pulse').forEach(c => c.classList.remove('pulse')), 1000);
    } catch (error) { line.classList.remove('busy'); toast(error.message); }
  });
  return turnQueue;
}

function startCall(name, number) {
  $('#caller').textContent = name; $('#number').textContent = number; $('#avatar').textContent = name.replace(/[^\p{Script=Han}A-Za-z]/gu, '').slice(0, 1) || '?';
  if (!timer) { callStart = Date.now(); timer = setInterval(() => { const s = Math.floor((Date.now() - callStart) / 1000); $('#timer').textContent = `${String(s / 60 | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 500); }
}
function endCall() {
  playing = false; clearInterval(timer); timer = null; mic.stop?.();
  $('#play').classList.remove('stop'); $('#play').innerHTML = `${icon('play')}<span>播放示例通话</span>`; paint();
  const pending = drafts.filter(d => d.status === 'draft').length;
  if (callStart) toast(pending ? `通话结束：还有 ${pending} 张草稿待确认` : '通话结束');
}
function resetCall() { $('#captions').innerHTML = ''; $('#peek').innerHTML = ''; recalls = []; shown = []; drafts = drafts.filter(d => d.status === 'draft'); previous = ''; trace = []; renderAssist(); renderLibrary(); }

const wait = ms => new Promise(r => setTimeout(r, ms));
function play(audio) { return new Promise(resolve => { const a = new Audio(audio); a.onended = resolve; a.onerror = resolve; a.play().catch(resolve); }); }
async function playScript() {
  if (playing) return endCall();
  if (!scripts.length) return toast('正在加载，请稍候');
  const script = scripts.find(s => s.id === $('#script').value);
  resetCall(); playing = true; startCall(script.caller, script.number);
  $('#play').classList.add('stop'); $('#play').innerHTML = `${icon('square')}<span>停止</span>`; paint();
  const voice = $('#mode').value === 'voice';
  if (!voice) {
    for (const [who, text] of script.lines) { if (!playing) break; handleTurn(who, text, addLine(who, text)); await wait(500 + text.length * 170); }
  } else {
    // Fetch every line up front so turns follow each other like a real call; transcription and judgement run behind playback.
    let clips;
    try { toast('正在准备通话语音…'); clips = await Promise.all(script.lines.map(([who, text]) => api('speak', { speaker: who, text, voice: who === 'me' ? 'zhengpaiqingnian' : script.voice }))); $('#toast').hidden = true; }
    catch (error) { toast(error.message); clips = null; }
    for (const [i, [who, text]] of (clips ? script.lines : []).entries()) {
      if (!playing) break;
      const { audio } = clips[i], line = addLine(who, '…', who === 'me' ? '我' : script.caller);
      // Transcription runs during playback, but like a real phone nothing is shown or judged until the sentence ends.
      const ended = play(audio);
      Promise.all([speech(audio), ended]).then(([result]) => {
        const heard = result.result.text?.trim() || text;
        line.firstChild.textContent = heard;
        line.querySelector('small').textContent = `本地转写 ${Math.round(result.inference_ms)}ms${heard !== text ? ` · 脚本原文：${text}` : ''}`;
        handleTurn(who, heard, line, result.inference_ms);
      }).catch(error => { line.remove(); toast(error.message); });
      await ended;
      // Replies come quickly when the speaker changes; the same speaker pauses a little between sentences.
      await wait(script.lines[i + 1]?.[0] === who ? 260 : 120);
    }
  }
  await turnQueue; if (playing) endCall();
}

const mic = new ConversationMic({
  getContext: () => ({ speaker }),
  onSegment: async (blob, context) => {
    const who = context?.speaker || speaker, line = addLine(who, '转写中…');
    try {
      const result = await speech(await blobDataUrl(blob));
      const text = result.result.text?.replace(/<\|[^|]*\|>/g, '').trim();
      if (!text || !/[\p{Script=Han}A-Za-z0-9]/u.test(text)) { line.remove(); return; }
      line.firstChild.textContent = text; handleTurn(who, text, line, result.inference_ms);
    } catch (error) { line.remove(); toast(error.message); }
  },
  onActivity: on => { if (mic.active) $('#mic-state').firstChild.textContent = on ? '正在说话 · 当前说话方：' : '聆听中 · 当前说话方：'; },
  onLevel: () => {}, onError: e => toast(e.message),
  onState: state => { $('#mic').classList.toggle('live', state === 'listening'); if (state !== 'listening') $('#mic-state').firstChild.textContent = '麦克风关闭 · 当前说话方：'; },
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.id === 'play') return playScript();
  if (button.id === 'hangup') return endCall();
  if (button.id === 'speaker') { speaker = speaker === 'peer' ? 'me' : 'peer'; $('#who').textContent = speaker === 'me' ? '我' : '对方'; return; }
  if (button.id === 'mic') {
    if (mic.active) return mic.stop();
    if (!timer) { resetCall(); startCall('现场通话', '麦克风只录到一侧声音，用 ⇄ 切换说话方'); }
    return mic.start();
  }
  const act = button.dataset.act, el = button.closest('[data-draft]');
  if (!act || !el) return;
  const draft = drafts.find(d => d.id === el.dataset.draft);
  if (act === 'ignore') { draft.status = 'ignored'; return renderAssist(); }
  draft.title = el.querySelector('input').value.trim() || draft.title;
  button.disabled = true;
  try {
    const out = await api('save', { card: { ...draft, status: undefined } });
    draft.status = 'saved'; cards = out.cards; renderAssist(); renderLibrary();
    toast(draft.updates ? '日程已更新' : `已存入：${draft.title}`);
  } catch (error) { button.disabled = false; toast(error.message); }
});
$('#say').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('#say-text').value.trim(); if (!text) return;
  if (!timer) { resetCall(); startCall('现场通话', '文字补充'); }
  $('#say-text').value = ''; handleTurn(speaker, text, addLine(speaker, text));
});

(async () => {
  try {
    toast('正在加载本地模型与个人数据…');
    const out = await api('setup', {});
    cards = out.cards; scripts = out.scripts; kinds = out.kinds;
    if (!out.tts) { $('#mode').value = 'text'; $('#mode').options[0].disabled = true; $('#mode').options[0].textContent = '阶跃真实语音（需 STEPFUN_API_KEY）'; }
    $('#script').innerHTML = scripts.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
    renderLibrary(); renderAssist(); $('#toast').hidden = true;
  } catch (error) { toast(error.message); }
})();
