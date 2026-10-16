// Nuvio provider: AnimeWitcher (animewitcher.com)
// Ported from the CloudStream plugin. Promise-based only (no async/await).
//
// How it works:
//   TMDB id -> titles (English / original) -> Algolia search
//   -> pick the series entry (and season) -> Firestore episode list
//   -> Firestore server list for the episode -> direct links.
//
// Supported servers in this version: PD (PixelDrain), KF (KrakenFiles) and
// any server whose link is already a direct .mp4 / .m3u8.
// Only runs for anime (TMDB genre "Animation" or original language Japanese).

var TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';

var FIREBASE_PROJECT_ID = 'animewitcher-1c66d';
var FIREBASE_API_KEY = 'AIzaSyAcbWRwfFNnCpoydDXlEALWnM_TYVcJOMU';
var algoliaAppId = 'D8LH9I7ZL7';
var algoliaApiKey = 'b56c01ef52540ef334bcdbaa00ded9e4';

var TAG = '[AnimeWitcher]';
var TIMEOUT_MS = 10000;
var TOTAL_TIMEOUT_MS = 25000;

var ALGOLIA_ATTRS = ['objectID', 'name', 'poster_uri', 'type', 'details', 'tags', 'story',
  'english_title', 'poster', 'rating', 'dubbed', 'path'];

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

function getJson(url, options) {
  return withTimeout(fetch(url, options || { headers: { 'Accept': 'application/json' } }), TIMEOUT_MS)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.json();
    });
}

function getText(url, headers) {
  return withTimeout(fetch(url, { headers: headers || {} }), TIMEOUT_MS)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.text();
    });
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();
}

function unique(list) {
  var out = [];
  list.forEach(function (x) { if (x && out.indexOf(x) === -1) out.push(x); });
  return out;
}

