// Nuvio provider: Cee (cee.buzz)  -  CEE IDs ONLY  (v2.1.0)
// Works only on local IDs:
//   cee:12345        movie, or an episode (the id of the episode itself, as in our catalog)
//   cee:12345:1:2    series id + season 1 + episode 2
// Any other id (tmdb:..., tt..., kitsu:...) is ignored: this provider returns nothing for it.
// Promise-based only, ES5 syntax only (Hermes sandbox: no async/await, no arrow functions).
//
// DEBUG_ROWS: when true and nothing can be played, one extra row is returned whose title
// explains why ("Cee DEBUG: ..."). Seeing that row proves the app really called this provider.
// Set it to false when you do not need it any more.

var DEBUG_ROWS = true;

var SITE_NAME = 'Cee';
var SITE_KEY = 'cee';
var MAIN_URL = 'https://cee.buzz';
var API = MAIN_URL + '/api/android';
var TAG = '[' + SITE_NAME + ']';
var TIMEOUT_MS = 12000;

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
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

// "cee:123"  or  "cee:123:1:2"   (also accepts the URL-encoded form "cee%3A123")
function parseCeeId(id) {
  var s = String(id === undefined || id === null ? '' : id);
  try { s = decodeURIComponent(s); } catch (e) { /* keep as is */ }
  var m = s.match(/^cee:(\d+)(?::(\d+):(\d+))?/i);
  if (!m) return null;
  return { nb: m[1], season: m[2] || null, episode: m[3] || null };
}

function qualityNumber(resolution) {
  var m = String(resolution || '').match(/(\d{3,4})/);
  if (m) return parseInt(m[1], 10);
  if (/4k/i.test(String(resolution))) return 2160;
  return 0;
}

// Series id + season + episode  ->  the episode's own id
function resolveEpisodeNb(seriesNb, season, episode) {
  var s = parseInt(season, 10) || 1;
  var e = parseInt(episode, 10) || 1;
  return getJson(API + '/videoSeason/id/' + seriesNb).then(function (eps) {
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

// Playable links of one video id (a movie id or an episode id)
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

    // Some Nuvio versions re-sort the list alphabetically; a rank prefix keeps quality order.
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

function debugRow(message) {
  if (!DEBUG_ROWS) return [];
  return [{
    name: SITE_NAME,
    title: SITE_NAME + ' DEBUG: ' + message,
    url: MAIN_URL + '/',
    quality: 'debug',
    provider: SITE_KEY,
    type: 'mp4'
  }];
}

// ------------------------------------------------------------------ entry point
function getStreams(id, mediaType, season, episode) {
  var isTv = (mediaType === 'tv' || mediaType === 'series');
  var type = isTv ? 'tv' : 'movie';

  var local = parseCeeId(id);
  if (!local) {
    // not a cee id: not mine, return nothing (no debug row, so other catalogs stay clean)
    return Promise.resolve([]);
  }
  console.log(TAG, 'Fetching', type, id, season || '', episode || '');

  var s = local.season || season;
  var e = local.episode || episode;
  var work;

  if (local.season) {
    // cee:<series>:<season>:<episode>  ->  find the episode id first
    work = resolveEpisodeNb(local.nb, local.season, local.episode).then(function (epNb) {
      return epNb ? fetchStreams(epNb) : [];
    });
  } else {
    // cee:<id>  ->  the id already is the movie / episode id: fetch directly
    work = fetchStreams(local.nb).then(function (list) {
      if (list.length || !isTv || !s || !e) return list;
      // nothing found: maybe the id is a series id and the app also gave season + episode
      return resolveEpisodeNb(local.nb, s, e).then(function (epNb) {
        return (epNb && epNb !== local.nb) ? fetchStreams(epNb) : list;
      });
    });
  }

  return work.then(function (list) {
    if (!list.length) {
      console.log(TAG, 'No streams for', id);
      return debugRow('no streams for ' + id + ' (' + type + ')');
    }
    console.log(TAG, list.length, 'streams for', id);
    return list;
  }).catch(function (err) {
    var msg = err && err.message ? err.message : String(err);
    console.log(TAG, 'Error:', msg);
    return debugRow('error ' + msg + ' (' + id + ')');
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
}
if (typeof global !== 'undefined') {
  global.getStreams = getStreams;
}
