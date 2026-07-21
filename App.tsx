
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { DialogBox } from './components/DialogBox';
import { GameState, LeaderboardEntry, NpcChatSession, RunSummary, TouchInput } from './types';
import { LYRICS, IDLE_SPRITE_URLS } from './constants';
import { gameAudio } from './utils/audioSystem';
import { useTranslation } from 'react-i18next';
import './i18n';
import {
  buildMikuMemoryBrief,
  commitMikuMemoryEndResult,
  consumePendingMikuGreeting,
  inheritGuestMikuMemoryForAccount,
  mikuMemoryScopeForAccount,
  prepareMikuMemoryEndRequest,
  searchMikuTopicMemory,
  syncAccountMikuMemoryFromServer,
} from './utils/mikuMemory';
import type { MikuMemoryEndResult } from './utils/mikuMemory';

const languages = [
  { code: 'zh', labelKey: 'lang_zh' },
  { code: 'en', labelKey: 'lang_en' },
  { code: 'ja', labelKey: 'lang_ja' },
] as const;

type LanguageCode = typeof languages[number]['code'];

const AUTH_TOKEN_KEY = 'cat_investigation_auth_token_v1';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

interface ActiveNpcChat extends NpcChatSession {
  messages: ChatMessage[];
  isLoading: boolean;
  error?: string;
  memoryScope?: string;
}

type AuthUser = {
  id: string;
  username: string;
};

type AuthMode = 'login' | 'register';

type GlobalLeaderboardEntry = LeaderboardEntry & {
  rank: number;
  userId?: string;
};

type VocaDbSongResult = {
  id?: number | string;
  name: string;
  additionalNames: string;
  artistString: string;
  artists: string[];
  songType: string;
  publishDate: string;
  pvs: string[];
  url: string;
  source: 'VocaDB' | 'Biliboard';
  matchKind?: 'exact' | 'contains' | 'partial' | 'fuzzy' | 'artist' | 'searchText';
  matchConfidence?: 'high' | 'medium' | 'low';
  matchReason?: string;
};

type VocaDbLookupResult = {
  query: string;
  results: VocaDbSongResult[];
  error?: string;
  primary: 'VocaDB' | 'Biliboard';
  debug: {
    vocadbUrl: string;
    mode: 'browser-fetch' | 'jsonp' | 'browser-failed' | 'biliboard-local';
    status?: number;
    contentType?: string;
    artistId?: number | string;
    artistName?: string;
    fetchError?: string;
    jsonpError?: string;
  };
};

type RecentSongLookupEntry = {
  key: string;
  expiresAtTurn: number;
  lookup: VocaDbLookupResult;
};

type BiliboardHotSong = {
  title: string;
  aliases: string[];
  producers: string[];
  vocalists: string[];
  bvids: string[];
  bilibiliUrls: string[];
  niconicoIds?: string[];
  youtubeIds?: string[];
  firstSeenIssue?: number;
  lastSeenIssue?: number;
  bestRank?: number;
  appearances: number;
  latestEntry?: {
    issue?: number;
    issueYear?: number;
    issueWeek?: number;
    rank?: number;
    bvid?: string;
    bilibiliUrl?: string;
    sourcePage?: string;
    sourceArticleUrl?: string;
    publishedAt?: string;
  };
  searchText: string;
};

type BiliboardHotDb = {
  stats: {
    issueCount: number;
    entryCount: number;
    songCount: number;
    boardStats?: Array<{
      boardId: number;
      boardName: string;
      issueCount: number;
      entryCount: number;
      firstIssue?: number;
      latestIssue?: number;
    }>;
    firstIssue?: number;
    latestIssue?: number;
  };
  songs: BiliboardHotSong[];
};

type ProducerAliasDbEntry = {
  canonicalName: string;
  producerNames?: string[];
  aliases: string[];
  weakAliases?: string[];
};

type ProducerAliasDb = {
  entries: Record<string, ProducerAliasDbEntry>;
};

type VocaDbArtistResult = {
  id: number | string;
  name: string;
  additionalNames: string;
  artistType: string;
};

type MikuChatApiResponse = {
  reply?: string;
  action?: 'vocaloid_search' | 'vocaloid_lyrics' | 'vocaloid_full_lyrics' | 'memory_search';
  queries?: string[];
  error?: string;
  detail?: string;
};

type LyricLookupResult = {
  query: string;
  searchedQueries?: string[];
  found: boolean;
  title?: string;
  pageId?: number | string;
  pageUrl?: string;
  source?: string;
  songTitle?: string;
  singer?: string;
  producer?: string;
  uploadDate?: string;
  description?: string;
  lyricsAvailable?: boolean;
  lyricLineCount?: number;
  languages?: string[];
  firstLine?: string;
  firstRomajiLine?: string;
  firstEnglishLine?: string;
  lyricSnippets?: string[];
  translatedSnippets?: string[];
  fullLyricsAvailable?: boolean;
  fullLyricText?: string;
  fullTranslatedText?: string;
  fullParallelText?: string;
  digest?: string;
  error?: string;
};

const VOCADB_SONG_API_URL = 'https://vocadb.net/api/songs';
const VOCADB_ARTIST_API_URL = 'https://vocadb.net/api/artists';
const VOCADB_FIELDS = 'Artists,Names,PVs,Tags';
const VOCADB_MAX_RESULTS = 4;
const BILIBOARD_HOT_DB_FILE = 'data/biliboard-hot-songs.json';
const PRODUCER_ALIAS_DB_FILE = 'data/vocaloid-producer-aliases-cn.json';
let biliboardHotDbPromise: Promise<BiliboardHotDb | null> | null = null;
let producerAliasDbPromise: Promise<ProducerAliasDb | null> | null = null;

const logMikuLookup = (stage: string, payload: Record<string, unknown>) => {
  console.info(`[miku-lookup] ${stage}`, payload);
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' ? value as Record<string, unknown> : undefined
);

