import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://voca.wiki/api.php';
const CATEGORY_TITLE = 'Category:Biliboard术力口周榜';
const BILIBOARD_PUBLIC_BASE = 'https://biliboard.uk/api/public';
const BOARD_SOURCES = [
  { id: 1, name: '周榜' },
  { id: 2, name: '传说曲周榜' },
];
const OUTPUT_PATH = join(fileURLToPath(new URL('..', import.meta.url)), 'public/data/biliboard-hot-songs.json');
const REQUEST_DELAY_MS = 120;
const ENRICH_SONG_PAGES = process.env.SKIP_SONG_ENRICH !== '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const apiGet = async (params) => {
  const url = new URL(API_BASE);
  Object.entries({ format: 'json', ...params }).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'MikuTownGame/0.1 local hot-song database builder',
    },
  });
  if (!response.ok) throw new Error(`VOCALOID_WIKI_HTTP_${response.status}`);
  return response.json();
};

const biliboardGet = async (path) => {
  const response = await fetch(`${BILIBOARD_PUBLIC_BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'MikuTownGame/0.1 local hot-song database builder',
    },
  });
  if (!response.ok) throw new Error(`BILIBOARD_HTTP_${response.status}_${path}`);
  return response.json();
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

const formatDateFromUnixSeconds = (value) => (
  Number.isFinite(value)
    ? new Date(value * 1000).toISOString().slice(0, 10)
    : ''
);

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
      issue,
      rank,
      title,
      canonicalTitle,
      aliases: [...new Set([title, canonicalTitle].filter(Boolean))],
      producers,
      vocalists,
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

const mapBiliboardRankingEntry = (row, board, issue) => {
  const title = cleanWikiText(row.title);
  const titleCn = cleanWikiText(row.titleCn || row.title_cn);
  const producers = (row.producers ?? []).map((item) => cleanWikiText(item.name)).filter(Boolean);
  const vocalists = (row.vocalists ?? []).map((item) => cleanWikiText(item.name)).filter(Boolean);
  const vocalistAliases = (row.vocalists ?? []).flatMap((item) => item.aliases ?? []).map(cleanWikiText).filter(Boolean);
  const producerAliases = (row.producers ?? []).flatMap((item) => item.aliases ?? []).map(cleanWikiText).filter(Boolean);
  const bvid = cleanWikiText(row.bvid);

  return {
    boardId: board.id,
    boardName: board.name,
    issue: issue.issue_id,
    issueYear: issue.year,
    issueWeek: issue.week,
    issueEndDate: issue.end_date,
    rank: row.rank,
    title,
    titleCn,
    canonicalTitle: title,
    aliases: [...new Set([title, titleCn].filter(Boolean))],
    producers,
    producerAliases,
    vocalists,
    vocalistAliases,
    bvid,
    bilibiliUrl: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
    publishedAt: formatDateFromUnixSeconds(row.pubtime),
    firstRecordedAt: formatDateFromUnixSeconds(row.firstRecordedAt || row.first_recorded_at),
    score: row.score,
    plays: row.stats?.views,
    favorites: row.stats?.favorites,
    likes: row.stats?.likes,
    coins: row.stats?.coins,
    weeksOnBoard: row.weeksOnBoard ?? row.weeks_on_board,
    peakRank: row.peakRank ?? row.peak_rank,
    sourcePage: `https://biliboard.uk/boards/${board.id}/issues/${issue.issue_id}`,
    sourcePageTitle: `Biliboard${board.name}/第${issue.issue_id}期`,
    sourceVideoId: issue.video_bvid,
    sourceArticleUrl: issue.video_bvid ? `https://www.bilibili.com/video/${issue.video_bvid}` : '',
    sourceIssuePublishedAt: formatDateFromUnixSeconds(issue.end_date),
  };
};

const fetchBiliboardEntries = async () => {
  const boardPayload = await biliboardGet('/boards');
  const availableBoards = new Map((Array.isArray(boardPayload) ? boardPayload : []).map((board) => [board.id, board]));
  const entries = [];
  const sourceStats = [];

  for (const boardSource of BOARD_SOURCES) {
    const board = availableBoards.get(boardSource.id) ?? boardSource;
    const issues = await biliboardGet(`/boards/${boardSource.id}/issues`);
    const sortedIssues = issues.slice().sort((a, b) => a.issue_id - b.issue_id);
    let entryCount = 0;

    for (const [index, issue] of sortedIssues.entries()) {
      const rankings = await biliboardGet(`/boards/${boardSource.id}/issues/${issue.issue_id}/rankings`);
      const issueEntries = rankings
        .map((row) => mapBiliboardRankingEntry(row, board, issue))
        .filter((entry) => entry.title);
      entries.push(...issueEntries);
      entryCount += issueEntries.length;
      console.info(`[biliboard-db] ${board.name} ${index + 1}/${sortedIssues.length} issue=${issue.issue_id} entries=${issueEntries.length}`);
      await sleep(REQUEST_DELAY_MS);
    }

    sourceStats.push({
      boardId: boardSource.id,
      boardName: board.name,
      issueCount: sortedIssues.length,
      entryCount,
      firstIssue: sortedIssues[0]?.issue_id,
      latestIssue: sortedIssues.at(-1)?.issue_id,
    });
  }

  return { entries, sourceStats };
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

const main = async () => {
  const { entries: allEntries, sourceStats } = await fetchBiliboardEntries();

  const songs = await enrichSongsWithSongPages(mergeEntries(allEntries));
  const payload = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: {
      name: 'Biliboard术力口热曲库',
      boards: sourceStats.map((item) => ({ id: item.boardId, name: item.boardName })),
      biliboardApi: BILIBOARD_PUBLIC_BASE,
      wikiApi: API_BASE,
      sourceNote: 'Built from Biliboard public API board rankings, including weekly chart and legendary-song weekly chart.',
    },
    stats: {
      boardStats: sourceStats,
      issueCount: sourceStats.reduce((sum, item) => sum + item.issueCount, 0),
      entryCount: allEntries.length,
      songCount: songs.length,
    },
    songs,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.info(`[biliboard-db] wrote ${OUTPUT_PATH}`);
  console.info(`[biliboard-db] ${payload.stats.issueCount} issues, ${payload.stats.entryCount} entries, ${payload.stats.songCount} unique songs`);
};

main().catch((error) => {
  console.error('[biliboard-db] failed', error);
  process.exitCode = 1;
});
