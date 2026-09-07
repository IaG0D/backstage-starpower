import { DIFFICULTIES } from './lib/parser.js';

const $ = id => document.getElementById(id);
const number = n => Math.round(n).toLocaleString('pt-BR');
const clock = n => { const ticks = Math.round(n * 100); return `${Math.floor(ticks / 6000).toString().padStart(2, '0')}:${((ticks % 6000) / 100).toFixed(2).padStart(5, '0')}`; };
const laneNames = ['verde', 'vermelha', 'amarela', 'azul', 'laranja', 'aberta'];
let worker, request = 0, metadata, result, demo = false;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function busy(value) {
  $('results').setAttribute('aria-busy', String(value));
  $('cancel').hidden = !value;
  for (const id of ['instrument', 'difficulty', 'analyze']) $(id).disabled = value || !metadata;
  for (const input of document.querySelectorAll('input[name="mode"], #whammy')) input.disabled = value;
}
function clear() {
  result = null;
  $('output').hidden = true;
  $('empty').hidden = false;
}
function fail(message) { clear(); busy(false); status(message, true); }
function makeWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.id !== request) return;
    if (data.type === 'error') { fail(data.message); return; }
    if (data.type === 'loaded') {
      metadata = data;
      $('song-title').textContent = data.title;
      $('result-kind').textContent = demo ? 'DEMONSTRAÇÃO · CHART ORIGINAL' : 'SEU CHART · PROCESSADO LOCALMENTE';
      $('instrument').replaceChildren(...[...new Set(data.tracks.map(t => t.instrument))].map(x => new Option(x, x)));
      if (data.tracks.some(t => t.instrument === 'Guitarra')) $('instrument').value = 'Guitarra';
      difficulties();
      calculate();
    } else if (data.type === 'result') {
      result = data.result;
      render();
      busy(false);
      status('Rota pronta. Use os horários e as notas abaixo como referência de treino.');
    }
  };
  worker.onerror = event => { event.preventDefault(); fail('Não foi possível processar o chart. Tente importar novamente.'); };
}
async function load(file, isDemo = false) {
  request++;
  const id = request;
  metadata = null; demo = isDemo; clear(); makeWorker(); busy(true);
  $('filename').textContent = file.name;
  $('song-title').textContent = file.name;
  $('song-subtitle').textContent = '';
  status('Lendo as trilhas do chart…');
  try {
    if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Escolha um arquivo não vazio de até 20 MB.');
    const buffer = await file.arrayBuffer();
    if (id !== request) return;
    worker.postMessage({ type: 'load', id, filename: file.name, buffer }, [buffer]);
  } catch (error) { if (id === request) fail(error.message); }
}
function difficulties() {
  const previous = $('difficulty').value;
  const options = DIFFICULTIES.filter(d => metadata.tracks.some(t => t.instrument === $('instrument').value && t.difficulty === d));
  $('difficulty').replaceChildren(...options.map(x => new Option(x, x)));
  if (options.includes(previous)) $('difficulty').value = previous;
}
function calculate() {
  if (!metadata) return;
  clear(); busy(true);
  const track = metadata.tracks.find(t => t.instrument === $('instrument').value && t.difficulty === $('difficulty').value);
  $('song-subtitle').textContent = [metadata.artist, track.instrument, track.difficulty].filter(Boolean).join(' · ');
  status('Comparando guardar e ativar ao longo do chart…');
  worker.postMessage({ type: 'analyze', id: ++request, track: track.id,
    mode: document.querySelector('input[name="mode"]:checked').value, whammy: $('whammy').checked });
}
function cue(a) { return `Nota ${number(a.note)} · ${a.lanes.map(l => laneNames[l]).join(' + ')}${a.beforeNote > .01 ? ` · ${a.beforeNote.toFixed(2)}s antes` : ''}`; }
function render() {
  $('empty').hidden = true; $('output').hidden = false;
  $('score').textContent = number(result.estimated);
  $('score-gain').textContent = `+${number(result.bonus)} com especial · estimativa`;
  $('activation-count').textContent = result.activations.length.toString().padStart(2, '0');
  $('phrase-count').textContent = `${result.phrases} frases disponíveis`;
  $('note-count').textContent = number(result.noteCount);
  $('duration').textContent = `${clock(result.duration)} até a última nota / sustain`;
  $('route').replaceChildren();
  if (!result.activations.length) {
    const item = document.createElement('li'); item.textContent = 'Sem ativação disponível: é preciso obter ao menos meia barra antes das notas que vão pontuar.';
    $('route').append(item);
  }
  for (const [i, a] of result.activations.entries()) {
    const item = document.createElement('li'); item.className = 'route-item';
    const badge = document.createElement('span'); badge.className = 'route-num'; badge.textContent = `${i + 1}`;
    const time = document.createElement('div'), strong = document.createElement('strong'), small = document.createElement('small');
    time.className = 'route-time'; strong.textContent = clock(a.time); small.textContent = `Compasso ${a.measure} · até ${clock(a.endTime)}`; time.append(strong, small);
    const reference = document.createElement('div'); reference.className = 'route-cue';
    const note = document.createElement('strong'), frets = document.createElement('small');
    note.textContent = `Nota ${number(a.note)}`;
    frets.textContent = a.lanes.map(l => laneNames[l]).join(' + ') + (a.beforeNote > .01 ? ` · ${a.beforeNote.toFixed(2)}s antes` : ''); reference.append(note, frets);
    const energy = document.createElement('div'); energy.className = 'route-energy';
    const percent = document.createElement('strong'), detail = document.createElement('small');
    percent.textContent = `${Math.round(a.energy * 100)}% de barra`; detail.textContent = `+${number(a.bonus)} pts estimados`; energy.append(percent, detail);
    item.append(badge, time, reference, energy); $('route').append(item);
  }
  $('warnings').replaceChildren(...result.warnings.map(w => { const p = document.createElement('p'); p.textContent = w; return p; }));
  $('warnings').hidden = !result.warnings.length;
  draw();
}
function plot(ctx, width, height, offset = 0) {
  const left = 32, right = width - 14, top = offset + 35, bottom = offset + height - 35;
  const x = t => left + t / Math.max(1, result.duration) * (right - left);
  ctx.fillStyle = '#131610'; ctx.fillRect(0, offset, width, height);
  for (const [i, a] of result.activations.entries()) {
    ctx.fillStyle = '#e2c17a26'; ctx.fillRect(x(a.time), top - 20, Math.max(2, x(a.endTime) - x(a.time)), bottom - top + 32);
    ctx.fillStyle = '#e2c17a'; ctx.font = 'bold 11px Segoe UI, sans-serif'; ctx.fillText(`${i + 1}`, x(a.time) + 3, top - 7);
  }
  for (let lane = 0; lane < 6; lane++) {
    const y = top + lane * (bottom - top) / 5;
    ctx.strokeStyle = '#303429'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = '#939b87'; ctx.font = '10px Segoe UI, sans-serif'; ctx.fillText(['V','R','A','Z','L','O'][lane], 9, y + 4);
  }
  for (const note of result.notes) for (const [i, lane] of note.lanes.entries()) {
    const y = top + lane * (bottom - top) / 5;
    ctx.fillStyle = note.sp ? '#7bd6b4' : ['#71bb82','#e7837b','#dcca7c','#82a5d8','#d49c72','#b3a5d5'][lane];
    ctx.globalAlpha = .55; ctx.fillRect(x(note.time), y - 1, Math.max(0, x(note.ends[i]) - x(note.time)), 2);
    ctx.globalAlpha = 1; ctx.fillRect(x(note.time) - 1.5, y - 3, 3, 6);
  }
  ctx.fillStyle = '#939b87'; ctx.font = '10px Segoe UI, sans-serif';
  for (let i = 0; i <= 4; i++) { ctx.textAlign = i === 4 ? 'right' : 'left'; ctx.fillText(clock(result.duration * i / 4), x(result.duration * i / 4), offset + height - 10); }
  ctx.textAlign = 'left';
}
function draw() {
  if (!result || $('output').hidden) return;
  const canvas = $('chart'), width = Math.max(480, canvas.clientWidth), height = 210, ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio); canvas.height = height * ratio;
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); plot(ctx, width, height);
}
async function exportImage() {
  if (!result) return;
  const snapshot = result;
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 455 + Math.max(1, result.activations.length) * 62;
  if (canvas.height > 16000) { status('Rota extensa demais para PNG. Consulte a lista na página.', true); return; }
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#11130f'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e2c17a'; ctx.font = 'bold 18px Segoe UI, sans-serif'; ctx.fillText('BACKSTAGE / STARPOWER LAB', 32, 42);
  ctx.fillStyle = '#f1f0e7'; ctx.font = 'bold 30px Segoe UI, sans-serif'; ctx.fillText(metadata.title, 32, 87, 1120);
  ctx.font = '16px Segoe UI, sans-serif'; ctx.fillText(`${$('song-subtitle').textContent} · ${number(result.estimated)} pontos estimados · ${result.mode === 'max' ? 'Whammy máximo' : 'Conservadora'}${result.whammyEnabled ? '' : ' (whammy OFF)'}`, 32, 117, 1120);
  plot(ctx, 1200, 230, 140);
  result.activations.forEach((a, i) => {
    const y = 405 + i * 62;
    ctx.fillStyle = '#e2c17a'; ctx.font = 'bold 20px Segoe UI, sans-serif'; ctx.fillText(`${i + 1}.  ${clock(a.time)}`, 32, y);
    ctx.fillStyle = '#f1f0e7'; ctx.font = '16px Segoe UI, sans-serif'; ctx.fillText(cue(a), 220, y, 690);
    ctx.fillText(`${Math.round(a.energy * 100)}% de barra`, 1000, y);
    ctx.fillStyle = '#a4aa9b'; ctx.font = '13px Segoe UI, sans-serif'; ctx.fillText(`Compasso ${a.measure} · até ${clock(a.endTime)} · +${number(a.bonus)} pontos estimados`, 220, y + 22);
  });
  ctx.fillStyle = '#a4aa9b'; ctx.font = '13px Segoe UI, sans-serif';
  ctx.fillText('Rota aproximada, não máximo teórico. Horários relativos ao chart. iag0d.github.io/backstage-starpower', 32, canvas.height - 22);
  canvas.toBlob(blob => {
    if (!blob || snapshot !== result) return;
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'backstage-starpower-rota.png'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000); status('Imagem da rota preparada para download.');
  }, 'image/png');
}
async function loadDemo() {
  const id = ++request;
  worker?.terminate(); metadata = null; clear(); busy(true);
  try {
    status('Carregando o chart demonstrativo…');
    const response = await fetch(new URL('./assets/neon-run.chart', import.meta.url));
    if (!response.ok) throw new Error('Não foi possível carregar a demo. Tente importar um chart.');
    const blob = await response.blob();
    if (id !== request) return;
    await load(new File([blob], 'neon-run.chart'), true);
    $('planner').scrollIntoView({ behavior: 'instant', block: 'start' });
  } catch (error) { if (id === request) fail(error.message); }
}
$('import').onclick = () => $('file').click();
$('file').onchange = () => { const file = $('file').files[0]; if (file) load(file); $('file').value = ''; };
for (const id of ['demo', 'hero-demo', 'empty-demo']) $(id).onclick = loadDemo;
$('analyze').onclick = calculate;
$('instrument').onchange = () => { difficulties(); calculate(); };
$('difficulty').onchange = calculate;
for (const input of document.querySelectorAll('input[name="mode"], #whammy')) input.onchange = () => {
  $('mode-hint').textContent = !$('whammy').checked ? 'Whammy desativado: somente energia das frases.' : `Considera ${document.querySelector('input[name="mode"]:checked').value === 'max' ? '100' : '70'}% do whammy disponível no modelo.`;
  calculate();
};
$('cancel').onclick = () => { request++; worker?.terminate(); metadata = null; clear(); busy(false); status('Análise cancelada. Importe o arquivo novamente quando quiser.'); };
$('export').onclick = exportImage;
for (const event of ['dragenter', 'dragover']) $('dropzone').addEventListener(event, e => { e.preventDefault(); $('dropzone').classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) $('dropzone').addEventListener(event, e => { e.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').addEventListener('drop', e => { if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
new ResizeObserver(draw).observe($('chart'));
