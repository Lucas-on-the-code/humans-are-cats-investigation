export type MikuMemoryChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type MikuTopicMemory = {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  startIndex?: number;
  endIndex?: number;
};

export type MikuMemorySession = {
  id: string;
  createdAt: string;
  messages: MikuMemoryChatMessage[];
  sessionSummary?: string;
  topics: MikuTopicMemory[];
  taggedTranscript?: string;
};

export type MikuKnowledgeMemory = {
  content: string;
  updatedAt: string;
  sourceSessionIds: string[];
};

export type MikuPendingGreeting = {
  content: string;
  generatedAt: string;
  sourceSessionId: string;
};

export type MikuMemoryState = {
  version: 1;
  sessionCount: number;
  sessions: MikuMemorySession[];
  knowledge?: MikuKnowledgeMemory;
  pendingGreeting?: MikuPendingGreeting;
};

export type MikuMemoryBrief = {
  knowledge?: string;
  recentTopicSessions: Array<{
    sessionId: string;
    occurredAt: string;
    sessionSummary?: string;
    topics: Array<{
      id: string;
      title: string;
      summary: string;
      keywords: string[];
    }>;
  }>;
};

export type MikuMemorySearchResult = {
  sessionId: string;
  topicId: string;
  title: string;
  summary: string;
  occurredAt: string;
  transcript: string;
  relevance: number;
};

export type MikuMemoryEndRequest = {
  sessionId: string;
  endedAt: string;
  sessionCount: number;
  shouldSummarizeTopics: boolean;
  shouldSummarizeKnowledge: boolean;
  previousKnowledge?: string;
  messages: MikuMemoryChatMessage[];
  knowledgeSourceSessions: Array<{
    id: string;
    createdAt: string;
    messages: MikuMemoryChatMessage[];
  }>;
  memoryBrief: MikuMemoryBrief;
};

export type MikuMemoryEndResult = {
  topicMemory?: {
    sessionSummary?: string;
    topics?: MikuTopicMemory[];
    taggedTranscript?: string;
  };
  knowledgeMemory?: {
    content?: string;
  };
  nextGreeting?: string;
};

export type PreparedMikuMemoryEnd = {
  memoryScope: string;
  request: MikuMemoryEndRequest;
};

const MIKU_MEMORY_STORAGE_KEY = 'cat_investigation_miku_memory_v1';
const MIKU_GUEST_MEMORY_SCOPE = 'guest';
const MIKU_GUEST_ID_STORAGE_KEY = `${MIKU_MEMORY_STORAGE_KEY}:guest_id`;
const MAX_STORED_MESSAGE_LENGTH = 700;
const MAX_SEARCH_RESULTS = 3;
const accountMemoryCache = new Map<string, MikuMemoryState>();

const emptyMemory = (): MikuMemoryState => ({
  version: 1,
  sessionCount: 0,
  sessions: [],
});

const isBrowserStorageAvailable = () => typeof window !== 'undefined' && Boolean(window.localStorage);

const cleanText = (value: unknown, maxLength = MAX_STORED_MESSAGE_LENGTH) => (
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
);

const normalizeMemoryScope = (scope: unknown) => cleanText(scope, 120).replace(/[^a-zA-Z0-9:_-]/g, '_') || MIKU_GUEST_MEMORY_SCOPE;

const isAccountMemoryScope = (scope: unknown) => normalizeMemoryScope(scope).startsWith('user:');

const storageKeyForScope = (scope: unknown) => `${MIKU_MEMORY_STORAGE_KEY}:${normalizeMemoryScope(scope)}`;

