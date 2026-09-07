const decoder = new TextDecoder();
const MAX_NOTES = 100000;
export const DIFFICULTIES = ['Expert', 'Hard', 'Medium', 'Easy'];
const midiTracks = { 'PART GUITAR': 'Guitarra', 'T1 GEMS': 'Guitarra', 'PART BASS': 'Baixo', 'PART RHYTHM': 'Rhythm', 'PART GUITAR COOP': 'Co-op', 'PART KEYS': 'Teclas (5 frets)' };
const chartTracks = { Single: 'Guitarra', DoubleBass: 'Baixo', DoubleRhythm: 'Rhythm', DoubleGuitar: 'Co-op', Keyboard: 'Teclas (5 frets)' };
const fail = message => { throw new Error(message); };
const integer = n => Number.isSafeInteger(n) && n >= 0;

export function parseFile(buffer, filename = 'notes.mid') {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!data.length || data.length > 20 * 1024 * 1024) fail('Escolha um arquivo não vazio de até 20 MB.');
  if (/\.midi?$/i.test(filename)) return parseMidi(data, filename);
  if (/\.chart$/i.test(filename)) return parseChart(decoder.decode(data), filename);
  fail('Formato não suportado. Use notes.mid, notes.midi ou notes.chart.');
}

export function parseChart(text, filename = 'notes.chart') {
  const sections = [...text.matchAll(/^\s*\[([^\]\r\n]+)\]\s*\{([^}]*)\}/gm)];
  const song = sections.find(s => s[1] === 'Song')?.[2] ?? '';
  const field = key => song.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'))?.[1]?.replace(/^"|"$/g, '');
  const resolution = Number(field('Resolution') ?? 192);
  const chart = { title: field('Name') || filename, artist: field('Artist') || '', resolution, tempos: [], signatures: [], tracks: [], warnings: [] };
  if (Number(field('Offset') ?? 0) !== 0) chart.warnings.push('Os horários são relativos ao chart; o Offset de áudio não é aplicado.');
  for (const [, name, body] of sections) {
    if (name === 'SyncTrack') {
      for (const line of body.split('\n')) {
        let m = line.match(/^\s*(\d+)\s*=\s*B\s+(\d+)\s*$/);
        if (m) chart.tempos.push({ tick: +m[1], bpm: +m[2] / 1000 });
        m = line.match(/^\s*(\d+)\s*=\s*TS\s+(\d+)(?:\s+(\d+))?\s*$/);
        if (m) chart.signatures.push({ tick: +m[1], numerator: +m[2], denominator: 2 ** +(m[3] ?? 2) });
        if (/=\s*A\s/.test(line)) chart.warnings.push('SyncTrack com anchors: confira a sincronização no jogo; anchors não são aplicados.');
      }
      continue;
    }
    const match = name.match(/^(Expert|Hard|Medium|Easy)(Single|DoubleBass|DoubleRhythm|DoubleGuitar|Keyboard)$/);
    if (!match) continue;
    const track = { instrument: chartTracks[match[2]], difficulty: match[1], notes: [], phrases: [] };
    if (/=\s*E\s+"?solo/i.test(body)) chart.warnings.push('Bônus de solo não é incluído na pontuação estimada.');
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*(\d+)\s*=\s*([NS])\s+(\d+)\s+(\d+)\s*$/);
      if (!m) continue;
      const tick = +m[1], code = +m[3], end = tick + +m[4];
      if (m[2] === 'N' && (code <= 4 || code === 7)) track.notes.push({ tick, end, lane: code === 7 ? 5 : code });
      if (m[2] === 'S' && code === 2 && end > tick) track.phrases.push({ tick, end });
    }
    if (track.notes.length) chart.tracks.push(track);
  }
  return finish(chart);
}

