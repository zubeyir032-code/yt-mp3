const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const NodeID3 = require('node-id3');

/** Windows konsol/yt-dlp çıktısı: önce UTF-8, gerekirse cp857 */
function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return iconv.decode(buf, 'cp857');
}

/** YouTube araması için Türkçe karakterleri ASCII'ye indirger */
function normalizeQuery(q) {
  const map = {
    'ı': 'i', 'İ': 'I', 'ğ': 'g', 'Ğ': 'G', 'ü': 'u', 'Ü': 'U',
    'ş': 's', 'Ş': 'S', 'ö': 'o', 'Ö': 'O', 'ç': 'c', 'Ç': 'C',
  };
  return q.replace(/[ıİğĞüÜşŞöÖçÇ]/g, c => map[c] || c);
}

/** shell kullanmadan yt-dlp çalıştırır (Türkçe karakterler bozulmaz) */
function ytdlpSearch(query, limit = 5) {
  const args = [
    `ytsearch${limit}:${query}`,
    '--flat-playlist',
    '--dump-single-json',
    '--no-download',
    '--ignore-errors',
    '--no-warnings',
  ];
  const result = spawnSync('yt-dlp', args, {
    cwd: __dirname,
    timeout: 35000,
    encoding: 'buffer',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const text = decodeOutput(result.stdout || Buffer.alloc(0)).trim();
  if (!text) return null;
  return JSON.parse(text);
}

function buildSearchVariants(query) {
  const variants = [];
  const seen = new Set();
  const add = (v) => {
    const t = (v || '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      variants.push(t);
    }
  };

  const q = query.trim();
  add(q);
  add(normalizeQuery(q));

  const parts = q.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const title = parts[0].trim();
    const artists = parts.slice(1).join(' - ').trim();
    const mainArtist = artists.split(',')[0].trim();
    add(`${mainArtist} ${title}`);
    add(`${title} ${mainArtist}`);
    add(`${mainArtist} - ${title}`);
    add(`${title} official audio`);
    add(title);
    add(`${mainArtist} ${title} official`);
  }

  return variants;
}

function scoreEntry(entry, query) {
  const t = normalizeQuery((entry.title || '').toLowerCase());
  const titlePart = normalizeQuery((query.split(/\s+-\s+/)[0] || query).toLowerCase());
  let score = 0;

  if (t.includes(titlePart)) score += 15;
  const words = normalizeQuery(query.toLowerCase()).split(/\W+/).filter(w => w.length > 2);
  for (const w of words) {
    if (t.includes(w)) score += 2;
  }
  if (/cover|karaoke|reaction|slowed|8d|nightcore|remix|canlı|live concert/i.test(t)) score -= 8;
  if (/official|video klip|klip|audio|lyrics|söz/i.test(t)) score += 3;
  return score;
}

function findBestEntry(data, query) {
  const entries = (data?.entries || []).filter(e => e?.id);
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0];
  return entries.reduce((best, e) =>
    scoreEntry(e, query) > scoreEntry(best, query) ? e : best
  );
}

function findTrack(query) {
  for (const variant of buildSearchVariants(query)) {
    try {
      const data = ytdlpSearch(variant, 5);
      const entry = findBestEntry(data, query);
      if (entry?.id) return entry;
    } catch (_) { /* sonraki varyant */ }
  }
  return null;
}

/** "Title - Artist1, Artist2" → { title, artist } */
function parseTrackQuery(query) {
  const parts = query.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return { title: parts[0].trim(), artist: parts.slice(1).join(' - ').trim() };
  }
  return { title: query, artist: '' };
}

/** YouTube playlistindeki tüm videoları getir */
function ytdlpPlaylist(url) {
  const result = spawnSync('yt-dlp', [
    '--flat-playlist', '--dump-single-json', '--no-download',
    '--ignore-errors', '--no-warnings', url,
  ], { timeout: 60000, encoding: 'buffer', windowsHide: true });
  if (result.error) throw result.error;
  const text = decodeOutput(result.stdout || Buffer.alloc(0)).trim();
  if (!text) return [];
  const data = JSON.parse(text);
  return (data.entries || []).filter(e => e?.id && e?.title).map(e => ({
    title: e.title,
    url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
    id: e.id,
    duration: e.duration || 0,
  }));
}

/** ID3 tag yaz: başlık, sanatçı; thumbnail korunur */
function writeID3Tags(filePath, info) {
  const tags = {};
  if (info.title) tags.title = info.title;
  if (info.artist) tags.artist = info.artist;
  try {
    NodeID3.update(tags, filePath);
  } catch (_) { /* önemli değil */ }
}

