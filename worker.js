import { parseFile } from './lib/parser.js';
import { analyze } from './lib/optimizer.js';
let chart;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'load') {
      chart = parseFile(data.buffer, data.filename);
      self.postMessage({ id: data.id, type: 'loaded', title: chart.title, artist: chart.artist,
        tracks: chart.tracks.map(({ id, instrument, difficulty }) => ({ id, instrument, difficulty })) });
    } else if (data.type === 'analyze' && chart) {
      self.postMessage({ id: data.id, type: 'result', result: analyze(chart, data.track, data.mode, data.whammy) });
    } else throw new Error('Importe um chart antes de analisar.');
  } catch (error) { if (data.type === 'load') chart = null; self.postMessage({ id: data.id, type: 'error', message: error.message }); }
};
