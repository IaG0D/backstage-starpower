import { timeMap } from './parser.js';

// Original, approximate model. CHOpt is a reference, NOT the engine used here.
// ponytail: 1/16-beat time grid + exact note boundaries; 256 energy bins with
// interpolation. No squeezes, early hits, CH 1.1 whammy bursts or exact sustain
// rounding. Upgrade only against a native/CHOpt validation corpus.
export function buildTimeline(chart, track, whammy = 1) {
  if (![0, 0.7, 1].includes(whammy)) throw new Error('Configuração de whammy inválida.');
  const map = timeMap(chart), res = chart.resolution;
  const grouped = new Map();
  for (const note of track.notes) { if (!grouped.has(note.tick)) grouped.set(note.tick, []); grouped.get(note.tick).push(note); }
  const groups = [...grouped].map(([tick, notes], i) => ({ tick, beat: tick / res, notes, index: i + 1, sp: false, phraseEnd: 0 }));
  const before = tick => { let lo = 0, hi = groups.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (groups[mid].tick < tick) lo = mid + 1; else hi = mid; } return lo; };
  let phrases = 0;
  for (const phrase of track.phrases) {
    const first = before(phrase.tick), end = before(phrase.end);
    if (first === end) continue;
    phrases++;
    for (let i = first; i < end; i++) groups[i].sp = true;
    groups[end - 1].phraseEnd = 0.25; // duplicates do not grant two phrases.
  }
  const events = new Map();
  const add = (beat, props = {}) => {
    const key = Math.round(beat * 1e8) / 1e8;
    const item = events.get(key) ?? { beat: key, head: 0, phrase: 0, holds: 0, whammy: 0 };
    for (const [k, v] of Object.entries(props)) item[k] += v;
    events.set(key, item);
    if (events.size > 100000) throw new Error('Chart muito extenso para esta versão (limite: 100 mil eventos de planejamento).');
  };
  let last = 0;
  for (const group of groups) {
    add(group.beat, { head: 50 * group.notes.length, phrase: group.phraseEnd });
    const lengths = group.notes.map(n => (n.end - n.tick) / res);
    // Clone Hero does not multiply an equal-length chord's sustain by fret count.
    const holds = lengths.every(n => n === lengths[0]) ? lengths.slice(0, 1) : lengths;
    for (const length of holds) if (length > 0) { add(group.beat, { holds: 1 }); add(group.beat + length, { holds: -1 }); }
    const sustain = Math.max(...lengths);
    if (group.sp && sustain > 0) { add(group.beat, { whammy: 1 }); add(group.beat + sustain, { whammy: -1 }); }
    last = Math.max(last, group.beat + sustain);
  }
  for (let b = 0; b < last; b += 1 / 16) add(b);
  add(last);
  for (const s of chart.signatures) if (s.tick / res <= last) add(s.tick / res);
  for (const t of chart.tempos) if (t.tick / res <= last) add(t.tick / res);
  const sorted = [...events.values()].sort((a, b) => a.beat - b.beat);
  const steps = [];
  let holding = 0, whipping = 0, streak = 0, base = 0;
  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i], end = sorted[i + 1]?.beat ?? event.beat;
    holding += event.holds; whipping += event.whammy;
    if (event.head) streak++;
    const multiplier = Math.min(4, 1 + Math.floor(streak / 10));
    const head = event.head * multiplier;
    const sustain = (end - event.beat) * res / Math.max(1, Math.floor(res / 25)) * holding * multiplier;
    base += head + sustain;
    steps.push({ beat: event.beat, end, time: map.seconds(event.beat), endTime: map.seconds(end), head, sustain,
      gain: whipping > 0 ? (end - event.beat) / 30 * whammy : 0,
      phrase: event.phrase, drain: (map.measures(end) - map.measures(event.beat)) / 8 });
  }
  return { steps, groups, phrases, base, map, last };
}

