// Nuvio provider: AnimeSlayer / أنمي سلاير (anslayer.com)
// Ported from the CloudStream plugin. Promise-based only (no async/await).
//
// Flow: TMDB id -> titles (English / original)
//   -> search AnimeSlayer -> pick the series entry (and season)
//   -> anime details (episodes are embedded) -> hoster list for the episode
//   -> direct links.
//
// Supported hosters: MediaFire, Playmate (HLS), Streamtape (best effort).
// Skipped (same as the CloudStream plugin): Vinovo, Firestream.
// Only runs for anime (TMDB genre "Animation" or original language Japanese).

var TMDB_API_KEY = '16fc93e65cf8c9184b8ac53006288677';

var API = 'https://anslayer.com/anime/public';
var CLIENT_ID = 'android-app2';
var CLIENT_SECRET = '7befba6263cc14c90d2f1d6da2c5cf9b251bfbbd';
var UA = 'okhttp/5.3.2';

var TAG = '[AnimeSlayer]';
var TIMEOUT_MS = 10000;
var TOTAL_TIMEOUT_MS = 25000;

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
  var m = String(q || '').match(/(\d{3,4})p?/);
  return m ? parseInt(m[1], 10) : 0;
}

function safeUrl(u) {
  // the episode link contains a backslash (n=slug\ep) which must be encoded
  return String(u).replace(/\\/g, '%5C').replace(/ /g, '%20');
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

    var date = en.release_date || en.first_air_date || '';
    return {
      isAnime: genreIds.indexOf(16) !== -1 || lang === 'ja',
      terms: terms,
      names: terms.map(normalize).filter(function (n) { return n; }),
      seasons: seasons,
      year: parseInt(date.substring(0, 4), 10) || null
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
  function strip(match) { return t.replace(match, ' ').replace(/\s+/g, ' ').trim(); }

  m = t.match(/\bseason (\d+)\b/);
  if (m) return { season: parseInt(m[1], 10), base: strip(m[0]) };
  m = t.match(/\b(\d+)(?:st|nd|rd|th) season\b/);
  if (m) return { season: parseInt(m[1], 10), base: strip(m[0]) };
  m = t.match(new RegExp('\\b(' + ordWords + ') season\\b'));
  if (m) return { season: EN_ORD[m[1]], base: strip(m[0]) };
  m = t.match(new RegExp('\\bseason (' + ordWords + ')\\b'));
  if (m) return { season: EN_ORD[m[1]], base: strip(m[0]) };
  m = t.match(/\u0627\u0644\u0645\u0648\u0633\u0645 (\S+)/);
  if (m) {
    var n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : AR_ORD[m[1]];
    if (n) return { season: n, base: strip(m[0]) };
  }
  m = t.match(/\bs(\d{1,2})\b/);
  if (m) return { season: parseInt(m[1], 10), base: strip(m[0]) };
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

// --------------------------------------------------------------- AnimeSlayer
function apiHeaders() {
  return {
    'client-id': CLIENT_ID,
    'client-secret': CLIENT_SECRET,
    'User-Agent': UA,
    'Accept': 'application/*+json'
  };
}

function apiGet(path, params) {
  var qs = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return getJson(API + '/' + path + '?' + qs, { headers: apiHeaders() });
}

function searchSite(term) {
  var j = JSON.stringify({
    _offset: 0, _limit: 30, _order_by: 'latest_first',
    list_type: 'filter', anime_name: term, just_info: 'Yes'
  });
  return apiGet('animes/get-published-animes', { json: j })
    .then(function (r) {
      return (r && r.response && Array.isArray(r.response.data)) ? r.response.data : [];
    })
    .catch(function () { return []; });
}

function pickEntry(hits, info, mediaType, season) {
  var scored = [];
  hits.forEach(function (h) {
    if (!h || !h.anime_id) return;
    var si = seasonInfo(h.anime_name);
    var score = titleScore(si.base, info.names);
    if (score < 50) return;
    scored.push({
      hit: h,
      score: score,
      season: si.season || 1,
      isMovie: /movie/i.test(String(h.anime_type || '')),
      year: parseInt(String(h.anime_release_year || '').substring(0, 4), 10) || null
    });
  });

  function best(list) {
    var b = null;
    list.forEach(function (x) { if (!b || x.score > b.score) b = x; });
    return b;
  }

  if (mediaType !== 'tv') {
    var pool = scored.filter(function (x) { return x.isMovie; });
    if (!pool.length) pool = scored;
    pool.forEach(function (x) {
      if (info.year && x.year) {
        if (x.year === info.year) x.score += 30;
        else if (Math.abs(x.year - info.year) === 1) x.score += 10;
        else x.score -= 60; // movies must be close to the TMDB year
      }
    });
    var m = best(pool);
    return (m && m.score >= 50) ? { hit: m.hit, absolute: false } : null;
  }

  var tvPool = scored.filter(function (x) { return !x.isMovie; });
  var s = parseInt(season, 10) || 1;
  var exact = best(tvPool.filter(function (x) { return x.season === s; }));
  if (exact) return { hit: exact.hit, absolute: false };
  if (s > 1) {
    var first = best(tvPool.filter(function (x) { return x.season === 1; }));
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
      return searchSite(term).then(function (hits) {
        return pickEntry(hits, info, mediaType, season);
      });
    });
  });
  return chain;
}