function ytdlpGetTitle(url) {
  const result = spawnSync('yt-dlp', [
    '--print', 'title', '--no-warnings', '--no-download', url,
  ], { timeout: 15000, windowsHide: true, encoding: 'buffer' });
  if (result.error || !result.stdout?.length) return 'audio';
  return decodeOutput(result.stdout).trim() || 'audio';
}

const pythonEnv = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const BATCH_SEARCH_DELAY_MS = 600;
const BATCH_CONCURRENCY = 5;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const downloads = {};

app.post('/api/search', (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Arama kelimesi girin.' });

  try {
    const data = ytdlpSearch(query, 10);
    const results = (data?.entries || []).filter(e => e.title && e.id).map(e => ({
      title: e.title,
      url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
      id: e.id,
      duration: e.duration || 0,
    }));
    if (results.length === 0) {
      const entry = findTrack(query);
      if (entry) {
        return res.json({
          results: [{
            title: entry.title,
            url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
            id: entry.id,
            duration: entry.duration || 0,
          }],
        });
      }
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Arama başarısız: ' + err.message });
  }
});

// YouTube playlist
app.post('/api/playlist', (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('youtube.com/playlist') && !url.includes('list=')) {
    return res.status(400).json({ error: 'Geçerli bir YouTube playlist linki girin.' });
  }
  try {
    const videos = ytdlpPlaylist(url);
    if (videos.length > 0) {
      res.json({ success: true, videos });
    } else {
      res.json({ success: false, message: 'Playlistte video bulunamadı.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Playlist alınamadı: ' + err.message.substring(0, 100) });
  }
});

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
}

app.post('/api/download', (req, res) => {
  const { url, title: providedTitle, artist: providedArtist, format: reqFormat } = req.body;
  const fmt = (reqFormat === 'mp4') ? 'mp4' : 'mp3';

  let title = providedTitle || '';
  let artist = providedArtist || '';
  if (!title) {
    try { title = ytdlpGetTitle(url); } catch (e) {}
  }
  if (!title) title = 'audio';
  const id = crypto.randomBytes(8).toString('hex');
  downloads[id] = { status: 'started', progress: 0, log: '', title, artist, ext: fmt };

  const ytArgs = ['--no-warnings', '--no-playlist', '--progress', '--embed-thumbnail',
    '--http-chunk-size', '10M',
    '-o', path.join('downloads', `${id}.%(ext)s`)];
  if (fmt === 'mp4') {
    ytArgs.unshift('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]', '--merge-output-format', 'mp4',
      '--concurrent-fragments', '5');
  } else {
        ytArgs.unshift('-x', '--audio-format', 'mp3',
      '--ffmpeg-location', '/usr/local/bin',
      '--postprocessor-args', 'ffmpeg:-threads 2');
  }
  ytArgs.push(url);

  const dl = spawn('yt-dlp', ytArgs, { windowsHide: true, cwd: __dirname });

  dl.stdout.on('data', (data) => {
    downloads[id].log += data.toString();
  });

  dl.stderr.on('data', (data) => {
    const text = data.toString();
    downloads[id].log += text;
    const match = text.match(/(\d+\.?\d*)%/);
    if (match) {
      downloads[id].progress = parseFloat(match[1]);
      downloads[id].status = 'downloading';
    }
  });

  dl.on('error', (err) => {
    downloads[id].status = 'error';
    downloads[id].error = err.message;
  });

  dl.on('close', (code) => {
    if (code === 0) {
      const ext = downloads[id].ext;
      const expectedPath = path.join(DOWNLOADS_DIR, `${id}.${ext}`);
      let filePath = null;
      if (fs.existsSync(expectedPath)) {
        filePath = expectedPath;
      } else {
        const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(id));
        if (files.length > 0) {
          filePath = path.join(DOWNLOADS_DIR, files[0]);
          if (files[0] !== `${id}.${ext}`) {
            fs.renameSync(filePath, expectedPath);
            filePath = expectedPath;
          }
        }
      }
      if (filePath) {
        if (ext === 'mp3') writeID3Tags(filePath, { title: downloads[id].title, artist: downloads[id].artist });
        downloads[id].status = 'completed';
        downloads[id].progress = 100;
      } else {
        downloads[id].status = 'error';
        downloads[id].error = 'Dosya oluşturulamadı.';
      }
    } else {
      downloads[id].status = 'error';
      downloads[id].error = `yt-dlp çıkış kodu: ${code}`;
    }
  });

  res.json({ success: true, id, format: fmt, downloadUrl: `/api/download/${id}` });
});

