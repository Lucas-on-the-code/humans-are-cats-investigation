type AudioContextConstructor = typeof AudioContext;

type VolumeState = {
  master: number;
  sfx: number;
  music: number;
};

type SfxTrack = {
  key: string;
  src: string;
  base: HTMLAudioElement | null;
  buffer: AudioBuffer | null;
  bufferPromise: Promise<void> | null;
  pool: HTMLAudioElement[];
  cursor: number;
};

type QueuedSfx = {
  key: string;
  volume: number;
  queuedAt: number;
};

const RECENT_SFX_QUEUE_MS = 3000;
const MAX_QUEUED_SFX = 12;

const clamp01 = (value: number) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

const isNotAllowedError = (error: unknown) => (
  typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'NotAllowedError'
);

const isRetryablePlayError = (error: unknown) => {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'NotAllowedError' || name === 'AbortError' || name === 'NotSupportedError';
};

class GameAudioSystem {
  private readonly sfxTracks = new Map<string, SfxTrack>();
  private volumes: VolumeState = { master: 0.5, sfx: 0.35, music: 0.3 };
  private audioContext: AudioContext | null = null;
  private music: HTMLAudioElement | null = null;
  private musicSrc = '';
  private musicLoop = true;
  private musicBuffer: AudioBuffer | null = null;
  private musicBufferPromise: Promise<void> | null = null;
  private musicBufferToken = 0;
  private musicGain: GainNode | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicStartedAt = 0;
  private musicOffset = 0;
  private musicDesired = false;
  private musicPlayToken = 0;
  private musicRetryTimer: number | null = null;
  private queuedSfx: QueuedSfx[] = [];
  private unlockCleanup: (() => void) | null = null;
  private sfxFlushResumePending = false;

  installGestureUnlock() {
    if (!isBrowser()) return () => {};
    if (this.unlockCleanup) return this.unlockCleanup;

    const unlock = () => { void this.unlock(); };
    const syncMusic = () => this.syncMusic();
    const unlockEvents = ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown'] as const;
    unlockEvents.forEach((eventName) => window.addEventListener(eventName, unlock, { passive: true }));
    document.addEventListener('visibilitychange', syncMusic);

    this.unlockCleanup = () => {
      unlockEvents.forEach((eventName) => window.removeEventListener(eventName, unlock));
      document.removeEventListener('visibilitychange', syncMusic);
      this.unlockCleanup = null;
    };
    return this.unlockCleanup;
  }