function qualityNumber(q) {
  var m = String(q || '').match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function sv(o) { return o && (o.stringValue !== undefined ? o.stringValue : undefined); }

function encId(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function firestoreUrl(path) {
  return 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID +
    '/databases/(default)/documents/' + path + '?key=' + FIREBASE_API_KEY;
}

// ------------------------------------------------------------------- TMDB
function tmdbGet(tmdbId, kind, lang, extra) {
  var url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId +
    '?api_key=' + TMDB_API_KEY + '&language=' + lang + (extra || '');
  return getJson(url).catch(function () { return null; });
}

function getTmdbInfo(tmdbId, mediaType) {
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  return tmdbGet(tmdbId, kind, 'en-US').then(function (en) {
    if (!en) throw new Error('TMDB lookup failed');

    var genreIds = (en.genres || []).map(function (g) { return g.id; });
    var lang = en.original_language || '';

    var terms = unique([
      en.title || en.name,
      en.original_title || en.original_name
    ]);

    var seasons = [];
    (en.seasons || []).forEach(function (s) {
      if (s && s.season_number > 0) seasons.push({ number: s.season_number, count: s.episode_count || 0 });
    });

    return {
      isAnime: genreIds.indexOf(16) !== -1 || lang === 'ja',
      terms: terms,
      names: terms.map(normalize).filter(function (n) { return n; }),
      seasons: seasons
    };
  });
}

// ----------------------------------------------------------- season parsing
var AR_ORD = {
  '\u0627\u0644\u0627\u0648\u0644': 1, '\u0627\u0644\u062B\u0627\u0646\u064A': 2, '\u0627\u0644\u062B\u0627\u0644\u062B': 3,
  '\u0627\u0644\u0631\u0627\u0628\u0639': 4, '\u0627\u0644\u062E\u0627\u0645\u0633': 5, '\u0627\u0644\u0633\u0627\u062F\u0633': 6,
  '\u0627\u0644\u0633\u0627\u0628\u0639': 7, '\u0627\u0644\u062B\u0627\u0645\u0646': 8, '\u0627\u0644\u062A\u0627\u0633\u0639': 9,
  '\u0627\u0644\u0639\u0627\u0634\u0631': 10
};
var EN_ORD = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

// -> { season: number|null, base: normalized title without the season marker }
function seasonInfo(text) {
  var t = normalize(text);
  var m;
  var ordWords = Object.keys(EN_ORD).join('|');

  m = t.match(/\bseason (\d+)\b/);
  if (m) return { season: parseInt(m[1], 10), base: t.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
  m = t.match(/\b(\d+)(?:st|nd|rd|th) season\b/);
  if (m) return { season: parseInt(m[1], 10), base: t.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
  m = t.match(new RegExp('\\b(' + ordWords + ') season\\b'));
  if (m) return { season: EN_ORD[m[1]], base: t.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
  m = t.match(new RegExp('\\bseason (' + ordWords + ')\\b'));
  if (m) return { season: EN_ORD[m[1]], base: t.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
  m = t.match(/\u0627\u0644\u0645\u0648\u0633\u0645 (\S+)/);
  if (m) {
    var n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : AR_ORD[m[1]];
    if (n) return { season: n, base: t.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
  }
  m = t.match(/\bs(\d{1,2})\b/);
  if (m) return { season: parseInt(m[1], 10), base: t.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
  return { season: null, base: t };
}

function titleScore(base, names) {
  if (!base) return 0;
  if (names.indexOf(base) !== -1) return 100;
  var partial = names.some(function (n) {
    if (!n) return false;
    if (Math.min(n.length, base.length) < 3) return false;
    return base.indexOf(n) !== -1 || n.indexOf(base) !== -1;
  });
  return partial ? 50 : 0;
}

// ----------------------------------------------------------------- Algolia
function algoliaHeaders() {
  return {
    'X-Algolia-Application-Id': algoliaAppId,
    'X-Algolia-API-Key': algoliaApiKey,
    'User-Agent': 'Algolia for Android (3.27.0); Android (16)',
    'Content-Type': 'application/json; charset=UTF-8'
  };
}

function refreshAlgoliaKeys() {
  return getJson(firestoreUrl('Settings/constants')).then(function (json) {
    var f = json && json.fields;
    var ss = f && f.search_settings && f.search_settings.mapValue && f.search_settings.mapValue.fields;
    if (!ss) return;
    var id = sv(ss.app_id_v3) || sv(ss.app_id) || sv(ss.app_id_v2);
    var key = sv(ss.api_key);
    if (id && key) {
      algoliaAppId = id;
      algoliaApiKey = key;
      console.log(TAG, 'Algolia keys refreshed');
    }
  }).catch(function () { /* keep the old keys */ });
}

function algoliaSearch(query) {
  var body = JSON.stringify({
    params: 'attributesToRetrieve=' + encodeURIComponent(JSON.stringify(ALGOLIA_ATTRS)) +
      '&hitsPerPage=50&page=0&query=' + encodeURIComponent(query)
  });
  function once() {
    return getJson('https://' + algoliaAppId + '-dsn.algolia.net/1/indexes/series/query', {
      method: 'POST',
      headers: algoliaHeaders(),
      body: body
    });
  }
  return once()
    .catch(function () { return refreshAlgoliaKeys().then(once); })
    .then(function (json) { return (json && Array.isArray(json.hits)) ? json.hits : []; })
    .catch(function () { return []; });
}

// Choose the series entry. For TV: the entry of the requested season, or, if
// the site has no separate entry for it, the season-1 entry with absolute numbering.
function pickEntry(hits, info, mediaType, season) {
  var scored = [];
  hits.forEach(function (h) {
    if (!h || !(h.objectID || h.path)) return;
    var texts = [h.name, h.english_title].filter(function (x) { return x; });
    var marker = null;
    var score = 0;
    texts.forEach(function (t) {
      var si = seasonInfo(t);
      if (si.season && !marker) marker = si.season;
      score = Math.max(score, titleScore(si.base, info.names));
    });
    if (score < 50) return;
    var dubbed = h.dubbed === true || String(h.dubbed).toLowerCase() === 'true';
    scored.push({ hit: h, score: score, season: marker || 1, dubbed: dubbed });
  });

  function best(list) {
    var b = null;
    list.forEach(function (x) {
      if (!b || x.score > b.score || (x.score === b.score && b.dubbed && !x.dubbed)) b = x;
    });
    return b;
  }

  if (mediaType !== 'tv') {
    var m = best(scored);
    return m ? { hit: m.hit, absolute: false } : null;
  }

  var s = parseInt(season, 10) || 1;
  var exact = best(scored.filter(function (x) { return x.season === s; }));
  if (exact) return { hit: exact.hit, absolute: false };
  if (s > 1) {
    var first = best(scored.filter(function (x) { return x.season === 1; }));
    if (first) return { hit: first.hit, absolute: true };
  }
  return null;
}

// Try each title term in order until an entry is found
function findEntry(info, mediaType, season) {
  var chain = Promise.resolve(null);
  info.terms.forEach(function (term) {
    chain = chain.then(function (found) {
      if (found) return found;
      return algoliaSearch(term).then(function (hits) {
        return pickEntry(hits, info, mediaType, season);
      });
    });
  });
  return chain;
}

function animeIdOf(hit) {
  var p = hit.path || hit.doc_ref || '';
  var id = p ? String(p).replace(/^.*anime_list\//, '').replace(/^\/+/, '') : '';
  return id || String(hit.objectID);
}

// --------------------------------------------------------------- Firestore
function fetchEpisodes(animeId) {
  return getJson(firestoreUrl('anime_list/' + encId(animeId) + '/episodes_summery/summery'))
    .then(function (json) {
      var vals = (json && json.fields && json.fields.episodes && json.fields.episodes.arrayValue &&
        json.fields.episodes.arrayValue.values) || [];
      var out = [];
      vals.forEach(function (v, i) {
        var f = v && v.mapValue && v.mapValue.fields;
        if (!f) return;
        var docId = sv(f.doc_id);
        if (!docId) return;
        var no = f.number || {};
        var n = parseInt(no.integerValue !== undefined ? no.integerValue :
          (no.stringValue !== undefined ? no.stringValue : no.doubleValue), 10);
        out.push({ id: docId, number: isNaN(n) ? (i + 1) : n });
      });
      out.sort(function (a, b) { return a.number - b.number; });
      return out;
    })
    .catch(function () { return []; });
}

function parseServer(f) {
  var name = sv(f.name);
  var link = sv(f.link);
  if (!name || !link) return null;
  return {
    name: name,
    link: link,
    quality: sv(f.quality) || '',
    openBrowser: !!(f.open_browser && f.open_browser.booleanValue)
  };
}

function fetchServers(animeId, episodeId) {
  var base = 'anime_list/' + encId(animeId) + '/episodes/' + encId(episodeId);

  function fallback() {
    return getJson(firestoreUrl(base + '/servers')).then(function (json) {
      var out = [];
      ((json && json.documents) || []).forEach(function (d) {
        var f = (d && d.fields) || {};
        var visible = f.visible && f.visible.booleanValue !== undefined ? f.visible.booleanValue : true;
        var s = parseServer(f);
        if (s && visible) out.push(s);
      });
      return out;
    }).catch(function () { return []; });
  }

  return getJson(firestoreUrl(base + '/servers2/all_servers')).then(function (json) {
    var arr = (json && json.fields && json.fields.servers && json.fields.servers.arrayValue &&
      json.fields.servers.arrayValue.values) || [];
    var out = [];
    arr.forEach(function (v) {
      var f = v && v.mapValue && v.mapValue.fields;
      var s = f && parseServer(f);
      if (s) out.push(s);
    });
    return out.length ? out : fallback();
  }).catch(fallback);
}

var wordsCache = {};
function getServerWords(serverName) {
  if (wordsCache[serverName]) return Promise.resolve(wordsCache[serverName]);
  return getJson(firestoreUrl('Settings/servers/servers/' + encId(serverName))).then(function (json) {
    var f = (json && json.fields) || {};
    var w = { word1: sv(f.word1), word2: sv(f.word2), word3: sv(f.word3), word4: sv(f.word4) };
    wordsCache[serverName] = w;
    return w;
  }).catch(function () { return null; });
}

// ------------------------------------------------------- server resolvers
var PD_ID = /pixeldra(?:in\.(?:com|net|dev)|\.in)\/(?:u|api\/file)\/([A-Za-z0-9_-]+)/i;

function pixeldrainApi(id) {
  return 'https://pixeldrain.com/api/file/' + id + '?download';
}

function resolvePixeldrain(link) {
  var m = String(link).match(PD_ID);
  if (m) return Promise.resolve({ url: pixeldrainApi(m[1]) });

  // The link is a page: look for the real file link inside it
  return getText(link).then(function (html) {
    var found = null;
    var og = html.match(/<meta property="og:video" content="([^"]+)/);
    if (og) found = og[1].replace(/&amp;/g, '&');
    if (!found) {
      var rel = html.match(/href="(\/u\/[A-Za-z0-9_-]+)"/i) || html.match(/(\/u\/[A-Za-z0-9_-]+)/);
      if (rel) found = 'https://pixeldrain.com' + rel[1];
    }
    if (!found) {
      var abs = html.match(/https?:\/\/pixeldrain\.com\/u\/[A-Za-z0-9_-]+/);
      if (abs) found = abs[0];
    }
    if (!found) return null;
    var m2 = found.match(PD_ID);
    return { url: m2 ? pixeldrainApi(m2[1]) : found };
  }).catch(function () { return null; });
}

function resolveKraken(server) {
  return getServerWords(server.name).then(function (w) {
    if (!w || !w.word1 || !w.word2) return null;
    return getText(server.link).then(function (html) {
      var i = html.indexOf(w.word1);
      if (i < 0) return null;
      var rest = html.substring(i + w.word1.length);
      var j = rest.indexOf(w.word2);
      if (j < 0) return null;
      var part = rest.substring(0, j).replace(/amp;/g, '');
      if (!part) return null;
      return { url: 'https://' + part, headers: { 'Referer': 'https://krakenfiles.com/' } };
    });
  }).catch(function () { return null; });
}

function resolveServer(server) {
  if (server.openBrowser) return Promise.resolve(null);
  var name = String(server.name).toUpperCase();
  if (/\.(mp4|m3u8)(\?|$)/i.test(server.link)) return Promise.resolve({ url: server.link });
  if (name === 'PD') return resolvePixeldrain(server.link);
  if (name === 'KF') return resolveKraken(server);
  return Promise.resolve(null); // other hosts are not supported yet
}

var FRIENDLY = { PD: 'PixelDrain', KF: 'KrakenFiles' };

function buildStreams(resolved, dubbed) {
  var items = resolved.map(function (r) {
    var q = qualityNumber(r.server.quality);
    var up = String(r.server.name).toUpperCase();
    return {
      q: q,
      pref: up === 'PD' ? 0 : (up === 'KF' ? 1 : 2),
      label: (q ? q + 'p' : 'Auto') + ' ' + (FRIENDLY[up] || r.server.name) + (dubbed ? ' (\u0645\u062F\u0628\u0644\u062C)' : ''),
      url: r.res.url,
      headers: r.res.headers
    };
  });
  items.sort(function (a, b) { return b.q - a.q || a.pref - b.pref; });

  var pad = String(items.length).length;
  return items.map(function (it, i) {
    var rank = String(i + 1);
    while (rank.length < pad) rank = '0' + rank;
    var label = rank + ' - ' + it.label;
    var s = {
      name: 'AnimeWitcher',
      title: label,
      url: it.url,
      quality: label,
      provider: 'animewitcher',
      type: /\.m3u8/i.test(it.url) ? 'm3u8' : 'mp4'
    };
    if (it.headers) s.headers = it.headers;
    return s;
  });
}

// ------------------------------------------------------------------- main
function pickEpisode(episodes, found, info, mediaType, season, episode) {
  if (!episodes.length) return null;
  if (mediaType !== 'tv') return episodes[0]; // movie: the first (only) episode

  var e = parseInt(episode, 10) || 1;
  var target = e;
  if (found.absolute) {
    var s = parseInt(season, 10) || 1;
    var before = 0;
    info.seasons.forEach(function (x) { if (x.number < s) before += x.count; });
    target = before + e;
  }
  for (var i = 0; i < episodes.length; i++) {
    if (episodes[i].number === target) return episodes[i];
  }
  return null;
}

function run(tmdbId, mediaType, season, episode) {
  return getTmdbInfo(tmdbId, mediaType).then(function (info) {
    if (!info.isAnime) {
      console.log(TAG, 'Not an anime - skipped');
      return [];
    }
    return findEntry(info, mediaType, season).then(function (found) {
      if (!found) {
        console.log(TAG, 'No match found');
        return [];
      }
      var animeId = animeIdOf(found.hit);
      var dubbed = found.hit.dubbed === true || String(found.hit.dubbed).toLowerCase() === 'true';

      return fetchEpisodes(animeId).then(function (episodes) {
        var ep = pickEpisode(episodes, found, info, mediaType, season, episode);
        if (!ep) {
          console.log(TAG, 'Episode not found');
          return [];
        }
        return fetchServers(animeId, ep.id).then(function (servers) {
          return Promise.all(servers.map(function (server) {
            return resolveServer(server)
              .then(function (res) { return res ? { server: server, res: res } : null; })
              .catch(function () { return null; });
          })).then(function (list) {
            return buildStreams(list.filter(function (x) { return x; }), dubbed);
          });
        });
      });
    });
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  console.log(TAG, 'Fetching', mediaType, tmdbId, season || '', episode || '');
  return withTimeout(run(tmdbId, mediaType, season, episode), TOTAL_TIMEOUT_MS)
    .catch(function (err) {
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