export function parseMidi(data, filename = 'notes.mid') {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0, boundary = data.length, eventCount = 0;
  const need = n => { if (p + n > boundary) fail('MIDI truncado ou tamanho de bloco inválido.'); };
  const byte = () => { need(1); return data[p++]; };
  const u16 = () => { need(2); const n = view.getUint16(p); p += 2; return n; };
  const u32 = () => { need(4); const n = view.getUint32(p); p += 4; return n; };
  const bytes = n => { need(n); const out = data.subarray(p, p + n); p += n; return out; };
  const vlq = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) { const b = byte(); n = n * 128 + (b & 127); if (!(b & 128)) return n; }
    fail('MIDI com número variável inválido.');
  };
  if (decoder.decode(bytes(4)) !== 'MThd') fail('Este arquivo não contém um cabeçalho MIDI válido.');
  const headerSize = u32();
  if (headerSize < 6) fail('Cabeçalho MIDI incompleto.');
  const format = u16(), count = u16(), resolution = u16();
  if (format > 1 || !count || count > 256 || resolution & 0x8000) fail('Use MIDI tipo 0/1 com resolução musical (PPQ), não SMPTE.');
  bytes(headerSize - 6);
  const chart = { title: filename, artist: '', resolution, tempos: [], signatures: [], tracks: [], warnings: [] };
  for (let t = 0; t < count; t++) {
    boundary = data.length;
    if (decoder.decode(bytes(4)) !== 'MTrk') fail('Bloco de trilha MIDI ausente.');
    const size = u32(); need(size); boundary = p + size;
    let tick = 0, running = 0, name = '', ended = false, enhanced = false;
    const sounding = new Map(), raw = [], opens = [], openStarts = new Map();
    while (p < boundary) {
      if (++eventCount > 1000000) fail('MIDI excede o limite de 1 milhão de eventos.');
      tick += vlq();
      if (!integer(tick)) fail('Posição MIDI inválida.');
      let status = byte();
      if (status < 128) { p--; status = running; if (!status) fail('Running status MIDI ausente.'); }
      if (status === 255) {
        const type = byte(), payload = bytes(vlq());
        if (type === 3) name = decoder.decode(payload).replace(/\0/g, '').trim();
        if ((type === 1 || type === 6) && /\[?ENHANCED_OPENS\]?/.test(decoder.decode(payload))) enhanced = true;
        if (type === 81 && payload.length === 3) chart.tempos.push({ tick, bpm: 60000000 / (payload[0] * 65536 + payload[1] * 256 + payload[2]) });
        if (type === 88 && payload.length >= 2) chart.signatures.push({ tick, numerator: payload[0], denominator: 2 ** payload[1] });
        if (type === 47) { ended = true; p = boundary; }
      } else if (status === 240 || status === 247) {
        const payload = bytes(vlq());
        if (payload.length >= 7 && payload[0] === 80 && payload[1] === 83 && payload[2] === 0 && payload[3] === 0 && payload[5] === 1) {
          const difficulty = payload[4];
          if (payload[6] === 1) openStarts.set(difficulty, tick);
          else if (openStarts.has(difficulty)) { opens.push({ difficulty, tick: openStarts.get(difficulty), end: tick }); openStarts.delete(difficulty); }
        }
      } else if (status >= 128 && status < 240) {
        running = status;
        const kind = status >> 4, pitch = byte(), velocity = (kind === 12 || kind === 13) ? 0 : byte();
        if (pitch > 127 || velocity > 127) fail('Byte de dados MIDI inválido.');
        const key = (status & 15) * 128 + pitch;
        if (kind === 9 && velocity > 0) {
          if (sounding.has(key)) fail('MIDI com notas sobrepostas na mesma lane/canal. Exporte novamente o chart.');
          sounding.set(key, { tick, pitch });
        } else if (kind === 8 || (kind === 9 && velocity === 0)) {
          const note = sounding.get(key);
          if (note) { raw.push({ ...note, end: tick }); sounding.delete(key); }
        }
      } else fail('Evento de sistema MIDI não suportado.');
    }
    if (!ended) fail('MIDI sem evento End of Track.');
    if (!midiTracks[name]) continue;
    if (sounding.size || openStarts.size) fail('Trilha de instrumento contém notas ou marcadores sem encerramento.');
    let phrases = raw.filter(n => n.pitch === 116);
    if (phrases.length && raw.some(n => n.pitch === 103)) chart.warnings.push('Possível seção de solo: bônus de solo não é incluído na pontuação estimada.');
    if (!phrases.length && raw.some(n => n.pitch === 103)) {
      phrases = raw.filter(n => n.pitch === 103);
      chart.warnings.push('Sem marcador 116: marcador 103 tratado como especial legado. song.ini pode mudar essa regra.');
    }
    for (const [d, base] of [[0, 60], [1, 72], [2, 84], [3, 96]]) {
      const notes = raw.filter(n => n.pitch >= base && n.pitch <= base + 4 || enhanced && n.pitch === base - 1).map(n => ({
        tick: n.tick, end: n.end - n.tick < resolution / 3 ? n.tick : n.end,
        lane: n.pitch === base - 1 || opens.some(o => (o.difficulty === d || o.difficulty === 255) && n.tick >= o.tick && n.tick < o.end) ? 5 : n.pitch - base
      }));
      if (notes.length) chart.tracks.push({ instrument: midiTracks[name], difficulty: ['Easy', 'Medium', 'Hard', 'Expert'][d], notes, phrases: phrases.map(n => ({ tick: n.tick, end: n.end })) });
    }
  }
  return finish(chart);
}

