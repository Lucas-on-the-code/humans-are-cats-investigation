import { readFile, writeFile } from 'node:fs/promises';

const HOT_DB_PATH = new URL('../public/data/biliboard-hot-songs.json', import.meta.url);
const OUTPUT_PATH = new URL('../public/data/vocaloid-producer-aliases-cn.json', import.meta.url);
const API_URL = 'https://moegirl.uk/api.php';

const MANUAL_ALIASES = {
  'DECO*27': ['DECO', '火锅P', '爹扣', '烤鸭P'],
  'かいりきベア': ['怪力熊', '熊熊'],
  'd0tc0mmie': ['点点P', '点点p'],
  'Masarada': ['玛莎拉蒂P', '玛莎拉蒂p', '玛莎拉蒂', '玛莎拉达', '马萨拉达'],
};

const MANUAL_WEAK_ALIASES = {
  'DECO*27': ['德克士', '周冬雨P', '移情别恋P', '阿里嘎多P'],
};

const CANONICAL_PRODUCER_GROUPS = [
  ['Nayutan星人', 'ナユタン星人', '外星人P', '外星人p', '奶油糖星人', '那由他星人'],
  ['Iyowa', 'いよわ', '胃弱'],
  ['Masarada', 'マサラダ', '玛莎拉蒂P', '玛莎拉蒂p', '玛莎拉蒂', '玛莎拉达', '马萨拉达'],
  ['Mitchie M', 'MitchieM', '登山P'],
  ['Giga', 'ギガ', 'ギガP', 'gigaP'],
  ['Shannon', 'シャノン'],
  ['Adeliae', 'アデリー'],
  ['PPP Sounds', 'PPP_Sounds'],
  ['春卷饭', 'はるまきごはん', 'HARUMAKI GOHAN'],
  ['晴いちばん', '晴一番'],
  ['郁P', '鬱P'],
  ['appy', 'appy_7', 'appy_h_happy'],
  ['Picon', 'Picon_ピコン', 'ピコン'],
  ['Pepoyo', 'ぺぽよ', 'ペぽよ', '枇杷油', '油姐'],
  ['Kikuo', 'きくお'],
  ['marasy_触手猴', 'marasy', '触手猴'],
  ['minato', 'minato(流星P)', '流星P'],
  ['Kon2008', 'Kon2008_29'],
  ['MR_CA', 'MR.CA'],
  ['みつあくま(门铃P)', 'みつあくま（门铃p）', '门铃P', '门铃p'],
  ['ユギカ', 'ユギカYugica'],
  ['宮守文学', '宫守文学'],
  ['黒うさぎ', '黒うさP', '黑兔P'],
  ['ピノキオピー', '匹诺曹P', '匹老板', '老匹'],
  ['かいりきベア', '怪力熊', '熊熊', 'kairiki bear'],
  ['d0tc0mmie', '点点P', '点点p'],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeName = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeComparable = (value) => normalizeName(value)
  .toLowerCase()
  .replace(/[^\p{Letter}\p{Number}\u3040-\u30ff\u3400-\u9fff]+/gu, '');

const CANONICAL_BY_NAME = new Map();
for (const group of CANONICAL_PRODUCER_GROUPS) {
  const canonical = group[0];
  group.forEach((name) => CANONICAL_BY_NAME.set(normalizeComparable(name), canonical));
}

const getCanonicalProducer = (name) => CANONICAL_BY_NAME.get(normalizeComparable(name)) || name;

const getManualGroupAliases = (producer) => (
  CANONICAL_PRODUCER_GROUPS.find((group) => group.some((name) => normalizeComparable(name) === normalizeComparable(producer))) || []
);

const isCjk = (value) => /[\u3400-\u9fff]/u.test(value);

const isProducerPage = (wikitext) => /\{\{\s*Producer\b/i.test(wikitext);

const getApi = async (params) => {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    headers: {
      'user-agent': 'humans-are-cats-alias-collector/1.0',
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
};

const fetchPage = async (title) => {
  const payload = await getApi({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    redirects: '1',
    titles: title,
    format: 'json',
    formatversion: '2',
  });
  const page = payload.query?.pages?.[0];
  const content = page?.revisions?.[0]?.content || '';
  if (!page || page.missing || !content) return null;
  return {
    title: page.title,
    pageid: page.pageid,
    wikitext: content,
  };
};

const searchPages = async (query) => {
  const payload = await getApi({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '8',
    format: 'json',
    formatversion: '2',
  });
  return payload.query?.search?.map((entry) => entry.title).filter(Boolean) || [];
};

const stripMarkup = (value) => value
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<ref\b[\s\S]*?<\/ref>/gi, '')
  .replace(/<ref\b[^/>]*\/>/gi, '')
  .replace(/-\{[\s\S]*?zh-hans:([^;|}/]+)[\s\S]*?\}-/g, '$1')
  .replace(/-\{([^{}]+)\}-/g, '$1')
  .replace(/\{\{lj\|([^{}|]+)\}\}/g, '$1')
  .replace(/\{\{ruby\|([^{}|]+)\|[^{}]*\}\}/g, '$1')
  .replace(/\{\{color\|[^{}|]+\|([^{}]+)\}\}/g, '$1')
  .replace(/\{\{lang\|[^{}|]+\|([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
  .replace(/\[\[([^\]]+)\]\]/g, '$1')
  .replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1')
  .replace(/'{2,}/g, '')
  .replace(/&nbsp;/g, ' ')
  .trim();

const extractTemplateField = (wikitext, fieldName) => {
  const pattern = new RegExp(`\\n\\|\\s*${fieldName}\\s*=([\\s\\S]*?)(?=\\n\\|\\s*[^\\n=]+\\s*=|\\n\\}\\})`, 'i');
  return wikitext.match(pattern)?.[1]?.trim() || '';
};

const extractDelimitedAliases = (value) => stripMarkup(value)
  .replace(/\{\{(?:黑幕|spoiler)\|([^{}]+)\}\}/gi, '$1')
  .replace(/\{\{[^{}]+\}\}/g, ' ')
  .split(/<br\s*\/?>|、|，|,|；|;|\/|\n/gi)
  .map((entry) => normalizeName(entry.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '')))
  .filter((entry) => entry && entry.length <= 24 && !entry.includes('zh-hk:') && !entry.includes('zh-tw:') && !entry.includes('ref>'));

const extractAliasGroups = (wikitext, pageTitle) => {
  const rawAliasField = extractTemplateField(wikitext, '别号')
    .replace(/<ref\b[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref\b[^/>]*\/>/gi, '');
  const weakSegments = [
    ...rawAliasField.matchAll(/<del[^>]*>([\s\S]*?)<\/del>/gi),
    ...rawAliasField.matchAll(/\{\{(?:黑幕|spoiler)\|([\s\S]*?)\}\}/gi),
  ].map((match) => match[1]);
  const weakAliases = new Set(weakSegments.flatMap(extractDelimitedAliases));
  const strongSource = rawAliasField
    .replace(/<del[^>]*>[\s\S]*?<\/del>/gi, ' ')
    .replace(/\{\{(?:黑幕|spoiler)\|[\s\S]*?\}\}/gi, ' ');
  const aliases = new Set(extractDelimitedAliases(strongSource));

  const pName = normalizeName(stripMarkup(extractTemplateField(wikitext, 'P主名字')));
  const cleanTitle = normalizeName(pageTitle);
  if (cleanTitle && cleanTitle !== pName && isCjk(cleanTitle)) aliases.add(cleanTitle);

  return {
    pName,
    aliases: [...aliases].filter((alias) => alias !== pName),
    weakAliases: [...weakAliases].filter((alias) => alias !== pName && !aliases.has(alias)),
  };
};

const isLikelyMatch = (producer, page, groups) => {
  const target = normalizeComparable(producer);
  if (!target) return false;
  const candidates = [
    page.title,
    groups.pName,
    ...groups.aliases,
    ...groups.weakAliases,
  ].map(normalizeComparable).filter(Boolean);
  return candidates.some((candidate) => (
    candidate === target
    || (candidate.length >= 3 && target.length >= 3 && (candidate.includes(target) || target.includes(candidate)))
  ));
};

const pickProducerPage = async (producer) => {
  const direct = await fetchPage(producer).catch(() => null);
  if (direct && isProducerPage(direct.wikitext)) {
    const groups = extractAliasGroups(direct.wikitext, direct.title);
    if (isLikelyMatch(producer, direct, groups)) return { ...direct, groups };
  }

  const titles = await searchPages(`${producer} P主`);
  for (const title of titles) {
    await sleep(80);
    const page = await fetchPage(title).catch(() => null);
    if (page && isProducerPage(page.wikitext)) {
      const groups = extractAliasGroups(page.wikitext, page.title);
      if (isLikelyMatch(producer, page, groups)) return { ...page, groups };
    }
  }
  return null;
};

const main = async () => {
  const hotDb = JSON.parse(await readFile(HOT_DB_PATH, 'utf8'));
  const counts = new Map();
  const variantsByCanonical = new Map();
  for (const song of hotDb.songs || []) {
    for (const producer of song.producers || []) {
      const name = normalizeName(producer);
      if (!name) continue;
      const canonical = getCanonicalProducer(name);
      counts.set(canonical, (counts.get(canonical) || 0) + 1);
      if (!variantsByCanonical.has(canonical)) variantsByCanonical.set(canonical, new Set());
      variantsByCanonical.get(canonical).add(name);
    }
  }

  const producers = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const entries = {};
  let found = 0;

  for (const [producer, songCount] of producers) {
    await sleep(120);
    const page = await pickProducerPage(producer).catch((error) => {
      console.warn(`[warn] ${producer}: ${error.message}`);
      return null;
    });
    const aliases = new Set(MANUAL_ALIASES[producer] || []);
    const weakAliases = new Set(MANUAL_WEAK_ALIASES[producer] || []);
    const variants = [...(variantsByCanonical.get(producer) || [])];
    [...variants, ...getManualGroupAliases(producer)].forEach((alias) => {
      if (normalizeComparable(alias) !== normalizeComparable(producer)) aliases.add(alias);
    });
    const sourcePages = [];
    let canonicalName = producer;

    if (page) {
      const extracted = page.groups || extractAliasGroups(page.wikitext, page.title);
      canonicalName = extracted.pName || page.title || producer;
      extracted.aliases.forEach((alias) => aliases.add(alias));
      extracted.weakAliases.forEach((alias) => weakAliases.add(alias));
      sourcePages.push({
        site: '萌娘百科',
        title: page.title,
        url: `https://moegirl.uk/${encodeURIComponent(page.title)}`,
      });
    }

    const cleanAliases = [...aliases]
      .map(normalizeName)
      .filter((alias) => alias && alias !== producer && alias !== canonicalName);
    const cleanWeakAliases = [...weakAliases]
      .map(normalizeName)
      .filter((alias) => alias && alias !== producer && alias !== canonicalName && !cleanAliases.includes(alias));

    if (cleanAliases.length || cleanWeakAliases.length || sourcePages.length) {
      found += 1;
      entries[producer] = {
        canonicalName,
        producerNames: variants,
        aliases: cleanAliases,
        weakAliases: cleanWeakAliases,
        sourcePages,
        songCount,
      };
      console.log(`[${found}] ${producer}: ${cleanAliases.join(' / ') || '-'}${cleanWeakAliases.length ? ` (weak: ${cleanWeakAliases.join(' / ')})` : ''}`);
    }
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceNote: 'Chinese fandom aliases for producers appearing in public/data/biliboard-hot-songs.json. Strong aliases are used for local lookup; weakAliases keep joke/deleted/black-screen aliases out of automatic triggers.',
    producerCount: producers.length,
    matchedProducerCount: Object.keys(entries).length,
    entries,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`wrote ${OUTPUT_PATH.pathname}`);
  console.log(`producers=${producers.length} matched=${Object.keys(entries).length}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
