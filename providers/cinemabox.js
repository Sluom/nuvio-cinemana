// Nuvio provider: CinemaBox (cinema.albox.co)
// Ported from the CloudStream plugin. Promise-based only (no async/await).
// NOTE: works only from inside Iraq.
//
// Search order: English title -> Arabic title -> original title (from TMDB).

var TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';

var API = 'https://cinema.albox.co/api/v4';
var TAG = '[CinemaBox]';
var TIMEOUT_MS = 15000;
var USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 14; 23043RP34G Build/UKQ1.240624.001)';

// Random per-session device id (the API only uses it to tell devices apart)
var DEVICE_ID = (function () {
  var s = '';
  for (var i = 0; i < 16; i++) s += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
  return s;
})();

var API_HEADERS = {
  'Accept-Language': 'en',
  'Device-Id': DEVICE_ID,
  'Device-Model': 'Xiaomi 23043RP34G',
  'Device-OS-Version': '14',
  'Device-Store': 'googleplay',
  'App-Version': '4.6.12',
  'X-Hide-Sensitive-Content': 'true',
  'X-Local-Before': 'true',
  'X-ISP-ID': '1',
  'User-Agent': USER_AGENT
};

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

function getJson(url, headers) {
  return withTimeout(fetch(url, { headers: headers || { 'Accept': 'application/json' } }), TIMEOUT_MS)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.json();
    });
}

function api(path) {
  return getJson(API + '/' + path, API_HEADERS);
}

// Arabic-aware normalisation: removes diacritics, unifies alef/ya/ta-marbuta
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

