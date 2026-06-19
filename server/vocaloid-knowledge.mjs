import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const VOCADB_BASE_URL = process.env.VOCADB_BASE_URL || 'https://vocadb.net';
const VOCADB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const VOCADB_USER_AGENT = process.env.VOCADB_USER_AGENT || 'MikuTownGame/0.1 (VocaDB lookup for in-game chat)';
const VOCALOID_LYRICS_API_URL = process.env.VOCALOID_LYRICS_API_URL || 'https://vocaloidlyrics.miraheze.org/w/api.php';
const VOCALOID_WIKI_API_URL = process.env.VOCALOID_WIKI_API_URL || 'https://voca.wiki/api.php';
const VOCALOID_LYRICS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const vocaDbCache = new Map();
const lyricsCache = new Map();
const execFileAsync = promisify(execFile);

const logLookup = (stage, payload) => {
  console.info(`[vocaloid-search] ${stage}`, JSON.stringify(payload, null, 2));
};

const normalizeQuery = (query) => (
  String(query || '')
    .replace(/[“”「」『』《》]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
);

const getCached = (key) => {
  const cached = vocaDbCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.createdAt > VOCADB_CACHE_TTL_MS) {
    vocaDbCache.delete(key);
    return undefined;
  }
  return cached.value;
};

const setCached = (key, value) => {
  vocaDbCache.set(key, { createdAt: Date.now(), value });
};

const getLyricsCached = (key) => {
  const cached = lyricsCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.createdAt > VOCALOID_LYRICS_CACHE_TTL_MS) {
    lyricsCache.delete(key);
    return undefined;
  }
  return cached.value;
};

const setLyricsCached = (key, value) => {
  lyricsCache.set(key, { createdAt: Date.now(), value });
};

const pick = (object, ...keys) => {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
};

const normalizeArtistName = (artistEntry) => {
  const artist = pick(artistEntry, 'artist', 'Artist') ?? artistEntry;
  const name = pick(artist, 'name', 'Name', 'defaultName', 'DefaultName');
  const role = pick(artistEntry, 'categories', 'Categories');
  if (!name) return undefined;
  return role ? `${name} (${role})` : String(name);
};

const normalizePv = (pv) => {
  const service = pick(pv, 'service', 'Service');
  const url = pick(pv, 'url', 'Url');
  const name = pick(pv, 'name', 'Name', 'pvType', 'PVType');
  if (!url && !service) return undefined;
  return [service, name, url].filter(Boolean).join(': ');
};

const normalizeSongEntry = (entry) => {
  const id = pick(entry, 'id', 'Id');
  const name = pick(entry, 'name', 'Name', 'defaultName', 'DefaultName');
  const additionalNames = pick(entry, 'additionalNames', 'AdditionalNames');
  const artistString = pick(entry, 'artistString', 'ArtistString');
  const publishDate = pick(entry, 'publishDate', 'PublishDate');
  const songType = pick(entry, 'songType', 'SongType');
  const artistsRaw = pick(entry, 'artists', 'Artists');
  const pvsRaw = pick(entry, 'pvs', 'PVs');
  const artists = Array.isArray(artistsRaw)
    ? artistsRaw.map(normalizeArtistName).filter(Boolean).slice(0, 8)
    : [];
  const pvs = Array.isArray(pvsRaw)
    ? pvsRaw.map(normalizePv).filter(Boolean).slice(0, 4)
    : [];

  return {
    id,
    name: name ? String(name) : '',
    additionalNames: additionalNames ? String(additionalNames) : '',
    artistString: artistString ? String(artistString) : '',
    artists,
    songType: songType ? String(songType) : '',
    publishDate: publishDate ? String(publishDate) : '',
    pvs,
    url: id ? `https://vocadb.net/S/${id}` : '',
    source: 'VocaDB',
  };
};

const extractItems = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.Items)) return data.Items;
  return [];
};