app.get('/api/status/:id', (req, res) => {
  const entry = downloads[req.params.id];
  if (!entry) return res.status(404).json({ error: 'İşlem bulunamadı.' });

  res.json({
    status: entry.status,
    progress: entry.progress,
    error: entry.error || null,
    log: entry.log || null,
    downloadUrl: entry.status === 'completed' ? `/api/download/${req.params.id}` : null,
  });
});

app.get('/api/download/:id', (req, res) => {
  const info = downloads[req.params.id];
  const ext = (info?.ext || 'mp3');
  let filePath = path.join(DOWNLOADS_DIR, `${req.params.id}.${ext}`);

  if (!fs.existsSync(filePath)) {
    // fallback: try other extensions
    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(req.params.id));
    if (files.length > 0) {
      filePath = path.join(DOWNLOADS_DIR, files[0]);
    } else {
      return res.status(404).json({ error: 'Dosya bulunamadı.' });
    }
  }

  const fileName = (info?.title || 'audio') + '.' + ext;
  res.download(filePath, sanitize(fileName), (err) => {
    if (!err) {
      setTimeout(() => fs.unlink(filePath, () => {}), 1000);
    }
  });
});

// Spotify playlist
app.post('/api/spotify', (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('spotify.com')) {
    return res.status(400).json({ error: 'Geçerli bir Spotify URL\'si girin.' });
  }

  const match = url.match(/(playlist|album)\/([a-zA-Z0-9]+)/);
  if (!match) return res.status(400).json({ error: 'Playlist veya albüm ID\'si bulunamadı.' });

  const type = match[1];
  const id = match[2];

  try {
    const pyCmd = spawnSync('python3', ['--version'], { timeout: 3000, encoding: 'utf8', windowsHide: true }).status === 0 ? 'python3' : 'python';
    const result = spawnSync(pyCmd, ['spotify_tracks.py', type, id], {
      cwd: __dirname,
      timeout: 60000,
      encoding: 'buffer',
      env: pythonEnv,
      windowsHide: true,
    });
    const raw = decodeOutput(result.stdout || Buffer.alloc(0));
    const tracks = JSON.parse(raw);
    if (Array.isArray(tracks) && tracks.length > 0) {
      res.json({ success: true, songs: tracks });
    } else {
      res.json({ success: false, message: 'Bu playlistte şarkı bulunamadı.' });
    }
  } catch (err) {
    res.json({
      success: false,
      message: 'Spotify alınamadı. "Toplu İndir" sekmesini kullan.',
    });
  }
});

// Batch download
const batches = {};

app.post('/api/batch', (req, res) => {
  const { songs, format: reqFormat } = req.body;
  const fmt = (reqFormat === 'mp4') ? 'mp4' : 'mp3';
  if (!songs || !Array.isArray(songs) || songs.length === 0) {
    return res.status(400).json({ error: 'En az bir şarkı adı girin.' });
  }

  const batchId = crypto.randomBytes(4).toString('hex');
  const items = songs.map(q => ({ query: q.trim(), status: 'bekliyor', title: '', error: null, downloadUrl: null }));
  batches[batchId] = { items, completed: 0, total: items.length, nextIdx: 0, active: 0, format: fmt };

  processBatch(batchId);

  res.json({ success: true, batchId, total: items.length });
});

function processBatch(batchId) {
  const batch = batches[batchId];
  if (!batch) return;

  const startNext = () => {
    while (batch.active < BATCH_CONCURRENCY && batch.nextIdx < batch.total) {
      const idx = batch.nextIdx++;
      batch.active++;
      processBatchItem(batchId, idx, () => {
        batch.active--;
        startNext();
      });
    }
  };

  startNext();
}

