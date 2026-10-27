// Nuvio provider: Cee (cee.buzz) - same API as Shabakaty Cinemana
// Ported from the CloudStream Cee plugin. Promise-based only (no async/await),
// because some Nuvio runtimes (Hermes sandbox) do not support it.
//
// Search order: English title -> original title (from TMDB).
// One TMDB request and at most two searches, so results come back fast.
//
// NOTE: Cee only works from inside Iraq.

var TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';

var SITE_NAME = 'Cee';
var SITE_KEY = 'cee';
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
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
    }
  }), TIMEOUT_MS).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  });
}

// Arabic-aware normalisation: removes diacritics, unifies alef / ya / ta-marbuta
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

// 1) TMDB id -> English / original title + year (one request)
function tmdbOne(tmdbId, kind, lang) {
  var url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId +
    '?api_key=' + TMDB_API_KEY + '&language=' + lang;
  return getJson(url).catch(function () { return null; });
}

function getTmdbInfo(tmdbId, mediaType) {
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  return tmdbOne(tmdbId, kind, 'en-US').then(function (en) {
    if (!en) throw new Error('TMDB lookup failed');
    var date = en.release_date || en.first_air_date || '';
    var terms = unique([
      en.title || en.name,
      en.original_title || en.original_name
    ]);
    return {
      terms: terms,
      names: terms.map(normalize).filter(function (n) { return n; }),
      year: parseInt(date.substring(0, 4), 10) || null
    };
  });
}

// 2) Search Cee (same endpoint the CloudStream plugin uses)
function searchSite(term, mediaType) {
  if (!term) return Promise.resolve([]);
  var enc = encodeURIComponent(term);
  var type = mediaType === 'tv' ? 'series' : 'movies';
  var url = API + '/AdvancedSearch?level=0&videoTitle=' + enc +
    '&staffTitle=' + enc +
    '&year=1900,' + new Date().getFullYear() +
    '&page=0&type=' + type + '&itemsPerPage=12';
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
      else if (!wantSeries) score -= 60; // movies must be close to the TMDB year
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  });

  return bestScore >= 50 ? best : null;
}

// English -> original (only if different), stop at the first match
function findItem(info, mediaType) {
  var chain = Promise.resolve(null);
  info.terms.forEach(function (term) {
    chain = chain.then(function (found) {
      if (found) return found;
      return searchSite(term, mediaType).then(function (res) {
        return pickBest(res, info, mediaType);
      });
    });
  });
  return chain;
}

// 4) For TV: find the episode's own id. For movies: the item id is enough.
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

// 5) Get the playable links
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
    out.sort(function (a, b) { return b._q - a._q; }); // highest quality first

    // Some Nuvio versions re-sort the list alphabetically by text, which puts
    // 1080p before 2160p. A rank prefix makes the alphabetical order equal
    // the quality order (1 - 2160p, 2 - 1080p, 3 - 720p, ...).
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

function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  console.log(TAG, 'Fetching', mediaType, tmdbId, season || '', episode || '');

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
