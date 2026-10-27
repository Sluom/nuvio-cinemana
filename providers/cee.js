// Nuvio provider: Cee (cee.buzz)
// Works on local IDs  ->  cee:12345   (movie)  or  cee:12345:1:2  (series, season 1 episode 2)
// Also works on TMDB IDs (live search through the Base64 endpoint).
// Promise-based only (ES5 compatible for Hermes sandbox).

var TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';

var SITE_NAME = 'Cee';
var SITE_KEY = 'cee';
var ID_PREFIX = 'cee';
var OTHER_PREFIXES = ['cinemana'];
var MAIN_URL = 'https://cee.buzz';

var API = MAIN_URL + '/api/android';
var TAG = '[' + SITE_NAME + ']';
var TIMEOUT_MS = 10000;

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

function getJson(url) {
  return withTimeout(fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'Referer': MAIN_URL
    }
  }), TIMEOUT_MS).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  });
}

// Pure JS UTF-8 to Base64 encoder (works in Hermes without btoa/Buffer)
function utf8ToBase64(str) {
  var utf8 = unescape(encodeURIComponent(String(str || '')));
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  var out = '';
  var i = 0;
  while (i < utf8.length) {
    var c1 = utf8.charCodeAt(i++);
    var c2 = i < utf8.length ? utf8.charCodeAt(i++) : NaN;
    var c3 = i < utf8.length ? utf8.charCodeAt(i++) : NaN;

    var e1 = c1 >> 2;
    var e2 = ((c1 & 3) << 4) | (c2 >> 4);
    var e3 = isNaN(c2) ? 64 : (((c2 & 15) << 2) | (c3 >> 6));
    var e4 = isNaN(c3) ? 64 : (c3 & 63);

    out += chars.charAt(e1) + chars.charAt(e2) + chars.charAt(e3) + chars.charAt(e4);
  }
  return out;
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

// Local ID parser: "cee:123"  or  "cee:123:1:2"
function parseLocalId(id, prefix) {
  var m = String(id).match(new RegExp('^' + prefix + ':(\\d+)(?::(\\d+):(\\d+))?'));
  if (!m) return null;
  return { nb: m[1], season: m[2] || null, episode: m[3] || null };
}

function hasOtherPrefix(id) {
  var s = String(id);
  for (var i = 0; i < OTHER_PREFIXES.length; i++) {
    if (s.indexOf(OTHER_PREFIXES[i] + ':') === 0) return true;
  }
  return false;
}

// 1) TMDB id -> English, Original, and Arabic titles + year
function tmdbOne(tmdbId, kind, lang) {
  var url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId +
    '?api_key=' + TMDB_API_KEY + '&language=' + lang;
  return getJson(url).catch(function () { return null; });
}

function getTmdbInfo(tmdbId, mediaType) {
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  return Promise.all([
    tmdbOne(tmdbId, kind, 'en-US'),
    tmdbOne(tmdbId, kind, 'ar-SA')
  ]).then(function (res) {
    var en = res[0];
    var ar = res[1];
    if (!en && !ar) throw new Error('TMDB lookup failed');
    var primary = en || ar;
    var date = primary.release_date || primary.first_air_date || '';
    var rawTerms = [];
    if (en) {
      rawTerms.push(en.title || en.name);
      rawTerms.push(en.original_title || en.original_name);
    }
    if (ar) {
      rawTerms.push(ar.title || ar.name);
    }
    var terms = unique(rawTerms);
    return {
      terms: terms,
      names: terms.map(normalize).filter(function (n) { return n; }),
      year: parseInt(date.substring(0, 4), 10) || null
    };
  });
}

// 2) Search Cee using the captured Base64 endpoint
function searchSite(term) {
  if (!term) return Promise.resolve([]);
  var b64 = utf8ToBase64(term.trim());
  var url = API + '/video/V/2/itemsPerPage/20/video_title_search/' + b64 +
    '/itemsPerPage/12/pageNumber/0/level/0';
  return getJson(url)
    .then(function (list) { return Array.isArray(list) ? list : []; })
    .catch(function () { return []; });
}

// 3) Pick the best match: title + year
function titleScore(itemTitle, names) {
  var t = normalize(itemTitle);
  if (!t) return 0;
  if (names.indexOf(t) !== -1) return 100;
  var partial = names.some(function (n) {
    if (Math.min(n.length, t.length) < 3) return false;
    return t.indexOf(n) !== -1 || n.indexOf(t) !== -1;
  });
  return partial ? 50 : 0;
}

function pickBest(results, info, mediaType) {
  var wantSeries = mediaType === 'tv';
  var best = null;
  var bestScore = 0;

  results.forEach(function (it) {
    if (!it || !it.nb) return;
    if (it.kind !== undefined && it.kind !== null) {
      var isSeries = parseInt(it.kind, 10) === 2;
      if (isSeries !== wantSeries) return;
    }

    var score = Math.max(titleScore(it.en_title, info.names), titleScore(it.ar_title, info.names));
    if (score === 0) return;

    var y = parseInt(it.year, 10);
    if (info.year && y) {
      if (y === info.year) score += 30;
      else if (Math.abs(y - info.year) === 1) score += 10;
      else if (!wantSeries) score -= 60;
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  });

  return bestScore >= 50 ? best : null;
}

function findItem(info, mediaType) {
  var chain = Promise.resolve(null);
  info.terms.forEach(function (term) {
    chain = chain.then(function (found) {
      if (found) return found;
      return searchSite(term).then(function (res) {
        return pickBest(res, info, mediaType);
      });
    });
  });
  return chain;
}

// 4) Resolve episode or movie videoId
function resolveVideoId(item, mediaType, season, episode) {
  if (mediaType !== 'tv') return Promise.resolve(String(item.nb));

  var s = parseInt(season, 10) || 1;
  var e = parseInt(episode, 10) || 1;
  return getJson(API + '/videoSeason/id/' + item.nb).then(function (eps) {
    if (!Array.isArray(eps)) return null;
    for (var i = 0; i < eps.length; i++) {
      var ep = eps[i];
      if (parseInt(ep.season, 10) === s && parseInt(ep.episodeNummer, 10) === e) {
        return String(ep.nb);
      }
    }
    return null;
  });
}

function qualityNumber(resolution) {
  var m = String(resolution || '').match(/(\d{3,4})/);
  if (m) return parseInt(m[1], 10);
  if (/4k/i.test(String(resolution))) return 2160;
  return 0;
}

// 5) Fetch playable stream links
function fetchStreams(videoId) {
  return getJson(API + '/transcoddedFiles/id/' + videoId).then(function (files) {
    if (!Array.isArray(files)) return [];
    var out = files
      .filter(function (f) { return f && f.videoUrl; })
      .map(function (f) {
        var q = qualityNumber(f.resolution);
        var label = q ? q + 'p' : (f.resolution || 'Auto');
        return {
          name: SITE_NAME,
          title: SITE_NAME + ' ' + label,
          url: f.videoUrl,
          quality: label,
          provider: SITE_KEY,
          type: /\.m3u8/i.test(f.videoUrl) ? 'm3u8' : 'mp4',
          _q: q,
          _label: label
        };
      });
    out.sort(function (a, b) { return b._q - a._q; });

    // Rank prefix so alphabetical order = quality order
    var pad = String(out.length).length;
    out.forEach(function (o, i) {
      var rank = String(i + 1);
      while (rank.length < pad) rank = '0' + rank;
      var label = rank + ' - ' + o._label;
      o.title = SITE_NAME + ' ' + label;
      o.quality = label;
      delete o._q;
      delete o._label;
    });
    return out;
  });
}

function logError(err) {
  console.log(TAG, 'Error:', err && err.message ? err.message : err);
  return [];
}

function getStreams(id, mediaType, season, episode) {
  mediaType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  console.log(TAG, 'Fetching', mediaType, id, season || '', episode || '');

  // A) ID belongs to the other site -> not mine, return nothing
  if (hasOtherPrefix(id)) {
    console.log(TAG, 'ID is for another provider, skipping:', id);
    return Promise.resolve([]);
  }

  // B) My own local ID: cee:12345 (or cee:12345:S:E)
  var local = parseLocalId(id, ID_PREFIX);
  if (local) {
    console.log(TAG, 'Local ID detected:', local.nb);
    var s = season || local.season;
    var e = episode || local.episode;
    var resolvePromise = (mediaType === 'tv')
      ? resolveVideoId({ nb: local.nb }, mediaType, s, e)
      : Promise.resolve(local.nb);

    return resolvePromise
      .then(function (videoId) {
        return videoId ? fetchStreams(videoId) : [];
      })
      .catch(logError);
  }

  // C) TMDB ID -> search on the site
  var tmdbIdMatch = String(id).match(/^tmdb:(\d+)/);
  var tmdbId = tmdbIdMatch ? tmdbIdMatch[1] : String(id);

  return getTmdbInfo(tmdbId, mediaType)
    .then(function (info) { return findItem(info, mediaType); })
    .then(function (item) {
      if (!item) {
        console.log(TAG, 'No match found on ' + SITE_NAME);
        return null;
      }
      return resolveVideoId(item, mediaType, season, episode);
    })
    .then(function (videoId) {
      return videoId ? fetchStreams(videoId) : [];
    })
    .catch(logError);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
}
if (typeof global !== 'undefined') {
  global.getStreams = getStreams;
}