const makeLocalId = () => {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

const getOrCreateGuestMemoryScope = () => {
  if (!isBrowserStorageAvailable()) return MIKU_GUEST_MEMORY_SCOPE;
  try {
    const existing = normalizeMemoryScope(window.localStorage.getItem(MIKU_GUEST_ID_STORAGE_KEY));
    if (existing !== MIKU_GUEST_MEMORY_SCOPE) return `${MIKU_GUEST_MEMORY_SCOPE}:${existing}`;
    const nextGuestId = normalizeMemoryScope(makeLocalId());
    window.localStorage.setItem(MIKU_GUEST_ID_STORAGE_KEY, nextGuestId);
    return `${MIKU_GUEST_MEMORY_SCOPE}:${nextGuestId}`;
  } catch {
    return MIKU_GUEST_MEMORY_SCOPE;
  }
};

export const mikuMemoryScopeForAccount = (accountId?: string | null) => {
  const cleanAccountId = normalizeMemoryScope(accountId);
  return accountId ? `user:${cleanAccountId}` : getOrCreateGuestMemoryScope();
};

const sanitizeMessages = (messages: MikuMemoryChatMessage[]) => messages
  .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && cleanText(message.content))
  .slice(-80)
  .map((message) => ({
    role: message.role,
    content: cleanText(message.content),
  }));

const sanitizeTopic = (topic: Partial<MikuTopicMemory>, fallbackId: string): MikuTopicMemory | undefined => {
  const title = cleanText(topic.title, 80);
  const summary = cleanText(topic.summary, 260);
  if (!title || !summary) return undefined;
  return {
    id: cleanText(topic.id, 100) || fallbackId,
    title,
    summary,
    keywords: Array.isArray(topic.keywords)
      ? topic.keywords.map((keyword) => cleanText(keyword, 40)).filter(Boolean).slice(0, 8)
      : [],
    startIndex: Number.isInteger(topic.startIndex) ? topic.startIndex : undefined,
    endIndex: Number.isInteger(topic.endIndex) ? topic.endIndex : undefined,
  };
};

const normalizeMemoryState = (value: unknown): MikuMemoryState => {
  if (!value || typeof value !== 'object') return emptyMemory();
  const raw = value as Partial<MikuMemoryState>;
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.map((session) => {
      const id = cleanText(session?.id, 100);
      const createdAt = cleanText(session?.createdAt, 40);
      const messages = sanitizeMessages(Array.isArray(session?.messages) ? session.messages : []);
      if (!id || !createdAt || messages.length === 0) return undefined;
      const topics = Array.isArray(session?.topics)
        ? session.topics.map((topic, index) => sanitizeTopic(topic, `${id}-topic-${index + 1}`)).filter(Boolean) as MikuTopicMemory[]
        : [];
      return {
        id,
        createdAt,
        messages,
        sessionSummary: cleanText(session?.sessionSummary, 360) || undefined,
        topics,
        taggedTranscript: cleanText(session?.taggedTranscript, 8000) || undefined,
      };
    }).filter(Boolean) as MikuMemorySession[]
    : [];

  const knowledgeContent = cleanText(raw.knowledge?.content, 4000);
  const pendingGreeting = cleanText(raw.pendingGreeting?.content, 120);

  return {
    version: 1,
    sessionCount: Math.max(Number(raw.sessionCount) || sessions.length, sessions.length),
    sessions,
    knowledge: knowledgeContent ? {
      content: knowledgeContent,
      updatedAt: cleanText(raw.knowledge?.updatedAt, 40) || new Date().toISOString(),
      sourceSessionIds: Array.isArray(raw.knowledge?.sourceSessionIds)
        ? raw.knowledge.sourceSessionIds.map((id) => cleanText(id, 100)).filter(Boolean).slice(-12)
        : [],
    } : undefined,
    pendingGreeting: pendingGreeting ? {
      content: pendingGreeting,
      generatedAt: cleanText(raw.pendingGreeting?.generatedAt, 40) || new Date().toISOString(),
      sourceSessionId: cleanText(raw.pendingGreeting?.sourceSessionId, 100),
    } : undefined,
  };
};

