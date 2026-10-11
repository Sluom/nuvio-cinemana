// Nuvio provider: Shabakaty Cinemana (سينمانا)
// Ported from the CloudStream plugin. Promise-based only (no async/await),
// because some Nuvio runtimes (Hermes sandbox) do not support it.
//
// NOTE: Cinemana only works from inside Iraq / Earthlink network.

var TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';

var MAIN_URL = 'https://cinemana.shabakaty.cc';
var API = MAIN_URL + '/api/android';
var TAG = '[Cinemana]';

function getJson(url) {
  return fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
    }
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  });
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();
}

// 1) TMDB id -> title + year
function getTmdbInfo(tmdbId, mediaType) {
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  var url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId +
    '?api_key=' + TMDB_API_KEY + '&language=en-US';
  return getJson(url).then(function (d) {
    var date = d.release_date || d.first_air_date || '';
    return {
      title: d.title || d.name || '',
      original: d.original_title || d.original_name || '',
      year: parseInt(date.substring(0, 4), 10) || null
    };
  });
}

// 2) Search Cinemana (same endpoint the CloudStream plugin uses)
function searchCinemana(title, mediaType) {
  if (!title) return Promise.resolve([]);
  var enc = encodeURIComponent(title);
  var type = mediaType === 'tv' ? 'series' : 'movies';
  var url = API + '/AdvancedSearch?level=0&videoTitle=' + enc +
    '&staffTitle=' + enc +
    '&year=1900,' + new Date().getFullYear() +
    '&page=0&type=' + type + '&itemsPerPage=12';
  return getJson(url)
    .then(function (list) { return Array.isArray(list) ? list : []; })
    .catch(function () { return []; });
}

// 3) Pick the best match by English title + year
function pickBest(results, info, mediaType) {
  var wantSeries = mediaType === 'tv';
  var names = [normalize(info.title), normalize(info.original)].filter(function (n) { return n; });
  var best = null;
  var bestScore = 0;

  results.forEach(function (it) {
    if (!it || !it.nb) return;
    if (it.kind !== undefined && it.kind !== null) {
      var isSeries = parseInt(it.kind, 10) === 2;
      if (isSeries !== wantSeries) return;
    }
    var en = normalize(it.en_title);
    if (!en) return;

    var score = 0;
    if (names.indexOf(en) !== -1) {
      score = 100;
    } else if (names.some(function (n) { return en.indexOf(n) !== -1 || n.indexOf(en) !== -1; })) {
      score = 50;
    }
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
          name: 'Cinemana',
          title: 'Cinemana ' + label,
          url: f.videoUrl,
          quality: label,
          provider: 'cinemana',
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
      o.title = 'Cinemana ' + label;
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
    .then(function (info) {
      return searchCinemana(info.title, mediaType).then(function (res) {
        var hit = pickBest(res, info, mediaType);
        if (hit) return hit;
        if (info.original && info.original !== info.title) {
          return searchCinemana(info.original, mediaType).then(function (res2) {
            return pickBest(res2, info, mediaType);
          });
        }
        return null;
      });
    })
    .then(function (item) {
      if (!item) {
        console.log(TAG, 'No match found on Cinemana');
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
