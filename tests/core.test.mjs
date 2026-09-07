import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFile, parseChart, timeMap } from '../lib/parser.js';
import { analyze, buildTimeline, solve } from '../lib/optimizer.js';

const chart = (notes, sync = '0 = B 120000\n0 = TS 4') => parseChart(`[Song]\n{\nResolution = 192\n}\n[SyncTrack]\n{\n${sync}\n}\n[ExpertSingle]\n{\n${notes}\n}`);
const vlq = n => { const bytes = [n & 127]; while (n >>= 7) bytes.unshift((n & 127) | 128); return bytes; };
const chunk = (name, bytes) => { const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([Buffer.from(name), length, Buffer.from(bytes)]); };
const midi = (events, format = 0) => Buffer.concat([chunk('MThd', [0, format, 0, format ? 2 : 1, 0, 192]), ...(format ? [chunk('MTrk', [0, 255, 81, 3, 7, 161, 32, 0, 255, 47, 0])] : []), chunk('MTrk', [0, 255, 3, 11, ...Buffer.from('PART GUITAR'), ...events, 0, 255, 47, 0])]);

test('chart parsing, chords, open notes, tempos and time signatures', () => {
  const c = chart('0 = N 0 0\n0 = N 2 0\n192 = N 7 0\n0 = S 2 384', '0 = B 120000\n768 = B 60000\n0 = TS 4\n768 = TS 3');
  assert.equal(c.tracks[0].notes.length, 3);
  assert.equal(c.tracks[0].notes[2].lane, 5);
  const map = timeMap(c);
  assert.equal(map.seconds(4), 2); assert.equal(map.seconds(7), 5);
  assert.equal(map.measureLabel(7), 3);
  assert.equal(buildTimeline(c, c.tracks[0]).phrases, 1);
});

test('MIDI type 0/1, running status, short-note cutoff and SP marker 116', () => {
  const events = [0, 144, 116, 100, 0, 96, 100, 48, 96, 0, ...vlq(144), 97, 100, ...vlq(192), 97, 0, 0, 116, 0];
  for (const format of [0, 1]) {
    const c = parseFile(midi(events, format), 'notes.midi');
    assert.deepEqual(c.tracks[0].notes, [{tick:0, end:0, lane:0}, {tick:192, end:384, lane:1}]);
    assert.deepEqual(c.tracks[0].phrases, [{tick:0, end:384}]);
  }
});

test('Phase Shift SysEx open regions are end-exclusive', () => {
  const sysex = value => [0, 240, 8, 80, 83, 0, 0, 3, 1, value, 247];
  const c = parseFile(midi([...sysex(1), 0, 144, 96, 100, 48, 96, 0, ...sysex(0), 0, 96, 100, 48, 96, 0]), 'notes.mid');
  assert.deepEqual(c.tracks[0].notes.map(n => n.lane), [5, 0]);
});

test('untrusted input fails clearly instead of inventing notes', () => {
  assert.throws(() => parseFile(new Uint8Array(), 'notes.mid'), /vazio/);
  assert.throws(() => parseFile(new Uint8Array(8), 'notes.mid'), /cabeçalho/);
  assert.throws(() => parseFile(midi([0, 144, 96, 100]), 'notes.mid'), /encerramento/);
  assert.throws(() => parseFile(midi([0, 144, 96, 100, 0, 96, 100]), 'notes.mid'), /sobrepostas/);
  assert.throws(() => parseFile(midi([0, 144, 96, 100, 48, 96, 0]).subarray(0, 30), 'notes.mid'), /truncado/);
  assert.throws(() => chart('9999999999999 = N 0 0'), /limites/);
  assert.throws(() => parseChart('[Song]\n{\n}'), /encontrei/);
  assert.throws(() => chart('0 = N 0 0', '0 = B 0'), /BPM/);
});

test('equal-length chord sustain is counted once; whammy is a union', () => {
  const c = chart('0 = N 0 768\n0 = N 2 768\n0 = S 2 192');
  const timeline = buildTimeline(c, c.tracks[0]);
  assert.ok(Math.abs(timeline.base - (100 + 768 / 7)) < 1e-8);
  assert.ok(Math.abs(timeline.steps.reduce((sum, s) => sum + s.gain, 0) - 4 / 30) < 1e-8);
  assert.equal(analyze(c, c.tracks[0].id).activations.length, 0);
});

test('no phrases means no fabricated activation or bonus', () => {
  const c = chart('0 = N 0 0\n192 = N 1 0');
  const r = analyze(c, c.tracks[0].id);
  assert.equal(r.estimated, 104); assert.equal(r.bonus, 0); assert.equal(r.activations.length, 0);
  assert.match(r.warnings[0], /Não há frases/);
});

test('dynamic program agrees with exhaustive search on integer-energy scenarios', () => {
  // Integer quarter-bar steps remove interpolation from the comparison.
  const brute = (steps, i = 0, energy = 0, active = false) => {
    if (i === steps.length) return 0;
    const s = steps[i];
    const use = () => { const left = Math.max(0, Math.min(1, energy + s.phrase) - s.drain); return s.head + brute(steps, i + 1, left, left > 0); };
    if (active) return use();
    const wait = brute(steps, i + 1, Math.min(1, energy + s.phrase));
    return energy >= .5 ? Math.max(wait, use()) : wait;
  };
  for (let seed = 1; seed <= 30; seed++) {
    const steps = Array.from({length:12}, (_, i) => ({ beat:i, end:i+1, time:i, endTime:i+1, head:((seed * 31 + i * 17) % 11) * 50, sustain:0, gain:0, phrase:i % 3 !== 2 ? .25 : 0, drain:.25 }));
    assert.equal(solve(steps, 4).bonus, brute(steps), `seed ${seed}`);
  }
});

test('planner saves energy for the dense section and never activates below half', () => {
  const steps = [0,0,10,10,200,200].map((head, i) => ({beat:i,end:i+1,time:i,endTime:i+1,head,sustain:0,gain:0,phrase:i<2?.25:0,drain:.25}));
  const r = solve(steps, 4);
  assert.equal(r.activations[0].time, 4); assert.equal(r.bonus, 400);
  assert.ok(r.activations.every(a => a.energy >= .5));
});

test('original demo runs both difficulty levels and strategies deterministically', async () => {
  const data = await readFile(new URL('../assets/neon-run.chart', import.meta.url));
  const c = parseFile(data, 'neon-run.chart');
  assert.equal(c.title, 'Neon Run'); assert.equal(c.tracks.length, 2);
  for (const track of c.tracks) {
    const max = analyze(c, track.id), standard = analyze(c, track.id, 'standard'), off = analyze(c, track.id, 'max', false);
    assert.ok(max.activations.length > 0); assert.ok(max.estimated > max.baseline);
    assert.ok(max.estimated >= standard.estimated); assert.ok(standard.estimated >= off.estimated);
    assert.ok(max.activations.every((a, i, all) => a.time <= a.endTime && a.energy >= .5 - 1e-9 && (!i || a.time >= all[i-1].endTime)));
    assert.equal(analyze(c, track.id).estimated, max.estimated);
  }
});

test('every interface binding and local HTML resource exists', async () => {
  const root = new URL('../', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const app = await readFile(new URL('app.js', root), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size, 'duplicate HTML id');
  for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `missing element ${id}`);
  for (const [, path] of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) if (path !== './') assert.ok((await readFile(new URL(path, root))).length > 0, path);
  assert.ok(!/https?:\/\//.test(app), 'no external app requests');
});
