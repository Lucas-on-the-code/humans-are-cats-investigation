import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://voca.wiki/api.php';
const CATEGORY_TITLE = 'Category:Biliboard术力口周榜';
const OUTPUT_PATH = process.env.BILIBOARD_DB_OUTPUT
  || join(fileURLToPath(new URL('..', import.meta.url)), 'public/data/biliboard-hot-songs.json');
const REQUEST_DELAY_MS = 120;
const ENRICH_SONG_PAGES = process.env.SKIP_SONG_ENRICH !== '1';
// Fallback guards: refuse to overwrite the existing DB unless the fresh build is sane.
// NOTE: biliboard.uk's public API is blocked by Cloudflare for the production server's
// IP, so the data source is voca.wiki's "Biliboard术力口周榜" weekly chart wikitext.
const MIN_ISSUES = 50;
const MIN_SONGS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const apiGet = async (params) => {
  const url = new URL(API_BASE);
  Object.entries({ format: 'json', ...params }).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  // voca.wiki occasionally drops a connection (transient TLS/reset); retry with backoff
  // so a single hiccup does not fail the whole weekly build. Hard timeout per attempt.
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'MikuTownGame/0.1 local hot-song database builder' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`VOCALOID_WIKI_HTTP_${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        console.info(`[biliboard-db] apiGet retry ${attempt}/3 (${error instanceof Error ? error.message : error}); backing off ${attempt * 500}ms`);
        await sleep(attempt * 500);
      }
    }
  }
  throw lastError;
};

const cleanWikiText = (value) => (
  String(value ?? '')
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/\{\{lj\|([^{}]+)\}\}/giu, '$1')
    .replace(/\{\{color\|[^|{}]+\|([^{}]+)\}\}/giu, '$1')
    .replace(/\{\{lang\|[^|{}]+\|([^{}]+)\}\}/giu, '$1')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/gu, '$2')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/'''?/gu, '')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim()
);

const normalizeKey = (value) => (
  cleanWikiText(value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[《》「」『』“”"'’‘`´·・\s_\-—–,.，。:：/／\\|｜()[\]（）【】]/gu, '')
);

const splitNames = (value) => (
  cleanWikiText(value)
    .split(/[、,，/&＆＋+]/gu)
    .map((item) => item.trim())
    .filter(Boolean)
);

const splitAliases = (value) => (
  String(value ?? '')
    .split(/<br\s*\/?>|[\n;]/giu)
    .flatMap((item) => item.split(/\s+\/\s+/gu))
    .map(cleanWikiText)
    .filter(Boolean)
);

const parseTemplateFields = (block) => {
  const fields = {};
  let currentKey = '';
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    const match = line.match(/^\|([^=]+)=(.*)$/u);
    if (match) {
      currentKey = match[1].trim();
      fields[currentKey] = match[2].trim();
    } else if (currentKey && line.trim()) {
      fields[currentKey] = `${fields[currentKey]}\n${line.trim()}`;
    }
  }
  return fields;
};

const parseIssueNumber = (title) => {
  const match = title.match(/\/第(\d+)期$/u);
  return match ? Number(match[1]) : undefined;
};

// Parse a CN wall-clock string like "2026-06-17 18:00:00" as Beijing time (UTC+8)
// into unix seconds. voca.wiki publishes all chart times in CST.
const parseCnDateToUnix = (value) => {
  const m = String(value ?? '').match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/u);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)) - 8 * 3600 * 1000;
  return Math.floor(ms / 1000);
};

// ISO-8601 year + week number for a unix timestamp (used for latestEntry serialization).
const isoYearAndWeek = (unix) => {
  if (!Number.isFinite(unix)) return { year: undefined, week: undefined };
  const base = new Date(unix * 1000);
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
};

const parseTemplateHeader = (wikitext) => {
  const match = wikitext.match(/\{\{Biliboard术力口周榜([\s\S]*?)\n\}\}/u);
  if (!match) return {};
  const fields = parseTemplateFields(match[1]);
  const bilibiliArticleMatch = wikitext.match(/\*\[(https:\/\/www\.bilibili\.com\/opus\/[^\s\]]+)/u);
  return {
    videoId: cleanWikiText(fields.id),
    publishedAt: cleanWikiText(fields['发布时间']),
    statWindow: cleanWikiText(fields['统计时间']),
    image: cleanWikiText(fields.image),
    bilibiliArticleUrl: bilibiliArticleMatch?.[1] || '',
  };
};

