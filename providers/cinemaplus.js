// Nuvio provider: Cinema Plus (cinema.plus app)
// Ported from the CloudStream plugin. Promise-based only (no async/await).
//
// This source is keyed by TMDB id, so no title search is needed:
//   TMDB id -> content page(s) from the app config -> episodeLinks / videoSources
//   -> Mux HLS link  (https://stream.mux.com/{token}.m3u8)

var CONFIG_URL = 'https://config.e-droid.net/srv/config.php?v=211&vname=3.0&idapp=3796813&idusu=0&cod_g=&gp=0&am=0&idl=en&pa_env=1&pa=GB&pn=cinema.plus&fus=010100000000&aid=7db3574f7ef4288a';
var EDROID_UA = 'Android Vinebre Software';
var GET_HTML = 'https://html.e-droid.net/html/get_html.php?ida=3796813&ids=';

var TAG = '[CinemaPlus]';
var TIMEOUT_MS = 15000;
var CONFIG_TTL_MS = 60 * 60 * 1000;

// Section titles that are menu pages, not content (Home / Discover)
var SKIP_TITLES = [
  '\u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0629',
  '\u0627\u0644\u0631\u0626\u064A\u0633\u064A\u0647',
  '\u0627\u0643\u062A\u0634\u0641'
];

// ------------------------------------------------------------------ helpers
function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () {
      if (!done) { done = true; reject(new Error('timeout')); }
    }, ms);
    promise.then(function (v) {
      if (!done) { done = true; clearTimeout(t); resolve(v); }
    }, function (e) {
      if (!done) { done = true; clearTimeout(t); reject(e); }
    });
  });
}

function getText(url, headers) {
  return withTimeout(fetch(url, { headers: headers || {} }), TIMEOUT_MS)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.text();
    });
}

// ------------------------------------------------------------------ config
var configCache = null;   // { ts, byTmdb }
var configPending = null;

// config.php lists one section per movie / series:
//   [s{pageId}_tipo=2][s{pageId}_tit={title}][s{pageId}_idgo={tmdbId}]...
function loadConfig() {
  if (configCache && Date.now() - configCache.ts < CONFIG_TTL_MS) {
    return Promise.resolve(configCache.byTmdb);
  }
  if (configPending) return configPending;

  configPending = getText(CONFIG_URL, { 'User-Agent': EDROID_UA }).then(function (body) {
    var sections = {};
    var order = [];
    var re = /\[s(\d+)_(\w+)=([^\]]*)\]/g;
    var m;
    while ((m = re.exec(body)) !== null) {
      if (!sections[m[1]]) { sections[m[1]] = {}; order.push(m[1]); }
      sections[m[1]][m[2]] = m[3];
    }

    var byTmdb = {};
    var count = 0;
    order.forEach(function (pageId) {
      var d = sections[pageId];
      if (d.tipo !== '2') return;
      var title = (d.tit || '').trim();
      if (!title) return;
      for (var i = 0; i < SKIP_TITLES.length; i++) {
        if (title.indexOf(SKIP_TITLES[i]) !== -1) return;
      }
      var tmdbId = parseInt((d.idgo || '').trim(), 10);
      if (isNaN(tmdbId)) return;
      if (!byTmdb[tmdbId]) byTmdb[tmdbId] = [];
      byTmdb[tmdbId].push(pageId);
      count++;
    });

    console.log(TAG, 'config:', count, 'items');
    if (count > 0) configCache = { ts: Date.now(), byTmdb: byTmdb };
    configPending = null;
    return byTmdb;
  }, function (err) {
    configPending = null;
    throw err;
  });
  return configPending;
}

// ------------------------------------------------------------- content pages
// SERIES page: const episodeLinks = {"s-e": "muxToken" | "fullUrl" | "#"}
function parseEpisodeLinks(html) {
  var m = html.match(/const\s+episodeLinks\s*=\s*\{([\s\S]*?)\}/);
  if (!m) return null;
  var out = {};
  var count = 0;
  var re = /"(\d+-\d+)":\s*"([^"]*)"/g;
  var p;
  while ((p = re.exec(m[1])) !== null) { out[p[1]] = p[2]; count++; }
  return count ? out : null;
}

// MOVIE page: const videoSources = {"480": "url|token", ...}
function parseVideoSources(html) {
  var m = html.match(/const\s+videoSources\s*=\s*\{([\s\S]*?)\}/);
  if (!m) return null;
  var out = [];
  var re = /"([^"]+)":\s*"([^"]*)"/g;
  var p;
  while ((p = re.exec(m[1])) !== null) {
    if (p[2] && p[2].trim()) out.push({ quality: p[1], src: p[2].trim() });
  }
  return out.length ? out : null;
}

function fetchPage(pageId) {
  return getText(GET_HTML + pageId, { 'User-Agent': EDROID_UA }).catch(function () { return null; });
}

// Non-http values are Mux tokens
function toStreamUrl(src) {
  return /^https?:/i.test(src) ? src : 'https://stream.mux.com/' + src + '.m3u8';
}

function qualityNumber(q) {
  var m = String(q || '').match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function buildStreams(items) {
  var seen = {};
  var list = [];
  items.forEach(function (it) {
    var url = toStreamUrl(it.src);
    if (seen[url]) return;
    seen[url] = true;
    list.push({ url: url, q: qualityNumber(it.quality), idx: list.length });
  });
  list.sort(function (a, b) { return b.q - a.q || a.idx - b.idx; });

  var pad = String(list.length).length;
  return list.map(function (it, i) {
    var rank = String(i + 1);
    while (rank.length < pad) rank = '0' + rank;
    var label = rank + ' - ' + (it.q ? it.q + 'p' : 'Auto');
    return {
      name: 'CinemaPlus',
      title: label,
      url: it.url,
      quality: label,
      provider: 'cinemaplus',
      type: /\.m3u8/i.test(it.url) ? 'm3u8' : 'mp4'
    };
  });
}

// ------------------------------------------------------------------- main
function run(tmdbId, mediaType, season, episode) {
  var id = parseInt(tmdbId, 10);
  return loadConfig().then(function (byTmdb) {
    var pageIds = byTmdb[id];
    if (!pageIds || !pageIds.length) {
      console.log(TAG, 'Not in the catalog');
      return [];
    }
    // The same TMDB id can exist as a movie and as a series -> check the page type
    return Promise.all(pageIds.map(fetchPage)).then(function (pages) {
      var s = parseInt(season, 10) || 1;
      var e = parseInt(episode, 10) || 1;

      for (var i = 0; i < pages.length; i++) {
        var html = pages[i];
        if (!html) continue;

        if (mediaType === 'tv') {
          var links = html.indexOf('const SERIES_ID') !== -1 ? parseEpisodeLinks(html) : null;
          if (!links) continue;
          var src = links[s + '-' + e];
          if (src && src !== '#') return buildStreams([{ quality: '', src: src }]);
        } else {
          var sources = parseVideoSources(html);
          if (sources) return buildStreams(sources);
        }
      }
      console.log(TAG, 'No playable source for this title');
      return [];
    });
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  console.log(TAG, 'Fetching', mediaType, tmdbId, season || '', episode || '');
  return run(tmdbId, mediaType, season, episode).catch(function (err) {
    console.log(TAG, 'Error:', err && err.message ? err.message : err);
    return [];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
}
if (typeof global !== 'undefined') {
  global.getStreams = getStreams;
}