// anime details -> [{ number, f2 }]  (f2 = link that returns the hoster list)
function getEpisodes(animeId) {
  return apiGet('anime/get-anime-details', { anime_id: animeId, fetch_episodes: 'Yes', more_info: 'No' })
    .then(function (r) {
      var resp = r && r.response;
      var list = (resp && resp.episodes && Array.isArray(resp.episodes.data)) ? resp.episodes.data : [];
      var out = [];
      list.forEach(function (e, i) {
        var urls = Array.isArray(e.episode_urls) ? e.episode_urls : [];
        var f2 = null;
        urls.forEach(function (u) {
          if (!f2 && u && u.episode_server_name === 'muilt' && u.episode_url) f2 = u.episode_url;
        });
        if (!f2) {
          urls.forEach(function (u) {
            if (!f2 && u && u.episode_url && String(u.episode_url).indexOf('/api/f?') !== -1) f2 = u.episode_url;
          });
        }
        if (!f2) return;
        var n = parseInt(e.episode_number, 10);
        out.push({ number: isNaN(n) ? (i + 1) : n, f2: f2 });
      });
      out.sort(function (a, b) { return a.number - b.number; });
      return out;
    })
    .catch(function () { return []; });
}

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

// ------------------------------------------------------------ hoster resolvers
function resolveMediafire(url) {
  return getText(url, { 'User-Agent': UA }).then(function (html) {
    var m = html.match(/href="(https:\/\/download[^"]+)"/);
    if (!m) return null;
    var dl = m[1].replace(/&amp;/g, '&');
    var file = dl.substring(dl.lastIndexOf('/') + 1);
    try { file = decodeURIComponent(file); } catch (e) { /* keep the raw name */ }
    return {
      host: 'MediaFire',
      url: dl,
      q: qualityNumber(file),
      headers: { 'Referer': 'https://www.mediafire.com/' }
    };
  }).catch(function () { return null; });
}

function resolvePlaymate(url) {
  var id = String(url).substring(String(url).lastIndexOf('/') + 1).split('?')[0];
  return getJson('https://playmate.to/api/s', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Referer': 'https://playmate.to/',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ c: id, d: 'web' })
  }).then(function (r) {
    if (!r || !r.sx) return null;
    return { host: 'Playmate', url: r.sx, q: 0, headers: { 'Referer': 'https://playmate.to/' } };
  }).catch(function () { return null; });
}

// Best effort: the page builds the video link from two string pieces
function resolveStreamtape(url) {
  var page = String(url).replace('/e/', '/v/');
  return getText(page, { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' })
    .then(function (html) {
      var re = /getElementById\('([a-z]*link)'\)\.innerHTML\s*=\s*(['"])(.*?)\2\s*\+\s*\((['"])(.*?)\4\)((?:\.substring\(\d+\))*)/g;
      var m;
      var last = null;
      while ((m = re.exec(html)) !== null) {
        if (m[1] === 'norobotlink') continue; // decoy line
        last = m;
      }
      if (!last) return null;
      var tail = last[5];
      var subs = last[6].match(/substring\((\d+)\)/g) || [];
      subs.forEach(function (x) { tail = tail.substring(parseInt(x.match(/\d+/)[0], 10)); });
      var link = last[3] + tail;
      if (link.indexOf('//') === 0) link = 'https:' + link;
      return { host: 'Streamtape', url: link, q: 0, headers: { 'Referer': 'https://streamtape.com/' } };
    }).catch(function () { return null; });
}

function resolveHoster(url) {
  var u = String(url);
  if (/mediafire\.com/i.test(u)) return resolveMediafire(u);
  if (/playmate\.to/i.test(u)) return resolvePlaymate(u);
  if (/streamtape|strtape|streamta\.pe|tapecontent/i.test(u)) return resolveStreamtape(u);
  return Promise.resolve(null); // vinovo / firestream / others are skipped
}

function buildStreams(resolved) {
  var items = resolved.map(function (r, idx) {
    return { idx: idx, q: r.q || 0, host: r.host, url: r.url, headers: r.headers };
  });
  items.sort(function (a, b) { return b.q - a.q || a.idx - b.idx; });

  var pad = String(items.length).length;
  return items.map(function (it, i) {
    var rank = String(i + 1);
    while (rank.length < pad) rank = '0' + rank;
    var label = rank + ' - ' + (it.q ? it.q + 'p' : 'Auto') + ' ' + it.host;
    var s = {
      name: 'AnimeSlayer',
      title: label,
      url: it.url,
      quality: label,
      provider: 'animeslayer',
      type: /\.m3u8/i.test(it.url) || it.host === 'Playmate' ? 'm3u8' : 'mp4'
    };
    if (it.headers) s.headers = it.headers;
    return s;
  });
}

// ------------------------------------------------------------------- main
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
      return getEpisodes(found.hit.anime_id).then(function (episodes) {
        var ep = pickEpisode(episodes, found, info, mediaType, season, episode);
        if (!ep) {
          console.log(TAG, 'Episode not found');
          return [];
        }
        return getJson(safeUrl(ep.f2), { headers: { 'User-Agent': UA } }).then(function (hosters) {
          var urls = Array.isArray(hosters) ? hosters.filter(function (x) { return typeof x === 'string'; }) : [];
          return Promise.all(urls.map(function (u) {
            return resolveHoster(u).catch(function () { return null; });
          })).then(function (list) {
            return buildStreams(list.filter(function (x) { return x; }));
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