function finish(chart) {
  if (!integer(chart.resolution) || chart.resolution < 1 || chart.resolution > 32767) fail('Resolução do chart inválida.');
  if (!chart.tracks.length) fail('Não encontrei guitarra, baixo, rhythm, co-op ou teclas de cinco frets neste arquivo.');
  const normalize = (values, fallback) => [...new Map([fallback, ...values].sort((a, b) => a.tick - b.tick).map(v => [v.tick, v])).values()];
  chart.tempos = normalize(chart.tempos, { tick: 0, bpm: 120 });
  chart.signatures = normalize(chart.signatures, { tick: 0, numerator: 4, denominator: 4 });
  for (const t of chart.tempos) if (!integer(t.tick) || !Number.isFinite(t.bpm) || t.bpm <= 0 || t.bpm > 2000) fail('Mapa de BPM inválido.');
  for (const s of chart.signatures) if (!integer(s.tick) || !integer(s.numerator) || s.numerator < 1 || s.numerator > 64 || ![1, 2, 4, 8, 16, 32, 64].includes(s.denominator)) fail('Fórmula de compasso inválida.');
  for (const track of chart.tracks) {
    if (track.notes.length > MAX_NOTES) fail('Trilha excede o limite de 100 mil notas.');
    for (const n of [...track.notes, ...track.phrases]) if (!integer(n.tick) || !integer(n.end) || n.end < n.tick || n.end / chart.resolution > 16000) fail('Notas fora dos limites suportados (16 mil beats).');
    track.notes = [...new Map(track.notes.map(n => [`${n.tick}:${n.lane}`, n])).values()].sort((a, b) => a.tick - b.tick || a.lane - b.lane);
    track.phrases.sort((a, b) => a.tick - b.tick);
    track.id = `${track.instrument}/${track.difficulty}`;
  }
  if (new Set(chart.tracks.map(t => t.id)).size !== chart.tracks.length) fail('Há trilhas duplicadas para o mesmo instrumento e dificuldade. Exporte um chart sem duplicatas.');
  chart.warnings = [...new Set(chart.warnings)];
  return chart;
}

export function timeMap(chart) {
  const tempo = chart.tempos.map(t => ({ beat: t.tick / chart.resolution, bpm: t.bpm, seconds: 0 }));
  const meter = chart.signatures.map(s => ({ beat: s.tick / chart.resolution, length: s.numerator * 4 / s.denominator, measure: 0 }));
  for (let i = 1; i < tempo.length; i++) tempo[i].seconds = tempo[i - 1].seconds + (tempo[i].beat - tempo[i - 1].beat) * 60 / tempo[i - 1].bpm;
  for (let i = 1; i < meter.length; i++) meter[i].measure = meter[i - 1].measure + (meter[i].beat - meter[i - 1].beat) / meter[i - 1].length;
  const segment = (array, beat) => { let lo = 0, hi = array.length; while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (array[m].beat <= beat) lo = m; else hi = m; } return array[lo]; };
  return {
    seconds(beat) { const t = segment(tempo, beat); return t.seconds + (beat - t.beat) * 60 / t.bpm; },
    measures(beat) { const m = segment(meter, beat); return m.measure + (beat - m.beat) / m.length; },
    measureLabel(beat) { return Math.floor(this.measures(beat) + 1e-7) + 1; }
  };
}