const saveAccountMemoryCache = (scope: unknown, memory: MikuMemoryState) => {
  const safeMemory = normalizeMemoryState(memory);
  accountMemoryCache.set(normalizeMemoryScope(scope), safeMemory);
  return safeMemory;
};

const loadStoredMikuMemory = (scope = MIKU_GUEST_MEMORY_SCOPE): MikuMemoryState => {
  if (!isBrowserStorageAvailable()) return emptyMemory();
  try {
    const memoryScope = normalizeMemoryScope(scope);
    const raw = window.localStorage.getItem(storageKeyForScope(memoryScope))
      || (memoryScope.startsWith(MIKU_GUEST_MEMORY_SCOPE) ? window.localStorage.getItem(MIKU_MEMORY_STORAGE_KEY) : null);
    if (!raw) return emptyMemory();
    return normalizeMemoryState(JSON.parse(raw));
  } catch {
    return emptyMemory();
  }
};

const saveStoredMikuMemory = (memory: MikuMemoryState, scope = MIKU_GUEST_MEMORY_SCOPE) => {
  if (!isBrowserStorageAvailable()) return;
  try {
    window.localStorage.setItem(storageKeyForScope(scope), JSON.stringify(normalizeMemoryState(memory)));
  } catch {
    // Memory is additive flavor; the game should keep running even when storage is unavailable.
  }
};

const clearStoredMikuMemory = (scope = MIKU_GUEST_MEMORY_SCOPE) => {
  if (!isBrowserStorageAvailable()) return;
  try {
    window.localStorage.removeItem(storageKeyForScope(scope));
  } catch {
    // Nothing to clear.
  }
};

export const loadMikuMemory = (scope = MIKU_GUEST_MEMORY_SCOPE): MikuMemoryState => {
  const memoryScope = normalizeMemoryScope(scope);
  if (isAccountMemoryScope(memoryScope)) return accountMemoryCache.get(memoryScope) ?? emptyMemory();
  return loadStoredMikuMemory(memoryScope);
};

export const saveMikuMemory = (memory: MikuMemoryState, scope = MIKU_GUEST_MEMORY_SCOPE) => {
  const memoryScope = normalizeMemoryScope(scope);
  if (isAccountMemoryScope(memoryScope)) {
    saveAccountMemoryCache(memoryScope, memory);
    return;
  }
  saveStoredMikuMemory(memory, memoryScope);
};

const hasAnyMemory = (memory: MikuMemoryState) => (
  memory.sessions.length > 0
  || Boolean(memory.knowledge?.content)
  || Boolean(memory.pendingGreeting?.content)
);

const persistAccountMikuMemory = async (
  scope: string,
  memory: MikuMemoryState,
  authToken?: string | null,
  options: { clearPendingGreeting?: boolean; mode?: 'merge' | 'replace' } = {},
) => {
  const memoryScope = normalizeMemoryScope(scope);
  const safeMemory = saveAccountMemoryCache(memoryScope, memory);
  if (!authToken || !isAccountMemoryScope(memoryScope)) return safeMemory;

  const res = await fetch('/api/miku-memory', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      memory: safeMemory,
      mode: options.mode ?? 'merge',
      clearPendingGreeting: Boolean(options.clearPendingGreeting),
    }),
  });
  if (!res.ok) throw new Error(`MIKU_MEMORY_SYNC_${res.status}`);
  const data = await res.json() as { memory?: MikuMemoryState };
  const serverMemory = saveAccountMemoryCache(memoryScope, normalizeMemoryState(data.memory));
  clearStoredMikuMemory(memoryScope);
  return serverMemory;
};