const cleanText = (value, maxLength = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
const cleanMultilineText = (value, maxLength = 18000) => String(value ?? '')
  .split('\n')
  .map((line) => line.replace(/[ \t]+/g, ' ').trim())
  .filter(Boolean)
  .join('\n')
  .slice(0, maxLength);

const normalizeLookupText = (value) => cleanText(value, 240)
  .toLowerCase()
  .normalize('NFKC')
  .replace(/[《》「」『』“”"'’‘`´·・\s_\-—–,.，。:：/／\\|｜()[\]（）【】!?！？♡☆★]/gu, '');

const stripSearchNoise = (query) => cleanText(query, 160)
  .replace(/歌词|歌詞|lyrics?|第一句|副歌|主歌|桥段|橋段|词|詞/giu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const expandLyricsQueries = (query) => {
  const text = stripSearchNoise(query);
  if (!text) return [];
  return [
    text,
    text.replace(/[A-Za-z0-9_*.-]+/g, ' '),
    ...text.split(/\s+|[，、,／/|｜]+/u),
  ]
    .map(stripSearchNoise)
    .filter((item) => item.length >= 2);
};

const lyricsApiUrl = (params) => {
  const url = new URL(VOCALOID_LYRICS_API_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  return url;
};

const vocaWikiApiUrl = (params) => {
  const url = new URL(VOCALOID_WIKI_API_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');
  return url;
};

const fetchLyricsJson = async (url) => {
  const cacheKey = `raw::${url.toString()}`;
  const cached = getLyricsCached(cacheKey);
  if (cached) return cached;

  // Miraheze currently challenges Node's native fetch from this environment,
  // while curl receives the MediaWiki JSON API normally.
  const { stdout } = await execFileAsync('curl', [
    '-sL',
    '--fail',
    '--max-time', '12',
    '-H', 'Accept: application/json',
    '-H', 'User-Agent: MikuTownGame/0.1 lyrics lookup',
    url.toString(),
  ], { maxBuffer: 2 * 1024 * 1024 });
  const payload = JSON.parse(stdout);
  setLyricsCached(cacheKey, payload);
  return payload;
};

const parseInfoboxField = (wikitext, field) => {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = wikitext.match(new RegExp(`\\|${escaped}\\s*=\\s*([^\\n]+)`, 'iu'));
  if (!match) return '';
  return cleanText(match[1]
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/<br\s*\/?>/giu, ', ')
    .replace(/'''+/g, '')
    .replace(/\{\{[^{}]*\}\}/g, ''), 240);
};

const extractLyricsBlock = (wikitext) => {
  const start = wikitext.search(/^==\s*(Lyrics|歌词|歌詞)\s*==/imu);
  if (start < 0) return '';
  const rest = wikitext.slice(start);
  const next = rest.slice(1).search(/\n==[^=]/u);
  return next >= 0 ? rest.slice(0, next + 1) : rest;
};

const cleanLyricCell = (value, maxLength = 260) => cleanText(String(value ?? '')
  .replace(/<ref[^>]*>[\s\S]*?<\/ref>/giu, '')
  .replace(/<br\s*\/?>/giu, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/\{\{lj\|([^{}|]+)\}\}/giu, '$1')
  .replace(/\{\{Photrans\|([^{}|]+)\}\}/giu, '$1')
  .replace(/\{\{lang\|[^{}|]+\|([^{}]+)\}\}/giu, '$1')
  .replace(/\{\{振假名\|template=Photrans\|/giu, '')
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
  .replace(/\[\[([^\]]+)\]\]/g, '$1')
  .replace(/\{\{[^{}]*\}\}/g, '')
  .replace(/'{2,}/g, '')
  .replace(/#NoHover/giu, ' ')
  .replace(/@\d+/g, '')
  .replace(/[{}|]/g, ' '), maxLength);

const parseLyricsRows = (lyricsBlock) => {
  if (!lyricsBlock.includes('{|')) return [];
  const rows = [];
  let current = [];
  lyricsBlock.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (line.startsWith('|-')) {
      if (current.length) rows.push(current);
      current = [];
      return;
    }
    if (!line.startsWith('|') || line.startsWith('{|') || line.startsWith('|}')) return;
    const cell = cleanLyricCell(line.slice(1));
    if (!cell || cell.startsWith('!') || /lyrics header|lyrics table|class=|rowspan=|colspan=/i.test(cell)) return;
    current.push(cell);
  });
  if (current.length) rows.push(current);
  return rows.filter((row) => row.some((cell) => cell && cell !== '<br />'));
};

const extractNamedTemplateField = (wikitext, fieldName) => {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\n\\|${escaped}\\s*=\\s*([\\s\\S]*?)(?=\\n\\|[a-zA-Z_\\u4e00-\\u9fff]+\\s*=|\\n\\}\\})`, 'iu');
  return wikitext.match(pattern)?.[1] || '';
};

const parseLyricsKaiRows = (lyricsBlock) => {
  const original = extractNamedTemplateField(lyricsBlock, 'original');
  const translated = extractNamedTemplateField(lyricsBlock, 'translated');
  const originals = original.split('\n').map((line) => cleanLyricCell(line, 180)).filter(isUsefulLyricCell);
  const translations = translated.split('\n').map((line) => cleanLyricCell(line, 180)).filter(isUsefulLyricCell);
  const length = Math.max(originals.length, translations.length);
  return Array.from({ length }, (_, index) => [originals[index] || '', '', translations[index] || ''])
    .filter((row) => row.some(Boolean));
};

const isUsefulLyricCell = (cell) => {
  const value = cleanText(cell, 160);
  if (!value || value.length < 2) return false;
  if (/^(miku|teto|rin|len|gumi|luka|meiko|kaito|flower|vflower|vocal|singer)$/iu.test(value)) return false;
  if (/lyrics header|lyrics table|class=|rowspan=|colspan=|^-+$|^\{\{|[}][}]$/iu.test(value)) return false;
  return /[\p{Letter}\p{Number}\u3040-\u30ff\u3400-\u9fff]/u.test(value);
};

const extractLyricSnippets = (rows, preferredIndex) => {
  const snippets = [];
  const seen = new Set();
  for (const row of rows) {
    const candidates = [
      preferredIndex === undefined ? undefined : row[preferredIndex],
      ...row,
    ].filter(Boolean);
    const cell = candidates.find(isUsefulLyricCell);
    if (!cell) continue;
    const snippet = cleanText(cell, 90);
    const key = normalizeLookupText(snippet);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    snippets.push(snippet);
    if (snippets.length >= 4) break;
  }
  return snippets;
};

const findFirstLyricCell = (rows, columnIndex = 0) => extractLyricSnippets(rows, columnIndex)[0] || '';

const buildFullLyricText = (rows, preferredIndex = 0, maxLength = 14000) => {
  const lines = [];
  for (const row of rows) {
    const cell = row[preferredIndex] || row.find(isUsefulLyricCell);
    if (!isUsefulLyricCell(cell)) continue;
    lines.push(cleanText(cell, 220));
  }
  return cleanMultilineText(lines.join('\n'), maxLength);
};

const buildFullParallelText = (rows, maxLength = 18000) => {
  const lines = [];
  for (const row of rows) {
    const original = isUsefulLyricCell(row[0]) ? cleanText(row[0], 220) : '';
    const translation = isUsefulLyricCell(row[2]) ? cleanText(row[2], 240) : '';
    if (!original && !translation) continue;
    lines.push(translation ? `${original} => ${translation}` : original);
  }
  return cleanMultilineText(lines.join('\n'), maxLength);
};

const buildLyricDigest = (rows) => {
  const english = rows.map((row) => row[2]).filter(Boolean);
  const romaji = rows.map((row) => row[1]).filter(Boolean);
  return [
    english.length ? `英文翻译行数约 ${english.length}` : '',
    romaji.length ? `罗马字行数约 ${romaji.length}` : '',
    rows.length ? `歌词表格行数约 ${rows.length}` : '',
  ].filter(Boolean).join('，');
};

const scoreLyricsSearchHit = (hit, terms) => {
  const title = normalizeLookupText(hit?.title);
  if (!title) return 0;
  let score = 0;
  terms.forEach((term) => {
    if (!term) return;
    if (title === term) score += 120;
    else if (title.includes(term) || term.includes(title)) score += 70;
    else if (term.length >= 3 && title.includes(term.slice(0, 3))) score += 32;
  });
  if (/album|disambiguation|lyrics wiki/i.test(hit?.title || '')) score -= 30;
  return score;
};

const parseLyricsPage = async ({ apiUrlBuilder, pageTitle, rawQuery, normalizedQueries, source, pageUrlBase, includeFullLyrics = false }) => {
  const parsePayload = await fetchLyricsJson(apiUrlBuilder({
    action: 'parse',
    page: pageTitle,
    prop: 'wikitext|sections|displaytitle',
  }));
  const wikitext = parsePayload?.parse?.wikitext?.['*'] || '';
  const lyricsBlock = extractLyricsBlock(wikitext);
  const tableRows = parseLyricsRows(lyricsBlock);
  const kaiRows = tableRows.length ? [] : parseLyricsKaiRows(lyricsBlock);
  const rows = tableRows.length ? tableRows : kaiRows;
  const resolvedTitle = parsePayload?.parse?.title || pageTitle;
  const lyricSnippets = extractLyricSnippets(rows, 0);
  const translatedSnippets = extractLyricSnippets(rows, 2);
  const fullLyricText = includeFullLyrics ? buildFullLyricText(rows, 0) : '';
  const fullTranslatedText = includeFullLyrics ? buildFullLyricText(rows, 2) : '';
  const fullParallelText = includeFullLyrics ? buildFullParallelText(rows) : '';
  return {
    query: rawQuery,
    searchedQueries: normalizedQueries,
    found: Boolean(lyricsBlock && rows.length),
    title: resolvedTitle,
    pageId: parsePayload?.parse?.pageid,
    pageUrl: `${pageUrlBase}${encodeURIComponent(String(resolvedTitle).replace(/ /g, '_'))}`,
    source,
    songTitle: parseInfoboxField(wikitext, 'songtitle')
      || parseInfoboxField(wikitext, '歌曲名称')
      || resolvedTitle,
    singer: parseInfoboxField(wikitext, 'singer') || parseInfoboxField(wikitext, '演唱'),
    producer: parseInfoboxField(wikitext, 'producer') || parseInfoboxField(wikitext, 'P主'),
    uploadDate: parseInfoboxField(wikitext, 'original upload date')
      || parseInfoboxField(wikitext, 'nnd_date')
      || parseInfoboxField(wikitext, 'bb_date')
      || parseInfoboxField(wikitext, 'yt_date'),
    description: parseInfoboxField(wikitext, 'description'),
    lyricsAvailable: Boolean(lyricsBlock && rows.length),
    lyricLineCount: rows.length,
    languages: [
      /jp:Japanese|Japanese|original=/iu.test(lyricsBlock) ? 'Japanese' : '',
      /rom:Romaji|Romaji/iu.test(lyricsBlock) ? 'Romaji' : '',
      /eng:English|English|translated=/iu.test(lyricsBlock) ? 'English/Translation' : '',
    ].filter(Boolean),
    firstLine: lyricSnippets[0] || '',
    firstRomajiLine: findFirstLyricCell(rows, 1),
    firstEnglishLine: translatedSnippets[0] || findFirstLyricCell(rows, 2),
    lyricSnippets,
    translatedSnippets,
    fullLyricsAvailable: Boolean(includeFullLyrics && fullLyricText),
    fullLyricText,
    fullTranslatedText,
    fullParallelText,
    digest: buildLyricDigest(rows),
  };
};

const searchLyricsSource = async ({ apiUrlBuilder, normalizedQueries, terms, rawQuery, source, pageUrlBase, includeFullLyrics = false }) => {
  const searchPayloads = await Promise.all(normalizedQueries.slice(0, 3).map(async (searchQuery) => {
    const url = apiUrlBuilder({
      action: 'query',
      list: 'search',
      srsearch: searchQuery,
      srlimit: '8',
    });
    const payload = await fetchLyricsJson(url);
    const hits = Array.isArray(payload?.query?.search) ? payload.query.search : [];
    return { searchQuery, hits };
  }));

  const hits = searchPayloads.flatMap(({ searchQuery, hits: searchHits }) => (
    searchHits.map((hit) => ({ ...hit, searchQuery, score: scoreLyricsSearchHit(hit, terms) }))
  ));
  const rankedHits = hits
    .filter((hit, index, list) => hit?.title && list.findIndex((item) => item.title === hit.title) === index)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  let fallback;
  for (const hit of rankedHits) {
    const parsed = await parseLyricsPage({ apiUrlBuilder, pageTitle: hit.title, rawQuery, normalizedQueries, source, pageUrlBase, includeFullLyrics });
    if (!fallback) fallback = parsed;
    if (parsed.found && parsed.lyricsAvailable) return parsed;
  }
  return fallback;
};

export const searchVocaloidLyrics = async (query, options = {}) => {
  const rawQuery = cleanText(query, 180);
  const song = options.song && typeof options.song === 'object' ? options.song : {};
  const includeFullLyrics = Boolean(options.includeFullLyrics);
  const candidateQueries = [
    song.name,
    song.additionalNames,
    rawQuery,
    `${song.name || rawQuery} ${song.artistString || ''}`,
  ]
    .flatMap((item) => cleanText(item, 220).split(/\s*,\s*/u))
    .flatMap(expandLyricsQueries)
    .map(stripSearchNoise)
    .filter((item) => item.length >= 2);
  const normalizedQueries = [...new Set(candidateQueries)].slice(0, 5);
  const cacheKey = `lyrics::${includeFullLyrics ? 'full' : 'short'}::${normalizedQueries.join('|')}`;
  const cached = getLyricsCached(cacheKey);
  if (cached) return cached;

  if (!normalizedQueries.length) {
    return { query: rawQuery, found: false, error: 'EMPTY_QUERY', source: 'Vocaloid Lyrics Wiki' };
  }

  try {
    const terms = normalizedQueries.map(normalizeLookupText).filter(Boolean);
    const lyricWikiResult = await searchLyricsSource({
      apiUrlBuilder: lyricsApiUrl,
      normalizedQueries,
      terms,
      rawQuery,
      source: 'Vocaloid Lyrics Wiki',
      pageUrlBase: 'https://vocaloidlyrics.miraheze.org/wiki/',
      includeFullLyrics,
    });
    if (lyricWikiResult?.found && lyricWikiResult.lyricsAvailable) {
      setLyricsCached(cacheKey, lyricWikiResult);
      logLookup('lyrics-result', {
        query: rawQuery,
        title: lyricWikiResult.title,
        found: lyricWikiResult.found,
        lyricLineCount: lyricWikiResult.lyricLineCount,
        source: lyricWikiResult.source,
      });
      return lyricWikiResult;
    }

    const vocaWikiResult = await searchLyricsSource({
      apiUrlBuilder: vocaWikiApiUrl,
      normalizedQueries,
      terms,
      rawQuery,
      source: 'VOCALOID中文歌词Wiki',
      pageUrlBase: 'https://voca.wiki/',
      includeFullLyrics,
    });
    const result = vocaWikiResult?.found && vocaWikiResult.lyricsAvailable ? vocaWikiResult : lyricWikiResult;
    if (!result?.title) {
      const payload = {
        query: rawQuery,
        searchedQueries: normalizedQueries,
        found: false,
        error: 'NO_LYRICS_PAGE_MATCH',
        source: 'Vocaloid Lyrics Wiki',
      };
      setLyricsCached(cacheKey, payload);
      return payload;
    }
    setLyricsCached(cacheKey, result);
    logLookup('lyrics-result', {
      query: rawQuery,
      title: result.title,
      found: result.found,
      lyricLineCount: result.lyricLineCount,
      source: result.source,
    });
    return result;
  } catch (error) {
    const payload = {
      query: rawQuery,
      searchedQueries: normalizedQueries,
      found: false,
      error: error instanceof Error ? error.message : 'LYRICS_LOOKUP_FAILED',
      source: 'Vocaloid Lyrics Wiki',
    };
    setLyricsCached(cacheKey, payload);
    logLookup('lyrics-error', payload);
    return payload;
  }
};

export const searchVocaDbSongs = async (query, options = {}) => {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return { query: normalizedQuery, results: [], error: undefined };

  const maxEntries = Math.max(1, Math.min(Number(options.maxEntries || 4), 8));
  const cacheKey = `${normalizedQuery}::${maxEntries}`;
  const cached = getCached(cacheKey);
  if (cached) {
    logLookup('cache-hit', {
      query: normalizedQuery,
      count: cached.results?.length ?? 0,
      error: cached.error,
    });
    return cached;
  }

  const url = new URL('/api/songs', VOCADB_BASE_URL);
  url.searchParams.set('query', normalizedQuery);
  url.searchParams.set('maxResults', String(maxEntries));
  url.searchParams.set('lang', 'Default');
  url.searchParams.set('nameMatchMode', 'Auto');
  url.searchParams.set('fields', 'Artists,Names,PVs,Tags');
  logLookup('vocadb-request', { query: normalizedQuery, url: url.toString() });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': VOCADB_USER_AGENT,
      },
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      throw new Error(`VOCADB_HTTP_${response.status}`);
    }
    if (!contentType.includes('json')) {
      throw new Error('VOCADB_NON_JSON_RESPONSE');
    }
    const data = await response.json();
    const results = extractItems(data).map(normalizeSongEntry).filter((entry) => entry.name).slice(0, maxEntries);
    const payload = {
      query: normalizedQuery,
      results,
      error: undefined,
      primary: 'VocaDB',
      debug: {
        vocadbUrl: url.toString(),
        status: response.status,
        contentType,
      },
    };
    logLookup('vocadb-result', {
      query: normalizedQuery,
      count: results.length,
      titles: payload.results.map((entry) => `${entry.name}${entry.artistString ? ` - ${entry.artistString}` : ''}`),
    });
    setCached(cacheKey, payload);
    return payload;
  } catch (error) {
    logLookup('vocadb-error', {
      query: normalizedQuery,
      error: error instanceof Error ? error.message : 'VOCADB_LOOKUP_FAILED',
    });
    const payload = {
      query: normalizedQuery,
      results: [],
      error: error instanceof Error ? error.message : 'VOCADB_LOOKUP_FAILED',
      primary: 'VocaDB',
      debug: {
        vocadbUrl: url.toString(),
      },
    };
    logLookup('lookup-result', {
      query: normalizedQuery,
      count: 0,
      error: payload.error,
    });
    setCached(cacheKey, payload);
    return payload;
  }
};

export const buildVocaloidObservation = (lookups) => {
  if (!Array.isArray(lookups) || lookups.length === 0) {
    return '本轮没有触发术力口资料库检索。';
  }

  return lookups.map((lookup, lookupIndex) => {
    const lines = [`检索 ${lookupIndex + 1}: "${lookup.query}"`];
    lines.push('注意: 检索词来自用户说法，可能不是正式歌名；回答时必须以条目里的“正式歌名”为准。');
    if (lookup.error) {
      lines.push(`状态: VocaDB 检索失败 (${lookup.error})`);
      if (!lookup.results.length) return lines.join('\n');
    }
    if (!lookup.results.length) {
      lines.push('状态: 未找到明确匹配。');
      return lines.join('\n');
    }

    lookup.results.forEach((song, index) => {
      lines.push([
        `${index + 1}. 正式歌名: ${song.name}`,
        song.matchKind ? `匹配方式: ${song.matchKind}${song.matchConfidence ? `/${song.matchConfidence}` : ''}` : '',
        song.matchReason ? `匹配说明: ${song.matchReason}` : '',
        song.matchKind === 'fuzzy' || song.matchConfidence === 'low' ? '注意: 这是模糊或低置信度候选，歌名不一定准确，必须按玩家上下文判断；上下文不支持时忽略。' : '',
        song.additionalNames ? `别名: ${song.additionalNames}` : '',
        song.artistString ? `作者/歌手: ${song.artistString}` : '',
        song.artists.length ? `关联艺术家: ${song.artists.join(', ')}` : '',
        song.songType ? `类型: ${song.songType}` : '',
        song.publishDate ? `发布日期: ${song.publishDate}` : '',
        song.url ? `资料链接: ${song.url}` : '',
      ].filter(Boolean).join(' | '));
    });
    return lines.join('\n');
  }).join('\n\n');
};

export const handleVocaloidSearchRequest = async (req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const query = requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '';
  const result = await searchVocaDbSongs(query);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(result));
};

export const handleVocaloidLyricsRequest = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
    return;
  }

  try {
    let query = '';
    let song;
    let includeFullLyrics = false;
    if (req.method === 'GET') {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      query = requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '';
      includeFullLyrics = requestUrl.searchParams.get('full') === '1' || requestUrl.searchParams.get('includeFullLyrics') === 'true';
    } else {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw.trim() ? JSON.parse(raw) : {};
      query = body.query || body.q || body.song?.name || '';
      song = body.song;
      includeFullLyrics = Boolean(body.includeFullLyrics || body.fullLyrics || body.full);
    }
    const result = await searchVocaloidLyrics(query, { song, includeFullLyrics });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'LYRICS_LOOKUP_FAILED' }));
  }
};