const pick = (object: Record<string, unknown> | undefined, ...keys: string[]) => {
  if (!object) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

const cleanText = (value: unknown, maxLength = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
const normalizeLookupText = (value: unknown) => cleanText(value, 200)
  .toLowerCase()
  .normalize('NFKC')
  .replace(/[《》「」『』“”"'’‘`´·・\s_\-—–,.，。:：/／\\|｜()[\]（）【】!?！？♡☆★]/gu, '');
const foldAmbiguousLookupText = (value: string) => value
  .replace(/[0０]/g, 'o')
  .replace(/[1１]/g, 'l')
  .replace(/[3３]/g, 'e')
  .replace(/[5５]/g, 's')
  .replace(/[7７]/g, 't')
  .replace(/@/g, 'a');
const lyricContextKeywords = /歌词|歌詞|lyrics?|第一句|下一句|副歌|主歌|桥段|橋段|词|詞|唱一下|唱出来|接着唱/u;
const songDiscussionKeywords = /歌词|歌詞|lyrics?|第一句|副歌|主歌|桥段|橋段|词|詞|感受|理解|解读|解讀|听后感|聽後感|喜欢|喜歡|觉得|覺得|感觉|感覺|讲什么|講什麼|关于什么|關於什麼|什么意思|什麼意思|主题|主題|这首歌|這首歌|这歌|這歌|歌曲|曲子/u;
const HOT_SONG_QUERY_ALIASES: Record<string, string[]> = {
  催眠术: ['メズマライザー', 'Mesmerizer', '催眠师'],
  世界第一公主殿下: ['ワールドイズマイン', 'World is Mine', '世界で一番おひめさま'],
  甩葱歌: ['Ievan Polkka', 'Levan Polkka', 'イエヴァン・ポルッカ'],
  消失: ['初音ミクの消失', 'The Disappearance of Hatsune Miku'],
};

const CURATED_VOCALOID_CLASSICS: BiliboardHotSong[] = [
  {
    title: 'メルト',
    aliases: ['メルト', 'Melt'],
    producers: ['ryo'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: 'メルト melt ryo supercell 初音ミク 初音未来 miku hatsune miku',
  },
  {
    title: 'ワールドイズマイン',
    aliases: ['ワールドイズマイン', 'World is Mine', '世界第一公主殿下', '世界で一番おひめさま'],
    producers: ['ryo'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: 'ワールドイズマイン world is mine 世界第一公主殿下 世界で一番おひめさま ryo supercell 初音ミク 初音未来 miku hatsune miku',
  },
  {
    title: '初音ミクの消失',
    aliases: ['初音ミクの消失', '初音未来的消失', 'The Disappearance of Hatsune Miku', '消失'],
    producers: ['cosMo@暴走P'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: '初音ミクの消失 初音未来的消失 the disappearance of hatsune miku 消失 cosmo@暴走p 初音ミク 初音未来 miku hatsune miku',
  },
  {
    title: 'Ievan Polkka',
    aliases: ['Ievan Polkka', 'Levan Polkka', '甩葱歌', 'イエヴァン・ポルッカ'],
    producers: ['Otomania'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: 'ievan polkka levan polkka 甩葱歌 イエヴァンポルッカ otomania 初音ミク 初音未来 miku hatsune miku',
  },
  {
    title: 'Tell Your World',
    aliases: ['Tell Your World'],
    producers: ['kz'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: 'tell your world kz livetune 初音ミク 初音未来 miku hatsune miku',
  },
  {
    title: '炉心融解',
    aliases: ['炉心融解', 'Roshin Yuukai', 'Meltdown'],
    producers: ['iroha(sasaki)'],
    vocalists: ['鏡音リン', '镜音铃', 'Kagamine Rin'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: '炉心融解 roshin yuukai meltdown iroha sasaki kuma 鏡音リン 镜音铃 kagamine rin',
  },
  {
    title: 'ローリンガール',
    aliases: ['ローリンガール', 'Rolling Girl', 'Rolling Girl／ローリンガール'],
    producers: ['wowaka'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: 'ローリンガール rolling girl wowaka 初音ミク 初音未来 miku hatsune miku',
  },
  {
    title: 'マトリョシカ',
    aliases: ['マトリョシカ', 'Matryoshka', '俄罗斯套娃'],
    producers: ['ハチ'],
    vocalists: ['初音ミク', 'GUMI', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: 'マトリョシカ matryoshka 俄罗斯套娃 ハチ hachi 米津玄師 初音ミク gumi 初音未来 miku hatsune miku',
  },
  {
    title: '砂の惑星',
    aliases: ['砂の惑星', 'Sand Planet', '沙之惑星'],
    producers: ['ハチ'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: '砂の惑星 sand planet 沙之惑星 ハチ hachi 米津玄師 初音ミク 初音未来 miku hatsune miku',
  },
  {
    title: 'ゴーストルール',
    aliases: ['ゴーストルール', 'Ghost Rule', '幽灵法则'],
    producers: ['DECO*27'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: 'ゴーストルール ghost rule 幽灵法则 deco*27 初音ミク 初音未来 miku hatsune miku',
  },
  {
    title: 'ヒビカセ',
    aliases: ['ヒビカセ', 'Hibikase'],
    producers: ['ギガ', 'Reol'],
    vocalists: ['初音ミク', '初音未来', 'miku', 'Hatsune Miku', 'Miku'],
    bvids: [],
    bilibiliUrls: [],
    bestRank: 1,
    appearances: 40,
    searchText: 'ヒビカセ hibikase ギガ giga reol 初音ミク 初音未来 miku hatsune miku',
  },
];

const expandHotSongQueries = (queries: string[]) => {
  const expanded: string[] = [];
  queries.forEach((query) => {
    const text = cleanText(query, 160);
    if (!text) return;
    expanded.push(text);
    const stripped = stripSongQueryNoise(text);
    if (stripped && stripped !== text) expanded.push(stripped);
    const normalized = normalizeLookupText(text);
    Object.entries(HOT_SONG_QUERY_ALIASES).forEach(([key, aliases]) => {
      const aliasGroup = [key, ...aliases];
      if (aliasGroup.some((alias) => normalized.includes(normalizeLookupText(alias)))) {
        expanded.push(...aliasGroup);
      }
    });
  });
  return [...new Set(expanded)].slice(0, 8);
};

const stripSongQueryNoise = (value: string) => cleanText(value, 160)
  .replace(/这首歌|這首歌|这歌|這歌|这曲|這曲|歌曲|曲子|歌名|歌词|歌詞|lyrics?/giu, ' ')
  .replace(/是谁写的?|誰寫的?|谁写的?|谁作的?|誰作的?|谁做的?|誰做的?|谁唱的?|誰唱的?/giu, ' ')
  .replace(/是谁|是誰|谁|誰|作者|p主|P主|制作|製作|原唱|歌手|歌姬|投稿|发布|發布|哪年|什么时候|什麼時候/gu, ' ')
  .replace(/你知道|知道|听过|聽過|唱过|唱過|熟悉|吗|嗎|呢|呀|啊/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeVocaDbArtist = (entry: unknown) => {
  const artistEntry = asRecord(entry);
  const artist = pick(artistEntry, 'artist', 'Artist') ?? entry;
  const artistObject = asRecord(artist);
  const name = cleanText(pick(artistObject, 'name', 'Name', 'defaultName', 'DefaultName'), 120);
  const role = cleanText(pick(artistEntry, 'categories', 'Categories'), 80);
  if (!name) return '';
  return role ? `${name} (${role})` : name;
};

const normalizeVocaDbPv = (entry: unknown) => {
  const pv = asRecord(entry);
  const service = cleanText(pick(pv, 'service', 'Service'), 80);
  const name = cleanText(pick(pv, 'name', 'Name', 'pvType', 'PVType'), 80);
  const url = cleanText(pick(pv, 'url', 'Url'), 240);
  if (!service && !url) return '';
  return [service, name, url].filter(Boolean).join(': ');
};

const extractVocaDbItems = (payload: unknown) => {
  if (Array.isArray(payload)) return payload;
  const object = asRecord(payload);
  const items = pick(object, 'items', 'Items');
  return Array.isArray(items) ? items : [];
};

const normalizeVocaDbSong = (entry: unknown): VocaDbSongResult => {
  const song = asRecord(entry);
  const id = pick(song, 'id', 'Id') as number | string | undefined;
  const name = cleanText(pick(song, 'name', 'Name', 'defaultName', 'DefaultName'), 160);
  const artistsRaw = pick(song, 'artists', 'Artists');
  const pvsRaw = pick(song, 'pvs', 'PVs');
  return {
    id,
    name,
    additionalNames: cleanText(pick(song, 'additionalNames', 'AdditionalNames'), 260),
    artistString: cleanText(pick(song, 'artistString', 'ArtistString'), 220),
    artists: Array.isArray(artistsRaw) ? artistsRaw.map(normalizeVocaDbArtist).filter(Boolean).slice(0, 8) : [],
    songType: cleanText(pick(song, 'songType', 'SongType'), 80),
    publishDate: cleanText(pick(song, 'publishDate', 'PublishDate'), 80),
    pvs: Array.isArray(pvsRaw) ? pvsRaw.map(normalizeVocaDbPv).filter(Boolean).slice(0, 4) : [],
    url: id ? `https://vocadb.net/S/${id}` : '',
    source: 'VocaDB',
  };
};

const buildVocaDbUrl = (query: string, callbackName?: string) => {
  const url = new URL(VOCADB_SONG_API_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('maxResults', String(VOCADB_MAX_RESULTS));
  url.searchParams.set('lang', 'Default');
  url.searchParams.set('nameMatchMode', 'Auto');
  url.searchParams.set('preferAccurateMatches', 'true');
  url.searchParams.set('fields', VOCADB_FIELDS);
  if (callbackName) url.searchParams.set('callback', callbackName);
  return url;
};

const buildVocaDbArtistUrl = (query: string) => {
  const url = new URL(VOCADB_ARTIST_API_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('maxResults', '3');
  url.searchParams.set('lang', 'Default');
  url.searchParams.set('nameMatchMode', 'Auto');
  url.searchParams.set('fields', 'Names');
  return url;
};

const parseVocaDbResults = (payload: unknown) => (
  extractVocaDbItems(payload)
    .map(normalizeVocaDbSong)
    .filter((song) => song.name)
    .slice(0, VOCADB_MAX_RESULTS)
);

const parseVocaDbArtists = (payload: unknown): VocaDbArtistResult[] => (
  extractVocaDbItems(payload)
    .map((entry) => {
      const artist = asRecord(entry);
      const id = pick(artist, 'id', 'Id') as number | string | undefined;
      return {
        id: id ?? '',
        name: cleanText(pick(artist, 'name', 'Name', 'defaultName', 'DefaultName'), 160),
        additionalNames: cleanText(pick(artist, 'additionalNames', 'AdditionalNames'), 240),
        artistType: cleanText(pick(artist, 'artistType', 'ArtistType'), 80),
      };
    })
    .filter((artist) => artist.id && artist.name)
    .slice(0, 3)
);

const getStaticDataUrls = (file: string) => {
  const baseUrl = (import.meta.env.BASE_URL || '/').replace(/\/?$/u, '/');
  return [...new Set([
    `${baseUrl}${file}`,
    `/${file}`,
    file,
  ])];
};

const getBiliboardHotDbUrls = () => getStaticDataUrls(BILIBOARD_HOT_DB_FILE);
const getProducerAliasDbUrls = () => getStaticDataUrls(PRODUCER_ALIAS_DB_FILE);

const isBiliboardHotDb = (payload: unknown): payload is BiliboardHotDb => (
  Boolean(payload)
  && typeof payload === 'object'
  && Array.isArray((payload as BiliboardHotDb).songs)
);

const isProducerAliasDb = (payload: unknown): payload is ProducerAliasDb => (
  Boolean(payload)
  && typeof payload === 'object'
  && Boolean((payload as ProducerAliasDb).entries)
  && typeof (payload as ProducerAliasDb).entries === 'object'
);

const loadBiliboardHotDb = () => {
  if (!biliboardHotDbPromise) {
    biliboardHotDbPromise = (async () => {
      const failures: string[] = [];
      for (const url of getBiliboardHotDbUrls()) {
        try {
          const response = await fetch(url, { cache: 'force-cache' });
          const contentType = response.headers.get('content-type') || '';
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (contentType && !contentType.includes('json')) throw new Error(`NON_JSON ${contentType}`);
          const payload = await response.json();
          if (!isBiliboardHotDb(payload)) throw new Error('BAD_HOT_DB_SHAPE');
          logMikuLookup('hot-db-loaded', {
            url,
            songCount: payload.songs.length,
            generatedAt: (payload as BiliboardHotDb & { generatedAt?: string }).generatedAt,
          });
          return payload;
        } catch (error) {
          failures.push(`${url}: ${error instanceof Error ? error.message : 'LOAD_FAILED'}`);
        }
      }
      logMikuLookup('hot-db-load-failed', { failures });
      biliboardHotDbPromise = null;
      return null;
    })();
  }
  return biliboardHotDbPromise;
};

const loadProducerAliasDb = () => {
  if (!producerAliasDbPromise) {
    producerAliasDbPromise = (async () => {
      const failures: string[] = [];
      for (const url of getProducerAliasDbUrls()) {
        try {
          const response = await fetch(url, { cache: 'force-cache' });
          const contentType = response.headers.get('content-type') || '';
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (contentType && !contentType.includes('json')) throw new Error(`NON_JSON ${contentType}`);
          const payload = await response.json();
          if (!isProducerAliasDb(payload)) throw new Error('BAD_PRODUCER_ALIAS_DB_SHAPE');
          logMikuLookup('producer-alias-db-loaded', {
            url,
            producerCount: Object.keys(payload.entries).length,
          });
          return payload;
        } catch (error) {
          failures.push(`${url}: ${error instanceof Error ? error.message : 'LOAD_FAILED'}`);
        }
      }
      logMikuLookup('producer-alias-db-load-failed', { failures });
      producerAliasDbPromise = null;
      return null;
    })();
  }
  return producerAliasDbPromise;
};

const getProducerAliasEntry = (producer: string, db?: ProducerAliasDb | null) => {
  if (!db) return undefined;
  const normalizedProducer = normalizeLookupText(producer);
  const directEntry = Object.entries(db.entries).find(([name]) => normalizeLookupText(name) === normalizedProducer)?.[1];
  if (directEntry) return directEntry;
  return Object.values(db.entries).find((entry) => (
    [entry.canonicalName, ...(entry.producerNames ?? []), ...entry.aliases]
      .some((name) => normalizeLookupText(name) === normalizedProducer)
  ));
};

const getProducerLookupNames = (producer: string, db?: ProducerAliasDb | null) => {
  const entry = getProducerAliasEntry(producer, db);
  return [...new Set([
    producer,
    entry?.canonicalName,
    ...(entry?.producerNames ?? []),
    ...(entry?.aliases ?? []),
  ].filter(Boolean) as string[])];
};

type HotSongMatch = {
  score: number;
  matchKind: NonNullable<VocaDbSongResult['matchKind']>;
  matchConfidence: NonNullable<VocaDbSongResult['matchConfidence']>;
  matchReason: string;
};

const getEditDistance = (a: string, b: string) => {
  const left = [...a];
  const right = [...b];
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i++) dp[i][0] = i;
  for (let j = 0; j <= right.length; j++) dp[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[left.length][right.length];
};

const getFuzzySimilarity = (a: string, b: string) => {
  if (!a || !b) return 0;
  const maxLength = Math.max([...a].length, [...b].length);
  if (maxLength === 0) return 0;
  return 1 - getEditDistance(a, b) / maxLength;
};

const getBestFuzzySimilarity = (a: string, b: string) => Math.max(
  getFuzzySimilarity(a, b),
  getFuzzySimilarity(foldAmbiguousLookupText(a), foldAmbiguousLookupText(b)),
);

const betterHotSongMatch = (current: HotSongMatch, candidate: HotSongMatch) => (
  candidate.score > current.score ? candidate : current
);

const scoreBiliboardSong = (song: BiliboardHotSong, terms: string[], options: { allowFuzzy?: boolean } = {}, producerAliasDb?: ProducerAliasDb | null): HotSongMatch => {
  const titleKeys = [song.title, ...song.aliases].map(normalizeLookupText).filter(Boolean);
  const peopleKeys = [
    ...song.producers.flatMap((producer) => getProducerLookupNames(producer, producerAliasDb)),
    ...song.vocalists,
  ].map(normalizeLookupText).filter(Boolean);
  let best: HotSongMatch = {
    score: 0,
    matchKind: 'searchText',
    matchConfidence: 'low',
    matchReason: '',
  };
  for (const term of terms) {
    if (!term) continue;
    titleKeys.forEach((key) => {
      if (key === term) {
        best = betterHotSongMatch(best, { score: 140, matchKind: 'exact', matchConfidence: 'high', matchReason: `标题/别名精确匹配: ${term}` });
        return;
      }
      if (foldAmbiguousLookupText(key) === foldAmbiguousLookupText(term)) {
        best = betterHotSongMatch(best, { score: 124, matchKind: 'fuzzy', matchConfidence: 'medium', matchReason: `标题/别名字符近似匹配: "${term}" 可能对应 "${key}"` });
        return;
      }
      if (key.length >= 3 && term.length >= 3 && term.includes(key)) {
        best = betterHotSongMatch(best, { score: 96, matchKind: 'contains', matchConfidence: 'high', matchReason: `玩家文本包含完整歌名/别名: ${key}` });
        return;
      }
      if (key.length >= 3 && term.length >= 3 && key.includes(term)) {
        best = betterHotSongMatch(best, { score: 76, matchKind: 'partial', matchConfidence: 'medium', matchReason: `玩家文本是歌名/别名的一部分: ${term}` });
        return;
      }
      if (!options.allowFuzzy || key.length < 3 || term.length < 3) return;
      const maxLength = Math.max(key.length, term.length);
      const lengthDiff = Math.abs(key.length - term.length);
      if (lengthDiff > Math.max(2, Math.floor(maxLength * 0.35))) return;
      const similarity = getBestFuzzySimilarity(key, term);
      const threshold = maxLength <= 4 ? 0.66 : 0.72;
      if (similarity >= threshold) {
        const rounded = Math.round(similarity * 100);
        best = betterHotSongMatch(best, {
          score: 68 + rounded / 4,
          matchKind: 'fuzzy',
          matchConfidence: similarity >= 0.82 ? 'medium' : 'low',
          matchReason: `模糊匹配: "${term}" 可能对应 "${key}"，相似度约 ${rounded}%`,
        });
      }
    });
    peopleKeys.forEach((key) => {
      if (key === term) {
        best = betterHotSongMatch(best, { score: 52, matchKind: 'artist', matchConfidence: 'medium', matchReason: `歌手/P主精确匹配: ${term}` });
      } else if (foldAmbiguousLookupText(key) === foldAmbiguousLookupText(term)) {
        best = betterHotSongMatch(best, { score: 84, matchKind: 'artist', matchConfidence: 'medium', matchReason: `歌手/P主字符近似匹配: "${term}" 可能对应 "${key}"` });
      } else if (key.length >= 3 && term.length >= 3 && (key.includes(term) || term.includes(key))) {
        best = betterHotSongMatch(best, { score: 36, matchKind: 'artist', matchConfidence: 'low', matchReason: `歌手/P主部分匹配: ${term}` });
      } else if (options.allowFuzzy && key.length >= 3 && term.length >= 3) {
        const similarity = getBestFuzzySimilarity(key, term);
        if (similarity >= 0.72) {
          best = betterHotSongMatch(best, {
            score: 30 + Math.round(similarity * 20),
            matchKind: 'artist',
            matchConfidence: 'low',
            matchReason: `歌手/P主模糊匹配: "${term}" 可能对应 "${key}"`,
          });
        }
      }
    });
    if (song.searchText.includes(term)) {
      best = betterHotSongMatch(best, { score: 46, matchKind: 'searchText', matchConfidence: 'low', matchReason: `搜索文本包含: ${term}` });
    }
  }
  if (best.score <= 0) return best;
  const rankBoost = Math.max(0, 24 - Math.min(song.bestRank ?? 24, 24));
  const appearanceBoost = Math.min(song.appearances, 20);
  const recencyBoost = Math.max(0, (song.lastSeenIssue ?? 0) - 80) * 0.4;
  return {
    ...best,
    score: best.score + rankBoost + appearanceBoost + recencyBoost,
  };
};

const mapBiliboardSongToLookupResult = (song: BiliboardHotSong, match?: HotSongMatch, producerAliasDb?: ProducerAliasDb | null): VocaDbSongResult => ({
  id: song.bvids[0] || song.title,
  name: song.title,
  additionalNames: song.aliases.filter((alias) => normalizeLookupText(alias) !== normalizeLookupText(song.title)).join(', '),
  artistString: [song.producers.join(', '), song.vocalists.length ? `feat. ${song.vocalists.join(', ')}` : ''].filter(Boolean).join(' '),
  artists: [
    ...song.producers.map((producer) => {
      const aliases = getProducerLookupNames(producer, producerAliasDb).filter((name) => name !== producer).slice(0, 4);
      return `${producer}${aliases.length ? ` / ${aliases.join(' / ')}` : ''} (P主)`;
    }),
    ...song.vocalists.map((vocalist) => `${vocalist} (歌姬)`),
  ],
  songType: `术力口曲库，最高第${song.bestRank ?? '?'}名，上榜${song.appearances}次`,
  publishDate: song.latestEntry?.publishedAt || '',
  pvs: song.bilibiliUrls.slice(0, 3).map((url) => `bilibili: ${url}`),
  url: song.bilibiliUrls[0] || song.latestEntry?.sourcePage || '',
  source: 'Biliboard',
  matchKind: match?.matchKind,
  matchConfidence: match?.matchConfidence,
  matchReason: match?.matchReason,
});

const lyricCacheKeysForSong = (song: VocaDbSongResult) => [
  song.name,
  song.additionalNames,
  song.url,
  String(song.id ?? ''),
]
  .flatMap((item) => cleanText(item, 260).split(/\s*,\s*/u))
  .map(normalizeLookupText)
  .filter(Boolean);

const searchBiliboardHotSongs = async (queries: string[], options: { allowFuzzy?: boolean } = {}): Promise<VocaDbLookupResult[]> => {
  const db = await loadBiliboardHotDb();
  const producerAliasDb = await loadProducerAliasDb();
  const songs = [
    ...CURATED_VOCALOID_CLASSICS,
    ...(db?.songs ?? []).filter((song) => !CURATED_VOCALOID_CLASSICS.some((classicSong) => (
      normalizeLookupText(classicSong.title) === normalizeLookupText(song.title)
    ))),
  ];
  if (!songs.length) return [];
  const terms = [...new Set(queries.map(normalizeLookupText).filter((term) => term.length >= 2))].slice(0, 6);
  if (terms.length === 0) return [];
  const ranked = songs
    .map((song) => ({ song, match: scoreBiliboardSong(song, terms, options, producerAliasDb) }))
    .filter((item) => item.match.score >= 65)
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, 4);
  if (!ranked.length) return [];
  return [{
    query: queries.join(' | '),
    results: ranked.map((item) => mapBiliboardSongToLookupResult(item.song, item.match, producerAliasDb)),
    primary: 'Biliboard',
    debug: {
      vocadbUrl: getBiliboardHotDbUrls()[0],
      mode: 'biliboard-local',
      status: 200,
      contentType: `local json; ${songs.length} songs; producer aliases ${producerAliasDb ? Object.keys(producerAliasDb.entries).length : 0}; curated classics ${CURATED_VOCALOID_CLASSICS.length}; latest issue ${db?.stats?.latestIssue ?? 'n/a'}`,
    },
  }];
};

const buildPassiveHotSongQueries = (messages: ChatMessage[]) => {
  const recentUserMessages = messages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => cleanText(message.content, 160))
    .filter(Boolean);
  const latest = recentUserMessages.at(-1);
  return [...new Set([
    latest,
    ...recentUserMessages.slice(-2),
    recentUserMessages.slice(-2).join(' '),
  ].filter(Boolean) as string[])].slice(0, 4);
};

const injectPassiveHotSongs = async (messages: ChatMessage[]): Promise<VocaDbLookupResult[]> => {
  const recentQueries = buildPassiveHotSongQueries(messages);
  const queries = expandHotSongQueries(recentQueries);
  if (queries.length === 0) return [];
  const lookups = await searchBiliboardHotSongs(queries, { allowFuzzy: true });
  if (lookups.length > 0) {
    logMikuLookup('passive-hot-db-hit', {
      queries,
      resultCount: lookups.reduce((sum, lookup) => sum + lookup.results.length, 0),
      titles: lookups.flatMap((lookup) => lookup.results.map((song) => `${song.name}${song.matchKind ? `/${song.matchKind}` : ''}`)).slice(0, 6),
    });
  }
  return lookups;
};

const fetchVocaDbJsonp = (url: URL) => new Promise<unknown>((resolve, reject) => {
  const callbackName = `__vocadbLookup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const jsonpUrl = new URL(url.toString());
  jsonpUrl.searchParams.set('callback', callbackName);
  const script = document.createElement('script');
  const globalWindow = window as typeof window & Record<string, (payload: unknown) => void>;
  let settled = false;

  const cleanup = () => {
    delete globalWindow[callbackName];
    script.remove();
  };

  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new Error('VOCADB_JSONP_TIMEOUT'));
  }, 8000);

  globalWindow[callbackName] = (payload: unknown) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    cleanup();
    resolve(payload);
  };

  script.onerror = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    cleanup();
    reject(new Error('VOCADB_JSONP_LOAD_FAILED'));
  };

  script.src = jsonpUrl.toString();
  script.async = true;
  document.head.appendChild(script);
});

const searchVocaDbArtistsFromBrowser = async (query: string): Promise<VocaDbArtistResult[]> => {
  const normalizedQuery = cleanText(query, 120);
  if (!normalizedQuery) return [];
  const url = buildVocaDbArtistUrl(normalizedQuery);
  try {
    const response = await fetch(url.toString(), { method: 'GET', mode: 'cors', credentials: 'omit' });
    if (!response.ok) return [];
    const payload = await response.json();
    return parseVocaDbArtists(payload);
  } catch {
    return [];
  }
};

const searchVocaDbFromBrowser = async (query: string, artist?: VocaDbArtistResult): Promise<VocaDbLookupResult> => {
  const normalizedQuery = cleanText(query, 120);
  const url = buildVocaDbUrl(normalizedQuery);
  if (artist?.id) {
    url.searchParams.append('artistId[]', String(artist.id));
    url.searchParams.set('artistParticipationStatus', 'Everything');
  }
  try {
    const response = await fetch(url.toString(), { method: 'GET', mode: 'cors', credentials: 'omit' });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) throw new Error(`VOCADB_BROWSER_HTTP_${response.status}`);
    if (!contentType.includes('json')) throw new Error('VOCADB_BROWSER_NON_JSON_RESPONSE');
    const payload = await response.json();
    return {
      query: artist ? `${normalizedQuery} / ${artist.name}` : normalizedQuery,
      results: parseVocaDbResults(payload),
      primary: 'VocaDB',
      debug: {
        vocadbUrl: url.toString(),
        mode: 'browser-fetch',
        status: response.status,
        contentType,
        artistId: artist?.id,
        artistName: artist?.name,
      },
    };
  } catch (fetchError) {
    try {
      const payload = await fetchVocaDbJsonp(url);
      return {
        query: artist ? `${normalizedQuery} / ${artist.name}` : normalizedQuery,
        results: parseVocaDbResults(payload),
        primary: 'VocaDB',
        debug: {
          vocadbUrl: url.toString(),
          mode: 'jsonp',
          artistId: artist?.id,
          artistName: artist?.name,
          fetchError: fetchError instanceof Error ? fetchError.message : 'VOCADB_BROWSER_FETCH_FAILED',
        },
      };
    } catch (jsonpError) {
      return {
        query: artist ? `${normalizedQuery} / ${artist.name}` : normalizedQuery,
        results: [],
        error: jsonpError instanceof Error ? jsonpError.message : 'VOCADB_BROWSER_LOOKUP_FAILED',
        primary: 'VocaDB',
        debug: {
          vocadbUrl: url.toString(),
          mode: 'browser-failed',
          artistId: artist?.id,
          artistName: artist?.name,
          fetchError: fetchError instanceof Error ? fetchError.message : 'VOCADB_BROWSER_FETCH_FAILED',
          jsonpError: jsonpError instanceof Error ? jsonpError.message : 'VOCADB_JSONP_FAILED',
        },
      };
    }
  }
};

const searchHotSongsThenVocaDb = async (queries: string[]): Promise<VocaDbLookupResult[]> => {
  const normalizedQueries = [...new Set(expandHotSongQueries(queries).map((query) => cleanText(query, 120)).filter(Boolean))].slice(0, 3);
  if (normalizedQueries.length === 0) return [];
  const localLookups = await searchBiliboardHotSongs(normalizedQueries, { allowFuzzy: true });
  if (localLookups.length > 0) {
    logMikuLookup('hot-db-hit', {
      queries: normalizedQueries,
      resultCount: localLookups.reduce((sum, lookup) => sum + lookup.results.length, 0),
      titles: localLookups.flatMap((lookup) => lookup.results.map((song) => `${song.name}${song.matchKind ? `/${song.matchKind}` : ''}`)).slice(0, 6),
    });
    return localLookups;
  }
  logMikuLookup('hot-db-miss-vocadb-fallback', { queries: normalizedQueries });

  const artistMatches = await Promise.all(normalizedQueries.map(async (query) => ({
    query,
    artists: await searchVocaDbArtistsFromBrowser(query),
  })));
  const artistAwareLookups: VocaDbLookupResult[] = [];
  const usedPairs = new Set<string>();

  for (const artistMatch of artistMatches) {
    for (const artist of artistMatch.artists.slice(0, 2)) {
      for (const songQuery of normalizedQueries) {
        if (songQuery === artistMatch.query) continue;
        const pairKey = `${songQuery}::${artist.id}`;
        if (usedPairs.has(pairKey)) continue;
        usedPairs.add(pairKey);
        const lookup = await searchVocaDbFromBrowser(songQuery, artist);
        if (lookup.results.length > 0) artistAwareLookups.push(lookup);
      }
    }
  }

  if (artistAwareLookups.length > 0) return artistAwareLookups.slice(0, 3);
  return Promise.all(normalizedQueries.map((query) => searchVocaDbFromBrowser(query)));
};

const getLookupMemoryKey = (lookup: VocaDbLookupResult) => (
  lookup.results
    .map((song) => [song.source, song.id, song.name, song.artistString].map(normalizeLookupText).filter(Boolean).join(':'))
    .filter(Boolean)
    .join('|') || normalizeLookupText(lookup.query)
);

const mergeLookupLists = (...lookupLists: VocaDbLookupResult[][]) => {
  const merged = new Map<string, VocaDbLookupResult>();
  lookupLists.flat().forEach((lookup) => {
    const key = getLookupMemoryKey(lookup);
    if (!key || merged.has(key)) return;
    merged.set(key, lookup);
  });
  return [...merged.values()];
};

const NpcChatBox: React.FC<{
  chat: ActiveNpcChat;
  onClose: () => void;
  onDeclineInvite: () => void;
  onSend: (text: string) => void;
  onStartChat: () => void;
}> = ({ chat, onClose, onDeclineInvite, onSend, onStartChat }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const isMiku = chat.kind === 'miku';
  const bubbleStyle: React.CSSProperties = chat.anchor
    ? { left: chat.anchor.x, top: chat.anchor.y, transform: 'translate(-50%, -100%)' }
    : { left: '50%', bottom: '8rem', transform: 'translateX(-50%)' };
  const lastMessageContent = chat.messages.at(-1)?.content ?? '';

  useEffect(() => {
    if (!isMiku) return;
    const messages = messagesRef.current;
    if (!messages) return;
    messages.scrollTop = messages.scrollHeight;
  }, [isMiku, chat.messages.length, lastMessageContent, chat.isLoading, chat.error]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || chat.isLoading) return;
    setDraft('');
    onSend(text);
  };

  return (
    <div
      className={`absolute z-40 pointer-events-auto pixel-font ${isMiku ? 'w-[min(340px,calc(100vw-24px))]' : 'w-[min(280px,calc(100vw-24px))]'}`}
      style={bubbleStyle}
    >
      <div className="relative game-panel-strong text-slate-50 rounded-lg px-3 py-2">
        <div className="absolute left-1/2 -bottom-2 h-4 w-4 -translate-x-1/2 rotate-45 bg-slate-950/95 border-r border-b border-cyan-300/40"></div>
        <div className="flex items-center justify-between gap-2 border-b border-cyan-300/20 pb-1 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            {chat.image && (
              <img src={chat.image} alt={chat.speaker} className="w-8 h-10 object-cover shrink-0 rounded-sm border border-cyan-300/40 bg-cyan-100" style={{ imageRendering: 'pixelated' }} />
            )}
            <div className="text-xs font-bold tracking-normal text-cyan-100 truncate">{chat.speaker}</div>
          </div>
          <button onClick={onClose} className="shrink-0 h-6 w-6 game-button-secondary rounded text-white text-sm leading-none">×</button>
        </div>

        <div className="flex flex-col gap-2">
          <div ref={messagesRef} className={`${isMiku ? 'max-h-36 md:max-h-44' : 'max-h-28'} overflow-y-auto space-y-1 pr-1`}>
            {chat.messages.map((message, idx) => (
              <p key={idx} className={`text-xs md:text-sm leading-snug ${message.role === 'user' ? 'text-sky-200' : 'text-slate-100'}`}>
                <span className={message.role === 'user' ? 'text-sky-300 mr-1' : 'text-cyan-300 mr-1'}>{message.role === 'user' ? t('npc_user_prefix') : t('npc_assistant_prefix')}</span>
                {message.content}
              </p>
            ))}
            {chat.isLoading && <p className="text-cyan-300 text-xs animate-pulse">{t('npc_miku_thinking')}</p>}
            {chat.error && <p className="text-slate-400 text-[11px]">{chat.error}</p>}
          </div>
          {isMiku && chat.isInvite ? (
            <div className="flex justify-end gap-2">
              <button onClick={onDeclineInvite} className="px-3 py-1 game-button-secondary rounded-md text-xs font-bold">{t('npc_invite_wait')}</button>
              <button onClick={onStartChat} className="px-3 py-1 game-button rounded-md text-xs font-bold">{t('npc_invite_chat')}</button>
            </div>
          ) : isMiku ? (
            <form onSubmit={submit} className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={chat.isLoading}
                className="min-w-0 flex-1 game-input rounded-md px-2 py-1 text-xs"
                placeholder={t('npc_input_placeholder')}
              />
              <button disabled={chat.isLoading || !draft.trim()} className="px-3 py-1 game-button rounded-md text-white text-xs font-bold disabled:opacity-40">{t('npc_send')}</button>
            </form>
          ) : (
            <button onClick={onClose} className="self-end text-cyan-200 hover:text-white px-1 py-0.5 text-xs animate-pulse font-bold">{t('npc_continue')}</button>
          )}
        </div>
      </div>
    </div>
  );
};

const TypewriterEffect: React.FC<{ text: string[], onComplete: () => void }> = ({ text, onComplete }) => {
  const { t } = useTranslation();
  const [displayedLines, setDisplayedLines] = useState<string[]>([]);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [isSkipped, setIsSkipped] = useState(false);
  const [isFinished, setIsFinished] = useState(false);

  useEffect(() => {
    if (isSkipped) return;
    if (currentLineIndex >= text.length) {
      setIsFinished(true);
      return;
    }
    const currentLine = text[currentLineIndex];
    if (charIndex < currentLine.length) {
      const timer = setTimeout(() => {
        setDisplayedLines(prev => {
          const newLines = [...prev];
          if (!newLines[currentLineIndex]) newLines[currentLineIndex] = '';
          newLines[currentLineIndex] += currentLine[charIndex];
          return newLines;
        });
        setCharIndex(prev => prev + 1);
      }, 10);
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => {
        setCurrentLineIndex(prev => prev + 1);
        setCharIndex(0);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [currentLineIndex, charIndex, text, isSkipped]);

  const handleClick = () => {
    if (isFinished) {
      onComplete();
      return;
    }
    setIsSkipped(true);
    setIsFinished(true);
    setDisplayedLines(text);
    setCurrentLineIndex(text.length);
    setCharIndex(0);
  };

  return (
    <div onClick={handleClick} className="font-mono text-emerald-200 text-sm md:text-base leading-relaxed p-6 intro-terminal rounded-lg cursor-pointer transition-colors">
      {displayedLines.map((line, i) => <div key={i} className="min-h-[1.5em]">{line}</div>)}
      {!isFinished && <span className="inline-block w-2 h-4 bg-emerald-300 animate-pulse ml-1"></span>}
      <div className="text-right text-xs text-emerald-400/70 mt-4 animate-pulse">
        {isFinished ? t('typewriter_continue') : t('typewriter_skip')}
      </div>
    </div>
  );
};

const isPhoneOrIpad = () => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  const platform = navigator.platform || '';
  const isPhone = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua);
  const isIpad = /iPad/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  return maxTouchPoints > 0 && (isPhone || isIpad);
};

const isSafariBrowser = () => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/i.test(ua);
};

const App: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [gameState, setGameState] = useState<GameState>('MENU');
  const [dialogLines, setDialogLines] = useState<string[]>([]);
  const [dialogImage, setDialogImage] = useState<string | undefined>(undefined);
  const [introComplete, setIntroComplete] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [lastRunSummary, setLastRunSummary] = useState<RunSummary | null>(null);
  const [currentRunToken, setCurrentRunToken] = useState<string | null>(null);
  const [globalLeaderboard, setGlobalLeaderboard] = useState<GlobalLeaderboardEntry[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(AUTH_TOKEN_KEY);
    } catch {
      return null;
    }
  });
  const [authMode, setAuthMode] = useState<AuthMode>('register');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [uploadedScoreId, setUploadedScoreId] = useState<string | null>(null);
  const [viewerLeaderboardEntry, setViewerLeaderboardEntry] = useState<GlobalLeaderboardEntry | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadAttemptedRunToken, setUploadAttemptedRunToken] = useState<string | null>(null);
  const [masterVolume, setMasterVolume] = useState<number>(0.5);
  const [bloomStrength, setBloomStrength] = useState<number>(1.5);
  const [sfxVolume, setSfxVolume] = useState<number>(0.35);
  const [musicVolume, setMusicVolume] = useState<number>(0.3);
  const [isRunMusicReady, setIsRunMusicReady] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [activeNpcChat, setActiveNpcChat] = useState<ActiveNpcChat | null>(null);
  const [dismissedMikuIds, setDismissedMikuIds] = useState<Set<number>>(() => new Set());
  const [isCursorIdleHidden, setIsCursorIdleHidden] = useState<boolean>(false);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const cursorIdleTimerRef = useRef<number | null>(null);
  const lyricCacheRef = useRef<Map<string, LyricLookupResult>>(new Map());
  const songContextTurnRef = useRef(0);
  const recentSongLookupRef = useRef<RecentSongLookupEntry[]>([]);
  const lastChatAnchorUpdateRef = useRef(0);
  const lastChatAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const safariCompatMode = isSafariBrowser();

  const touchInputRef = useRef<TouchInput>({ left: false, right: false, up: false, down: false, action: false, attack: false, interact: false, dash: false });

  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const detectedLanguage = (i18n.resolvedLanguage || i18n.language || 'zh').split('-')[0];
  const currentLang: LanguageCode = languages.some((lang) => lang.code === detectedLanguage)
    ? detectedLanguage as LanguageCode
    : 'zh';
  const currentLangLabel = t(languages.find((lang) => lang.code === currentLang)?.labelKey || 'lang_zh');

  const handleSelect = (code: LanguageCode) => {
    void i18n.changeLanguage(code);
    setIsOpen(false);
  };

  useEffect(() => {
    document.documentElement.lang = currentLang;
  }, [currentLang]);

  const authHeaders = (extra: Record<string, string> = {}) => ({
    ...extra,
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  });

  const fetchGlobalLeaderboard = useCallback(async () => {
    try {
      const res = await fetch('/api/leaderboard', { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { entries?: GlobalLeaderboardEntry[]; viewerBest?: GlobalLeaderboardEntry | null };
      setGlobalLeaderboard(Array.isArray(data.entries) ? data.entries.slice(0, 50) : []);
      setViewerLeaderboardEntry(data.viewerBest ?? null);
    } catch {
      setGlobalLeaderboard([]);
      setViewerLeaderboardEntry(null);
    }
  }, [authToken]);

  useEffect(() => {
    if (safariCompatMode && !isGameOver) return;
    void fetchGlobalLeaderboard();
  }, [fetchGlobalLeaderboard, isGameOver, safariCompatMode]);

  useEffect(() => {
    if (!isGameOver) return;
    void fetchGlobalLeaderboard();
    const timer = window.setInterval(() => {
      void fetchGlobalLeaderboard();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [isGameOver, fetchGlobalLeaderboard]);

  useEffect(() => {
    if (!authToken) {
      setAuthUser(null);
      return;
    }
    let cancelled = false;
    const loadMe = async () => {
      try {
        const res = await fetch('/api/auth/me', { headers: authHeaders() });
        const data = await res.json() as { user?: AuthUser | null };
        if (cancelled) return;
        if (res.ok && data.user) setAuthUser(data.user);
        else {
          setAuthToken(null);
          localStorage.removeItem(AUTH_TOKEN_KEY);
        }
      } catch {
        if (!cancelled) setAuthMessage(t('auth_sync_fail'));
      }
    };
    void loadMe();
    return () => { cancelled = true; };
  }, [authToken, t]);

  useEffect(() => {
    if (!authToken || !authUser?.id) return;
    let cancelled = false;
    const syncMikuMemory = async () => {
      try {
        await syncAccountMikuMemoryFromServer(authToken, authUser.id);
      } catch {
        if (!cancelled) setAuthMessage(t('miku_memory_sync_fail'));
      }
    };
    void syncMikuMemory();
    return () => { cancelled = true; };
  }, [authToken, authUser?.id, t]);

  const sha256Hex = async (text: string) => {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  const solvePow = async (nonce: string, difficulty: number) => {
    const target = '0'.repeat(difficulty);
    for (let answer = 0; answer < 20_000_000; answer++) {
      const digest = await sha256Hex(`${nonce}:${answer}`);
      if (digest.startsWith(target)) return String(answer);
    }
    throw new Error('POW_TIMEOUT');
  };

  const saveAuth = (token: string, user: AuthUser, inheritGuestMemory = false) => {
    if (inheritGuestMemory) {
      const userMemoryScope = mikuMemoryScopeForAccount(user.id);
      inheritGuestMikuMemoryForAccount(user.id, token);
      setActiveNpcChat((current) => {
        if (!current || current.kind !== 'miku' || !current.memoryScope?.startsWith('guest')) return current;
        return { ...current, memoryScope: userMemoryScope };
      });
    }
    setAuthToken(token);
    setAuthUser(user);
    setAuthMessage(t('logged_in_as_message', { username: user.username }));
    setIsAuthModalOpen(false);
    try {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } catch {
      // Auth still works in memory when local storage is unavailable.
    }
  };

  const submitAuth = async () => {
    if (authBusy) return;
    setAuthBusy(true);
    setAuthMessage(authMode === 'register' ? t('auth_registering') : t('auth_logging_in'));
    try {
      let pow: { nonce: string; answer: string } | undefined;
      if (authMode === 'register') {
        const challengeRes = await fetch('/api/auth/challenge', { method: 'POST' });
        const challenge = await challengeRes.json() as { nonce: string; difficulty: number; error?: string };
        if (!challengeRes.ok) throw new Error(challenge.error || 'CHALLENGE_FAILED');
        const answer = await solvePow(challenge.nonce, challenge.difficulty);
        pow = { nonce: challenge.nonce, answer };
      }

      const res = await fetch(`/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authUsername, password: authPassword, pow }),
      });
      const data = await res.json() as { token?: string; user?: AuthUser; error?: string };
      if (!res.ok || !data.token || !data.user) throw new Error(data.error || 'AUTH_FAILED');
      saveAuth(data.token, data.user, authMode === 'register');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AUTH_FAILED';
      const friendly = message === 'USERNAME_TAKEN'
        ? t('auth_username_taken')
        : message === 'BAD_PASSWORD'
          ? t('auth_bad_password')
          : message === 'BAD_USERNAME'
            ? t('auth_bad_username')
            : message === 'REGISTER_RATE_LIMITED'
              ? t('auth_rate_limited')
              : message === 'BAD_CREDENTIALS'
                ? t('auth_bad_credentials')
                : t('auth_generic_fail');
      setAuthMessage(friendly);
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    if (authToken) void fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
    setAuthToken(null);
    setAuthUser(null);
    setViewerLeaderboardEntry(null);
    setAuthMessage('');
    try {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch {
      // Nothing to clear.
    }
  };

  const recordRun = (summary: RunSummary) => {
    setLastRunSummary(summary);
  };

  const submitGlobalScore = async (tokenOverride?: string) => {
    const token = tokenOverride || authToken;
    if (!lastRunSummary || !token || uploadBusy || uploadedScoreId) return;
    if (!currentRunToken) {
      setAuthMessage(t('run_no_token'));
      return;
    }
    setUploadBusy(true);
    setUploadAttemptedRunToken(currentRunToken);
    setAuthMessage(t('uploading_score'));
    try {
      const res = await fetch('/api/leaderboard/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ summary: lastRunSummary, runToken: currentRunToken }),
      });
      const data = await res.json() as { entry?: GlobalLeaderboardEntry; entries?: GlobalLeaderboardEntry[]; viewerBest?: GlobalLeaderboardEntry | null; error?: string };
      if (!res.ok || !data.entry) throw new Error(data.error || 'UPLOAD_FAILED');
      setUploadedScoreId(data.entry.id);
      setViewerLeaderboardEntry(data.viewerBest ?? data.entry);
      if (Array.isArray(data.entries)) setGlobalLeaderboard(data.entries.slice(0, 50));
      else void fetchGlobalLeaderboard();
      setAuthMessage(t('upload_success'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'UPLOAD_FAILED';
      const friendly = message === 'RUN_ALREADY_SUBMITTED'
        ? t('upload_already_submitted')
        : message === 'LOGIN_REQUIRED'
          ? t('upload_login_required')
          : message === 'SCORE_TOO_HIGH' || message === 'DISTANCE_TOO_HIGH' || message === 'TIME_TRAVEL'
            ? t('upload_score_rejected')
            : t('upload_fail_generic');
      setAuthMessage(friendly);
    } finally {
      setUploadBusy(false);
    }
  };

  useEffect(() => {
    if (!isGameOver || !authToken || !lastRunSummary || !currentRunToken || uploadedScoreId || uploadBusy) return;
    if (uploadAttemptedRunToken === currentRunToken) return;
    void submitGlobalScore(authToken);
  }, [isGameOver, authToken, lastRunSummary, currentRunToken, uploadedScoreId, uploadBusy, uploadAttemptedRunToken]);

  useEffect(() => {
    const checkDevice = () => {
      setIsMobile(isPhoneOrIpad());
    };
    checkDevice();
    window.addEventListener('resize', checkDevice);
    window.visualViewport?.addEventListener('resize', checkDevice);
    return () => {
      window.removeEventListener('resize', checkDevice);
      window.visualViewport?.removeEventListener('resize', checkDevice);
    };
  }, []);

  useEffect(() => {
    if (isMobile && gameState === 'PLAYING') return;
    touchInputRef.current = { left: false, right: false, up: false, down: false, action: false, attack: false, interact: false, dash: false };
  }, [isMobile, gameState]);

  useEffect(() => {
    if (safariCompatMode && gameState === 'MENU') return;
    gameAudio.setMusic('/audio/bgm.mp3', { loop: true });
    const cleanupUnlock = gameAudio.installGestureUnlock();
    return () => {
      cleanupUnlock();
      gameAudio.stopMusic({ reset: true });
    };
  }, [gameState, safariCompatMode]);

  useEffect(() => {
    gameAudio.setVolumes({ master: masterVolume, sfx: sfxVolume, music: musicVolume });
  }, [masterVolume, sfxVolume, musicVolume]);

  useEffect(() => {
    const syncMusic = () => {
      gameAudio.setMusicDesired(gameState === 'PLAYING' && isRunMusicReady && !document.hidden);
    };
    syncMusic();
    document.addEventListener('visibilitychange', syncMusic);
    return () => document.removeEventListener('visibilitychange', syncMusic);
  }, [gameState, isRunMusicReady]);

  const startRun = () => {
    setIsGameOver(false);
    setLastRunSummary(null);
    setCurrentRunToken(null);
    setUploadedScoreId(null);
    setUploadAttemptedRunToken(null);
    setActiveNpcChat(null);
    setDismissedMikuIds(new Set());
    setIsRunMusicReady(false);
    gameAudio.stopMusic({ reset: true });
    setGameState('PLAYING');
    setDialogLines([]);
    void fetch('/api/runs/start', { method: 'POST', headers: authHeaders() })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((data: { runToken?: string }) => {
        if (data.runToken) setCurrentRunToken(data.runToken);
      })
      .catch(() => {
        setAuthMessage(t('run_server_disconnected'));
      });
  };

  const finalizeMikuChatMemory = useCallback((chat: ActiveNpcChat) => {
    if (chat.kind !== 'miku' || chat.isInvite || chat.isLoading) return;
    const prepared = prepareMikuMemoryEndRequest(chat.messages, chat.memoryScope);
    if (!prepared) return;

    void fetch('/api/miku-chat/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepared.request),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json() as MikuMemoryEndResult;
      })
      .then((result) => {
        commitMikuMemoryEndResult(prepared, result, authToken);
      })
      .catch(() => {
        commitMikuMemoryEndResult(prepared, undefined, authToken);
      });
  }, [authToken]);

  const startNpcChat = useCallback((session: NpcChatSession) => {
    const memoryScope = session.kind === 'miku' ? mikuMemoryScopeForAccount(authUser?.id) : undefined;
    const pendingMikuGreeting = session.kind === 'miku' ? consumePendingMikuGreeting(memoryScope, authToken) : undefined;
    const lines = pendingMikuGreeting ? [pendingMikuGreeting] : session.lines;
    setActiveNpcChat({
      ...session,
      lines,
      messages: lines.map((content) => ({ role: 'assistant', content })),
      isLoading: false,
      memoryScope,
    });
    setDialogLines([]);
    setDialogImage(session.image);
  }, [authToken, authUser?.id]);

  const closeNpcChat = () => {
    if (activeNpcChat) finalizeMikuChatMemory(activeNpcChat);
    setActiveNpcChat(null);
    setDialogLines([]);
    setDialogImage(undefined);
  };

  const declineNpcChatInvite = () => {
    // Read from the render-scope closure. Never call setState inside another
    // setter's updater because StrictMode can invoke updaters more than once.
    if (activeNpcChat?.isInvite && activeNpcChat.target?.type === 'npc' && activeNpcChat.target.kind === 'miku') {
      const dismissedId = activeNpcChat.target.id;
      setDismissedMikuIds((prev) => {
        const next = new Set(prev);
        next.add(dismissedId);
        return next;
      });
    }
    setActiveNpcChat(null);
    setDialogLines([]);
    setDialogImage(undefined);
  };

  const startActiveMikuChat = () => {
    setActiveNpcChat((current) => {
      if (!current || current.kind !== 'miku') return current;
      return { ...current, isInvite: false };
    });
  };

  const updateNpcChatAnchor = useCallback((anchor: { x: number; y: number }) => {
    const now = performance.now();
    const previous = lastChatAnchorRef.current;
    if (
      previous
      && now - lastChatAnchorUpdateRef.current < 100
      && Math.abs(previous.x - anchor.x) < 10
      && Math.abs(previous.y - anchor.y) < 10
    ) {
      return;
    }
    lastChatAnchorUpdateRef.current = now;
    lastChatAnchorRef.current = anchor;
    setActiveNpcChat((current) => {
      if (!current) return current;
      if (current.anchor && Math.abs(current.anchor.x - anchor.x) < 4 && Math.abs(current.anchor.y - anchor.y) < 4) return current;
      return { ...current, anchor };
    });
  }, []);

  const rememberLyricsForSong = (song: VocaDbSongResult, lyrics: LyricLookupResult) => {
    lyricCacheKeysForSong(song).forEach((key) => lyricCacheRef.current.set(key, lyrics));
    if (lyrics.title) lyricCacheRef.current.set(normalizeLookupText(lyrics.title), lyrics);
    if (lyrics.songTitle) lyricCacheRef.current.set(normalizeLookupText(lyrics.songTitle), lyrics);
  };

  const hasFullLyricContext = (lyrics?: LyricLookupResult) => Boolean(lyrics?.fullLyricsAvailable && (lyrics.fullLyricText || lyrics.fullParallelText));

  const fetchLyricsForSong = async (song: VocaDbSongResult, options: { includeFullLyrics?: boolean } = {}): Promise<LyricLookupResult | undefined> => {
    const cached = lyricCacheKeysForSong(song).map((key) => lyricCacheRef.current.get(key)).find(Boolean);
    if (cached && (!options.includeFullLyrics || hasFullLyricContext(cached))) return cached;
    try {
      const res = await fetch('/api/vocaloid-lyrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: [song.name, song.additionalNames, song.artistString].filter(Boolean).join(' '), song, includeFullLyrics: Boolean(options.includeFullLyrics) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lyrics = await res.json() as LyricLookupResult;
      rememberLyricsForSong(song, lyrics);
      logMikuLookup('lyrics-prefetch', {
        song: song.name,
        found: lyrics.found,
        title: lyrics.title,
        lyricLineCount: lyrics.lyricLineCount,
        error: lyrics.error,
      });
      return lyrics;
    } catch (error) {
      const lyrics: LyricLookupResult = {
        query: song.name,
        found: false,
        error: error instanceof Error ? error.message : 'LYRICS_LOOKUP_FAILED',
      };
      rememberLyricsForSong(song, lyrics);
      return lyrics;
    }
  };

  const prefetchLyricsForLookups = async (lookups: VocaDbLookupResult[], options: { includeFullLyrics?: boolean } = {}) => {
    const songs = lookups.flatMap((lookup) => lookup.results).slice(0, 4);
    if (!songs.length) return [];
    return Promise.all(songs.map((song) => fetchLyricsForSong(song, options)));
  };

  const getRecentSongLookups = (turn: number) => {
    recentSongLookupRef.current = recentSongLookupRef.current.filter((entry) => entry.expiresAtTurn >= turn);
    return recentSongLookupRef.current.map((entry) => entry.lookup);
  };

  const rememberRecentSongLookups = (lookups: VocaDbLookupResult[], turn: number) => {
    if (!lookups.length) return;
    const entries = new Map<string, RecentSongLookupEntry>(recentSongLookupRef.current.map((entry) => [entry.key, entry]));
    lookups.forEach((lookup) => {
      if (!lookup.results.length) return;
      const key = getLookupMemoryKey(lookup);
      if (!key) return;
      entries.set(key, {
        key,
        lookup,
        expiresAtTurn: turn + 3,
      });
    });
    recentSongLookupRef.current = [...entries.values()].filter((entry) => entry.expiresAtTurn >= turn).slice(-8);
  };

  const lyricsForLookups = (lookups: VocaDbLookupResult[]) => {
    const contexts: LyricLookupResult[] = [];
    const seen = new Set<string>();
    lookups.flatMap((lookup) => lookup.results).forEach((song) => {
      const lyrics = lyricCacheKeysForSong(song).map((key) => lyricCacheRef.current.get(key)).find(Boolean);
      if (!lyrics) return;
      const key = normalizeLookupText(lyrics.title || lyrics.query || song.name);
      if (seen.has(key)) return;
      seen.add(key);
      contexts.push(lyrics);
    });
    return contexts.slice(0, 3);
  };

  const fetchLyricsForQueries = async (queries: string[], lookups: VocaDbLookupResult[], options: { includeFullLyrics?: boolean } = {}) => {
    const lookupSongs = lookups.flatMap((lookup) => lookup.results);
    const contexts: LyricLookupResult[] = [];
    for (const query of queries.slice(0, 3)) {
      const normalizedQuery = normalizeLookupText(query);
      const matchedSong = lookupSongs.find((song) => (
        lyricCacheKeysForSong(song).some((key) => key && (key.includes(normalizedQuery) || normalizedQuery.includes(key)))
      ));
      if (matchedSong) {
        const lyrics = await fetchLyricsForSong(matchedSong, options);
        if (lyrics) contexts.push(lyrics);
        continue;
      }
      try {
        const res = await fetch('/api/vocaloid-lyrics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, includeFullLyrics: Boolean(options.includeFullLyrics) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const lyrics = await res.json() as LyricLookupResult;
        if (lyrics.title) lyricCacheRef.current.set(normalizeLookupText(lyrics.title), lyrics);
        contexts.push(lyrics);
      } catch (error) {
        contexts.push({
          query,
          found: false,
          error: error instanceof Error ? error.message : 'LYRICS_LOOKUP_FAILED',
        });
      }
    }
    return contexts;
  };

  const sendMikuMessage = async (text: string) => {
    if (!activeNpcChat || activeNpcChat.kind !== 'miku' || activeNpcChat.isLoading) return;
    const userMessage: ChatMessage = { role: 'user', content: text };
    const nextMessages = [...activeNpcChat.messages, userMessage];
    setActiveNpcChat({ ...activeNpcChat, messages: nextMessages, isLoading: true, error: undefined });

    let reply = '';
    let error: string | undefined;
    try {
      const currentSongTurn = ++songContextTurnRef.current;
      const wantsLyricsNow = lyricContextKeywords.test(text);
      const isSongDiscussion = songDiscussionKeywords.test(text);
      const currentLookups = await injectPassiveHotSongs(nextMessages);
      rememberRecentSongLookups(currentLookups, currentSongTurn);
      const passiveLookups = mergeLookupLists(currentLookups, getRecentSongLookups(currentSongTurn));
      await prefetchLyricsForLookups(passiveLookups);
      const initialLyricContexts = (wantsLyricsNow || isSongDiscussion) ? lyricsForLookups(passiveLookups) : [];
      const memoryScope = activeNpcChat.memoryScope ?? mikuMemoryScopeForAccount(authUser?.id);
      const memoryBrief = buildMikuMemoryBrief(memoryScope);
      const res = await fetch('/api/miku-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages, passiveVocaloidLookups: passiveLookups, lyricContexts: initialLyricContexts, memoryBrief }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as MikuChatApiResponse;
      if (data.action === 'memory_search' && Array.isArray(data.queries) && data.queries.length > 0) {
        const memorySearchResults = data.queries.flatMap((query) => searchMikuTopicMemory(query, memoryScope));
        const uniqueMemorySearchResults = [...new Map(memorySearchResults.map((result) => [`${result.sessionId}:${result.topicId}`, result])).values()].slice(0, 3);
        const finalRes = await fetch('/api/miku-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: nextMessages, passiveVocaloidLookups: passiveLookups, lyricContexts: initialLyricContexts, memoryBrief, memorySearchResults: uniqueMemorySearchResults }),
        });
        if (!finalRes.ok) throw new Error(`HTTP ${finalRes.status}`);
        const finalData = await finalRes.json() as MikuChatApiResponse;
        if (typeof finalData.reply === 'string' && finalData.reply.trim()) reply = finalData.reply.trim();
        else throw new Error(finalData.error || 'EMPTY_REPLY');
      } else if (data.action === 'vocaloid_search' && Array.isArray(data.queries) && data.queries.length > 0) {
        const lookups = await searchHotSongsThenVocaDb(data.queries);
        rememberRecentSongLookups(lookups, currentSongTurn);
        const combinedLookups = mergeLookupLists(lookups, passiveLookups, getRecentSongLookups(currentSongTurn));
        await prefetchLyricsForLookups(combinedLookups);
        const lyricContexts = (wantsLyricsNow || isSongDiscussion) ? lyricsForLookups(combinedLookups) : [];
        const finalRes = await fetch('/api/miku-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: nextMessages, vocaloidLookups: lookups, passiveVocaloidLookups: combinedLookups, lyricContexts, memoryBrief }),
        });
        if (!finalRes.ok) throw new Error(`HTTP ${finalRes.status}`);
        const finalData = await finalRes.json() as MikuChatApiResponse;
        if (typeof finalData.reply === 'string' && finalData.reply.trim()) reply = finalData.reply.trim();
        else throw new Error(finalData.error || 'EMPTY_REPLY');
      } else if ((data.action === 'vocaloid_lyrics' || data.action === 'vocaloid_full_lyrics') && Array.isArray(data.queries) && data.queries.length > 0) {
        const lyricContexts = await fetchLyricsForQueries(data.queries, passiveLookups, { includeFullLyrics: data.action === 'vocaloid_full_lyrics' });
        const finalRes = await fetch('/api/miku-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: nextMessages, passiveVocaloidLookups: passiveLookups, lyricContexts, memoryBrief }),
        });
        if (!finalRes.ok) throw new Error(`HTTP ${finalRes.status}`);
        const finalData = await finalRes.json() as MikuChatApiResponse;
        if (typeof finalData.reply === 'string' && finalData.reply.trim()) reply = finalData.reply.trim();
        else throw new Error(finalData.error || 'EMPTY_REPLY');
      } else if (typeof data.reply === 'string' && data.reply.trim()) {
        reply = data.reply.trim();
      }
      else throw new Error('EMPTY_REPLY');
    } catch (sendError) {
      error = t('miku_connection_unavailable', { message: sendError instanceof Error ? sendError.message : '' });
    }

    // Only apply the reply if this is still the exact chat session that sent it.
    // Closing and reopening creates a new messages array, so stale replies bail.
    setActiveNpcChat((current) => {
      if (!current || current.kind !== 'miku') return current;
      if (current.messages !== nextMessages) return current;
      return {
        ...current,
        messages: reply ? [...nextMessages, { role: 'assistant', content: reply }] : nextMessages,
        isLoading: false,
        error,
      };
    });
  };

  const handleTouchStart = (key: keyof TouchInput, e?: React.TouchEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    void gameAudio.unlock();
    if (gameState === 'PLAYING' && !isRunMusicReady) {
      setIsRunMusicReady(true);
      gameAudio.setMusicDesired(!document.hidden);
    }
    touchInputRef.current[key] = true;
  };
  const handleTouchEnd = (key: keyof TouchInput, e?: React.TouchEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    touchInputRef.current[key] = false;
  };
  const preventCtx = (e: React.MouseEvent | React.TouchEvent) => { e.preventDefault(); e.stopPropagation(); };
  const canAutoHideCursor = gameState === 'PLAYING' && !isSettingsOpen && !activeNpcChat;
  const shouldHideCursor = canAutoHideCursor && isCursorIdleHidden;

  useEffect(() => {
    const clearCursorTimer = () => {
      if (cursorIdleTimerRef.current !== null) {
        window.clearTimeout(cursorIdleTimerRef.current);
        cursorIdleTimerRef.current = null;
      }
    };

    if (!canAutoHideCursor) {
      clearCursorTimer();
      setIsCursorIdleHidden(false);
      return clearCursorTimer;
    }

    const armCursorTimer = () => {
      clearCursorTimer();
      cursorIdleTimerRef.current = window.setTimeout(() => {
        setIsCursorIdleHidden(true);
        cursorIdleTimerRef.current = null;
      }, 2000);
    };

    const showCursorAndRearm = () => {
      setIsCursorIdleHidden(false);
      armCursorTimer();
    };

    showCursorAndRearm();
    window.addEventListener('pointermove', showCursorAndRearm);
    window.addEventListener('mousemove', showCursorAndRearm);
    return () => {
      window.removeEventListener('pointermove', showCursorAndRearm);
      window.removeEventListener('mousemove', showCursorAndRearm);
      clearCursorTimer();
    };
  }, [canAutoHideCursor]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const displayedGlobalLeaderboard = globalLeaderboard.slice(0, 50);
  const viewerIsInTopList = !!viewerLeaderboardEntry && displayedGlobalLeaderboard.some((entry) => entry.id === viewerLeaderboardEntry.id);
  const shouldMountGameCanvas = gameState !== 'MENU';

  return (
    <div ref={appShellRef} className={`fixed inset-0 bg-[#050510] overflow-hidden font-mono selection:bg-cyan-500 selection:text-black ${shouldHideCursor ? 'cursor-none' : 'cursor-auto'}`}>
      {shouldHideCursor && <style>{'* { cursor: none !important; }'}</style>}
      <button aria-label={t('settings_title')} onClick={() => setIsSettingsOpen(true)} className="absolute top-5 right-5 z-50 h-11 w-11 rounded-full game-panel text-white text-lg hover:border-cyan-300/70 transition-all active:scale-95">⚙</button>

      {isSettingsOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90 p-4">
          <div className="game-panel-strong p-6 md:p-8 rounded-lg w-full max-w-sm text-white">
            <h2 className="text-2xl font-bold mb-7 pixel-font text-center text-cyan-200">{t('settings_title')}</h2>
            <div className="mb-7">
              <label className="text-slate-300 text-sm font-bold mb-3 flex justify-between">
                <span>{t('master_volume')}</span>
                <span className="text-cyan-400">{Math.round(masterVolume * 100)}%</span>
              </label>
              <input type="range" min="0" max="1" step="0.05" value={masterVolume} onChange={(e) => setMasterVolume(parseFloat(e.target.value))} className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400" />
            </div>
            <div className="mb-7">
              <label className="text-slate-300 text-sm font-bold mb-3 flex justify-between">
                <span>{t('sfx_volume')}</span>
                <span className="text-cyan-400">{Math.round(sfxVolume * 100)}%</span>
              </label>
              <input type="range" min="0" max="1" step="0.05" value={sfxVolume} onChange={(e) => setSfxVolume(parseFloat(e.target.value))} className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400" />
            </div>
            <div className="mb-8">
              <label className="text-slate-300 text-sm font-bold mb-3 flex justify-between">
                <span>{t('music_volume')}</span>
                <span className="text-cyan-400">{Math.round(musicVolume * 100)}%</span>
              </label>
              <input type="range" min="0" max="1" step="0.05" value={musicVolume} onChange={(e) => setMusicVolume(parseFloat(e.target.value))} className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400" />
            </div>
            <div className="mb-8">
              <label className="text-slate-300 text-sm font-bold mb-3 flex justify-between">
                <span>{t('bloom_strength')}</span>
                <span className="text-cyan-400">{bloomStrength.toFixed(1)}</span>
              </label>
              <input type="range" min="0.5" max="3.0" step="0.1" value={bloomStrength} onChange={(e) => setBloomStrength(parseFloat(e.target.value))} className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-400" />
            </div>
            <div className="mb-8">
              <label className="text-slate-300 text-sm font-bold mb-3 flex justify-between">
                <span>{t('language_label')}</span>
              </label>
              <div className="relative w-full" ref={menuRef}>
                <button
                  type="button"
                  className="lang-select-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={isOpen}
                  onClick={() => setIsOpen((open) => !open)}
                >
                  <span>{currentLangLabel}</span>
                  <span aria-hidden="true" className={`lang-select-arrow ${isOpen ? 'open' : ''}`} />
                </button>
                {isOpen && (
                  <ul className="lang-select-menu" role="listbox" aria-label={t('language_label')}>
                    {languages.map((lang) => {
                      const isActive = currentLang === lang.code;
                      return (
                        <li key={lang.code} role="none">
                          <button
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            className={`lang-select-item ${isActive ? 'active' : ''}`}
                            onClick={() => handleSelect(lang.code)}
                          >
                            {t(lang.labelKey)}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
            <button onClick={() => setIsSettingsOpen(false)} className="w-full py-3 game-button text-white font-bold rounded-md text-sm">{t('confirm_return')}</button>
          </div>
        </div>
      )}

      {shouldMountGameCanvas && (
      <div className="absolute inset-0 z-10">
          <GameCanvas 
          gameState={gameState} setGameState={setGameState} 
          setDialogContent={setDialogLines} setDialogImage={setDialogImage}
          onGameOver={(summary) => { gameAudio.stopMusic(); setIsRunMusicReady(false); if (activeNpcChat) finalizeMikuChatMemory(activeNpcChat); setActiveNpcChat(null); recordRun(summary); setGameState('MENU'); setIsGameOver(true); setIntroComplete(true); }}
          onWin={() => { setGameState('ENDING'); setDialogLines(LYRICS.ending.map(line => t(line))); setDialogImage(IDLE_SPRITE_URLS[0]); }}
          onRunIntroStart={() => {
            void gameAudio.unlock();
            setIsRunMusicReady(true);
            gameAudio.setMusicDesired(!document.hidden);
          }}
          onNpcChatStart={startNpcChat}
          activeNpcChatTarget={activeNpcChat?.target}
          activeConversationTarget={activeNpcChat && !activeNpcChat.isInvite ? activeNpcChat.target : undefined}
          dismissedMikuIds={dismissedMikuIds}
          onNpcChatAnchorChange={updateNpcChatAnchor}
          masterVolume={masterVolume} sfxVolume={sfxVolume} touchInputRef={touchInputRef}
          bloomStrength={bloomStrength}
        />
      </div>
      )}

      {gameState === 'MENU' && (
        <div className="absolute inset-0 main-menu-screen flex flex-col items-center justify-center text-center p-4 z-40">
          {isGameOver ? (
             <div className="animate-in fade-in zoom-in duration-500 flex flex-col items-center gap-6 w-full max-w-4xl">
               <h1 className="text-5xl md:text-7xl text-cyan-100 font-bold pixel-font drop-shadow-[0_0_30px_rgba(34,211,238,0.42)]">{t('game_over_title')}</h1>
               {lastRunSummary && (
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full">
                   <div className="game-panel p-4 rounded-lg text-left">
                     <div className="text-slate-400 text-xs">{t('score_label')}</div>
                     <div className="text-3xl text-yellow-300 font-bold">{lastRunSummary.score.toLocaleString()}</div>
                   </div>
                   <div className="game-panel p-4 rounded-lg text-left">
                     <div className="text-slate-400 text-xs">{t('distance_label')}</div>
                     <div className="text-3xl text-cyan-300 font-bold">{lastRunSummary.distance}m</div>
                   </div>
                   <div className="game-panel p-4 rounded-lg text-left">
                     <div className="text-slate-400 text-xs">{t('combo_label')}</div>
                     <div className="text-3xl text-pink-300 font-bold">x{lastRunSummary.bestCombo}</div>
                   </div>
                   <div className="game-panel p-4 rounded-lg text-left">
                     <div className="text-slate-400 text-xs">{t('title_label')}</div>
                     <div className="text-xl text-white font-bold">{lastRunSummary.title}</div>
                   </div>
                 </div>
               )}
               <div className="grid md:grid-cols-[0.85fr_1.15fr] gap-4 w-full">
                 <div className="game-panel rounded-lg p-4 text-left">
                   <h2 className="text-cyan-300 font-bold mb-3">{t('local_score_title')}</h2>
                   <div className="text-sm text-slate-300">{t('score')}</div>
                   <div className="text-4xl text-yellow-300 font-bold mb-3">{lastRunSummary?.score.toLocaleString() ?? '0'}</div>
                   {authUser ? (
                     <div className="space-y-3">
                       <div className="text-sm text-slate-300">{t('logged_in_as', { username: authUser.username })}</div>
                       <div className="text-sm text-yellow-200">
                         {uploadedScoreId ? t('already_uploaded') : uploadBusy ? t('uploading') : t('waiting_upload')}
                       </div>
                       {!uploadedScoreId && !uploadBusy && (
                         <button onClick={() => void submitGlobalScore()} className="px-4 py-2 bg-yellow-400 text-slate-950 font-bold rounded-md hover:bg-yellow-300 transition-colors">{t('reupload')}</button>
                       )}
                       <button onClick={logout} className="px-4 py-2 game-button-secondary rounded-md">{t('logout')}</button>
                     </div>
                   ) : (
                     <div className="space-y-3">
                       <p className="text-sm text-slate-300">{t('login_prompt')}</p>
                       <button onClick={() => { setAuthMode('register'); setIsAuthModalOpen(true); }} className="px-4 py-2 game-button text-white font-bold rounded-md">{t('login_register_btn')}</button>
                     </div>
                   )}
                   {authMessage && <div className="mt-3 text-xs text-yellow-200">{authMessage}</div>}
                 </div>

                 <div className="game-panel rounded-lg p-4 w-full">
                   <div className="flex items-center justify-between gap-3 mb-3">
                     <h2 className="text-yellow-300 font-bold text-left">{t('global_top50')}</h2>
                     <button onClick={() => void fetchGlobalLeaderboard()} className="text-xs game-button-secondary px-2 py-1 rounded-md">{t('refresh')}</button>
                   </div>
                   {authUser && viewerLeaderboardEntry && !viewerIsInTopList && (
                     <div className="mb-3 grid grid-cols-[72px_1fr_90px_80px] gap-2 text-sm px-2 py-2 border border-cyan-400/70 bg-cyan-500/15 text-cyan-50 rounded-md">
                       <span className="text-yellow-300">#{viewerLeaderboardEntry.rank}</span>
                       <span className="font-bold">{viewerLeaderboardEntry.playerName}</span>
                       <span>{viewerLeaderboardEntry.score.toLocaleString()}</span>
                       <span>{viewerLeaderboardEntry.distance}m</span>
                     </div>
                   )}
                   <div className="grid grid-cols-[48px_1fr_90px_80px] gap-2 text-xs text-slate-400 px-2 pb-2 border-b border-slate-800">
                     <span>#</span><span>{t('player')}</span><span>{t('score')}</span><span>{t('distance')}</span>
                   </div>
                   {displayedGlobalLeaderboard.length === 0 ? (
                     <div className="text-slate-500 py-6">{t('no_global_records')}</div>
                   ) : displayedGlobalLeaderboard.map((entry) => {
                     const isViewerEntry = !!authUser && entry.userId === authUser.id;
                     return (
                     <div key={entry.id} className={`grid grid-cols-[48px_1fr_90px_80px] gap-2 text-sm px-2 py-2 border-b border-slate-900 ${isViewerEntry ? 'bg-cyan-950/60 text-cyan-50 ring-1 ring-cyan-500/70' : 'text-white'}`}>
                       <span className="text-yellow-300">{entry.rank}</span>
                       <span className={isViewerEntry ? 'font-bold text-cyan-100' : ''}>{entry.playerName}</span>
                       <span>{entry.score.toLocaleString()}</span>
                       <span>{entry.distance}m</span>
                     </div>
                     );
                   })}
                 </div>
               </div>
               <button onClick={startRun} className="px-16 py-5 game-button font-bold pixel-font text-white text-xl rounded-md">{t('retry')}</button>
             </div>
          ) : (
            !introComplete ? <TypewriterEffect key={currentLang} text={LYRICS.intro.map((line) => t(line))} onComplete={() => setIntroComplete(true)} /> : (
              <div className="animate-in fade-in zoom-in duration-500 main-menu-shell rounded-lg px-6 py-7 md:px-10 md:py-9 text-left">
                <div className="flex items-center justify-between gap-4 border-b border-cyan-800/70 pb-4">
                  <div className="text-xs text-cyan-200 font-bold">CAT_NET / ENDLESS CASE</div>
                  <div className="text-xs text-yellow-300 font-bold">RUN_01</div>
                </div>
                <div className="py-8 md:py-10">
                  <h1 className="main-menu-title text-6xl md:text-8xl font-bold pixel-font leading-none">{t('main_title')}</h1>
                  <div className="mt-5 max-w-xl text-sm md:text-base leading-relaxed text-slate-300">
                    {t('main_subtitle')}
                  </div>
                </div>
                <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 border-t border-cyan-800/70 pt-5">
                  <div className="grid grid-cols-3 gap-3 text-xs text-slate-400">
                    <div><span className="block text-cyan-200 font-bold">{t('move')}</span>A / D</div>
                    <div><span className="block text-cyan-200 font-bold">{t('jump')}</span>{t('key_space')}</div>
                    <div><span className="block text-cyan-200 font-bold">{t('detect')}</span>F</div>
                  </div>
                  <button onClick={startRun} className="main-menu-button px-12 py-4 font-bold pixel-font text-xl rounded-md">{t('start_investigation')}</button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {isAuthModalOpen && (
        <div className="absolute inset-0 z-50 bg-slate-950/90 flex items-center justify-center p-4">
          <div className="w-full max-w-sm game-panel-strong rounded-lg p-5 text-left">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="text-cyan-300 font-bold pixel-font text-xl">{t('auth_modal_title')}</h2>
              <button onClick={() => setIsAuthModalOpen(false)} className="h-8 w-8 game-button-secondary text-white rounded-md">{t('close')}</button>
            </div>
            <div className="flex gap-2 text-sm mb-4">
              <button onClick={() => setAuthMode('register')} className={`px-3 py-1 rounded-md border ${authMode === 'register' ? 'bg-cyan-600 border-cyan-300 text-white' : 'border-slate-600 text-slate-300'}`}>{t('register_tab')}</button>
              <button onClick={() => setAuthMode('login')} className={`px-3 py-1 rounded-md border ${authMode === 'login' ? 'bg-cyan-600 border-cyan-300 text-white' : 'border-slate-600 text-slate-300'}`}>{t('login_tab')}</button>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void submitAuth(); }} className="space-y-3">
              <input value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder={t('username_placeholder')} className="w-full game-input rounded-md px-3 py-2" />
              <input value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder={t('password_placeholder')} type="password" className="w-full game-input rounded-md px-3 py-2" />
              <button disabled={authBusy} className="w-full px-4 py-2 game-button text-white font-bold rounded-md disabled:opacity-50 disabled:cursor-not-allowed">
                {authBusy ? t('processing') : authMode === 'register' ? t('register_login_btn') : t('login_btn')}
              </button>
            </form>
            {lastRunSummary && !authUser && (
              <div className="mt-3 text-xs text-yellow-200">{t('login_upload_notice')}</div>
            )}
            {authMessage && <div className="mt-3 text-xs text-slate-300">{authMessage}</div>}
            <div className="mt-3 text-[11px] leading-relaxed text-slate-500">
              {t('auth_note')}
            </div>
          </div>
        </div>
      )}

      {gameState === 'PLAYING' && activeNpcChat && (
        <NpcChatBox chat={activeNpcChat} onClose={closeNpcChat} onDeclineInvite={declineNpcChatInvite} onSend={sendMikuMessage} onStartChat={startActiveMikuChat} />
      )}

      {(!activeNpcChat && (gameState === 'DIALOG' || gameState === 'ENDING')) && dialogLines.length > 0 && (
        <DialogBox lines={dialogLines} onNext={() => { if(gameState === 'ENDING') setDialogLines([]); else setGameState('PLAYING'); setDialogLines([]); setDialogImage(undefined); }} isEnding={gameState === 'ENDING'} image={dialogImage} />
      )}

      {gameState === 'PLAYING' && isMobile && (
        <div className="absolute inset-0 pointer-events-none z-30 touch-none select-none [-webkit-tap-highlight-color:transparent]">
          <div className="absolute bottom-8 left-7 w-44 h-44 pointer-events-auto opacity-70 active:opacity-95 transition-opacity">
              <button aria-label={t('jump')} className="absolute top-0 left-1/3 w-1/3 h-1/3 rounded-t-2xl touch-control-button" onTouchStart={(e) => handleTouchStart('up', e)} onTouchEnd={(e) => handleTouchEnd('up', e)} onTouchCancel={(e) => handleTouchEnd('up', e)} onContextMenu={preventCtx}>▲</button>
              <button aria-label={t('crouch')} className="absolute bottom-0 left-1/3 w-1/3 h-1/3 rounded-b-2xl touch-control-button" onTouchStart={(e) => handleTouchStart('down', e)} onTouchEnd={(e) => handleTouchEnd('down', e)} onTouchCancel={(e) => handleTouchEnd('down', e)} onContextMenu={preventCtx}>▼</button>
              <button aria-label={t('move_left')} className="absolute top-1/3 left-0 w-1/3 h-1/3 rounded-l-2xl touch-control-button" onTouchStart={(e) => handleTouchStart('left', e)} onTouchEnd={(e) => handleTouchEnd('left', e)} onTouchCancel={(e) => handleTouchEnd('left', e)} onContextMenu={preventCtx}>◀</button>
              <button aria-label={t('move_right')} className="absolute top-1/3 right-0 w-1/3 h-1/3 rounded-r-2xl touch-control-button" onTouchStart={(e) => handleTouchStart('right', e)} onTouchEnd={(e) => handleTouchEnd('right', e)} onTouchCancel={(e) => handleTouchEnd('right', e)} onContextMenu={preventCtx}>▶</button>
          </div>
          <div className="absolute bottom-8 right-7 flex gap-4 pointer-events-auto opacity-75 active:opacity-100 transition-opacity items-end text-white">
             <button aria-label={t('interact')} className="w-16 h-16 rounded-full touch-control-button font-bold text-lg flex items-center justify-center mb-10 text-yellow-100" onTouchStart={(e) => handleTouchStart('interact', e)} onTouchEnd={(e) => handleTouchEnd('interact', e)} onTouchCancel={(e) => handleTouchEnd('interact', e)} onContextMenu={preventCtx}>E</button>
             <div className="flex flex-col gap-5">
               <button aria-label={t('action')} className="w-24 h-24 rounded-full touch-control-button font-bold text-3xl flex items-center justify-center text-cyan-50" onTouchStart={(e) => handleTouchStart('action', e)} onTouchEnd={(e) => handleTouchEnd('action', e)} onTouchCancel={(e) => handleTouchEnd('action', e)} onContextMenu={preventCtx}>●</button>
               <div className="flex gap-4">
                 <button aria-label={t('dash')} className="w-20 h-20 rounded-full touch-control-button font-bold text-xl flex items-center justify-center text-blue-100" onTouchStart={(e) => handleTouchStart('dash', e)} onTouchEnd={(e) => handleTouchEnd('dash', e)} onTouchCancel={(e) => handleTouchEnd('dash', e)} onContextMenu={preventCtx}>D</button>
                 <button aria-label={t('attack')} className="w-20 h-20 rounded-full touch-control-button font-bold text-xl flex items-center justify-center text-rose-100" onTouchStart={(e) => handleTouchStart('attack', e)} onTouchEnd={(e) => handleTouchEnd('attack', e)} onTouchCancel={(e) => handleTouchEnd('attack', e)} onContextMenu={preventCtx}>F</button>
               </div>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