export const syncAccountMikuMemoryFromServer = async (authToken?: string | null, accountId?: string | null) => {
  if (!authToken || !accountId) return emptyMemory();
  const memoryScope = mikuMemoryScopeForAccount(accountId);
  if (!isAccountMemoryScope(memoryScope)) return emptyMemory();

  const res = await fetch('/api/miku-memory', {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw new Error(`MIKU_MEMORY_LOAD_${res.status}`);
  const data = await res.json() as { memory?: MikuMemoryState };
  const serverMemory = normalizeMemoryState(data.memory);
  if (hasAnyMemory(serverMemory)) {
    clearStoredMikuMemory(memoryScope);
    return saveAccountMemoryCache(memoryScope, serverMemory);
  }

  const legacyLocalMemory = loadStoredMikuMemory(memoryScope);
  if (hasAnyMemory(legacyLocalMemory)) {
    return await persistAccountMikuMemory(memoryScope, legacyLocalMemory, authToken);
  }

  return saveAccountMemoryCache(memoryScope, serverMemory);
};

const mergeKnowledgeMemory = (account?: MikuKnowledgeMemory, guest?: MikuKnowledgeMemory): MikuKnowledgeMemory | undefined => {
  if (!account?.content) return guest;
  if (!guest?.content || account.content === guest.content) return account;
  return {
    content: [
      '账号已有记忆：',
      account.content,
      '',
      '登录前临时记忆：',
      guest.content,
    ].join('\n').slice(0, 4000),
    updatedAt: account.updatedAt > guest.updatedAt ? account.updatedAt : guest.updatedAt,
    sourceSessionIds: [...new Set([...account.sourceSessionIds, ...guest.sourceSessionIds])].slice(-12),
  };
};

export const inheritGuestMikuMemoryForAccount = (accountId?: string | null, authToken?: string | null) => {
  if (!accountId || !isBrowserStorageAvailable()) return;
  const accountScope = mikuMemoryScopeForAccount(accountId);
  const guestScope = getOrCreateGuestMemoryScope();
  if (accountScope === guestScope) return;

  try {
    const guestMemory = loadStoredMikuMemory(guestScope);
    if (!hasAnyMemory(guestMemory)) return;

    const accountMemory = loadMikuMemory(accountScope);
    const sessionsById = new Map<string, MikuMemorySession>();
    [...guestMemory.sessions, ...accountMemory.sessions].forEach((session) => {
      sessionsById.set(session.id, session);
    });
    const sessions = [...sessionsById.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const nextMemory: MikuMemoryState = {
      ...accountMemory,
      sessionCount: Math.max(accountMemory.sessionCount + guestMemory.sessionCount, sessions.length),
      sessions,
      knowledge: mergeKnowledgeMemory(accountMemory.knowledge, guestMemory.knowledge),
      pendingGreeting: accountMemory.pendingGreeting ?? guestMemory.pendingGreeting,
    };
    saveMikuMemory(nextMemory, accountScope);
    if (authToken) {
      void persistAccountMikuMemory(accountScope, nextMemory, authToken)
        .then(() => saveMikuMemory(emptyMemory(), guestScope))
        .catch(() => {});
    } else {
      saveMikuMemory(emptyMemory(), guestScope);
    }
  } catch {
    // A failed migration should not block login or gameplay.
  }
};

export const buildMikuMemoryBrief = (memoryOrScope: MikuMemoryState | string = MIKU_GUEST_MEMORY_SCOPE): MikuMemoryBrief => {
  const memory = typeof memoryOrScope === 'string' ? loadMikuMemory(memoryOrScope) : memoryOrScope;
  return {
    knowledge: memory.knowledge?.content,
    recentTopicSessions: memory.sessions.slice(-5).map((session) => ({
      sessionId: session.id,
      occurredAt: session.createdAt,
      sessionSummary: session.sessionSummary,
      topics: session.topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        summary: topic.summary,
        keywords: topic.keywords,
      })),
    })).filter((session) => session.topics.length > 0),
  };
};