  async unlock() {
    if (!isBrowser()) return;
    const ctx = this.getAudioContext();
    if (ctx?.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    this.ensureMusicBuffer();
    this.preloadSfx();
    this.flushQueuedSfx();
    this.syncMusic();
  }

  setVolumes(next: Partial<VolumeState>) {
    this.volumes = {
      master: next.master === undefined ? this.volumes.master : clamp01(next.master),
      sfx: next.sfx === undefined ? this.volumes.sfx : clamp01(next.sfx),
      music: next.music === undefined ? this.volumes.music : clamp01(next.music),
    };
    this.applyMusicVolume();
  }

  registerSfx(urls: Record<string, string>) {
    Object.entries(urls).forEach(([key, src]) => {
      if (!this.sfxTracks.has(key)) {
        this.sfxTracks.set(key, {
          key,
          src,
          base: null,
          buffer: null,
          bufferPromise: null,
          pool: [],
          cursor: 0,
        });
      } else {
        const track = this.sfxTracks.get(key);
        if (track && track.src !== src) {
          track.src = src;
          track.base = null;
          track.buffer = null;
          track.bufferPromise = null;
          track.pool = [];
          track.cursor = 0;
        }
      }
      const track = this.sfxTracks.get(key);
      if (track) this.ensureBaseAudio(track);
    });
  }

  preloadSfx() {
    this.sfxTracks.forEach((track) => {
      const audio = this.ensureBaseAudio(track);
      try {
        audio.load();
      } catch {
        // Loading remains best-effort; playback has its own fallback path.
      }
      if (this.audioContext) this.ensureBuffer(track);
    });
  }

  playSfx(key: string, volumeMultiplier = 1) {
    if (!isBrowser()) return;
    const track = this.sfxTracks.get(key);
    if (!track) return;
    const volume = clamp01(this.volumes.master * this.volumes.sfx * volumeMultiplier);
    if (volume <= 0) return;

    const ctx = this.getAudioContext();
    const bufferPromise = this.ensureBuffer(track);
    if (this.playBuffered(track, volume)) return;

    if (ctx && ctx.state !== 'running') {
      this.queueSfx(track.key, volume);
      void ctx.resume()
        .then(() => this.flushQueuedSfx())
        .catch(() => {});
      return;
    }

    if (bufferPromise && !track.buffer) {
      this.queueSfx(track.key, volume);
      return;
    }

    this.playPooledHtmlAudio(track, volume);
  }

  setMusic(src: string, options: { loop?: boolean } = {}) {
    if (!isBrowser()) return;
    const nextLoop = options.loop ?? true;
    if (this.music && this.musicSrc === src) {
      this.musicLoop = nextLoop;
      this.music.loop = nextLoop;
      if (this.musicSource) this.musicSource.loop = nextLoop;
      this.applyMusicVolume();
      return;
    }

    this.clearMusicRetry();
    this.stopWebAudioMusic({ reset: true });
    this.musicBufferToken++;
    this.musicBuffer = null;
    this.musicBufferPromise = null;
    this.musicOffset = 0;
    if (this.music) {
      this.music.pause();
      this.music.src = '';
      this.music.load();
    }

    const music = this.createAudioElement(src);
    this.musicLoop = nextLoop;
    music.loop = nextLoop;
    music.addEventListener('canplay', () => this.syncMusic());
    music.addEventListener('canplaythrough', () => this.syncMusic());
    music.addEventListener('stalled', () => this.scheduleMusicRetry());
    music.addEventListener('error', () => this.scheduleMusicRetry());
    this.music = music;
    this.musicSrc = src;
    this.applyMusicVolume();
    try {
      music.load();
    } catch {
      // The next user gesture or retry will try again.
    }
    if (this.audioContext) this.ensureMusicBuffer();
  }

  setMusicDesired(shouldPlay: boolean) {
    this.musicDesired = shouldPlay;
    this.syncMusic();
  }

  stopMusic(options: { reset?: boolean } = {}) {
    this.musicDesired = false;
    this.clearMusicRetry();
    this.stopWebAudioMusic(options);
    if (!this.music) return;
    this.music.pause();
    if (options.reset) {
      try {
        this.music.currentTime = 0;
      } catch {
        // Some browsers reject seeking before metadata is available.
      }
    }
  }

  private getAudioContext() {
    if (!isBrowser()) return null;
    if (this.audioContext?.state === 'closed') this.audioContext = null;
    if (this.audioContext) return this.audioContext;
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
    if (!AudioContextCtor) return null;
    this.audioContext = new AudioContextCtor();
    return this.audioContext;
  }

  private createAudioElement(src: string) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    audio.setAttribute('playsinline', 'true');
    return audio;
  }

  private ensureBaseAudio(track: SfxTrack) {
    if (!track.base) {
      track.base = this.createAudioElement(track.src);
      track.base.onended = () => {
        if (!track.base) return;
        track.base.currentTime = 0;
      };
    }
    return track.base;
  }