const parseRankingEntries = (wikitext, pageTitle) => {
  const issue = parseIssueNumber(pageTitle);
  const header = parseTemplateHeader(wikitext);
  const issueEndDate = parseCnDateToUnix(header.publishedAt);
  const { year: issueYear, week: issueWeek } = isoYearAndWeek(issueEndDate);
  const entries = [];
  const blockRegex = /\{\{虚拟歌手外语排行榜\/bricks([\s\S]*?)\n\}\}/gu;
  for (const match of wikitext.matchAll(blockRegex)) {
    const fields = parseTemplateFields(match[1]);
    const rankRaw = cleanWikiText(fields['本期']);
    const rankMatch = rankRaw.match(/\d+/u);
    const rank = rankRaw === 'OP' ? 0 : rankMatch ? Number(rankMatch[0]) : undefined;
    const title = cleanWikiText(fields['曲名']);
    if (!title) continue;
    const canonicalTitle = cleanWikiText(fields['条目']) || title;
    const producers = splitNames(fields['P主']);
    const vocalists = splitNames(fields['歌姬']);
    const bvid = cleanWikiText(fields.id);
    entries.push({
      boardId: 1,
      boardName: '周榜',
      issue,
      issueYear,
      issueWeek,
      issueEndDate,
      rank,
      title,
      titleCn: '',
      canonicalTitle,
      aliases: [...new Set([title, canonicalTitle].filter(Boolean))],
      producers,
      producerAliases: [],
      vocalists,
      vocalistAliases: [],
      bvid,
      bilibiliUrl: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
      publishedAt: cleanWikiText(fields['时间']),
      score: Number(cleanWikiText(fields['得点']).replace(/[^\d.]/gu, '')) || undefined,
      plays: Number(cleanWikiText(fields['播放']).replace(/[^\d.]/gu, '')) || undefined,
      favorites: Number(cleanWikiText(fields['收藏']).replace(/[^\d.]/gu, '')) || undefined,
      likes: Number(cleanWikiText(fields['点赞']).replace(/[^\d.]/gu, '')) || undefined,
      coins: Number(cleanWikiText(fields['硬币']).replace(/[^\d.]/gu, '')) || undefined,
      sourcePage: `https://voca.wiki/${encodeURIComponent(pageTitle).replace(/%2F/gu, '/')}`,
      sourcePageTitle: pageTitle,
      sourceVideoId: header.videoId,
      sourceArticleUrl: header.bilibiliArticleUrl,
      sourceIssuePublishedAt: header.publishedAt,
    });
  }
  return entries;
};

const fetchCategoryPages = async () => {
  const pages = [];
  let cmcontinue;
  do {
    const payload = await apiGet({
      action: 'query',
      list: 'categorymembers',
      cmtitle: CATEGORY_TITLE,
      cmlimit: 500,
      cmcontinue,
    });
    pages.push(...(payload.query?.categorymembers ?? []));
    cmcontinue = payload.continue?.cmcontinue;
  } while (cmcontinue);

  return pages
    .filter((page) => page.ns === 0 && /^Biliboard术力口周榜\/第\d+期$/u.test(page.title))
    .map((page) => ({ title: page.title, issue: parseIssueNumber(page.title) }))
    .filter((page) => Number.isFinite(page.issue))
    .sort((a, b) => a.issue - b.issue);
};

const fetchPageWikitext = async (title) => {
  const payload = await apiGet({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    redirects: 1,
  });
  return payload.parse?.wikitext?.['*'] || '';
};

// Fetch every issue of the Biliboard术力口周榜 from voca.wiki and parse the ranking
// entries out of each issue page's wikitext. (biliboard.uk public API is unusable
// from this host — Cloudflare 403s the server IP — so voca.wiki is the source of truth.)
const fetchVocaWikiEntries = async () => {
  const pages = await fetchCategoryPages();
  const entries = [];
  for (const [index, page] of pages.entries()) {
    const wikitext = await fetchPageWikitext(page.title);
    const issueEntries = parseRankingEntries(wikitext, page.title).filter((entry) => entry.title);
    entries.push(...issueEntries);
    console.info(`[biliboard-db] voca.wiki ${index + 1}/${pages.length} issue=${page.issue} entries=${issueEntries.length}`);
    await sleep(REQUEST_DELAY_MS);
  }

  return {
    entries,
    sourceStats: [{
      boardId: 1,
      boardName: '周榜',
      issueCount: pages.length,
      entryCount: entries.length,
      firstIssue: pages[0]?.issue,
      latestIssue: pages.at(-1)?.issue,
    }],
  };
};