export const consumePendingMikuGreeting = (scope = MIKU_GUEST_MEMORY_SCOPE, authToken?: string | null) => {
  const memory = loadMikuMemory(scope);
  const greeting = memory.pendingGreeting?.content;
  if (!greeting) return undefined;
  const nextMemory = { ...memory, pendingGreeting: undefined };
  saveMikuMemory(nextMemory, scope);
  const memoryScope = normalizeMemoryScope(scope);
  if (authToken && isAccountMemoryScope(memoryScope)) {
    void persistAccountMikuMemory(memoryScope, nextMemory, authToken, { clearPendingGreeting: true }).catch(() => {});
  }
  return greeting;
};

const countUserTurns = (messages: MikuMemoryChatMessage[]) => messages.filter((message) => (
  message.role === 'user' && cleanText(message.content)
)).length;

const makeSessionId = () => `miku-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const prepareMikuMemoryEndRequest = (messages: MikuMemoryChatMessage[], scope = MIKU_GUEST_MEMORY_SCOPE): PreparedMikuMemoryEnd | undefined => {
  const cleanMessages = sanitizeMessages(messages);
  if (countUserTurns(cleanMessages) === 0) return undefined;

  const memoryScope = normalizeMemoryScope(scope);
  const memory = loadMikuMemory(memoryScope);
  const sessionId = makeSessionId();
  const endedAt = new Date().toISOString();
  const sessionCount = memory.sessionCount + 1;
  const currentSourceSession = {
    id: sessionId,
    createdAt: endedAt,
    messages: cleanMessages,
  };
  const knowledgeSourceSessions = sessionCount % 3 === 0
    ? [...memory.sessions.slice(-2).map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      messages: session.messages,
    })), currentSourceSession]
    : [];

  return {
    memoryScope,
    request: {
      sessionId,
      endedAt,
      sessionCount,
      shouldSummarizeTopics: countUserTurns(cleanMessages) > 2,
      shouldSummarizeKnowledge: sessionCount % 3 === 0,
      previousKnowledge: memory.knowledge?.content,
      messages: cleanMessages,
      knowledgeSourceSessions,
      memoryBrief: buildMikuMemoryBrief(memory),
    },
  };
};

const normalizeSearchText = (value: unknown) => cleanText(value, 1000)
  .toLowerCase()
  .normalize('NFKC')
  .replace(/[《》「」『』“”"'’‘`´·・,，。:：;；/／\\|｜()[\]（）【】!?！？~～\-—–_]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const searchTokens = (query: string) => {
  const normalized = normalizeSearchText(query)
    .replace(/上次|之前|以前|那次|那件事|刚才|剛才|聊过|聊過|说过|說過|提过|提過|我们|我們|你还记得|你還記得/gu, ' ');
  const tokens = normalized
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const cjkText = normalized.replace(/\s+/gu, '');
  if (/[\u4e00-\u9fff]/u.test(cjkText) && cjkText.length > 2) {
    for (let size = 2; size <= Math.min(4, cjkText.length); size++) {
      for (let index = 0; index <= cjkText.length - size; index++) {
        tokens.push(cjkText.slice(index, index + size));
      }
    }
  }
  return [...new Set(tokens)].slice(0, 18);
};

const formatTranscript = (messages: MikuMemoryChatMessage[]) => messages
  .map((message) => `${message.role === 'user' ? '玩家' : 'Miku'}：${message.content}`)
  .join('\n');

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extractTaggedTopicTranscript = (session: MikuMemorySession, topic: MikuTopicMemory) => {
  if (!session.taggedTranscript) return '';
  const id = escapeRegExp(topic.id);
  const pattern = new RegExp(`\\[TOPIC_START[^\\]]*id=["']?${id}["']?[^\\]]*\\]([\\s\\S]*?)\\[TOPIC_END[^\\]]*id=["']?${id}["']?[^\\]]*\\]`, 'u');
  const match = session.taggedTranscript.match(pattern);
  return cleanText(match?.[0], 8000);
};