function firstNumber(text) {
  var m = String(text || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function qualityNumber(q) {
  var m = String(q || '').match(/(\d{3,4})/);
  if (m) return parseInt(m[1], 10);
  if (/4k/i.test(String(q))) return 2160;
  return 0;
}

function unique(list) {
  var out = [];
  list.forEach(function (x) {
    if (x && out.indexOf(x) === -1) out.push(x);
  });
  return out;
}

// ------------------------------------------------------------------- TMDB
function tmdbOne(tmdbId, kind, lang) {
  var url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId +
    '?api_key=' + TMDB_API_KEY + '&language=' + lang;
  return getJson(url).catch(function () { return null; });
}

// -> { titles: [english, arabic, original], year }
function getTmdbInfo(tmdbId, mediaType) {
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  return Promise.all([tmdbOne(tmdbId, kind, 'en-US'), tmdbOne(tmdbId, kind, 'ar')]).then(function (r) {
    var en = r[0] || {};
    var ar = r[1] || {};
    if (!r[0] && !r[1]) throw new Error('TMDB lookup failed');
    var date = en.release_date || en.first_air_date || ar.release_date || ar.first_air_date || '';
    return {
      titles: unique([
        en.title || en.name,
        ar.title || ar.name,
        en.original_title || en.original_name || ar.original_title || ar.original_name
      ]),
      year: parseInt(date.substring(0, 4), 10) || null
    };
  });
}

// ---------------------------------------------------------------- matching
function titleScore(cardTitle, names) {
  var t = normalize(cardTitle);
  if (!t) return 0;
  if (names.indexOf(t) !== -1) return 100;
  var partial = names.some(function (n) {
    if (!n) return false;
    var shorter = Math.min(n.length, t.length);
    if (shorter < 3) return false;
    return t.indexOf(n) !== -1 || n.indexOf(t) !== -1;
  });
  return partial ? 50 : 0;
}

function epochYear(ms) {
  var n = parseInt(ms, 10);
  if (!n) return null;
  return new Date(n).getUTCFullYear();
}

function searchTerm(term) {
  return api('search?page_size=25&page_number=1&term=' + encodeURIComponent(term))
    .then(function (res) { return (res && Array.isArray(res.results)) ? res.results : []; })
    .catch(function () { return []; });
}

function getDetails(id) {
  return api('shows/shows/dynamic/' + id).then(function (res) {
    if (res && res.post_info) return res;
    return api('shows/shows/dynamic/' + id + '?season_id=0');
  });
}

// Search one term, verify the best candidates through their details page.
function findWithTerm(term, info, mediaType) {
  var wantType = mediaType === 'tv' ? 'SERIES' : 'MOVIE';
  var names = info.titles.map(normalize).filter(function (n) { return n; });

  return searchTerm(term).then(function (results) {
    var cands = results
      .filter(function (c) { return c && c.id && String(c.type || '').toUpperCase() === wantType; })
      .map(function (c) { return { card: c, score: titleScore(c.title, names) }; })
      .filter(function (x) { return x.score >= 50; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, 3);

    return Promise.all(cands.map(function (x) {
      return getDetails(x.card.id)
        .then(function (details) { return { id: String(x.card.id), score: x.score, details: details }; })
        .catch(function () { return null; });
    })).then(function (list) {
      var best = null;
      var bestScore = 0;
      list.forEach(function (x) {
        if (!x || !x.details || !x.details.post_info) return;
        var score = x.score;
        var y = epochYear(x.details.post_info.release_date);
        if (info.year && y) {
          if (y === info.year) score += 30;
          else if (Math.abs(y - info.year) === 1) score += 10;
          else if (mediaType !== 'tv') score -= 60; // movies must be close to the TMDB year
        }
        if (score > bestScore) { bestScore = score; best = x; }
      });
      return bestScore >= 50 ? best : null;
    });
  });
}

// English -> Arabic -> original, stop at the first match
function findShow(info, mediaType) {
  var chain = Promise.resolve(null);
  info.titles.forEach(function (term) {
    chain = chain.then(function (found) {
      if (found) return found;
      return findWithTerm(term, info, mediaType);
    });
  });
  return chain;
}

// ---------------------------------------------------------------- seasons
function seasonCards(sections) {
  var out = [];
  sections.forEach(function (s) {
    (s.data || []).forEach(function (c) {
      if (!c) return;
      if (String(c.type || '').toLowerCase() === 'season' ||
          String(c.card_type || '').toLowerCase() === 'seasonposter') out.push(c);
    });
  });
  return out;
}

function buildSeasons(info, sections) {
  var seasons = [];
  var used = {};
  seasonCards(sections).forEach(function (card, index) {
    if (!card.id) return;
    var sid = String(card.id);
    if (seasons.some(function (s) { return s.id === sid; })) return;
    var number = firstNumber(card.title) || (index + 1);
    if (used[number]) {
      var max = 0;
      Object.keys(used).forEach(function (k) { max = Math.max(max, parseInt(k, 10)); });
      number = max + 1;
    }
    used[number] = true;
    seasons.push({ number: number, id: sid });
  });
  var cur = info.current_season_id;
  if (cur && !seasons.some(function (s) { return s.id === String(cur); })) {
    seasons.push({ number: parseInt(info.season_number, 10) || 1, id: String(cur) });
  }
  return seasons;
}

function episodesFromSections(sections) {
  var sec = null;
  sections.forEach(function (s) { if (!sec && s.section_type === 'episodes') sec = s; });
  var cards = (sec && sec.data) ? sec.data : [];
  var out = [];
  cards.forEach(function (ep, i) {
    if (!ep || !ep.id) return;
    out.push({
      id: String(ep.id),
      number: parseInt(ep.description, 10) || firstNumber(ep.title) || (i + 1)
    });
  });
  return out;
}

function loadSeasonEpisodes(showId, seasonId) {
  return api('shows/shows/dynamic/' + showId + '?season_id=' + seasonId)
    .catch(function () { return null; })
    .then(function (res) {
      if (res && res.post_info && String(res.post_info.current_season_id) === String(seasonId)) {
        var eps = episodesFromSections(res.sections || []);
        if (eps.length) return eps;
      }
      return api('shows/seasons/player/' + seasonId).then(function (r) {
        var out = [];
        ((r && r.episodes) || []).forEach(function (e, i) {
          if (e && e.id) out.push({ id: String(e.id), number: parseInt(e.episode_number, 10) || (i + 1) });
        });
        return out;
      });
    })
    .catch(function () { return []; });
}

// -> id used by /shows/episodes/player/{id}
function resolvePlayerId(found, mediaType, season, episode) {
  var details = found.details;
  var info = details.post_info;
  if (mediaType !== 'tv') {
    return Promise.resolve(info.episode_id ? String(info.episode_id) : found.id);
  }

  var s = parseInt(season, 10) || 1;
  var e = parseInt(episode, 10) || 1;
  var seasons = buildSeasons(info, details.sections || []);
  var target = null;
  seasons.forEach(function (x) { if (!target && x.number === s) target = x; });
  if (!target) return Promise.resolve(null);

  return loadSeasonEpisodes(found.id, target.id).then(function (eps) {
    for (var i = 0; i < eps.length; i++) {
      if (eps[i].number === e) return eps[i].id;
    }
    return null;
  });
}

// ----------------------------------------------------------------- streams
function fetchStreams(playerId) {
  return api('shows/episodes/player/' + playerId).then(function (res) {
    var vids = (res && Array.isArray(res.videos)) ? res.videos : [];
    var items = vids
      .filter(function (v) { return v && v.url; })
      .map(function (v) {
        var q = qualityNumber(v.quality);
        return { url: v.url, q: q, label: q ? q + 'p' : (String(v.quality || '') || 'Auto') };
      });
    items.sort(function (a, b) { return b.q - a.q; }); // highest quality first

    // Rank prefix keeps the order even if the app sorts alphabetically
    var pad = String(items.length).length;
    return items.map(function (it, i) {
      var rank = String(i + 1);
      while (rank.length < pad) rank = '0' + rank;
      var label = rank + ' - ' + it.label;
      return {
        name: 'CinemaBox',
        title: label,
        url: it.url,
        quality: label,
        headers: { 'User-Agent': USER_AGENT },
        provider: 'cinemabox',
        type: /\.m3u8/i.test(it.url) ? 'm3u8' : 'mp4'
      };
    });
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  console.log(TAG, 'Fetching', mediaType, tmdbId, season || '', episode || '');

  return getTmdbInfo(tmdbId, mediaType)
    .then(function (info) { return findShow(info, mediaType); })
    .then(function (found) {
      if (!found) {
        console.log(TAG, 'No match found');
        return null;
      }
      return resolvePlayerId(found, mediaType, season, episode);
    })
    .then(function (playerId) {
      return playerId ? fetchStreams(playerId) : [];
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