const parseSongPageMetadata = (wikitext) => {
  const aliases = [];
  const titleReplaceMatch = wikitext.match(/^\{\{标题替换\|(.+)\}\}$/mu);
  if (titleReplaceMatch) aliases.push(...splitAliases(titleReplaceMatch[1]));

  const songboxMatch = wikitext.match(/\{\{VOCALOID_Songbox\/new([\s\S]*?)\n\}\}/u);
  const fields = songboxMatch ? parseTemplateFields(songboxMatch[1]) : {};
  aliases.push(...splitAliases(fields['歌曲名称']));

  return {
    aliases: [...new Set(aliases)],
    producers: splitNames(fields['P主']),
    vocalists: splitNames(fields['演唱']),
    niconicoId: cleanWikiText(fields.nnd_id),
    youtubeId: cleanWikiText(fields.yt_id),
    bilibiliId: cleanWikiText(fields.bb_id),
  };
};

const enrichSongsWithSongPages = async (songs) => {
  if (!ENRICH_SONG_PAGES) return songs;
  for (const [index, song] of songs.entries()) {
    try {
      const wikitext = await fetchPageWikitext(song.title);
      const metadata = parseSongPageMetadata(wikitext);
      song.aliases = [...new Set([...song.aliases, ...metadata.aliases])];
      song.producers = [...new Set([...song.producers, ...metadata.producers])];
      song.vocalists = [...new Set([...song.vocalists, ...metadata.vocalists])];
      song.niconicoIds = metadata.niconicoId ? [metadata.niconicoId] : [];
      song.youtubeIds = metadata.youtubeId ? [metadata.youtubeId] : [];
      if (metadata.bilibiliId) song.bvids = [...new Set([...song.bvids, metadata.bilibiliId])];
      song.searchText = normalizeKey([
        song.title,
        ...song.aliases,
        ...song.producers,
        ...song.vocalists,
        ...song.bvids,
        ...song.niconicoIds,
        ...song.youtubeIds,
      ].join(' '));
      console.info(`[biliboard-db] enrich ${index + 1}/${songs.length} ${song.title} aliases=${metadata.aliases.length}`);
    } catch (error) {
      console.info(`[biliboard-db] enrich skipped ${index + 1}/${songs.length} ${song.title}: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return songs;
};

const mergeEntries = (entries) => {
  const songs = new Map();
  for (const entry of entries) {
    const titleKey = normalizeKey(entry.canonicalTitle || entry.title);
    const producerKey = normalizeKey(entry.producers.join(','));
    const key = `${titleKey}::${producerKey}`;
    const existing = songs.get(key);
    if (!existing) {
      songs.set(key, {
        id: key,
        title: entry.canonicalTitle || entry.title,
        aliases: entry.aliases,
        producers: [...new Set([...(entry.producers ?? []), ...(entry.producerAliases ?? [])])],
        vocalists: [...new Set([...(entry.vocalists ?? []), ...(entry.vocalistAliases ?? [])])],
        bvids: entry.bvid ? [entry.bvid] : [],
        bilibiliUrls: entry.bilibiliUrl ? [entry.bilibiliUrl] : [],
        firstSeenIssue: entry.issue,
        lastSeenIssue: entry.issue,
        firstSeenAt: entry.issueEndDate,
        lastSeenAt: entry.issueEndDate,
        bestRank: entry.rank,
        appearances: 1,
        latestEntry: entry,
        entries: [entry],
      });
      continue;
    }

    existing.aliases = [...new Set([...existing.aliases, ...entry.aliases])];
    existing.producers = [...new Set([...existing.producers, ...(entry.producers ?? []), ...(entry.producerAliases ?? [])])];
    existing.vocalists = [...new Set([...existing.vocalists, ...(entry.vocalists ?? []), ...(entry.vocalistAliases ?? [])])];
    if (entry.bvid) existing.bvids = [...new Set([...existing.bvids, entry.bvid])];
    if (entry.bilibiliUrl) existing.bilibiliUrls = [...new Set([...existing.bilibiliUrls, entry.bilibiliUrl])];
    existing.firstSeenIssue = Math.min(existing.firstSeenIssue ?? entry.issue, entry.issue);
    existing.lastSeenIssue = Math.max(existing.lastSeenIssue ?? entry.issue, entry.issue);
    existing.firstSeenAt = Math.min(existing.firstSeenAt ?? entry.issueEndDate ?? Infinity, entry.issueEndDate ?? Infinity);
    existing.lastSeenAt = Math.max(existing.lastSeenAt ?? entry.issueEndDate ?? 0, entry.issueEndDate ?? 0);
    existing.bestRank = Math.min(existing.bestRank ?? entry.rank ?? 999, entry.rank ?? 999);
    existing.appearances += 1;
    existing.entries.push(entry);
    if ((entry.issueEndDate ?? 0) >= (existing.latestEntry.issueEndDate ?? 0)) existing.latestEntry = entry;
  }

  return [...songs.values()]
    .map((song) => ({
      ...song,
      recentEntries: song.entries
        .slice()
        .sort((a, b) => (b.issueEndDate ?? 0) - (a.issueEndDate ?? 0))
        .slice(0, 5)
        .map((entry) => ({
          issue: entry.issue,
          issueYear: entry.issueYear,
          issueWeek: entry.issueWeek,
          rank: entry.rank,
          title: entry.title,
          titleCn: entry.titleCn,
          bvid: entry.bvid,
          bilibiliUrl: entry.bilibiliUrl,
          sourcePage: entry.sourcePage,
          sourceArticleUrl: entry.sourceArticleUrl,
          publishedAt: entry.publishedAt,
          issueEndDate: entry.issueEndDate,
        })),
      latestEntry: {
        issue: song.latestEntry.issue,
        issueYear: song.latestEntry.issueYear,
        issueWeek: song.latestEntry.issueWeek,
        rank: song.latestEntry.rank,
        title: song.latestEntry.title,
        titleCn: song.latestEntry.titleCn,
        bvid: song.latestEntry.bvid,
        bilibiliUrl: song.latestEntry.bilibiliUrl,
        sourcePage: song.latestEntry.sourcePage,
        sourceArticleUrl: song.latestEntry.sourceArticleUrl,
        publishedAt: song.latestEntry.publishedAt,
        issueEndDate: song.latestEntry.issueEndDate,
      },
      entries: undefined,
      searchText: normalizeKey([
        song.title,
        ...song.aliases,
        ...song.producers,
        ...song.vocalists,
        ...song.bvids,
      ].join(' ')),
    }))
    .sort((a, b) => {
      const lastSeenDiff = (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
      if (lastSeenDiff) return lastSeenDiff;
      const appearancesDiff = b.appearances - a.appearances;
      if (appearancesDiff) return appearancesDiff;
      return (a.bestRank ?? 999) - (b.bestRank ?? 999);
    });
};

const buildPayload = async () => {
  const { entries: allEntries, sourceStats } = await fetchVocaWikiEntries();

  const songs = await enrichSongsWithSongPages(mergeEntries(allEntries));
  return {
    version: 3,
    generatedAt: new Date().toISOString(),
    source: {
      name: 'Biliboard术力口周榜热曲库',
      boards: sourceStats.map((item) => ({ id: item.boardId, name: item.boardName })),
      wikiApi: API_BASE,
      sourceNote: 'Built from voca.wiki "Biliboard术力口周榜" weekly chart wikitext. biliboard.uk public API is Cloudflare-blocked for the production server IP, so voca.wiki is the data source.',
    },
    stats: {
      boardStats: sourceStats,
      issueCount: sourceStats.reduce((sum, item) => sum + item.issueCount, 0),
      entryCount: allEntries.length,
      songCount: songs.length,
    },
    songs,
  };
};

// Atomic + guarded write: serialize to a temp file, validate (counts + re-parse),
// only then rename over the real DB. Any failure leaves the existing DB untouched
// and the process exits non-zero so the weekly cron / monitoring surfaces it.
const writePayload = async (payload) => {
  const issueCount = payload.stats?.issueCount ?? 0;
  const songCount = payload.songs?.length ?? 0;
  if (!Number.isFinite(issueCount) || issueCount < MIN_ISSUES) {
    throw new Error(`VALIDATION_FAIL issueCount=${issueCount} < MIN_ISSUES=${MIN_ISSUES}`);
  }
  if (!Number.isFinite(songCount) || songCount < MIN_SONGS) {
    throw new Error(`VALIDATION_FAIL songCount=${songCount} < MIN_SONGS=${MIN_SONGS}`);
  }
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  const tmpPath = `${OUTPUT_PATH}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  // Re-parse the temp file to prove it is not truncated/corrupt before swapping in.
  JSON.parse(await readFile(tmpPath, 'utf8'));
  await rename(tmpPath, OUTPUT_PATH);
};

const main = async () => {
  const payload = await buildPayload();
  await writePayload(payload);
  console.info(`[biliboard-db] wrote ${OUTPUT_PATH}`);
  console.info(`[biliboard-db] ${payload.stats.issueCount} issues, ${payload.stats.entryCount} entries, ${payload.stats.songCount} unique songs`);
};

main().catch((error) => {
  console.error('[biliboard-db] FAILED — existing DB left untouched:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