const transcriptForTopic = (session: MikuMemorySession, topic: MikuTopicMemory) => {
  const tagged = extractTaggedTopicTranscript(session, topic);
  if (tagged) return tagged;
  if (Number.isInteger(topic.startIndex) && Number.isInteger(topic.endIndex)) {
    const start = Math.max(0, topic.startIndex ?? 0);
    const end = Math.min(session.messages.length - 1, topic.endIndex ?? start);
    if (start <= end) return formatTranscript(session.messages.slice(start, end + 1));
  }
  return formatTranscript(session.messages);
};

export const searchMikuTopicMemory = (query: string, memoryOrScope: MikuMemoryState | string = MIKU_GUEST_MEMORY_SCOPE): MikuMemorySearchResult[] => {
  const memory = typeof memoryOrScope === 'string' ? loadMikuMemory(memoryOrScope) : memoryOrScope;
  const normalizedQuery = normalizeSearchText(query);
  const tokens = searchTokens(query);
  if (!normalizedQuery && tokens.length === 0) return [];

  const results: MikuMemorySearchResult[] = [];
  for (const session of memory.sessions) {
    for (const topic of session.topics) {
      const haystack = normalizeSearchText([
        topic.title,
        topic.summary,
        topic.keywords.join(' '),
        session.sessionSummary,
      ].filter(Boolean).join(' '));
      let relevance = 0;
      if (haystack.includes(normalizedQuery)) relevance += 8;
      for (const token of tokens) {
        if (haystack.includes(token)) relevance += token.length > 3 ? 3 : 2;
      }
      if (relevance <= 0) continue;
      results.push({
        sessionId: session.id,
        topicId: topic.id,
        title: topic.title,
        summary: topic.summary,
        occurredAt: session.createdAt,
        transcript: transcriptForTopic(session, topic),
        relevance,
      });
    }
  }

  return results
    .sort((a, b) => b.relevance - a.relevance || Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, MAX_SEARCH_RESULTS);
};

export const commitMikuMemoryEndResult = (prepared: PreparedMikuMemoryEnd, result?: MikuMemoryEndResult, authToken?: string | null) => {
  const memory = loadMikuMemory(prepared.memoryScope);
  const topics = Array.isArray(result?.topicMemory?.topics)
    ? result.topicMemory.topics.map((topic, index) => sanitizeTopic(topic, `${prepared.request.sessionId}-topic-${index + 1}`)).filter(Boolean) as MikuTopicMemory[]
    : [];
  const session: MikuMemorySession = {
    id: prepared.request.sessionId,
    createdAt: prepared.request.endedAt,
    messages: prepared.request.messages,
    sessionSummary: cleanText(result?.topicMemory?.sessionSummary, 360) || undefined,
    topics,
    taggedTranscript: cleanText(result?.topicMemory?.taggedTranscript, 8000) || undefined,
  };
  const knowledgeContent = cleanText(result?.knowledgeMemory?.content, 4000);
  const nextGreeting = cleanText(result?.nextGreeting, 120);
  const nextMemory: MikuMemoryState = {
    ...memory,
    sessionCount: Math.max(prepared.request.sessionCount, memory.sessionCount + 1),
    sessions: [...memory.sessions, session],
    knowledge: knowledgeContent ? {
      content: knowledgeContent,
      updatedAt: prepared.request.endedAt,
      sourceSessionIds: prepared.request.knowledgeSourceSessions.map((source) => source.id),
    } : memory.knowledge,
    pendingGreeting: nextGreeting ? {
      content: nextGreeting,
      generatedAt: prepared.request.endedAt,
      sourceSessionId: prepared.request.sessionId,
    } : memory.pendingGreeting,
  };
  saveMikuMemory(nextMemory, prepared.memoryScope);
  if (authToken && isAccountMemoryScope(prepared.memoryScope)) {
    void persistAccountMikuMemory(prepared.memoryScope, nextMemory, authToken).catch(() => {});
  }
};