function processBatchItem(batchId, idx, onDone) {
  const batch = batches[batchId];
  const item = batch.items[idx];
  item.status = 'aranıyor';

  try {
    const entry = findTrack(item.query);

    if (!entry?.id) {
      item.status = 'hata';
      item.error = 'Sonuç bulunamadı.';
      batch.completed++;
      onDone();
      return;
    }

    const url = entry.url || `https://www.youtube.com/watch?v=${entry.id}`;
    item.title = entry.title || item.query;
    item.status = 'indiriliyor';

    const id = crypto.randomBytes(8).toString('hex');
    item.downloadId = id;

    const info = parseTrackQuery(item.query);
    const fmt = batch.format || 'mp3';
    downloads[id] = { status: 'started', progress: 0, log: '', title: info.title, artist: info.artist, ext: fmt };

    const ytArgs = ['--no-warnings', '--no-playlist', '--progress', '--embed-thumbnail',
      '--http-chunk-size', '10M',
      '-o', path.join('downloads', `${id}.%(ext)s`)];
    if (fmt === 'mp4') {
      ytArgs.unshift('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]', '--merge-output-format', 'mp4',
        '--concurrent-fragments', '5');
    } else {
      ytArgs.unshift('-x', '--audio-format', 'mp3',
                             '--ffmpeg-location', '/usr/bin',

        '--postprocessor-args', 'ffmpeg:-threads 2');
    }
    ytArgs.push(url);

    const dl = spawn('yt-dlp', ytArgs, { windowsHide: true, cwd: __dirname });

    dl.stderr.on('data', (data) => {
      const text = data.toString();
      downloads[id].log += text;
      const match = text.match(/(\d+\.?\d*)%/);
      if (match) downloads[id].progress = parseFloat(match[1]);
    });

    dl.on('close', (code) => {
      const ext = downloads[id]?.ext || 'mp3';
      const expectedPath = path.join(DOWNLOADS_DIR, `${id}.${ext}`);
      let filePath = null;
      if (fs.existsSync(expectedPath)) {
        filePath = expectedPath;
      } else {
        const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(id));
        if (files.length > 0) {
          filePath = path.join(DOWNLOADS_DIR, files[0]);
          if (!filePath.endsWith(`.${ext}`)) fs.renameSync(filePath, expectedPath);
          filePath = expectedPath;
        }
      }
      if (code === 0 && filePath) {
        if (ext === 'mp3') writeID3Tags(filePath, { title: info.title, artist: info.artist });
        downloads[id].status = 'completed';
        downloads[id].progress = 100;
        item.status = 'tamam';
        item.downloadUrl = `/api/download/${id}`;
      } else {
        downloads[id].status = 'error';
        item.status = 'hata';
        item.error = `İndirme hatası (kod: ${code})`;
      }
      batch.completed++;
      onDone();
    });

    dl.on('error', (err) => {
      downloads[id].status = 'error';
      item.status = 'hata';
      item.error = err.message;
      batch.completed++;
      onDone();
    });

  } catch (err) {
    item.status = 'hata';
    item.error = 'Arama hatası: ' + err.message.substring(0, 100);
    batch.completed++;
    onDone();
  }
}

app.get('/api/batch-status/:batchId', (req, res) => {
  const batch = batches[req.params.batchId];
  if (!batch) return res.status(404).json({ error: 'Toplu işlem bulunamadı.' });

  res.json({
    total: batch.total,
    completed: batch.completed,
    finished: batch.completed >= batch.total,
    items: batch.items.map(i => ({
      query: i.query,
      status: i.status,
      title: i.title,
      error: i.error,
      downloadUrl: i.downloadUrl,
    })),
  });
});

// Health check (Render vs. için)
app.get('/health', (req, res) => res.send('OK'));

// Başlangıç kontrolleri
function checkDep(cmd, args, name) {
  try {
    const r = spawnSync(cmd, args || ['--version'], { timeout: 10000, encoding: 'utf8' });
    const ok = r.status === 0;
    if (!ok) console.error(`  [DEBUG] ${cmd} çıkış kodu: ${r.status}, stderr: ${(r.stderr||'').trim().slice(0,200)}`);
    return { ok, ver: (r.stdout || '').trim().split('\n')[0] };
  } catch (e) { console.error(`  [DEBUG] ${cmd} hata: ${e.message}`); return { ok: false }; }
}

const os = require('os');

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu çalışıyor → PORT: ${PORT}`);
  console.log(`Bağlantı: http://localhost:${PORT}`);

  // Bağımlılık kontrolleri
  const deps = [
    ['yt-dlp', null, 'YouTube indirici'],
        ['/usr/local/bin/ffmpeg', null, 'Ses/video dönüştürücü'],
    ['python3', ['--version'], 'Python (Spotify için)'],
  ];
  for (const [cmd, args, label] of deps) {
    const r = checkDep(cmd, args);
    console.log(`  ${r.ok ? '✓' : '✗'} ${label} (${cmd})${r.ver ? ' — ' + r.ver : ''}`);
  }

  // Ağ bilgisi
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`  http://${iface.address}:${PORT}`);
        }
      }
    }
  } catch (_) {}
});