export function solve(steps, bins = 256) {
  if (!Number.isInteger(bins) || bins < 2 || bins > 1024 || bins % 2) throw new Error('Resolução do planejador inválida.');
  if (steps.length > 100000) throw new Error('Limite de eventos excedido.');
  const width = bins + 1, policy = new Uint8Array(steps.length * width);
  let nextOff = new Float64Array(width), nextOn = new Float64Array(width);
  let off = new Float64Array(width), on = new Float64Array(width);
  const lookup = (array, energy) => {
    const at = Math.max(0, Math.min(bins, energy * bins)), low = Math.floor(at), high = Math.min(bins, low + 1);
    return array[low] + (array[high] - array[low]) * (at - low);
  };
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    for (const field of ['head', 'sustain', 'phrase', 'gain', 'drain']) if (!Number.isFinite(s[field]) || s[field] < 0) throw new Error('Evento de pontuação inválido.');
    for (let e = 0; e <= bins; e++) {
      const energy = e / bins;
      const wait = lookup(nextOff, energy + s.phrase + s.gain);
      const charged = Math.min(1, energy + s.phrase), net = s.drain - s.gain;
      const fraction = net > charged ? charged / net : 1;
      const remaining = charged - net;
      const use = s.head + s.sustain * fraction + (remaining > 1e-10 ? lookup(nextOn, remaining) : lookup(nextOff, s.gain * (1 - fraction)));
      on[e] = e === 0 ? wait : use;
      const activate = e >= bins / 2 && use > wait + 1e-7;
      off[e] = activate ? use : wait;
      policy[i * width + e] = +activate;
    }
    [nextOff, off] = [off, nextOff]; [nextOn, on] = [on, nextOn];
  }
  let energy = 0, active = false, current = null, bonus = 0, collected = 0;
  const activations = [], meter = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], bucket = Math.max(0, Math.min(bins, Math.round(energy * bins)));
    if (!active && energy >= 0.5 - 1e-9 && policy[i * width + bucket]) {
      active = true;
      current = { beat: s.beat, time: s.time, energy, phrases: collected, bonus: 0, end: s.end, endTime: s.endTime };
      activations.push(current); collected = 0;
    }
    if (s.phrase) collected++;
    if (active) {
      const charged = Math.min(1, energy + s.phrase), net = s.drain - s.gain;
      const fraction = net > charged ? charged / net : 1;
      const gained = s.head + s.sustain * fraction;
      bonus += gained; current.bonus += gained;
      current.end = s.beat + (s.end - s.beat) * fraction;
      current.endTime = s.time + (s.endTime - s.time) * fraction;
      energy = Math.min(1, charged - net);
      if (energy <= 1e-10) { active = false; energy = s.gain * (1 - fraction); }
    } else energy = Math.min(1, energy + s.phrase + s.gain);
    if (i % 8 === 0 || s.phrase) meter.push({ time: s.time, energy, active });
  }
  return { activations, bonus, meter };
}

export function analyze(chart, trackId, mode = 'max', whammyEnabled = true) {
  if (!['max', 'standard'].includes(mode)) throw new Error('Modo inválido.');
  const track = chart.tracks.find(t => t.id === trackId);
  if (!track) throw new Error('Escolha uma trilha válida.');
  const timeline = buildTimeline(chart, track, whammyEnabled ? (mode === 'max' ? 1 : 0.7) : 0);
  const route = solve(timeline.steps);
  const notes = timeline.groups.map(g => ({ beat: g.beat, time: timeline.map.seconds(g.beat), index: g.index,
    lanes: g.notes.map(n => n.lane), ends: g.notes.map(n => timeline.map.seconds(n.end / chart.resolution)), sp: g.sp }));
  for (const a of route.activations) {
    const anchor = notes.find(n => n.time >= a.time - 1e-6) ?? notes.at(-1);
    a.note = anchor.index; a.lanes = anchor.lanes; a.beforeNote = Math.max(0, anchor.time - a.time);
    a.measure = timeline.map.measureLabel(a.beat);
  }
  const baseline = Math.round(timeline.base + notes.length * 2);
  return { ...route, notes, mode, whammyEnabled, baseline, estimated: Math.round(baseline + route.bonus),
    duration: timeline.map.seconds(timeline.last), phrases: timeline.phrases, noteCount: track.notes.length,
    warnings: [...chart.warnings, ...(!timeline.phrases ? ['Não há frases de especial nesta trilha. Nenhuma rota pode ser ativada.'] : [])] };
}
