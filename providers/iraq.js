// Nuvio provider: Cinemana + Cee merged into ONE list, ranked by quality.
// Both sites use the same API; links from both are combined and ranked
// together (2160p Cee, 2160p Cinemana, 1080p Cee, 1080p Cinemana, ...).
// Promise-based only (no async/await). Works only from inside Iraq.
// If one site is unreachable (blocked / different ISP), the other still works.

var TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';
var GROUP_NAME = 'Cinemana + Cee';
var TAG = '[Iraq]';
var TIMEOUT_MS = 15000;

// Order here = order for ties (same quality)
var SOURCES = [
  { name: 'Cee', api: 'https://cee.buzz/api/android' },
  { name: 'Cinemana', api: 'https://cinemana.shabakaty.cc/api/android' }
];

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

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim();
}

// TMDB id -> title + year (shared by both sources)
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

function searchSite(api, title, mediaType) {
  if (!title) return Promise.resolve([]);
  var enc = encodeURIComponent(title);
  var type = mediaType === 'tv' ? 'series' : 'movies';
  var url = api + '/AdvancedSearch?level=0&videoTitle=' + enc +
    '&staffTitle=' + enc +
    '&year=1900,' + new Date().getFullYear() +
    '&page=0&type=' + type + '&itemsPerPage=12';
  return getJson(url)
    .then(function (list) { return Array.isArray(list) ? list : []; })
    .catch(function () { return []; });
}

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
      else if (!wantSeries) score -= 60;
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  });

  return bestScore >= 50 ? best : null;
}

function resolveVideoId(api, item, mediaType, season, episode) {
  if (mediaType !== 'tv') return Promise.resolve(String(item.nb));

  var s = parseInt(season, 10) || 1;
  var e = parseInt(episode, 10) || 1;
  return getJson(api + '/videoSeason/id/' + item.nb).then(function (eps) {
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

// One site -> raw list of { src, q, label, url }
function streamsFromSite(src, srcIndex, info, mediaType, season, episode) {
  return searchSite(src.api, info.title, mediaType)
    .then(function (res) {
      var hit = pickBest(res, info, mediaType);
      if (hit) return hit;
      if (info.original && info.original !== info.title) {
        return searchSite(src.api, info.original, mediaType).then(function (res2) {
          return pickBest(res2, info, mediaType);
        });
      }
      return null;
    })
    .then(function (item) {
      if (!item) {
        console.log(TAG, src.name, 'no match');
        return null;
      }
      return resolveVideoId(src.api, item, mediaType, season, episode);
    })
    .then(function (videoId) {
      if (!videoId) return [];
      return getJson(src.api + '/transcoddedFiles/id/' + videoId).then(function (files) {
        if (!Array.isArray(files)) return [];
        return files
          .filter(function (f) { return f && f.videoUrl; })
          .map(function (f) {
            var q = qualityNumber(f.resolution);
            return {
              srcName: src.name,
              srcIndex: srcIndex,
              q: q,
              label: q ? q + 'p' : (f.resolution || 'Auto'),
              url: f.videoUrl
            };
          });
      });
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  console.log(TAG, 'Fetching', mediaType, tmdbId, season || '', episode || '');

  return getTmdbInfo(tmdbId, mediaType)
    .then(function (info) {
      return Promise.all(SOURCES.map(function (src, i) {
        return withTimeout(streamsFromSite(src, i, info, mediaType, season, episode), TIMEOUT_MS)
          .catch(function (err) {
            console.log(TAG, src.name, 'failed:', err && err.message ? err.message : err);
            return [];
          });
      }));
    })
    .then(function (lists) {
      var all = [];
      lists.forEach(function (l) { all = all.concat(l); });

      // Highest quality first; same quality -> source order (Cee, then Cinemana)
      all.sort(function (a, b) {
        if (b.q !== a.q) return b.q - a.q;
        return a.srcIndex - b.srcIndex;
      });

      // Rank prefix so an alphabetical sort in the app keeps this exact order
      var pad = String(all.length).length;
      return all.map(function (s, i) {
        var rank = String(i + 1);
        while (rank.length < pad) rank = '0' + rank;
        var label = rank + ' - ' + s.label + ' ' + s.srcName;
        return {
          name: GROUP_NAME,
          title: label,
          url: s.url,
          quality: label,
          provider: 'iraq',
          type: /\.m3u8/i.test(s.url) ? 'm3u8' : 'mp4'
        };
      });
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
