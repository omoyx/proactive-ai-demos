import { ConversationMic, blobDataUrl } from '/proactive-ai-demos/memory/audio.js';

const $ = s => document.querySelector(s);
const session = `meeting-${crypto.randomUUID()}`;
// Voiceprints are per meeting: a new run must not match last meeting's speakers.
let voiceSession = `${session}-0`, runs = 0;
const icons = { doc: 'file-text', sheet: 'sheet', slides: 'presentation', pdf: 'file-type', photo: 'images', note: 'sticky-note', event: 'calendar-days', todo: 'handshake', decision: 'gavel' };
const colors = ['#79d3ae', '#ffc78f', '#c3d1ff', '#f5a3c0', '#d7e48a', '#9ee0f0'];
let cards = [], meetings = [], kinds = {}, shown = [], recalls = [], drafts = [], trace = [], uses = [];
let meeting = null, people = [], voiceprints = {}, matches = { ok: 0, total: 0 }, previous = null;
let playing = false, started = 0, timer = null, turnQueue = Promise.resolve(), summarized = false;
const seen = new Set();

async function api(action, data) {
  const response = await fetch(`/api/meeting/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, ...data }) });
  const output = await response.json();
  if (!response.ok) throw new Error(output.error || '请求失败');
  return output;
}
// Every line goes through the same diarization session, so voiceprints stay stable across the meeting.
async function speech(audio) {
  const response = await fetch('/api/run/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio, language: 'zh', engine: 'paraformer-small', diarize: true, session: voiceSession }) });
  const output = await response.json();
  if (!response.ok) throw new Error(output.error || '转写失败');
  const segments = output.result.segments || [];
  const main = [...segments].filter(s => s.speaker_id).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  return { text: output.result.text?.replace(/\n/g, '，').trim(), voiceprint: main?.speaker_id || null, score: main?.match_score, uncertain: !main || main.uncertain, ms: output.inference_ms };
}
const esc = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icon = name => `<i data-lucide="${name}"></i>`;
const paint = () => window.lucide?.createIcons();
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }
const fieldList = (fields, used = []) => Object.keys(fields || {}).length ? `<dl class="fields">${Object.entries(fields).map(([k, v]) => `<dt class="${used.includes(k) ? 'hit' : ''}">${esc(k)}</dt><dd class="${used.includes(k) ? 'hit' : ''}">${esc(v)}</dd>`).join('')}</dl>` : '';
const color = name => colors[Math.max(0, people.indexOf(name)) % colors.length];

function renderLibrary() {
  $('#card-count').textContent = cards.length;
  const groups = {};
  for (const card of cards) (groups[card.app] ||= []).push(card);
  $('#library').innerHTML = Object.entries(groups).map(([app, list]) => `<div class="group"><h3>${esc(app)}</h3>${list.map(card =>
    `<div class="mini ${shown.includes(card.id) ? 'lit' : ''} ${card.status === 'saved' ? 'new' : ''}"><b>${esc(card.title)}</b><span>${esc(Object.values(card.fields || {}).join(' · ') || card.text)}</span></div>`).join('')}</div>`).join('');
}
function renderPeople(talking) {
  const prints = Object.entries(voiceprints);
  $('#people').innerHTML = people.map(name => {
    const print = prints.find(([, v]) => v.name === name);
    return `<span class="person ${talking === name ? 'talking' : ''}" data-person="${esc(name)}"><span class="dot" style="background:${color(name)}">${esc(name.slice(0, 1))}</span>${esc(name.length > 3 ? name.slice(-2) : name)}${print ? `<small>声纹 ${esc(print[1].label)}</small>` : ''}</span>`;
  }).join('') + (matches.total ? `<span class="person stat"><small>声纹与脚本一致 ${matches.ok}/${matches.total}</small></span>` : '');
  $('#say-who').innerHTML = people.map(name => `<option>${esc(name)}</option>`).join('');
}
function renderAssist() {
  $('#recall-count').textContent = recalls.length;
  $('#tally').textContent = `承诺 ${drafts.filter(d => d.kind === 'todo' && d.status !== 'ignored').length} · 文件 ${recalls.length}${uses.length ? ` · 用到 ${uses.length}` : ''}`;
  $('#recalls').innerHTML = recalls.length ? recalls.map(r => `<article class="card recall" data-id="${r.card.id}">
      <div class="meta"><span>${icon(icons[r.card.kind] || 'file')} ${esc(r.card.app)} · ${esc(kinds[r.card.kind] || '')}</span><em>${r.reason === 'related' ? '与承诺相关' : `${esc(r.who)}提到`}</em></div>
      <h4>${esc(r.card.title)}${r.used ? '<span class="badge ok">我用到了</span>' : ''}</h4>${fieldList(r.card.fields, r.used)}<p>${esc(r.card.text)}</p>
      ${r.used ? `<div class="used-by">${icon('check-check')}我说：“${esc(r.usedBy)}”</div>` : ''}
      <div class="why">“${esc(r.trigger)}” · 相似度 ${r.similarity.toFixed(3)} · 突出度 z=${r.z.toFixed(2)}${r.lexical ? ' · 词语命中' : ''}</div></article>`).join('')
    : '<p class="empty">有人提到“上次那份表”“方案第三版”时，相关文件会出现在这里。</p>';
  const visible = drafts.filter(d => d.status !== 'ignored');
  $('#draft-count').textContent = visible.filter(d => d.status === 'draft').length;
  $('#drafts').innerHTML = visible.length ? visible.map(d => `<article class="card draft ${d.kind === 'decision' ? 'decision' : ''} ${d.tentative ? 'tentative' : ''} ${d.status}" data-draft="${d.id}">
      <div class="meta"><span>${icon(icons[d.kind])} ${d.kind === 'decision' ? '决定' : `承诺 · ${esc(d.owner === '?' ? '待确认' : d.owner)}`}${d.tentative ? '<span class="badge">未明确答应</span>' : d.kind === 'todo' ? `<span class="badge ${d.accepted ? 'ok' : ''}">${d.accepted ? '已答应' : '待对方答应'}</span>` : ''}</span><em>${d.status === 'saved' ? '已存入' : '规则识别'}</em></div>
      ${d.status === 'draft' ? `<input value="${esc(d.title)}" aria-label="标题">` : `<h4>${esc(d.title)}</h4>`}
      ${fieldList(d.fields)}<p>原话：“${esc(d.source_quote)}”</p>
      ${d.status === 'draft' ? `<div class="actions"><button class="ok" data-act="save">${d.kind === 'decision' ? '记入决定' : '存为待办'}</button><button data-act="ignore">忽略</button></div>` : ''}</article>`).join('')
    : '<p class="empty">有人说“我来…”“你周一前把…”时，记下负责人与截止时间，等你确认。</p>';
  $('#trace').innerHTML = trace.slice(-40).reverse().map(t => `<div><b>${esc(t.who)}</b>${t.print ? ` <small>声纹 ${esc(t.print)}${t.uncertain ? '（待确认）' : ''}</small>` : ''}：${esc(t.text)}<br>
    ${t.reasons.length ? esc(t.reasons.join('、')) : '不打扰'} · ${t.models.map(m => `${m.model} ${Math.round(m.inference_ms)}ms`).join(' / ') || '无模型调用'}${t.asr ? ` · 转写+声纹 ${Math.round(t.asr)}ms` : ''}</div>`).join('');
  document.querySelectorAll('.card[data-id], .card[data-draft]').forEach(c => { const key = c.dataset.id || c.dataset.draft; if (!seen.has(key)) { c.classList.add('fresh'); seen.add(key); } });
  paint();
}
// The cover screen shows one card at a time in the middle; a turn with two (commitment + its file) shows both in turn.
function peek(items) {
  const box = $('#peek');
  clearTimeout(peek.t);
  const show = (i) => {
    const x = items[i];
    box.innerHTML = `<div class="peek-card ${x.tone}">
      <div class="peek-kind">${icon(x.icon)}<span>${esc(x.label)}</span>${x.badge ? `<em>${esc(x.badge)}</em>` : ''}${items.length > 1 ? `<small>${i + 1}/${items.length}</small>` : ''}</div>
      <b>${esc(x.title)}</b>${x.rows.length ? `<dl>${x.rows.slice(0, 3).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}</div>`;
    paint();
    peek.t = setTimeout(() => (i + 1 < items.length ? show(i + 1) : (box.innerHTML = '')), i + 1 < items.length ? 3500 : 8000);
  };
  show(0);
}
function addLine(who, text, note = '') {
  const line = document.createElement('div');
  line.className = `line ${who === '我' ? 'me' : ''} busy`; line.style.setProperty('--c', color(who));
  line.innerHTML = `<span class="who" style="color:${color(who)}">${esc(who)}</span><span class="text">${esc(text)}</span>${note ? `<small>${esc(note)}</small>` : ''}`;
  $('#captions').append(line);
  while ($('#captions').children.length > 3) $('#captions').firstChild.remove();
  return line;
}
function setWho(line, who) { line.className = `line ${who === '我' ? 'me' : ''} busy`; line.style.setProperty('--c', color(who)); const w = line.querySelector('.who'); w.textContent = who; w.style.color = color(who); }

function handleTurn(who, text, line, extra = {}) {
  turnQueue = turnQueue.then(async () => {
    const prior = previous; previous = { speaker: who, text };
    try {
      const out = await api('turn', { speaker: who, text, people, previous: prior, shown });
      previous.assign = out.assign;
      line.classList.remove('busy');
      const items = [], tags = [];
      for (const r of out.recalls) {
        if (r.repeat) { document.querySelector(`.card.recall[data-id="${r.card.id}"]`)?.classList.add('pulse'); continue; }
        recalls.unshift({ ...r, trigger: text, who }); shown.push(r.card.id);
        items.push({ tone: 'file', icon: icons[r.card.kind] || 'file', label: `${r.reason === 'related' ? '相关' : '提到'}${kinds[r.card.kind] || '文件'}`, title: r.card.title, rows: Object.entries(r.card.fields || {}) });
      }
      if (out.recalls.some(r => !r.repeat)) tags.push('<span class="tag file">文件</span>');
      // "我" quoted a card shown earlier: mark the card, highlight the facts used, and show it again on the cover.
      for (const u of out.uses || []) {
        const r = recalls.find(x => x.card.id === u.card.id); if (!r) continue;
        r.used = [...new Set([...(r.used || []), ...u.facts.map(([k]) => k)])]; r.usedBy = text;
        uses.push({ title: u.card.title, facts: u.facts });
        items.push({ tone: 'used', icon: 'check-check', label: '我用到了', title: u.card.title, rows: u.facts, all: true });
        tags.push(`<span class="tag used">用到 ${esc(u.card.title.replace(/\.\w+$/, ''))}</span>`);
      }
      if (out.draft) {
        drafts.unshift(out.draft);
        const d = out.draft, decision = d.kind === 'decision';
        items.unshift({ tone: decision ? 'decide' : 'commit', icon: icons[d.kind], label: decision ? '决定' : d.owner === '?' ? '承诺 · 负责人待确认' : `${d.owner}的承诺`,
          badge: decision ? '' : d.tentative ? '未明确答应' : d.accepted ? '已答应' : '待答应', title: decision ? d.title : d.task,
          rows: decision ? [['提出', d.fields.提出]] : Object.entries(d.fields).filter(([k]) => k !== '负责人') });
        tags.push(out.draft.kind === 'decision' ? '<span class="tag decide">决定</span>' : `<span class="tag commit">${out.draft.tentative ? '意向' : '承诺'}</span>`);
      }
      if (out.signals.accepts) {
        const task = drafts.find(d => d.kind === 'todo' && (d.owner === who || d.owner === '?') && !d.accepted);
        // An assignment whose name was misheard belongs to whoever says "好的" next.
        if (task) { if (task.owner === '?') { task.owner = who; task.title = `${who}：${task.task}`; task.fields.负责人 = who; task.text = task.text.replace(/^待确认/, who); }
          task.accepted = true; tags.push('<span class="tag commit">已答应</span>'); }
      }
      line.insertAdjacentHTML('beforeend', tags.join(''));
      if (items.length) peek(items);
      trace.push({ who, text, reasons: out.signals.reasons, models: out.trace.filter(t => !t.cold_start), ...extra });
      renderAssist(); renderLibrary();
      setTimeout(() => document.querySelectorAll('.card.pulse').forEach(c => c.classList.remove('pulse')), 1000);
    } catch (error) { line.classList.remove('busy'); toast(error.message); }
  });
  return turnQueue;
}

// Scripted meetings bind each new voiceprint to the line's speaker once, then check later lines against it.
function nameFor(heard, expected) {
  if (!heard.voiceprint) return { who: expected || people[0], note: '声纹未确定' };
  let print = voiceprints[heard.voiceprint];
  if (!print) {
    const label = String.fromCharCode(65 + Object.keys(voiceprints).length);
    const taken = new Set(Object.values(voiceprints).map(v => v.name));
    const name = expected && !taken.has(expected) ? expected : `说话人${label}`;
    print = voiceprints[heard.voiceprint] = { label, name };
    if (!people.includes(name)) people.push(name);
  }
  if (expected) { matches.total++; if (print.name === expected) matches.ok++; }
  return { who: print.name, note: `声纹 ${print.label}${heard.uncertain ? ' 待确认' : ''}${expected && print.name !== expected ? ` · 脚本为${expected}` : ''}` };
}

function syncSeg() {
  document.querySelectorAll('[data-meeting]').forEach(b => b.classList.toggle('on', b.dataset.meeting === $('#script').value));
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === $('#mode').value));
}
function startMeeting(title, place) {
  $('#title').textContent = title.replace(/\s*·.*$/, ''); $('#place').textContent = `Pura X 外屏 · ${place}`; summarized = false; $('#summary').innerHTML = '';
  $('#rec').classList.add('on');
  if (!timer) { started = Date.now(); timer = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); $('#timer').textContent = `${String(s / 60 | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 500); }
}
function resetMeeting(names) {
  $('#captions').innerHTML = ''; $('#peek').innerHTML = ''; recalls = []; shown = []; drafts = []; trace = []; uses = []; previous = null;
  voiceprints = {}; matches = { ok: 0, total: 0 }; voiceSession = `${session}-${++runs}`; people = names; renderPeople(); renderAssist(); renderLibrary();
}
async function endMeeting() {
  playing = false; clearInterval(timer); timer = null; mic.stop?.(); $('#rec').classList.remove('on');
  $('#play').classList.remove('stop'); $('#play').innerHTML = `${icon('play')}<span>播放</span>`; paint();
  await turnQueue;
  if (started && !summarized) renderSummary();
}

function renderSummary() {
  summarized = true;
  const tasks = drafts.filter(d => d.kind === 'todo' && d.status !== 'ignored'), decisions = drafts.filter(d => d.kind === 'decision' && d.status !== 'ignored');
  if (!tasks.length && !decisions.length && !recalls.length) return;
  const owners = {};
  for (const t of tasks) (owners[t.owner] ||= []).push(t);
  const mine = owners['我'] || [];
  $('#summary').innerHTML = `<div class="summary"><h3>${icon('clipboard-list')}会后汇总 · ${esc(meeting?.title || '现场记录')}</h3>
    ${mine.length ? `<h4>我答应的</h4><ul>${mine.map(t => `<li>${esc(t.task)}${t.fields.截止 ? ` <em>${esc(t.fields.截止)}</em>` : ''}</li>`).join('')}</ul>` : ''}
    ${Object.entries(owners).filter(([o]) => o !== '我').map(([o, list]) => `<h4>${esc(o)}</h4><ul>${list.map(t => `<li>${esc(t.task)}${t.fields.截止 ? ` <em>${esc(t.fields.截止)}</em>` : ''}${t.tentative ? ' <em>未明确答应</em>' : !t.accepted ? ' <em>未回应</em>' : ''}</li>`).join('')}</ul>`).join('')}
    ${decisions.length ? `<h4>决定</h4><ul>${decisions.map(d => `<li>${esc(d.title)}</li>`).join('')}</ul>` : ''}
    ${uses.length ? `<h4>我在会上引用的信息</h4><ul>${uses.map(u => `<li>${esc(u.title)} <em>${esc(u.facts.map(([k, v]) => `${k} ${v}`).join('；'))}</em></li>`).join('')}</ul>` : ''}
    ${recalls.length ? `<h4>提到的文件</h4><ul>${[...new Map(recalls.map(r => [r.card.id, r.card])).values()].map(c => `<li>${esc(c.title)}</li>`).join('')}</ul>` : ''}
    <div class="actions"><button class="ok" data-act="memo">存入备忘录</button><button data-act="save-all">全部承诺存为待办</button></div></div>`;
  paint(); $('#summary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function memoText() {
  const tasks = drafts.filter(d => d.kind === 'todo' && d.status !== 'ignored'), decisions = drafts.filter(d => d.kind === 'decision' && d.status !== 'ignored');
  const files = [...new Set(recalls.map(r => r.card.title))];
  return [`${meeting?.title || '现场记录'}（${people.join('、')}）`, ...tasks.map(t => `${t.owner}${t.tentative ? '（未明确）' : ''}：${t.task}${t.fields.截止 ? `，${t.fields.截止}` : ''}`),
    ...decisions.map(d => `决定：${d.title}`), ...uses.map(u => `我引用 ${u.title}：${u.facts.map(([k, v]) => `${k} ${v}`).join('，')}`), files.length ? `提到文件：${files.join('、')}` : ''].filter(Boolean).join('；');
}
async function save(draft) {
  const out = await api('save', { card: { ...draft, status: undefined } });
  draft.status = 'saved'; cards = out.cards;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
function play(audio) { return new Promise(resolve => { const a = new Audio(audio); a.onended = resolve; a.onerror = resolve; a.play().catch(resolve); }); }
async function playMeeting() {
  if (playing) return endMeeting();
  meeting = meetings.find(m => m.id === $('#script').value);
  if (!meeting) return toast('正在加载，请稍候');
  const voice = $('#mode').value === 'voice';
  // Voice mode learns who is who from voiceprints; text mode trusts the script.
  resetMeeting(voice ? [] : Object.keys(meeting.people)); playing = true; startMeeting(meeting.title, meeting.place);
  $('#play').classList.add('stop'); $('#play').innerHTML = `${icon('square')}<span>结束</span>`; paint();
  if (!voice) {
    for (const [who, text] of meeting.lines) { if (!playing) break; renderPeople(who); handleTurn(who, text, addLine(who, text)); await wait(500 + text.length * 150); }
  } else {
    let clips;
    try { toast('正在准备多人语音…'); clips = await Promise.all(meeting.lines.map(([who, text]) => api('speak', { text, voice: meeting.people[who] }))); $('#toast').hidden = true; }
    catch (error) { toast(error.message); clips = null; }
    let order = Promise.resolve();
    for (const [i, [who, text]] of (clips ? meeting.lines : []).entries()) {
      if (!playing) break;
      const line = addLine('…', '正在说…'); renderPeople();
      const heard = speech(clips[i].audio), ended = play(clips[i].audio);
      // A real recorder only transcribes once the speaker pauses, so nothing about a line shows before its audio ends.
      // Voiceprints are bound in speaking order even if transcriptions come back out of order.
      order = order.then(() => Promise.all([heard, ended]).then(([result]) => {
        const { who: name, note } = nameFor(result, who), said = result.text || text;
        setWho(line, name); line.querySelector('.text').textContent = said;
        line.insertAdjacentHTML('beforeend', `<small>${esc(note)} · ${Math.round(result.ms)}ms${said !== text ? ` · 原文：${esc(text)}` : ''}</small>`);
        renderPeople(name);
        handleTurn(name, said, line, { asr: result.ms, print: voiceprints[result.voiceprint]?.label, uncertain: result.uncertain });
      }).catch(error => { line.remove(); toast(error.message); }));
      await ended;
      await wait(meeting.lines[i + 1]?.[0] === who ? 260 : 160);
    }
    await order;
  }
  await turnQueue; if (playing) endMeeting();
}

const mic = new ConversationMic({
  getContext: () => ({}),
  onSegment: async blob => {
    const line = addLine('…', '转写中…');
    try {
      const heard = await speech(await blobDataUrl(blob));
      const text = heard.text?.replace(/<\|[^|]*\|>/g, '').trim();
      if (!text || !/[\p{Script=Han}A-Za-z0-9]/u.test(text)) { line.remove(); return; }
      const { who, note } = nameFor(heard, null);
      setWho(line, who); line.querySelector('.text').textContent = text; line.insertAdjacentHTML('beforeend', `<small>${esc(note)}</small>`);
      renderPeople(who); handleTurn(who, text, line, { asr: heard.ms, print: voiceprints[heard.voiceprint]?.label, uncertain: heard.uncertain });
    } catch (error) { line.remove(); toast(error.message); }
  },
  onActivity: on => { if (mic.active) $('#mic-state').textContent = on ? '有人在说话…' : '聆听中 · 按声纹自动分人，点击名字可改名'; },
  onLevel: () => {}, onError: e => toast(e.message),
  onState: state => { $('#mic').classList.toggle('live', state === 'listening'); if (state !== 'listening') $('#mic-state').textContent = '现场模式按声纹自动分人，点击名字可改名'; },
});

document.addEventListener('click', async event => {
  const person = event.target.closest('[data-person]');
  if (person) {
    const old = person.dataset.person, name = prompt('这位是谁？', old)?.trim();
    if (!name || name === old || !/^[\p{Script=Han}A-Za-z0-9 ·-]{1,12}$/u.test(name)) return;
    people = people.map(p => (p === old ? name : p));
    for (const v of Object.values(voiceprints)) if (v.name === old) v.name = name;
    document.querySelectorAll('.line .who').forEach(w => { if (w.textContent === old) w.textContent = name; });
    return renderPeople();
  }
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.meeting && !playing) { $('#script').value = button.dataset.meeting; meeting = meetings.find(m => m.id === button.dataset.meeting); people = Object.keys(meeting.people); renderPeople(); return syncSeg(); }
  if (button.dataset.mode && !playing) { $('#mode').value = button.dataset.mode; return syncSeg(); }
  if (button.id === 'play') return playMeeting();
  if (button.id === 'end') return endMeeting();
  if (button.id === 'mic') {
    if (mic.active) return mic.stop();
    if (!timer) { meeting = null; resetMeeting(['我']); startMeeting('现场会议', '麦克风录音 · 本机转写与分人'); }
    return mic.start();
  }
  const act = button.dataset.act;
  button.disabled = true;
  try {
    if (act === 'memo') {
      const out = await api('save', { card: { kind: 'note', app: '备忘录', title: `会议纪要 · ${meeting?.title || '现场会议'}`, fields: { 参会: people.join('、') }, text: memoText() } });
      cards = out.cards; renderLibrary(); return toast('会议纪要已存入备忘录，之后可被召回');
    }
    if (act === 'save-all') {
      for (const d of drafts.filter(d => d.status === 'draft')) await save(d);
      renderAssist(); renderLibrary(); return toast('承诺已存为待办');
    }
    const el = button.closest('[data-draft]'); if (!act || !el) return;
    const draft = drafts.find(d => d.id === el.dataset.draft);
    if (act === 'ignore') { draft.status = 'ignored'; return renderAssist(); }
    draft.title = el.querySelector('input').value.trim() || draft.title;
    await save(draft); renderAssist(); renderLibrary(); toast(`已存入：${draft.title}`);
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
$('#say').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('#say-text').value.trim(), who = $('#say-who').value || '我'; if (!text) return;
  if (!timer) { if (!people.length) resetMeeting(['我']); startMeeting(meeting?.title || '现场会议', '文字补充'); }
  $('#say-text').value = ''; renderPeople(who); handleTurn(who, text, addLine(who, text));
});

(async () => {
  try {
    toast('正在加载本地模型与文件…');
    const out = await api('setup', {});
    cards = out.cards; meetings = out.meetings; kinds = out.kinds;
    const voiceBtn = document.querySelector('[data-mode="voice"]');
    if (!out.tts) { voiceBtn.disabled = true; voiceBtn.title = '需要 STEPFUN_API_KEY'; $('#mode').value = 'text'; }
    $('#script-seg').innerHTML = meetings.map(m => `<button type="button" data-meeting="${m.id}" title="${esc(m.title)}">${esc(m.title.replace(/\s*·.*$/, ''))}</button>`).join('');
    $('#script').value = meetings[0].id; syncSeg();
    meeting = meetings[0]; people = Object.keys(meeting.people);
    renderLibrary(); renderPeople(); renderAssist(); $('#toast').hidden = true;
  } catch (error) { toast(error.message); }
})();
