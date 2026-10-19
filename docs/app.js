'use strict';
const $ = (selector) => document.querySelector(selector);
const player = $('#player');
let manifest, key, selected = 0, videoURL, controller, generation = 0;
let posterURLs = [];
const b64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

async function derive(password, kdf) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(kdf.salt), iterations: kdf.iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

async function decrypt(asset, cryptoKey, signal) {
  const response = await fetch(asset.file, { signal });
  if (!response.ok) throw new Error('NETWORK');
  const data = await response.arrayBuffer();
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(asset.iv), additionalData: new TextEncoder().encode(asset.aad) }, cryptoKey, data);
}

function videoStatus(message, retry = false) {
  const status = $('#video-status');
  status.replaceChildren(document.createTextNode(message));
  status.hidden = !message;
  if (retry) {
    const button = document.createElement('button');
    button.textContent = '重试';
    button.addEventListener('click', () => selectVideo(selected));
    status.append(button);
  }
}

async function selectVideo(index) {
  selected = index;
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const cryptoKey = key;
  const video = manifest.videos[index];
  player.pause();
  player.removeAttribute('src');
  player.load();
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = undefined;
  player.poster = posterURLs[index] || '';
  $('#playing-kicker').textContent = `SCENE 0${index + 1} / DEMO FILM`;
  $('#playing-title').textContent = video.title;
  $('#playing-description').textContent = video.description;
  $('#playing-duration').textContent = time(video.duration);
  $('#journey').replaceChildren();
  video.steps.forEach((step, position) => {
    if (position) { const arrow = document.createElement('i'); arrow.textContent = '→'; arrow.setAttribute('aria-hidden', 'true'); $('#journey').append(arrow); }
    const item = document.createElement('span'); item.textContent = step; $('#journey').append(item);
  });
  document.querySelectorAll('.video-card').forEach((card, position) => card.setAttribute('aria-pressed', String(position === index)));
  videoStatus('正在准备视频…');
  try {
    const clear = await decrypt(video.video, cryptoKey, signal);
    if (generation !== current) return;
    videoURL = URL.createObjectURL(new Blob([clear], { type: 'video/mp4' }));
    player.src = videoURL;
    player.load();
    videoStatus('');
  } catch (error) {
    if (generation === current && error.name !== 'AbortError') videoStatus('视频暂时未能加载，请检查网络后重试。', true);
  }
}

function renderList() {
  $('#video-list').replaceChildren();
  manifest.videos.forEach((video, index) => {
    const button = document.createElement('button');
    button.className = 'video-card';
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    const top = document.createElement('span'); top.className = 'card-top';
    const number = document.createElement('span'); number.textContent = `0${index + 1} / 场景`;
    const duration = document.createElement('span'); duration.textContent = time(video.duration);
    top.append(number, duration);
    const image = document.createElement('img'); image.className = 'card-poster'; image.alt = ''; image.src = posterURLs[index];
    const title = document.createElement('span'); title.className = 'card-title'; title.textContent = video.title;
    const subtitle = document.createElement('span'); subtitle.className = 'card-subtitle'; subtitle.textContent = video.subtitle;
    button.append(top, image, title, subtitle);
    button.addEventListener('click', () => selectVideo(index));
    $('#video-list').append(button);
  });
}

$('#unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('#unlock').disabled) return;
  $('#unlock').disabled = true;
  $('#gate-status').textContent = '正在解锁…';
  const password = $('#password').value;
  let verified = false;
  try {
    if (!crypto.subtle) throw new Error('UNSUPPORTED');
    const response = await fetch('manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('NETWORK');
    manifest = await response.json();
    const candidate = await derive(password, manifest.kdf);
    const check = await decrypt(manifest.check, candidate);
    if (new TextDecoder().decode(check) !== 'AI OS video gallery v1') throw new Error('INVALID');
    verified = true;
    key = candidate;
    posterURLs = await Promise.all(manifest.videos.map(async (video) => URL.createObjectURL(new Blob([await decrypt(video.poster, key)], { type: 'image/jpeg' }))));
    $('#password').value = '';
    $('#gate-status').textContent = '';
    renderList();
    $('#gate').hidden = true;
    $('#gallery').hidden = false;
    $('#lock').focus({ preventScroll: true });
    await selectVideo(0);
  } catch (error) {
    key = undefined;
    posterURLs.forEach((url) => URL.revokeObjectURL(url)); posterURLs = [];
    $('#gate-status').textContent = error.message === 'UNSUPPORTED' ? '请使用支持安全播放的新版浏览器打开。' : !verified && error.name === 'OperationError' ? '密码不正确，请重新输入。' : '暂时未能加载，请检查网络后重试。';
    if (!verified && error.name === 'OperationError') $('#password').select();
  } finally {
    $('#unlock').disabled = false;
  }
});

player.addEventListener('error', () => {
  if (player.getAttribute('src')) videoStatus('浏览器暂时无法播放此视频，请重试或换用新版浏览器。', true);
});

$('#lock').addEventListener('click', () => {
  generation++;
  controller?.abort();
  player.pause(); player.removeAttribute('src'); player.removeAttribute('poster'); player.load();
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = undefined;
  posterURLs.forEach((url) => URL.revokeObjectURL(url)); posterURLs = [];
  key = undefined;
  $('#video-list').replaceChildren();
  $('#gallery').hidden = true;
  $('#gate').hidden = false;
  $('#password').value = '';
  $('#password').focus();
  window.scrollTo(0, 0);
});