  private ensureBuffer(track: SfxTrack) {
    if (track.buffer) return null;
    if (track.bufferPromise) return track.bufferPromise;
    const ctx = this.getAudioContext();
    if (!ctx) return null;
    track.bufferPromise = fetch(track.src)
      .then((res) => {
        if (!res.ok) throw new Error(`Audio fetch failed: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        track.buffer = buffer;
      })
      .catch(() => {
        track.buffer = null;
      })
      .finally(() => {
        track.bufferPromise = null;
        this.flushQueuedSfx();
      });
    return track.bufferPromise;
  }

  private ensureMusicBuffer() {
    if (!this.musicSrc || this.musicBuffer || this.musicBufferPromise) return;
    const ctx = this.getAudioContext();
    if (!ctx) return;
    const requestedSrc = this.musicSrc;
    const token = this.musicBufferToken;
    this.musicBufferPromise = fetch(requestedSrc)
      .then((res) => {
        if (!res.ok) throw new Error(`Music fetch failed: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        if (token !== this.musicBufferToken || requestedSrc !== this.musicSrc) return;
        this.musicBuffer = buffer;
      })
      .catch(() => {
        if (token !== this.musicBufferToken || requestedSrc !== this.musicSrc) return;
        this.musicBuffer = null;
      })
      .finally(() => {
        if (token !== this.musicBufferToken || requestedSrc !== this.musicSrc) return;
        this.musicBufferPromise = null;
        this.syncMusic();
      });
  }

  private playBuffered(track: SfxTrack, volume: number) {
    const ctx = this.audioContext;
    if (!ctx || ctx.state !== 'running' || !track.buffer) {
      if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
      return false;
    }

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = track.buffer;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
    return true;
  }

  private playPooledHtmlAudio(track: SfxTrack, volume: number, fromQueue = false) {
    const audio = this.nextPoolAudio(track);
    audio.volume = volume;
    try {
      audio.currentTime = 0;
    } catch {
      // Metadata may not be ready yet; play() can still begin once enough data arrives.
    }
    const playPromise = audio.play();
    if (playPromise) {
      void playPromise.catch((error) => {
        if (!fromQueue && isRetryablePlayError(error)) this.queueSfx(track.key, volume);
      });
    }
  }

  private nextPoolAudio(track: SfxTrack) {
    const initialPoolSize = track.key === 'collect' ? 16 : 6;
    const maxPoolSize = track.key === 'collect' ? 32 : 10;
    if (track.pool.length === 0) {
      track.pool = Array.from({ length: initialPoolSize }, () => this.createAudioElement(track.src));
    }

    const available = track.pool.find((audio) => audio.paused || audio.ended);
    if (available) return available;

    if (track.pool.length < maxPoolSize) {
      const audio = this.createAudioElement(track.src);
      track.pool.push(audio);
      return audio;
    }

    const audio = track.pool[track.cursor % track.pool.length];
    track.cursor = (track.cursor + 1) % track.pool.length;
    audio.pause();
    return audio;
  }

  private queueSfx(key: string, volume: number) {
    const now = Date.now();
    this.queuedSfx = this.queuedSfx
      .filter((item) => now - item.queuedAt <= RECENT_SFX_QUEUE_MS)
      .slice(-MAX_QUEUED_SFX + 1);
    this.queuedSfx.push({ key, volume, queuedAt: now });
  }

  private flushQueuedSfx() {
    const ctx = this.audioContext;
    if (ctx && ctx.state !== 'running') {
      if (!this.sfxFlushResumePending) {
        this.sfxFlushResumePending = true;
        void ctx.resume()
          .then(() => {
            this.sfxFlushResumePending = false;
            if (ctx.state === 'running') this.flushQueuedSfx();
          })
          .catch(() => {
            this.sfxFlushResumePending = false;
          });
      }
      return;
    }

    const now = Date.now();
    const queued = this.queuedSfx.filter((item) => now - item.queuedAt <= RECENT_SFX_QUEUE_MS);
    this.queuedSfx = [];
    queued.forEach((item) => {
      const track = this.sfxTracks.get(item.key);
      if (!track) return;
      if (this.playBuffered(track, item.volume)) return;
      this.playPooledHtmlAudio(track, item.volume, true);
    });
  }

  private applyMusicVolume() {
    const volume = clamp01(this.volumes.master * this.volumes.music);
    if (this.music) this.music.volume = volume;
    if (this.musicGain) this.musicGain.gain.value = volume;
  }

  private syncMusic() {
    if (!isBrowser() || !this.music) return;
    this.applyMusicVolume();

    const shouldPlay = this.musicDesired && !document.hidden && this.music.volume > 0;
    if (!shouldPlay) {
      this.stopWebAudioMusic();
      this.music.pause();
      return;
    }

    const ctx = this.getAudioContext();
    if (ctx) this.ensureMusicBuffer();
    if (ctx?.state === 'running' && this.musicBuffer) {
      if (!this.music.paused) {
        this.musicOffset = this.music.currentTime || this.musicOffset;
        this.music.pause();
      }
      this.startWebAudioMusic(ctx);
      return;
    }

    if (this.musicSource && this.musicBuffer) {
      this.stopWebAudioMusic();
    } else {
      this.syncHtmlMusicPosition();
    }

    if (this.music.networkState === HTMLMediaElement.NETWORK_EMPTY) {
      try {
        this.music.load();
      } catch {
        // Retry is scheduled below if play fails.
      }
    }

    if (!this.music.paused && !this.music.ended) return;
    const token = ++this.musicPlayToken;
    const playPromise = this.music.play();
    if (playPromise) {
      void playPromise.catch((error) => {
        if (token === this.musicPlayToken && !isNotAllowedError(error)) this.scheduleMusicRetry();
      });
    }
  }

  private scheduleMusicRetry() {
    if (this.musicRetryTimer !== null || !isBrowser()) return;
    this.musicRetryTimer = window.setTimeout(() => {
      this.musicRetryTimer = null;
      if (this.musicDesired) this.syncMusic();
    }, 700);
  }

  private clearMusicRetry() {
    if (this.musicRetryTimer === null || !isBrowser()) return;
    window.clearTimeout(this.musicRetryTimer);
    this.musicRetryTimer = null;
  }

  private startWebAudioMusic(ctx: AudioContext) {
    if (!this.musicBuffer || this.musicSource) return;

    if (!this.musicGain || this.musicGain.context !== ctx) {
      this.musicGain = ctx.createGain();
      this.musicGain.connect(ctx.destination);
    }
    this.applyMusicVolume();

    const source = ctx.createBufferSource();
    source.buffer = this.musicBuffer;
    source.loop = this.musicLoop;
    source.connect(this.musicGain);
    source.onended = () => {
      if (this.musicSource === source) this.musicSource = null;
    };

    const offset = this.musicBuffer.duration > 0
      ? this.musicOffset % this.musicBuffer.duration
      : 0;
    source.start(0, offset);
    this.musicStartedAt = ctx.currentTime - offset;
    this.musicSource = source;
  }

  private getLiveWebAudioMusicOffset() {
    const ctx = this.audioContext;
    if (!ctx || !this.musicBuffer || !this.musicSource) return this.musicOffset;
    const elapsed = Math.max(0, ctx.currentTime - this.musicStartedAt);
    return this.musicBuffer.duration > 0
      ? elapsed % this.musicBuffer.duration
      : elapsed;
  }

  private syncHtmlMusicPosition() {
    if (!this.music || !Number.isFinite(this.musicOffset)) return;
    if (Math.abs((this.music.currentTime || 0) - this.musicOffset) < 0.05) return;
    try {
      this.music.currentTime = this.musicOffset;
    } catch {
      // Some browsers reject seeking before metadata is available.
    }
  }

  private stopWebAudioMusic(options: { reset?: boolean } = {}) {
    const source = this.musicSource;
    if (source && !options.reset) {
      this.musicOffset = this.getLiveWebAudioMusicOffset();
    }
    if (options.reset) this.musicOffset = 0;
    this.syncHtmlMusicPosition();
    if (!source) return;

    this.musicSource = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    try {
      source.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

export const gameAudio = new GameAudioSystem();
