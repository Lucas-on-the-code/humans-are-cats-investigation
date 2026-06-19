import React, { useRef, useEffect, useState } from 'react';
import {
  COLORS,
  GRAVITY,
  JUMP_FORCE,
  MOVE_SPEED,
  DASH_SPEED,
  DASH_DURATION,
  DASH_COOLDOWN,
  COMBAT,
  INTERACTION_QUOTES,
  MIKU_CHAT_OPENING_LINES,
  NPC_SPRITE_URLS,
  NPC_VARIANT_2_URLS,
  RANDOM_NPC_CHAT_LINES,
  WALK_SPRITE_URLS,
  SCENE_IMAGES,
  IDLE_SPRITE_URLS,
  AUDIO_URLS,
} from '../constants';
import {
  GameState,
  Player,
  NPC,
  Projectile,
  Particle,
  Item,
  TouchInput,
  NpcType,
  Platform,
  Hazard,
  Position,
  RunSummary,
  NpcChatSession,
  NpcChatTarget,
} from '../types';
import { gameAudio } from '../utils/audioSystem';

interface GameCanvasProps {
  gameState: GameState;
  setGameState: (state: GameState) => void;
  setDialogContent: (lines: string[]) => void;
  setDialogImage: (url: string | undefined) => void;
  onGameOver: (summary: RunSummary) => void;
  onWin: () => void;
  onRunIntroStart: () => void;
  onNpcChatStart: (session: NpcChatSession) => void;
  activeNpcChatTarget?: NpcChatTarget;
  activeConversationTarget?: NpcChatTarget;
  dismissedMikuIds?: Set<number>;
  onNpcChatAnchorChange: (anchor: { x: number; y: number }) => void;
  masterVolume: number;
  sfxVolume: number;
  touchInputRef: React.MutableRefObject<TouchInput>;
}

const BASE_HEIGHT = 600;
const MIN_VIEWPORT_WIDTH = 320;
const MIN_VIEWPORT_HEIGHT = 240;
const MAX_CHUNKS_PER_GENERATION = 12;
const VIRTUAL_GROUND_Y = 530;
const BASE_FRAME_MS = 1000 / 60;
const DEFAULT_PARTICLE_LIMIT = 220;
const DEFAULT_PROJECTILE_LIMIT = 60;
const RUN_START_X = 220;
const CHUNK_LENGTH = 760;
const GENERATE_AHEAD = 2600;
const CLEAN_BEHIND = 1000;
const CLEAN_FAR_BEHIND = CHUNK_LENGTH * 8;
const AIR_WALL_CAMERA_SAFE_RATIO = 0.36;
const INTRO_TREE_CENTER_X = 209;
const INTRO_TREE_PROMPT_Y = 244;
const INTRO_DROP_START_X = INTRO_TREE_CENTER_X - 25;
const INTRO_DROP_START_Y = VIRTUAL_GROUND_Y - 80 * 4;
const INTRO_DROP_DURATION_MS = 1050;
const INTRO_DROP_ARC_HEIGHT = 70;
const MANUAL_ACCEL = 0.82;
const GROUND_FRICTION = 0.82;
const AIR_FRICTION = 0.94;
const MAX_MANUAL_SPEED = MOVE_SPEED + 1.4;
const PROJECTILE_SPEED = 17;
const PROJECTILE_MAX_RANGE = 300;
const PLAYER_DAMAGE_INVULN = 650;
const DEATH_ANIM_MAX_MS = 1750;
const DEATH_POP_VY = -16;
const COMBO_WINDOW_MS = 4500;
const BOOST_TIME = 7000;
const NPC_PULSE_COOLDOWN = 850;
const GROUND_COIN_Y = VIRTUAL_GROUND_Y - 55;
const CAR_IMAGE_BOTTOM_Y = 596;
const CAR_WIDTH = 172;
const CAR_HEIGHT = 88;
const CAR_RIDE_DISTANCE = 1550;
const CAR_CRUISE_SPEED = 17.2;
const TRAFFIC_MIN_SPEED = 6.6;
const TRAFFIC_MAX_SPEED = 13.4;
const TAXI_TRAFFIC_MIN_SPEED = 8.8;
const TAXI_TRAFFIC_MAX_SPEED = 14.6;
const TRAFFIC_MIN_INTERVAL = 1300;
const TRAFFIC_MAX_INTERVAL = 2300;
const TRAFFIC_SPAWN_MARGIN = 260;
const TRAFFIC_MIN_SPACING = 520;
const TAXI_RANDOM_CHANCE = 0.03;
const TAXI_INITIAL_DELAY = 12000;
const TAXI_MIN_DELAY = 18000;
const TAXI_MAX_DELAY = 34000;
const TAXI_FREERIDE_THRESHOLD = 3;
const TAXI_FREERIDE_BONUS = 1800;
const NPC_TALK_RANGE = 92;
const PIXELS_PER_METER = 100;
const MIKU_NPC_IMAGE = '/sprites/npc_v2/npc_v2_0.png';
const CAR_SPRITE_KEYS = ['black', 'white', 'green', 'taxi', 'blue', 'red'] as const;
type CarSpriteKey = typeof CAR_SPRITE_KEYS[number];
const TRAFFIC_CAR_SPRITES: Exclude<CarSpriteKey, 'taxi'>[] = ['black', 'white', 'green', 'blue', 'red'];
const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
const pickTrafficSprite = () => TRAFFIC_CAR_SPRITES[Math.floor(Math.random() * TRAFFIC_CAR_SPRITES.length)];
const pickRandomLine = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const hasAudioUrl = (key: string): key is keyof typeof AUDIO_URLS => key in AUDIO_URLS;

const LAYER_ORDER = ['sky', 'cloud', 'farHouse', 'midHouse', 'house', 'sidewalk', 'lamp', 'tree'];
const PARALLAX_SPEEDS: Record<string, number> = {
  sky: 0,
  cloud: 0.1,
  farHouse: 0.2,
  midHouse: 0.4,
  house: 0.6,
  lamp: 0.85,
  tree: 0.95,
  sidewalk: 1.0,
};
const getIntroCameraX = (virtualWidth: number) => (INTRO_TREE_CENTER_X - virtualWidth / 2) / PARALLAX_SPEEDS.tree;
const getRunCameraX = (playerX: number, virtualWidth: number) => Math.max(0, playerX - virtualWidth * 0.32);
const getDistanceMeters = (distancePx: number) => Math.floor(distancePx / PIXELS_PER_METER);
const getDistanceHeat = (distance: number) => Math.min(1, Math.max(0, distance / (CHUNK_LENGTH * 18)));
const getChunkHeat = (index: number) => Math.min(1, Math.max(0, (index - 2) / 32));
const getAllowedDanger = (heat: number) => (heat < 0.28 ? 1 : heat < 0.62 ? 2 : 3);
const RUNNING_JUMP_START_VX = Math.min(MAX_MANUAL_SPEED, (MANUAL_ACCEL * GROUND_FRICTION) / (1 - GROUND_FRICTION));
const JUMP_COIN_START_FRAME = 6;
const JUMP_COIN_END_FRAME = 40;

interface JumpTrajectoryPoint {
  frame: number;
  x: number;
  y: number;
}

const buildJumpTrajectory = (): JumpTrajectoryPoint[] => {
  const points: JumpTrajectoryPoint[] = [];
  let x = 0;
  let y = 0;
  let vx = RUNNING_JUMP_START_VX;
  let vy = JUMP_FORCE;

  for (let frame = 0; frame < 72; frame++) {
    if (frame > 0) {
      vx = Math.min(MAX_MANUAL_SPEED, (vx + MANUAL_ACCEL) * AIR_FRICTION);
      vy += GRAVITY;
    }
    x += vx;
    y += vy;
    points.push({ frame, x, y });
    if (frame > 0 && y >= 0) break;
  }

  return points;
};

const JUMP_PICKUP_TRAJECTORY = buildJumpTrajectory();

const sampleJumpTrajectory = (frame: number) => {
  const maxFrame = JUMP_PICKUP_TRAJECTORY[JUMP_PICKUP_TRAJECTORY.length - 1]?.frame ?? 0;
  const clampedFrame = Math.max(0, Math.min(maxFrame, frame));
  const floorFrame = Math.floor(clampedFrame);
  const ceilFrame = Math.ceil(clampedFrame);
  const a = JUMP_PICKUP_TRAJECTORY[floorFrame] ?? JUMP_PICKUP_TRAJECTORY[0];
  const b = JUMP_PICKUP_TRAJECTORY[ceilFrame] ?? a;
  const t = clampedFrame - floorFrame;
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
  };
};

interface LayerDim {
  w: number;
  h: number;
}

type DrawableAsset = HTMLImageElement;
type ObstacleType = 'BARRIER' | 'LOW_BAR';

interface RunnerObstacle extends Position {
  id: number;
  width: number;
  height: number;
  type: ObstacleType;
  damage: number;
  passed: boolean;
}

interface FloatingText extends Position {
  text: string;
  color: string;
  life: number;
  vy: number;
  size: number;
}

interface DecorativePedestrian extends Position {
  id: number;
  width: number;
  height: number;
  vx: number;
  patrolStart: number;
  patrolEnd: number;
  spriteSet: 'npc' | 'npc_v2';
  frameOffset: number;
}

interface RideableCar extends Position {
  id: number;
  width: number;
  height: number;
  vx: number;
  cruiseVx: number;
  speedPulse: number;
  speedPhase: number;
  rideUntilX: number;
  occupied: boolean;
  used: boolean;
  canRide: boolean;
  spriteKey: CarSpriteKey;
}

interface RunStats {
  score: number;
  distance: number;
  evidence: number;
  scans: number;
  nearMisses: number;
  taxiRides: number;
  combo: number;
  bestCombo: number;
  multiplier: number;
  startedAt: number;
  lastComboAt: number;
}

type MapModuleFamily = 'flow' | 'jump' | 'slide' | 'laser' | 'stealth' | 'mixed' | 'recovery';

interface MapRhythm {
  recentIds: string[];
  recentFamilies: MapModuleFamily[];
  dangerStreak: number;
}

interface MapModule {
  id: string;
  family: MapModuleFamily;
  minHeat: number;
  maxHeat?: number;
  weight: number;
  danger: number;
  build: (index: number, startX: number, heat: number, groundNpcY: number) => void;
}

const getViewportDims = () => {
  if (typeof window === 'undefined') return { width: 1280, height: 720 };
  const vv = window.visualViewport;
  const rawWidth = Math.round(vv?.width ?? window.innerWidth);
  const rawHeight = Math.round(vv?.height ?? window.innerHeight);
  return {
    width: Number.isFinite(rawWidth) && rawWidth > 0 ? Math.max(MIN_VIEWPORT_WIDTH, rawWidth) : 1280,
    height: Number.isFinite(rawHeight) && rawHeight > 0 ? Math.max(MIN_VIEWPORT_HEIGHT, rawHeight) : 720,
  };
};

const getVirtualWidth = (width: number, height: number) => {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.max(MIN_VIEWPORT_WIDTH, width) : 1280;
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.max(MIN_VIEWPORT_HEIGHT, height) : 720;
  return (safeWidth / safeHeight) * BASE_HEIGHT;
};

const rectsOverlap = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

const circleRectOverlap = (
  circle: { x: number; y: number; radius: number },
  rect: { x: number; y: number; width: number; height: number },
) => {
  const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));
  const dx = circle.x - closestX;
  const dy = circle.y - closestY;
  return dx * dx + dy * dy <= circle.radius * circle.radius;
};

const isHazardActive = (hazard: Hazard, now: number) => Math.sin(now / 520 + hazard.phase) > -0.55;

const isTypingTarget = (target: EventTarget | null) => (
  target instanceof HTMLElement
  && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
);

const emptyStats = (): RunStats => ({
  score: 0,
  distance: 0,
  evidence: 0,
  scans: 0,
  nearMisses: 0,
  taxiRides: 0,
  combo: 0,
  bestCombo: 0,
  multiplier: 1,
  startedAt: Date.now(),
  lastComboAt: 0,
});

export const GameCanvas: React.FC<GameCanvasProps> = ({
  gameState,
  onGameOver,
  onRunIntroStart,
  onNpcChatStart,
  activeNpcChatTarget,
  activeConversationTarget,
  dismissedMikuIds,
  onNpcChatAnchorChange,
  masterVolume,
  sfxVolume,
  touchInputRef,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [dims, setDims] = useState(getViewportDims);

  const playerRef = useRef<Player>({
    x: RUN_START_X, y: VIRTUAL_GROUND_Y - 80, width: 50, height: 80, emoji: 'cat',
    vx: 0, vy: 0, isGrounded: true, direction: 1,
    panic: 0, isHiding: false, hp: COMBAT.PLAYER_MAX_HP, maxHp: COMBAT.PLAYER_MAX_HP,
    attackCooldown: 0, isAttacking: false, evidenceCollected: 0,
    isDashing: false, dashCooldown: 0, dashTime: 0,
    canWallJump: false, wallJumpDirection: 0,
    isInitialHiding: false, invulnerableTime: 0,
    isSliding: false, slideTime: 0, magnetTime: 0, shieldTime: 0,
  });

  const platformsRef = useRef<Platform[]>([]);
  const hazardsRef = useRef<Hazard[]>([]);
  const obstaclesRef = useRef<RunnerObstacle[]>([]);
  const pedestriansRef = useRef<DecorativePedestrian[]>([]);
  const carsRef = useRef<RideableCar[]>([]);
  const npcsRef = useRef<NPC[]>([]);
  const itemsRef = useRef<Item[]>([]);
  const projectilesRef = useRef<Projectile[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const floatingTextsRef = useRef<FloatingText[]>([]);
  const dashTrailRef = useRef<Position[]>([]);
  const cameraRef = useRef({ x: 0, y: 0 });
  const gameStateRef = useRef<GameState>(gameState);
  const keysRef = useRef<{ [key: string]: boolean }>({});
  const statsRef = useRef<RunStats>(emptyStats());
  const nextChunkXRef = useRef(620);
  const leftAirWallXRef = useRef(RUN_START_X - 120);
  const chunkIndexRef = useRef(0);
  const mapRhythmRef = useRef<MapRhythm>({ recentIds: [], recentFamilies: [], dangerStreak: 0 });
  const objectIdRef = useRef(1);
  const endedRef = useRef(false);
  const screenShakeRef = useRef(0);
  const prevJumpRef = useRef(false);
  const prevActionRef = useRef(false);
  const prevInteractRef = useRef(false);
  const pointerActionRef = useRef(false);
  const mikuProximityRef = useRef<Set<number>>(new Set());
  const trafficSpawnerRef = useRef({ nextAt: 0, taxiDueAt: 0 });
  const deathAnimRef = useRef({ active: false, startedAt: 0 });
  const introDropRef = useRef<{ phase: 'waiting' | 'jumping' | 'done'; startedAt: number; startCameraX: number }>({
    phase: 'done',
    startedAt: 0,
    startCameraX: 0,
  });

  const imagesRef = useRef<Record<string, DrawableAsset>>({});
  const layerDimsRef = useRef<Record<string, LayerDim>>({});
  const isTabVisibleRef = useRef<boolean>(typeof document !== 'undefined' ? !document.hidden : true);
  const targetFpsRef = useRef<number>(60);
  const particleLimitRef = useRef<number>(DEFAULT_PARTICLE_LIMIT);
  const projectileLimitRef = useRef<number>(DEFAULT_PROJECTILE_LIMIT);
  const sceneQualityScaleRef = useRef<number>(1);
  const spriteQualityScaleRef = useRef<number>(1);
  const viewportRef = useRef(getViewportDims());
  const resizeRafRef = useRef<number | null>(null);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  const getAssetSize = (asset: DrawableAsset) => {
    return { width: asset.naturalWidth, height: asset.naturalHeight };
  };

  const nextId = () => objectIdRef.current++;

  const playSound = (type: 'JUMP' | 'SHOOT' | 'HIT' | 'DAMAGE' | 'COLLECT' | 'DASH' | 'CAT' | 'DEATH') => {
    const primaryKey = type.toLowerCase();
    const fallbackKey = type === 'SHOOT' ? 'attack' : type === 'HIT' ? 'damage' : '';
    const soundKey = hasAudioUrl(primaryKey) ? primaryKey : fallbackKey;
    if (!soundKey || !hasAudioUrl(soundKey)) return;
    gameAudio.playSfx(soundKey);
  };

  useEffect(() => {
    const updateVisibility = () => { isTabVisibleRef.current = !document.hidden; };
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 8 : 8;
    const memory = typeof navigator !== 'undefined' && 'deviceMemory' in navigator ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 8 : 8;
    const shortEdge = Math.min(window.innerWidth, window.innerHeight);
    const isLowEnd = cores <= 4 || memory <= 4 || shortEdge <= 820;
    const isMidEnd = !isLowEnd && (cores <= 8 || memory <= 8 || shortEdge <= 1080);

    if (isLowEnd) {
      targetFpsRef.current = 45;
      particleLimitRef.current = 150;
      projectileLimitRef.current = 42;
      sceneQualityScaleRef.current = 0.5;
      spriteQualityScaleRef.current = 0.8;
      return;
    }
    if (isMidEnd) {
      targetFpsRef.current = 55;
      particleLimitRef.current = 180;
      projectileLimitRef.current = 50;
      sceneQualityScaleRef.current = 0.75;
      spriteQualityScaleRef.current = 0.9;
      return;
    }

    targetFpsRef.current = 60;
    particleLimitRef.current = DEFAULT_PARTICLE_LIMIT;
    projectileLimitRef.current = DEFAULT_PROJECTILE_LIMIT;
    sceneQualityScaleRef.current = 1;
    spriteQualityScaleRef.current = 1;
  }, []);

  useEffect(() => {
    const isTouchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
    const updateLayerDims = () => {
      const tempDims: Record<string, LayerDim> = {};
      LAYER_ORDER.forEach(key => {
        const asset = imagesRef.current[key];
        if (asset) {
          const { width, height } = getAssetSize(asset);
          if (height > 0) {
            const scale = BASE_HEIGHT / height;
            tempDims[key] = { w: width * scale, h: BASE_HEIGHT };
          }
        }
      });
      layerDimsRef.current = tempDims;
    };
    const applyResize = () => {
      const next = getViewportDims();
      const prev = viewportRef.current;
      const widthDelta = Math.abs(next.width - prev.width);
      const heightDelta = Math.abs(next.height - prev.height);
      if (isTouchDevice && gameState === 'PLAYING' && widthDelta <= 2 && heightDelta > 0 && heightDelta < 140) return;
      viewportRef.current = next;
      setDims((oldDims) => oldDims.width === next.width && oldDims.height === next.height ? oldDims : next);
      updateLayerDims();
    };
    const scheduleResize = () => {
      if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        applyResize();
      });
    };
    window.addEventListener('resize', scheduleResize);
    window.visualViewport?.addEventListener('resize', scheduleResize);
    return () => {
      window.removeEventListener('resize', scheduleResize);
      window.visualViewport?.removeEventListener('resize', scheduleResize);
      if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    };
  }, [isLoaded, gameState]);

  useEffect(() => {
    let mounted = true;
    const loadAllAssets = async () => {
      const promises: Promise<void>[] = [];
      const tempImages: Record<string, DrawableAsset> = {};
      gameAudio.registerSfx(AUDIO_URLS);
      gameAudio.preloadSfx();

      const withQuality = (src: string, scale: number) => {
        try {
          const url = new URL(src);
          const currentW = Number(url.searchParams.get('w') || '');
          const currentH = Number(url.searchParams.get('h') || '');
          if (Number.isFinite(currentW) && currentW > 0) url.searchParams.set('w', String(Math.max(320, Math.round(currentW * scale))));
          if (Number.isFinite(currentH) && currentH > 0) url.searchParams.set('h', String(Math.max(180, Math.round(currentH * scale))));
          return url.toString();
        } catch {
          return src;
        }
      };

      const addImage = (key: string, src: string, fallbackSrc?: string) => new Promise<void>((res) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          res();
        };
        const timeoutId = window.setTimeout(done, 12000);
        const img = new Image();
        img.decoding = 'async';
        img.src = src;
        img.onload = () => {
          if (settled) return;
          if (mounted) tempImages[key] = img;
          done();
        };
        img.onerror = () => {
          if (settled) return;
          if (fallbackSrc && fallbackSrc !== src) {
            img.src = fallbackSrc;
            return;
          }
          done();
        };
      });

      Object.entries(SCENE_IMAGES).forEach(([k, s]) => promises.push(addImage(k, withQuality(s, sceneQualityScaleRef.current), s)));
      WALK_SPRITE_URLS.forEach((s, i) => promises.push(addImage(`walk_${i}`, withQuality(s, spriteQualityScaleRef.current), s)));
      IDLE_SPRITE_URLS.forEach((s, i) => promises.push(addImage(`idle_${i}`, withQuality(s, spriteQualityScaleRef.current), s)));
      NPC_SPRITE_URLS.forEach((s, i) => promises.push(addImage(`decor_npc_${i}`, withQuality(s, spriteQualityScaleRef.current), s)));
      NPC_VARIANT_2_URLS.forEach((s, i) => promises.push(addImage(`decor_npc_v2_${i}`, withQuality(s, spriteQualityScaleRef.current), s)));
      CAR_SPRITE_KEYS.forEach((key) => promises.push(addImage(`car_${key}`, `/sprites/cars/${key}.png`)));

      await Promise.all(promises);
      if (!mounted) return;
      const hasCoreLayers = ['sky', 'cloud', 'house', 'tree', 'sidewalk'].every((k) => Boolean(tempImages[k]));
      if (!hasCoreLayers) {
        setTimeout(loadAllAssets, 1200);
        return;
      }
      imagesRef.current = tempImages;
      gameAudio.preloadSfx();

      const tempDims: Record<string, LayerDim> = {};
      LAYER_ORDER.forEach(key => {
        const asset = tempImages[key];
        if (asset) {
          const { width, height } = getAssetSize(asset);
          if (height > 0) {
            const scale = BASE_HEIGHT / height;
            tempDims[key] = { w: width * scale, h: BASE_HEIGHT };
          }
        }
      });
      layerDimsRef.current = tempDims;
      setIsLoaded(true);
    };
    loadAllAssets();
    return () => { mounted = false; };
  }, []);

  const resetRun = () => {
    playerRef.current = {
      ...playerRef.current,
      x: INTRO_DROP_START_X,
      y: INTRO_DROP_START_Y,
      width: 50,
      height: 80,
      vx: 0,
      vy: 0,
      hp: COMBAT.PLAYER_MAX_HP,
      maxHp: COMBAT.PLAYER_MAX_HP,
      panic: 0,
      evidenceCollected: 0,
      isGrounded: false,
      isInitialHiding: false,
      isDashing: false,
      dashCooldown: 0,
      dashTime: 0,
      canWallJump: false,
      wallJumpDirection: 0,
      invulnerableTime: 0,
      isSliding: false,
      slideTime: 0,
      magnetTime: 0,
      shieldTime: 0,
      direction: 1,
    };
    statsRef.current = emptyStats();
    platformsRef.current = [];
    hazardsRef.current = [];
    obstaclesRef.current = [];
    pedestriansRef.current = [];
    carsRef.current = [];
    npcsRef.current = [];
    itemsRef.current = [];
    projectilesRef.current = [];
    particlesRef.current = [];
    floatingTextsRef.current = [];
    dashTrailRef.current = [];
    keysRef.current = {};
    touchInputRef.current = { left: false, right: false, up: false, down: false, action: false, attack: false, interact: false, dash: false };
    const introCameraX = getIntroCameraX(getVirtualWidth(dims.width, dims.height));
    cameraRef.current = { x: introCameraX, y: 0 };
    nextChunkXRef.current = 620;
    leftAirWallXRef.current = RUN_START_X - 120;
    chunkIndexRef.current = 0;
    mapRhythmRef.current = { recentIds: [], recentFamilies: [], dangerStreak: 0 };
    objectIdRef.current = 1;
    endedRef.current = false;
    screenShakeRef.current = 0;
    prevJumpRef.current = false;
    prevActionRef.current = false;
    prevInteractRef.current = false;
    pointerActionRef.current = false;
    mikuProximityRef.current = new Set();
    deathAnimRef.current = { active: false, startedAt: 0 };
    introDropRef.current = { phase: 'waiting', startedAt: 0, startCameraX: introCameraX };
    const now = Date.now();
    trafficSpawnerRef.current = { nextAt: now, taxiDueAt: now + TAXI_INITIAL_DELAY };
  };

  const addFloatingText = (text: string, x: number, y: number, color = '#ffffff', size = 18) => {
    floatingTextsRef.current.push({ text, x, y, color, size, life: 58, vy: -0.8 });
    if (floatingTextsRef.current.length > 28) floatingTextsRef.current.shift();
  };

  const emitIntroLeaves = (x: number, y: number) => {
    const colors = ['#86efac', '#4ade80', '#bbf7d0', '#65a30d'];
    for (let i = 0; i < 34; i++) {
      if (particlesRef.current.length >= particleLimitRef.current) break;
      particlesRef.current.push({
        x,
        y,
        vx: -5 + Math.random() * 10,
        vy: -7 + Math.random() * 7,
        life: 48 + Math.random() * 34,
        color: colors[i % colors.length],
        size: 3 + Math.random() * 5,
        shape: 'leaf',
      });
    }
  };

  const startIntroJump = () => {
    if (gameState !== 'PLAYING' || introDropRef.current.phase !== 'waiting') return;
    const p = playerRef.current;
    introDropRef.current = { phase: 'jumping', startedAt: Date.now(), startCameraX: cameraRef.current.x };
    p.x = INTRO_DROP_START_X;
    p.y = INTRO_DROP_START_Y;
    p.vx = 0;
    p.vy = 0;
    p.direction = 1;
    p.isGrounded = false;
    statsRef.current.startedAt = Date.now();
    emitIntroLeaves(p.x + p.width / 2, p.y + p.height * 0.55);
    addFloatingText('GO', p.x + p.width / 2, p.y - 12, '#bbf7d0', 20);
    playSound('JUMP');
    onRunIntroStart();
  };

  const getTaxiBoardingZone = (car: RideableCar) => ({
    x: car.x + 8,
    y: car.y - 30,
    width: car.width - 16,
    height: car.height + 42,
  });

  const getNpcTalkZone = (npc: { x: number; y: number; width: number; height: number }) => ({
    x: npc.x - NPC_TALK_RANGE * 0.5,
    y: npc.y - 16,
    width: npc.width + NPC_TALK_RANGE,
    height: npc.height + 34,
  });

  const getNpcChatAnchor = (npc: { x: number; y: number; width: number }, kind: 'miku' | 'random') => {
    const scale = Math.max(MIN_VIEWPORT_HEIGHT, dims.height) / BASE_HEIGHT;
    const screenX = (npc.x + npc.width / 2 - cameraRef.current.x) * scale;
    const screenY = (npc.y - 18) * scale;
    return {
      x: screenX,
      y: screenY,
    };
  };

  const openNpcChat = (npc: NPC) => {
    const isMiku = npc.chatKind === 'miku';
    const kind = isMiku ? 'miku' : 'random';
    onNpcChatStart({
      kind,
      speaker: isMiku ? '初音未来' : npc.label || '路人',
      lines: [isMiku ? pickRandomLine(MIKU_CHAT_OPENING_LINES) : pickRandomLine(RANDOM_NPC_CHAT_LINES)],
      isInvite: isMiku,
      image: isMiku ? MIKU_NPC_IMAGE : undefined,
      anchor: getNpcChatAnchor(npc, kind),
      target: { type: 'npc', id: npc.id, kind },
    });
  };

  const openPedestrianChat = (pedestrian: DecorativePedestrian) => {
    onNpcChatStart({
      kind: 'random',
      speaker: '路人',
      lines: [pickRandomLine(RANDOM_NPC_CHAT_LINES)],
      anchor: getNpcChatAnchor(pedestrian, 'random'),
      target: { type: 'pedestrian', id: pedestrian.id, kind: 'random' },
    });
  };

  const syncNpcChatAnchor = () => {
    if (!activeNpcChatTarget) return;
    const target = activeNpcChatTarget.type === 'npc'
      ? npcsRef.current.find((npc) => npc.id === activeNpcChatTarget.id)
      : pedestriansRef.current.find((pedestrian) => pedestrian.id === activeNpcChatTarget.id);
    if (!target) {
      onNpcChatAnchorChange({ x: -10000, y: -10000 });
      return;
    }
    onNpcChatAnchorChange(getNpcChatAnchor(target, activeNpcChatTarget.kind));
  };

  const awardScore = (base: number, label: string, x: number, y: number, combo = true) => {
    const stats = statsRef.current;
    const now = Date.now();
    if (combo) {
      stats.combo = now - stats.lastComboAt <= COMBO_WINDOW_MS ? stats.combo + 1 : 1;
      stats.lastComboAt = now;
      stats.bestCombo = Math.max(stats.bestCombo, stats.combo);
      stats.multiplier = Math.min(5, 1 + Math.floor(stats.combo / 4) * 0.25);
    }
    const score = Math.round(base * stats.multiplier);
    stats.score += score;
    addFloatingText(`${label} +${score}`, x, y, combo ? '#ffe066' : '#9ee6ff', combo ? 18 : 15);
  };

  const endRun = () => {
    if (endedRef.current) return;
    endedRef.current = true;
    const stats = statsRef.current;
    const hasFreerideBonus = stats.taxiRides >= TAXI_FREERIDE_THRESHOLD;
    const score = Math.floor(stats.score + (hasFreerideBonus ? TAXI_FREERIDE_BONUS : 0));
    const title = hasFreerideBonus
      ? '白嫖打车王'
      : stats.bestCombo >= 28
        ? '连击狂热'
        : stats.nearMisses >= 8
          ? '擦边大师'
          : getDistanceMeters(stats.distance) >= 180
            ? '远距调查员'
            : stats.evidence >= 6
              ? '证据猎手'
              : '见习调查员';
    onGameOver({
      score,
      distance: getDistanceMeters(stats.distance),
      evidence: stats.evidence,
      scans: stats.scans,
      nearMisses: stats.nearMisses,
      bestCombo: stats.bestCombo,
      survivalTime: Math.floor((Date.now() - stats.startedAt) / 1000),
      title,
    });
  };

  const makeNpc = (x: number, y: number, overrides: Partial<NPC> = {}): NPC => ({
    x,
    y,
    width: overrides.width ?? 50,
    height: overrides.height ?? 80,
    emoji: 'placeholder',
    id: nextId(),
    type: NpcType.WORKER,
    scanned: false,
    originalEmoji: '',
    scannedEmoji: '',
    dialogText: INTERACTION_QUOTES,
    isTarget: false,
    vx: 0.7,
    vy: 0,
    patrolStart: x - 90,
    patrolEnd: x + 120,
    visionRange: 220,
    visionHeight: 150,
    alertLevel: 0,
    damageCooldown: 0,
    scanHits: 0,
    maxScanHits: 1,
    label: '巡逻',
    ...overrides,
  });

  const makeMikuNpc = (x: number): NPC => makeNpc(x, VIRTUAL_GROUND_Y - 80, {
    width: 54,
    height: 80,
    vx: 0.28,
    patrolStart: x - 45,
    patrolEnd: x + 75,
    visionRange: 0,
    visionHeight: 0,
    maxScanHits: 1,
    label: '初音未来',
    dialogText: MIKU_CHAT_OPENING_LINES,
    chatKind: 'miku',
    spriteKey: 'decor_npc_v2_0',
  });

  const addPickup = (x: number, y: number, type: Item['type']) => {
    itemsRef.current.push({ id: nextId(), x, y, width: 30, height: 30, type, collected: false, floatOffset: 0 });
  };

  const addPickupLine = (x: number, y: number, count: number, gap: number, type: Item['type'] = 'FISH') => {
    for (let i = 0; i < count; i++) addPickup(x + i * gap, y, type);
  };

  const addPickupArc = (x: number, y: number, count: number, _gap: number, _lift = 46, type: Item['type'] = 'FISH') => {
    const startFrame = JUMP_COIN_START_FRAME;
    const endFrame = Math.min(JUMP_COIN_END_FRAME, JUMP_PICKUP_TRAJECTORY[JUMP_PICKUP_TRAJECTORY.length - 1]?.frame ?? JUMP_COIN_END_FRAME);
    const firstPoint = sampleJumpTrajectory(startFrame);
    for (let i = 0; i < count; i++) {
      const t = count <= 1 ? 0 : i / (count - 1);
      const point = sampleJumpTrajectory(lerp(startFrame, endFrame, t));
      addPickup(x + point.x - firstPoint.x, y + point.y, type);
    }
  };

  const addPlatform = (x: number, y: number, width: number) => {
    platformsRef.current.push({ x, y, width, height: 18, type: 'FLOOR' });
  };

  const addLaser = (x: number, width: number, phase: number, y = VIRTUAL_GROUND_Y - 18) => {
    hazardsRef.current.push({ id: nextId(), x, y, width, height: 10, damage: COMBAT.HAZARD_DAMAGE, type: 'LASER', phase });
  };

  const addTrafficCar = (x: number, spriteKey?: CarSpriteKey) => {
    const id = nextId();
    const selectedSprite = spriteKey ?? pickTrafficSprite();
    const canRide = selectedSprite === 'taxi';
    const width = canRide ? CAR_WIDTH + 12 : CAR_WIDTH;
    const height = canRide ? CAR_HEIGHT + 6 : CAR_HEIGHT;
    const cruiseVx = canRide
      ? randomBetween(TAXI_TRAFFIC_MIN_SPEED, TAXI_TRAFFIC_MAX_SPEED)
      : randomBetween(TRAFFIC_MIN_SPEED, TRAFFIC_MAX_SPEED);
    carsRef.current.push({
      id,
      x,
      y: CAR_IMAGE_BOTTOM_Y - height,
      width,
      height,
      vx: cruiseVx,
      cruiseVx,
      speedPulse: canRide ? randomBetween(0.25, 0.85) : randomBetween(0.35, 1.35),
      speedPhase: Math.random() * Math.PI * 2,
      rideUntilX: x + CAR_RIDE_DISTANCE,
      occupied: false,
      used: false,
      canRide,
      spriteKey: selectedSprite,
    });
  };

  const spawnRandomTraffic = (now: number) => {
    const spawner = trafficSpawnerRef.current;
    if (now < spawner.nextAt) return;

    const camX = cameraRef.current.x;
    const spawnX = camX - TRAFFIC_SPAWN_MARGIN - Math.random() * 180;
    const hasNearbyCar = carsRef.current.some((car) => Math.abs(car.x - spawnX) < TRAFFIC_MIN_SPACING);
    if (!hasNearbyCar) {
      const shouldSpawnTaxi = now >= spawner.taxiDueAt || Math.random() < TAXI_RANDOM_CHANCE;
      addTrafficCar(spawnX, shouldSpawnTaxi ? 'taxi' : undefined);
      if (shouldSpawnTaxi) spawner.taxiDueAt = now + randomBetween(TAXI_MIN_DELAY, TAXI_MAX_DELAY);
    }

    spawner.nextAt = now + TRAFFIC_MIN_INTERVAL + Math.random() * (TRAFFIC_MAX_INTERVAL - TRAFFIC_MIN_INTERVAL);
  };

  const addDecorativePedestrians = (index: number, startX: number) => {
    const count = index < 1 ? 1 : 1 + (index % 3 === 0 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const spriteSet = (index + i) % 2 === 0 ? 'npc' : 'npc_v2';
      const height = spriteSet === 'npc' ? 72 : 68;
      const width = spriteSet === 'npc' ? 43 : 45;
      const x = startX + 70 + i * 260 + ((index * 97) % 140);
      const patrolStart = x - 90;
      const patrolEnd = x + 120;
      pedestriansRef.current.push({
        id: nextId(),
        x,
        y: VIRTUAL_GROUND_Y - height,
        width,
        height,
        vx: ((index + i) % 2 === 0 ? 0.28 : -0.24),
        patrolStart,
        patrolEnd,
        spriteSet,
        frameOffset: (index * 173 + i * 311) % 1000,
      });
    }
  };

  const addBarrier = (x: number, damage = 16, width = 50) => {
    obstaclesRef.current.push({ id: nextId(), x, y: VIRTUAL_GROUND_Y - 62, width, height: 62, type: 'BARRIER', damage, passed: false });
  };

  const addLowBar = (x: number, width = 122, damage = 13) => {
    obstaclesRef.current.push({ id: nextId(), x, y: VIRTUAL_GROUND_Y - 86, width, height: 28, type: 'LOW_BAR', damage, passed: false });
  };

  const addPatrolNpc = (x: number, groundNpcY: number, startX: number, heat: number, label = '巡查') => {
    npcsRef.current.push(makeNpc(x, groundNpcY, {
      patrolStart: Math.max(startX + 40, x - 90),
      patrolEnd: Math.min(startX + CHUNK_LENGTH - 40, x + 150),
      vx: (0.75 + heat * 0.8) * (Math.random() < 0.5 ? 1 : -1),
      visionRange: 215 + heat * 80,
      label,
    }));
  };

  const addTargetNpc = (x: number, groundNpcY: number, startX: number, heat: number, hard = false) => {
    npcsRef.current.push(makeNpc(x, hard ? VIRTUAL_GROUND_Y - 90 : groundNpcY, {
      patrolStart: Math.max(startX + 60, x - 70),
      patrolEnd: Math.min(startX + CHUNK_LENGTH - 30, x + 145),
      isTarget: true,
      type: hard ? NpcType.LEADER : NpcType.EATER,
      maxScanHits: hard ? 3 : 2,
      width: hard ? 60 : 50,
      height: hard ? 90 : 80,
      vx: (-0.55 - heat * 0.45) * (Math.random() < 0.5 ? 1 : -1),
      visionRange: hard ? 285 : 235,
      label: hard ? '首领' : '目标',
    }));
  };

  const mapModules: MapModule[] = [
    {
      id: 'coin_warmup',
      family: 'flow',
      minHeat: 0,
      maxHeat: 0.22,
      weight: 1,
      danger: 0,
      build: (index, startX) => {
        addPickupLine(startX + 84, GROUND_COIN_Y, 7, 54);
        addBarrier(startX + 520, 14, 46);
        addPickup(startX + 650, GROUND_COIN_Y, index % 4 === 0 ? 'SHIELD' : 'FISH');
      },
    },
    {
      id: 'slide_intro',
      family: 'slide',
      minHeat: 0,
      maxHeat: 0.32,
      weight: 1,
      danger: 1,
      build: (_index, startX, heat, groundNpcY) => {
        addPickupLine(startX + 105, GROUND_COIN_Y, 4, 58);
        addLowBar(startX + 330, 132);
        addTargetNpc(startX + 575, groundNpcY, startX, heat);
      },
    },
    {
      id: 'breather_line',
      family: 'recovery',
      minHeat: 0,
      weight: 0.88,
      danger: 0,
      build: (index, startX) => {
        addPickupLine(startX + 90, GROUND_COIN_Y, 5, 50);
        addPickupArc(startX + 365, GROUND_COIN_Y, 4, 54, 56);
        if (index >= 2 && index % 2 === 0) npcsRef.current.push(makeMikuNpc(startX + 575));
        addPickup(startX + 690, GROUND_COIN_Y, index % 3 === 0 ? 'HEALTH' : 'FISH');
      },
    },
    {
      id: 'jump_bonus_steps',
      family: 'jump',
      minHeat: 0.08,
      weight: 0.92,
      danger: 1,
      build: (index, startX) => {
        const y1 = 458 - Math.floor(Math.random() * 24);
        const y2 = y1 - 36 - Math.floor(Math.random() * 18);
        addPickupArc(startX + 72, GROUND_COIN_Y, 5, 48, 62);
        addPlatform(startX + 215, y1, 150);
        addPlatform(startX + 420, y2, 150);
        addPlatform(startX + 610, Math.max(382, y2 - 30), 130);
        addPickupLine(startX + 235, y1 - 44, 3, 44);
        addPickupLine(startX + 440, y2 - 44, 3, 44);
        addPickup(startX + 650, Math.max(382, y2 - 30) - 48, index % 4 === 0 ? 'SHIELD' : 'FISH');
      },
    },
    {
      id: 'laser_rooftop_choice',
      family: 'laser',
      minHeat: 0.14,
      weight: 1.15,
      danger: 1,
      build: (index, startX) => {
        const laserX = startX + 130 + Math.floor(Math.random() * 42);
        addLaser(laserX, 230 + Math.floor(Math.random() * 60), index * 0.73);
        addPlatform(laserX + 24, 405, 250);
        addPickupLine(laserX + 45, 360, 5, 42);
        addBarrier(startX + 590, 16, 50);
      },
    },
    {
      id: 'patrol_gap',
      family: 'stealth',
      minHeat: 0.16,
      weight: 1.05,
      danger: 1,
      build: (_index, startX, heat, groundNpcY) => {
        addPatrolNpc(startX + 150, groundNpcY, startX, heat, '快巡');
        addPickup(startX + 350, GROUND_COIN_Y, Math.random() < 0.4 ? 'MAGNET' : 'FISH');
        addTargetNpc(startX + 520, groundNpcY, startX, heat, heat > 0.55);
      },
    },
    {
      id: 'low_high_switch',
      family: 'mixed',
      minHeat: 0.2,
      weight: 1.2,
      danger: 2,
      build: (index, startX) => {
        addLowBar(startX + 115, 110, 14);
        addLaser(startX + 315, 198 + Math.floor(Math.random() * 45), index * 0.58);
        addPlatform(startX + 545, 390 + Math.floor(Math.random() * 30), 190);
        addPickupLine(startX + 565, 346, 4, 44);
      },
    },
    {
      id: 'double_laser_timing',
      family: 'laser',
      minHeat: 0.34,
      weight: 1,
      danger: 2,
      build: (index, startX) => {
        addLaser(startX + 105, 150 + Math.floor(Math.random() * 36), index * 0.45);
        addLaser(startX + 415, 150 + Math.floor(Math.random() * 42), index * 0.45 + Math.PI);
        addPickupLine(startX + 275, GROUND_COIN_Y, 3, 48);
        addBarrier(startX + 630, 16, 48);
        addPickup(startX + 695, GROUND_COIN_Y, index % 2 === 0 ? 'HEALTH' : 'FISH');
      },
    },
    {
      id: 'security_combo',
      family: 'stealth',
      minHeat: 0.38,
      weight: 1.05,
      danger: 2,
      build: (_index, startX, heat, groundNpcY) => {
        addPatrolNpc(startX + 145, groundNpcY, startX, heat, '巡查');
        addLowBar(startX + 350, 104, 14);
        addTargetNpc(startX + 565, groundNpcY, startX, heat, heat > 0.65);
        addPickup(startX + 485, GROUND_COIN_Y, Math.random() < 0.45 ? 'MAGNET' : 'FISH');
      },
    },
    {
      id: 'jump_thread',
      family: 'jump',
      minHeat: 0.42,
      weight: 0.95,
      danger: 1,
      build: (index, startX) => {
        const baseY = 388 + Math.floor(Math.random() * 28);
        addLaser(startX + 92, 245, index * 0.7);
        addPlatform(startX + 130, baseY, 205);
        addPlatform(startX + 405, baseY + 45, 190);
        addPickupLine(startX + 150, baseY - 46, 4, 44);
        addPickupLine(startX + 425, baseY - 2, 3, 46);
      },
    },
    {
      id: 'staccato_slide_jump',
      family: 'mixed',
      minHeat: 0.48,
      weight: 1.15,
      danger: 3,
      build: (_index, startX) => {
        addLowBar(startX + 100, 112, 14);
        addBarrier(startX + 330, 17, 50);
        addPickup(startX + 535, GROUND_COIN_Y, 'FISH');
        addPickupArc(startX + 250, GROUND_COIN_Y, 6, 54, 88);
      },
    },
    {
      id: 'split_lane_reward',
      family: 'jump',
      minHeat: 0.52,
      weight: 0.95,
      danger: 1,
      build: (index, startX) => {
        addBarrier(startX + 155, 16, 48);
        addPlatform(startX + 245, 404, 126);
        addPlatform(startX + 435, 404, 126);
        addLaser(startX + 240, 126, index * 0.4);
        addLaser(startX + 430, 126, index * 0.4 + 1.7);
        addPickup(startX + 615, GROUND_COIN_Y, index % 3 === 0 ? 'SHIELD' : 'FISH');
      },
    },
    {
      id: 'late_gauntlet',
      family: 'mixed',
      minHeat: 0.68,
      weight: 0.9,
      danger: 3,
      build: (index, startX, heat, groundNpcY) => {
        addLowBar(startX + 90, 106, 14);
        addLaser(startX + 285, 166, index * 0.58);
        addBarrier(startX + 495, 18, 50);
        addTargetNpc(startX + 640, groundNpcY, startX, heat, true);
        addPickupArc(startX + 155, GROUND_COIN_Y, 5, 60, 96);
      },
    },
    {
      id: 'late_rooftop_sprint',
      family: 'jump',
      minHeat: 0.72,
      weight: 0.85,
      danger: 2,
      build: (index, startX) => {
        addLaser(startX + 85, 150, index * 0.5);
        addPlatform(startX + 125, 432, 120);
        addPlatform(startX + 310, 392, 120);
        addPlatform(startX + 495, 354, 120);
        addPlatform(startX + 635, 392, 110);
        addPickupLine(startX + 145, 388, 3, 42);
        addPickupLine(startX + 515, 310, 3, 42);
      },
    },
  ];

  const chooseMapModule = (index: number, heat: number): MapModule => {
    if (index === 0) return mapModules[0];
    if (index === 1) return mapModules[1];
    if (index === 2) return mapModules.find((module) => module.id === 'breather_line') ?? mapModules[0];

    const rhythm = mapRhythmRef.current;
    const allowedDanger = getAllowedDanger(heat);
    const needsRecovery = rhythm.dangerStreak >= 2 || index % 7 === 0;
    const recentIdSet = new Set(rhythm.recentIds);
    const lastFamily = rhythm.recentFamilies[0];
    const heatEligible = mapModules.filter((module) => (
      heat >= module.minHeat
      && heat <= (module.maxHeat ?? 1)
      && module.danger <= allowedDanger
    ));
    let candidates = heatEligible.filter((module) => (
      (!recentIdSet.has(module.id) || heatEligible.length < 6)
      && (!needsRecovery || module.family === 'recovery' || module.danger <= 1)
    ));
    if (candidates.length < 4) {
      candidates = heatEligible.filter((module) => (
        (!recentIdSet.has(module.id) || heatEligible.length < 6)
      ));
    }
    if (candidates.length < 3) {
      candidates = heatEligible;
    }
    if (candidates.length === 0) {
      candidates = mapModules.filter((module) => (
        heat >= module.minHeat
        && heat <= (module.maxHeat ?? 1)
      ));
    }

    const weighted = candidates.map((module) => {
      let weight = module.weight;
      if (module.danger === 2) weight *= 0.45 + heat * 0.9;
      if (module.danger >= 3) weight *= 0.25 + heat * 0.85;
      if (module.family === lastFamily) weight *= 0.22;
      if (needsRecovery && module.family === 'recovery') weight *= 3;
      if (needsRecovery && module.danger === 0) weight *= 2;
      weight *= 0.8 + Math.random() * 0.55;
      return { module, weight };
    });
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    let pick = Math.random() * totalWeight;
    for (const item of weighted) {
      pick -= item.weight;
      if (pick <= 0) return item.module;
    }
    return weighted[weighted.length - 1]?.module ?? mapModules[0];
  };

  const addChunk = (index: number, startX: number) => {
    const heat = getChunkHeat(index);
    const groundNpcY = VIRTUAL_GROUND_Y - 80;
    addDecorativePedestrians(index, startX);

    const module = chooseMapModule(index, heat);
    module.build(index, startX, heat, groundNpcY);

    const rhythm = mapRhythmRef.current;
    rhythm.recentIds = [module.id, ...rhythm.recentIds].slice(0, 5);
    rhythm.recentFamilies = [module.family, ...rhythm.recentFamilies].slice(0, 3);
    rhythm.dangerStreak = module.danger >= 2 ? rhythm.dangerStreak + 1 : 0;
  };

  const ensureGenerated = (virtualWidth: number) => {
    if (!Number.isFinite(virtualWidth) || !Number.isFinite(cameraRef.current.x)) return;
    const aheadX = cameraRef.current.x + virtualWidth + GENERATE_AHEAD;
    if (!Number.isFinite(aheadX)) return;
    let chunksGenerated = 0;
    while (nextChunkXRef.current < aheadX && chunksGenerated < MAX_CHUNKS_PER_GENERATION) {
      addChunk(chunkIndexRef.current, nextChunkXRef.current);
      chunkIndexRef.current++;
      nextChunkXRef.current += CHUNK_LENGTH;
      chunksGenerated++;
    }
  };

  const clearInputState = (stopDash = false) => {
    keysRef.current = {};
    touchInputRef.current = { left: false, right: false, up: false, down: false, action: false, attack: false, interact: false, dash: false };
    pointerActionRef.current = false;
    prevJumpRef.current = false;
    prevActionRef.current = false;
    prevInteractRef.current = false;
    if (stopDash) {
      const p = playerRef.current;
      p.isDashing = false;
      p.dashTime = 0;
    }
  };

  const reconcileModifierKeys = (e: KeyboardEvent) => {
    if (!e.shiftKey) keysRef.current.shift = false;
    if (!e.metaKey) keysRef.current.meta = false;
    if (!e.ctrlKey) keysRef.current.control = false;
    if (!e.altKey) keysRef.current.alt = false;
  };

  useEffect(() => {
    if (gameState === 'PLAYING') resetRun();
  }, [gameState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') {
        clearInputState(true);
        return;
      }
      reconcileModifierKeys(e);
      keysRef.current[e.key.toLowerCase()] = true;
      startIntroJump();
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      keysRef.current[e.key.toLowerCase()] = false;
      reconcileModifierKeys(e);
    };
    const handleFocusBoundary = () => clearInputState(true);
    const handleVisibilityChange = () => {
      if (document.hidden) clearInputState(true);
    };
    const handleFocusIn = (e: FocusEvent) => {
      if (isTypingTarget(e.target)) clearInputState(true);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleFocusBoundary);
    window.addEventListener('focus', handleFocusBoundary);
    window.addEventListener('pagehide', handleFocusBoundary);
    window.addEventListener('focusin', handleFocusIn);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleFocusBoundary);
      window.removeEventListener('focus', handleFocusBoundary);
      window.removeEventListener('pagehide', handleFocusBoundary);
      window.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [gameState]);

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startIntroJump();
    pointerActionRef.current = true;
  };

  useEffect(() => {
    if (!isLoaded) return;
    let animationId: number | null = null;
    let disposed = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const drawImageSafe = (imgKey: string, x: number, y: number, w: number, h: number) => {
      const asset = imagesRef.current[imgKey];
      if (!asset) return;
      if (asset instanceof HTMLImageElement && (!asset.complete || asset.naturalWidth <= 0)) return;
      ctx.drawImage(asset, x, y, w, h);
    };

    const emitParticles = (x: number, y: number, color: string, count: number, size = 5) => {
      for (let i = 0; i < count; i++) {
        if (particlesRef.current.length >= particleLimitRef.current) break;
        particlesRef.current.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 12,
          vy: (Math.random() - 0.5) * 12,
          life: 34 + Math.random() * 18,
          color,
          size: Math.random() * size + 2,
        });
      }
    };

    const getPlayerHitbox = () => {
      const p = playerRef.current;
      const hitHeight = p.isSliding ? 44 : p.height;
      return {
        x: p.x + 8,
        y: p.y + p.height - hitHeight,
        width: p.width - 16,
        height: hitHeight,
      };
    };

    const getPlayerPickupHitbox = () => {
      const hitbox = getPlayerHitbox();
      return {
        x: hitbox.x + 6,
        y: hitbox.y + 5,
        width: Math.max(8, hitbox.width - 12),
        height: Math.max(8, hitbox.height - 10),
      };
    };

    const getItemPickupCircle = (it: Item) => ({
      x: it.x + it.width / 2,
      y: it.y + it.height / 2 + it.floatOffset,
      radius: it.type === 'FISH' ? 11 : 13,
    });

    const damagePlayer = (amount: number, sourceX: number) => {
      const p = playerRef.current;
      if (deathAnimRef.current.active) return;
      if (p.invulnerableTime > 0 || p.isDashing) return;
      if (p.shieldTime > 0) {
        p.shieldTime = 0;
        screenShakeRef.current = 6;
        addFloatingText('SHIELD', p.x, p.y - 20, '#66f2c2', 18);
        playSound('DASH');
        return;
      }
      p.hp = Math.max(0, p.hp - amount);
      p.panic = Math.min(100, p.panic + 25);
      p.invulnerableTime = PLAYER_DAMAGE_INVULN;
      p.vy = Math.min(p.vy, -5);
      statsRef.current.combo = 0;
      statsRef.current.multiplier = 1;
      screenShakeRef.current = 12;
      emitParticles(p.x + p.width / 2, p.y + p.height / 2, '#ff3355', 14, 7);
      if (sourceX < p.x) p.x += 18;
      if (p.hp <= 0) {
        deathAnimRef.current = { active: true, startedAt: Date.now() };
        p.hp = 0;
        p.vx = sourceX < p.x ? 2.6 : -2.6;
        p.vy = DEATH_POP_VY;
        p.isDashing = false;
        p.isSliding = false;
        p.slideTime = 0;
        p.invulnerableTime = DEATH_ANIM_MAX_MS + 500;
        screenShakeRef.current = 18;
        addFloatingText('MISS', p.x + p.width / 2, p.y - 24, '#ff6b8a', 24);
        playSound('DEATH');
        return;
      }
      playSound('DAMAGE');
    };

    const collectItem = (it: Item) => {
      if (it.collected) return;
      const p = playerRef.current;
      it.collected = true;
      playSound('COLLECT');
      if (it.type === 'HEALTH') {
        p.hp = Math.min(p.maxHp, p.hp + COMBAT.HEALTH_PACK_HEAL);
        addFloatingText('HEAL', it.x, it.y, '#66f2c2', 16);
        emitParticles(it.x + 15, it.y + 15, '#66f2c2', 10, 5);
        return;
      }
      if (it.type === 'MAGNET') {
        p.magnetTime = BOOST_TIME;
        awardScore(180, 'MAGNET', it.x, it.y);
        emitParticles(it.x + 15, it.y + 15, '#9ee6ff', 12, 6);
        return;
      }
      if (it.type === 'SHIELD') {
        p.shieldTime = BOOST_TIME;
        awardScore(180, 'SHIELD', it.x, it.y);
        emitParticles(it.x + 15, it.y + 15, '#66f2c2', 12, 6);
        return;
      }
      if (it.type === 'EVIDENCE') {
        statsRef.current.evidence++;
        p.evidenceCollected = statsRef.current.evidence;
        awardScore(1000, 'DATA', it.x, it.y);
        emitParticles(it.x + 15, it.y + 15, '#FFD700', 16, 7);
        return;
      }
      awardScore(90, 'FISH', it.x, it.y);
      emitParticles(it.x + 15, it.y + 15, '#ffe066', 6, 4);
    };

    let lastFrameTime = performance.now();
    const frameInterval = () => 1000 / targetFpsRef.current;
    const scheduleLoop = () => {
      if (
        disposed
        || gameStateRef.current !== 'PLAYING'
        || endedRef.current
        || document.hidden
        || animationId !== null
      ) return;
      animationId = requestAnimationFrame(loop);
    };
    const resumeLoop = () => {
      if (document.hidden) {
        isTabVisibleRef.current = false;
        if (animationId !== null) {
          cancelAnimationFrame(animationId);
          animationId = null;
        }
        return;
      }
      isTabVisibleRef.current = true;
      lastFrameTime = performance.now();
      scheduleLoop();
    };

    const loop = (now: number) => {
      animationId = null;
      if (disposed) return;
      if (!isTabVisibleRef.current) {
        lastFrameTime = now;
        return;
      }
      const deltaMs = now - lastFrameTime;
      if (deltaMs < frameInterval()) {
        scheduleLoop();
        return;
      }
      // R2: cap delta so a single physics step can't tunnel through thin obstacles
      // (AABB is single-frame, no sweep). 33ms ≈ dtScale 2; full sub-stepping is a follow-up.
      const clampedDelta = Math.min(deltaMs, 33);
      const dtScale = clampedDelta / BASE_FRAME_MS;
      lastFrameTime = now;
      update(dtScale);
      syncNpcChatAnchor();
      draw();
      scheduleLoop();
    };

    const update = (dtScale: number) => {
      if (endedRef.current) return;
      const p = playerRef.current;
      const stats = statsRef.current;
      const keys = keysRef.current;
      const touch = touchInputRef.current;
      const virtualWidth = getVirtualWidth(dims.width, dims.height);
      const now = Date.now();

      if (introDropRef.current.phase !== 'done') {
        ensureGenerated(virtualWidth);
        const anyTouchInput = touch.up || touch.down || touch.left || touch.right || touch.action || touch.attack || touch.interact || touch.dash;
        const anyKeyInput = Object.values(keys).some(Boolean);
        const pointerAction = pointerActionRef.current;
        pointerActionRef.current = false;

        if (introDropRef.current.phase === 'waiting') {
          cameraRef.current.x = getIntroCameraX(virtualWidth);
          if (anyTouchInput || anyKeyInput || pointerAction) startIntroJump();
          particlesRef.current.forEach((part) => { part.x += part.vx * dtScale; part.y += part.vy * dtScale; part.life -= dtScale; });
          particlesRef.current = particlesRef.current.filter((part) => part.life > 0);
          floatingTextsRef.current.forEach((ft) => { ft.y += ft.vy * dtScale; ft.life -= dtScale; });
          floatingTextsRef.current = floatingTextsRef.current.filter((ft) => ft.life > 0);
          return;
        }

        const introProgress = Math.min(1, (now - introDropRef.current.startedAt) / INTRO_DROP_DURATION_MS);
        const moveEase = smoothstep(introProgress);
        const cameraEase = easeInOutCubic(introProgress);
        const landingY = VIRTUAL_GROUND_Y - p.height;
        const targetCamX = getRunCameraX(RUN_START_X, virtualWidth);
        p.x = lerp(INTRO_DROP_START_X, RUN_START_X, moveEase);
        p.y = lerp(INTRO_DROP_START_Y, landingY, moveEase) - Math.sin(introProgress * Math.PI) * INTRO_DROP_ARC_HEIGHT;
        p.vx = 0;
        p.vy = 0;
        p.direction = 1;
        p.isGrounded = false;
        p.isDashing = false;
        p.isSliding = false;
        cameraRef.current.x = lerp(introDropRef.current.startCameraX, targetCamX, cameraEase);

        particlesRef.current.forEach((part) => { part.x += part.vx * dtScale; part.y += part.vy * dtScale; part.life -= dtScale; });
        particlesRef.current = particlesRef.current.filter((part) => part.life > 0);
        floatingTextsRef.current.forEach((ft) => { ft.y += ft.vy * dtScale; ft.life -= dtScale; });
        floatingTextsRef.current = floatingTextsRef.current.filter((ft) => ft.life > 0);

        if (introProgress >= 1) {
          p.x = RUN_START_X;
          p.y = landingY;
          p.isGrounded = true;
          introDropRef.current = { phase: 'done', startedAt: 0, startCameraX: targetCamX };
          cameraRef.current.x = targetCamX;
          emitParticles(p.x + p.width / 2, VIRTUAL_GROUND_Y - 6, '#dbeafe', 10, 4);
        }
        return;
      }

      if (deathAnimRef.current.active) {
        p.isDashing = false;
        p.isSliding = false;
        p.isGrounded = false;
        p.vy += GRAVITY * dtScale;
        p.y += p.vy * dtScale;
        p.x += p.vx * dtScale;
        p.vx *= Math.pow(0.985, dtScale);
        p.invulnerableTime = Math.max(p.invulnerableTime, 250);

        carsRef.current.forEach((car) => {
          if (car.occupied) return;
          const targetTrafficVx = car.cruiseVx + Math.sin(now / 650 + car.speedPhase) * car.speedPulse;
          car.vx += (targetTrafficVx - car.vx) * 0.035 * dtScale;
          car.x += car.vx * dtScale;
        });
        particlesRef.current.forEach((part) => { part.x += part.vx * dtScale; part.y += part.vy * dtScale; part.life -= dtScale; });
        particlesRef.current = particlesRef.current.filter((part) => part.life > 0);
        floatingTextsRef.current.forEach((ft) => { ft.y += ft.vy * dtScale; ft.life -= dtScale; });
        floatingTextsRef.current = floatingTextsRef.current.filter((ft) => ft.life > 0);
        if (screenShakeRef.current > 0) screenShakeRef.current = Math.max(0, screenShakeRef.current - 1.2 * dtScale);

        const viewLeft = cameraRef.current.x - CLEAN_BEHIND;
        const viewRight = cameraRef.current.x + virtualWidth + CLEAN_BEHIND;
        carsRef.current = carsRef.current.filter((o) => o.x + o.width > viewLeft && o.x < viewRight);

        const elapsed = now - deathAnimRef.current.startedAt;
        if (elapsed > DEATH_ANIM_MAX_MS || p.y > BASE_HEIGHT + 180) endRun();
        return;
      }

      ensureGenerated(virtualWidth);
      spawnRandomTraffic(now);

      const isTextInputActive = isTypingTarget(document.activeElement);
      const jumpPressed = !isTextInputActive && (keys['arrowup'] || keys['w'] || keys[' '] || touch.up);
      const slidePressed = !isTextInputActive && (keys['arrowdown'] || keys['s'] || touch.down);
      const interactPressed = !isTextInputActive && (keys['e'] || touch.interact);
      const pointerAction = pointerActionRef.current;
      pointerActionRef.current = false;
      const actionPressed = !isTextInputActive && (keys['f'] || touch.action || touch.attack || pointerAction);
      const jumpEdge = jumpPressed && !prevJumpRef.current;
      const actionEdge = actionPressed && !prevActionRef.current;
      const interactEdge = interactPressed && !prevInteractRef.current;
      prevJumpRef.current = jumpPressed;
      prevActionRef.current = actionPressed;
      prevInteractRef.current = interactPressed;

      const heat = getDistanceHeat(stats.distance);
      const ridingCar = carsRef.current.find((car) => car.occupied);
      if (p.dashCooldown > 0) p.dashCooldown = Math.max(0, p.dashCooldown - 16 * dtScale);
      if (p.dashTime > 0) p.dashTime = Math.max(0, p.dashTime - 16 * dtScale);
      else if (p.isDashing) p.isDashing = false;
      if (p.invulnerableTime > 0) p.invulnerableTime = Math.max(0, p.invulnerableTime - 16 * dtScale);
      if (p.magnetTime > 0) p.magnetTime = Math.max(0, p.magnetTime - 16 * dtScale);
      if (p.shieldTime > 0) p.shieldTime = Math.max(0, p.shieldTime - 16 * dtScale);
      if (p.slideTime > 0) p.slideTime = Math.max(0, p.slideTime - 16 * dtScale);
      p.isSliding = p.slideTime > 0 || (slidePressed && p.isGrounded);
      const prevY = p.y;

      if (isTextInputActive) {
        p.vx = 0;
        p.isDashing = false;
        p.dashTime = 0;
        p.isSliding = false;
        p.slideTime = 0;
      }

      if (ridingCar) {
        ridingCar.vx = CAR_CRUISE_SPEED;
        ridingCar.x += ridingCar.vx * dtScale;
        p.x = ridingCar.x + ridingCar.width * 0.5 - p.width / 2;
        p.y = ridingCar.y - p.height + 14;
        p.vx = ridingCar.vx;
        p.vy = 0;
        p.isGrounded = true;
        p.isDashing = false;
        p.isSliding = false;
        if (ridingCar.x >= ridingCar.rideUntilX) {
          ridingCar.occupied = false;
          ridingCar.used = true;
          ridingCar.vx = ridingCar.cruiseVx;
          p.y = ridingCar.y - p.height;
          p.vx = ridingCar.cruiseVx;
          p.invulnerableTime = Math.max(p.invulnerableTime, 450);
          awardScore(620, 'TAXI RIDE', p.x, p.y - 20);
          addFloatingText('下车', p.x + p.width / 2, p.y - 28, '#9ee6ff', 18);
        }
      } else {
      if (!isTextInputActive && (keys['shift'] || touch.dash) && p.dashCooldown <= 0 && !p.isDashing) {
        p.isDashing = true;
        p.dashTime = DASH_DURATION;
        p.dashCooldown = DASH_COOLDOWN;
        p.vy = 0;
        playSound('DASH');
      }

      const horizontalInput = isTextInputActive ? 0 : (keys['arrowright'] || keys['d'] || touch.right ? 1 : 0) - (keys['arrowleft'] || keys['a'] || touch.left ? 1 : 0);
      if (horizontalInput !== 0) p.direction = horizontalInput > 0 ? 1 : -1;
      if (p.isDashing) {
        p.vx = p.direction * DASH_SPEED;
      } else {
        p.vx += horizontalInput * MANUAL_ACCEL * dtScale;
        p.vx *= p.isGrounded ? GROUND_FRICTION : AIR_FRICTION;
        p.vx = Math.max(-MAX_MANUAL_SPEED, Math.min(MAX_MANUAL_SPEED, p.vx));
        if (horizontalInput === 0 && Math.abs(p.vx) < 0.08) p.vx = 0;
      }
      if (!p.isDashing) p.vy += GRAVITY * dtScale;

      if (jumpEdge && p.isGrounded && !p.isSliding) {
        p.vy = JUMP_FORCE;
        p.isGrounded = false;
        playSound('JUMP');
      }
      if (slidePressed && p.isGrounded) p.slideTime = 520;

      p.x += p.vx * dtScale;
      const leftWallX = leftAirWallXRef.current;
      if (p.x < leftWallX) {
        p.x = leftWallX;
        p.vx = Math.max(0, p.vx);
        p.isDashing = false;
        p.dashTime = 0;
      }
      p.y += p.vy * dtScale;
      }
      if (ridingCar) {
        p.isGrounded = true;
      } else {
        p.isGrounded = false;
        if (p.y + p.height > VIRTUAL_GROUND_Y) {
          p.y = VIRTUAL_GROUND_Y - p.height;
          p.vy = 0;
          p.isGrounded = true;
        }
        platformsRef.current.forEach((plat) => {
          const overlapsX = p.x + p.width > plat.x && p.x < plat.x + plat.width;
          if (plat.type === 'FLOOR' && overlapsX && prevY + p.height <= plat.y && p.y + p.height >= plat.y && p.vy >= 0) {
            p.y = plat.y - p.height;
            p.vy = 0;
            p.isGrounded = true;
          }
        });
      }
      let boardingCar: RideableCar | null = null;
      carsRef.current.forEach((car) => {
        if (car.occupied) return;
        const targetTrafficVx = car.cruiseVx + Math.sin(now / 650 + car.speedPhase) * car.speedPulse;
        car.vx += (targetTrafficVx - car.vx) * 0.035 * dtScale;
        car.x += car.vx * dtScale;
        if (ridingCar || !car.canRide || car.used) return;
        if (rectsOverlap(getPlayerHitbox(), getTaxiBoardingZone(car))) {
          boardingCar = car;
        }
        const carTopY = car.y;
        const overlapsX = p.x + p.width > car.x + 12 && p.x < car.x + car.width - 12;
        if (overlapsX && prevY + p.height <= carTopY + 12 && p.y + p.height >= carTopY && p.vy >= 0) {
          p.y = carTopY - p.height;
          p.vy = 0;
          p.isGrounded = true;
          boardingCar = car;
        }
      });
      if (boardingCar && boardingCar.canRide && !boardingCar.used && (interactEdge || slidePressed)) {
        boardingCar.occupied = true;
        boardingCar.vx = CAR_CRUISE_SPEED;
        boardingCar.rideUntilX = boardingCar.x + CAR_RIDE_DISTANCE;
        p.x = boardingCar.x + boardingCar.width * 0.5 - p.width / 2;
        p.y = boardingCar.y - p.height + 14;
        p.vx = CAR_CRUISE_SPEED;
        p.vy = 0;
        p.isSliding = false;
        p.isDashing = false;
        stats.taxiRides++;
        const taxiText = stats.taxiRides >= TAXI_FREERIDE_THRESHOLD ? '白嫖达成' : `搭上出租车 ${stats.taxiRides}/${TAXI_FREERIDE_THRESHOLD}`;
        addFloatingText(taxiText, p.x + p.width / 2, p.y - 28, '#66f2c2', 18);
        playSound('COLLECT');
      }
      const activeRide = carsRef.current.some((car) => car.occupied);
      const playerHitbox = getPlayerHitbox();
      const nearbyMikuIds = new Set(
        npcsRef.current
          .filter((npc) => !npc.scanned && npc.chatKind === 'miku' && rectsOverlap(playerHitbox, getNpcTalkZone(npc)))
          .map((npc) => npc.id)
      );
      // I7: deleting the current element during Set.forEach is defined behavior per spec
      // (deletes of already-visited elements are no-ops; unvisited ones are skipped).
      mikuProximityRef.current.forEach((id) => {
        if (!nearbyMikuIds.has(id)) mikuProximityRef.current.delete(id);
      });

      if (!activeRide && !boardingCar && !activeNpcChatTarget) {
        const autoTalkMiku = npcsRef.current
          .filter((npc) => !npc.scanned && npc.chatKind === 'miku' && !dismissedMikuIds?.has(npc.id) && nearbyMikuIds.has(npc.id) && !mikuProximityRef.current.has(npc.id))
          .sort((a, b) => Math.abs(a.x + a.width / 2 - (p.x + p.width / 2)) - Math.abs(b.x + b.width / 2 - (p.x + p.width / 2)))[0];
        if (autoTalkMiku) {
          mikuProximityRef.current.add(autoTalkMiku.id);
          p.vx = 0;
          p.isDashing = false;
          p.isSliding = false;
          addFloatingText('CHAT?', autoTalkMiku.x + autoTalkMiku.width / 2, autoTalkMiku.y - 38, '#67e8f9', 16);
          openNpcChat(autoTalkMiku);
          return;
        }
      }

      if (!activeRide && !boardingCar && interactEdge) {
        const talkNpc = npcsRef.current
          .filter((npc) => !npc.scanned && npc.chatKind === 'miku' && rectsOverlap(playerHitbox, getNpcTalkZone(npc)))
          .sort((a, b) => Math.abs(a.x + a.width / 2 - (p.x + p.width / 2)) - Math.abs(b.x + b.width / 2 - (p.x + p.width / 2)))[0];
        if (talkNpc) {
          p.vx = 0;
          p.isDashing = false;
          p.isSliding = false;
          addFloatingText('TALK', talkNpc.x + talkNpc.width / 2, talkNpc.y - 38, '#9ee6ff', 16);
          openNpcChat(talkNpc);
          return;
        }
        const talkPedestrian = pedestriansRef.current
          .filter((ped) => rectsOverlap(playerHitbox, getNpcTalkZone(ped)))
          .sort((a, b) => Math.abs(a.x + a.width / 2 - (p.x + p.width / 2)) - Math.abs(b.x + b.width / 2 - (p.x + p.width / 2)))[0];
        if (talkPedestrian) {
          p.vx = 0;
          p.isDashing = false;
          p.isSliding = false;
          addFloatingText('TALK', talkPedestrian.x + talkPedestrian.width / 2, talkPedestrian.y - 34, '#9ee6ff', 16);
          openPedestrianChat(talkPedestrian);
          return;
        }
      }

      const previousDistance = stats.distance;
      stats.distance = Math.max(stats.distance, p.x - RUN_START_X);
      if (stats.distance > previousDistance) {
        stats.score += ((stats.distance - previousDistance) / PIXELS_PER_METER) * (18 + heat * 20);
      }
      if (stats.combo > 0 && now - stats.lastComboAt > COMBO_WINDOW_MS) {
        stats.combo = 0;
        stats.multiplier = 1;
      }

      if (p.attackCooldown > 0) p.attackCooldown = Math.max(0, p.attackCooldown - 16 * dtScale);
      if (!activeRide && actionEdge && p.attackCooldown <= 0) {
        const projectileSpeed = PROJECTILE_SPEED + heat * 4;
        if (projectilesRef.current.length >= projectileLimitRef.current) projectilesRef.current.shift();
        projectilesRef.current.push({
          x: p.x + (p.direction === 1 ? p.width : 0),
          y: p.y + p.height * 0.45,
          vx: p.direction * projectileSpeed,
          life: PROJECTILE_MAX_RANGE / projectileSpeed,
          color: COLORS.projectile,
        });
        p.attackCooldown = COMBAT.SHOOT_COOLDOWN;
        playSound('SHOOT');
      }

      const hitbox = playerHitbox;

      if (!activeRide) obstaclesRef.current.forEach((obstacle) => {
        if (!obstacle.passed && p.x > obstacle.x + obstacle.width) {
          obstacle.passed = true;
          if (Math.abs(hitbox.y + hitbox.height - (obstacle.y + obstacle.height)) < 70) {
            stats.nearMisses++;
            awardScore(180, 'NEAR', obstacle.x, obstacle.y - 12);
          }
        }
        if (rectsOverlap(hitbox, obstacle)) {
          damagePlayer(obstacle.damage, obstacle.x + obstacle.width / 2);
          obstacle.passed = true;
        }
      });

      if (!activeRide) hazardsRef.current.forEach((hazard) => {
        if (!hazard.passed && p.x > hazard.x + hazard.width) {
          hazard.passed = true;
          if (hitbox.y + hitbox.height > hazard.y - 46) {
            stats.nearMisses++;
            awardScore(220, 'NEAR', hazard.x, hazard.y - 10);
          }
        }
        if (isHazardActive(hazard, now) && rectsOverlap(hitbox, hazard)) {
          damagePlayer(hazard.damage, hazard.x + hazard.width / 2);
          hazard.passed = true;
        }
      });

      npcsRef.current.forEach((n) => {
        if (n.damageCooldown > 0) n.damageCooldown = Math.max(0, n.damageCooldown - 16 * dtScale);
        if (!n.scanned) {
          const isPausedForMikuChat = activeConversationTarget?.type === 'npc' && activeConversationTarget.kind === 'miku' && activeConversationTarget.id === n.id;
          if (!isPausedForMikuChat) {
            n.x += n.vx * dtScale;
            if (n.x < n.patrolStart) { n.x = n.patrolStart; n.vx = Math.abs(n.vx); }
            if (n.x + n.width > n.patrolEnd) { n.x = n.patrolEnd - n.width; n.vx = -Math.abs(n.vx); }
          }
          const facing = n.vx >= 0 ? 1 : -1;
          const npcEyeX = facing === 1 ? n.x + n.width : n.x;
          const npcEyeY = n.y + n.height * 0.45;
          const forwardDistance = facing === 1 ? hitbox.x + hitbox.width / 2 - npcEyeX : npcEyeX - (hitbox.x + hitbox.width / 2);
          const verticalDistance = Math.abs(hitbox.y + hitbox.height / 2 - npcEyeY);
          const canSeePlayer = !activeRide && forwardDistance > -15 && forwardDistance < n.visionRange && verticalDistance < n.visionHeight / 2 && !p.isDashing;
          if (canSeePlayer) {
            n.alertLevel = Math.min(100, n.alertLevel + (1.35 + heat * 0.8) * dtScale);
            p.panic = Math.min(100, p.panic + 0.9 * dtScale);
            if (n.alertLevel >= 58 && n.damageCooldown <= 0) {
              damagePlayer(COMBAT.ALERT_DAMAGE, n.x + n.width / 2);
              n.damageCooldown = NPC_PULSE_COOLDOWN;
            }
          } else {
            n.alertLevel = Math.max(0, n.alertLevel - 0.9 * dtScale);
          }
          if (!n.chatKind && !activeRide && rectsOverlap(hitbox, n)) damagePlayer(COMBAT.CONTACT_DAMAGE, n.x + n.width / 2);
        }
      });
      p.panic = Math.max(0, p.panic - 0.35 * dtScale);

      pedestriansRef.current.forEach((ped) => {
        ped.x += ped.vx * dtScale;
        if (ped.x < ped.patrolStart) {
          ped.x = ped.patrolStart;
          ped.vx = Math.abs(ped.vx);
        }
        if (ped.x + ped.width > ped.patrolEnd) {
          ped.x = ped.patrolEnd - ped.width;
          ped.vx = -Math.abs(ped.vx);
        }
      });

      projectilesRef.current.forEach((pr) => {
        if (pr.life <= 0) return; // R4: don't move/iterate an already-dead projectile
        pr.x += pr.vx * dtScale;
        pr.life -= dtScale;
        if (pr.life <= 0) return;
        npcsRef.current.forEach((n) => {
          if (n.scanned || n.chatKind || pr.life <= 0) return;
          if (pr.x > n.x && pr.x < n.x + n.width && pr.y > n.y && pr.y < n.y + n.height) {
            n.scanHits++;
            pr.life = 0;
            playSound('HIT');
            emitParticles(n.x + n.width / 2, n.y + n.height / 2, n.isTarget ? '#FFD700' : '#FF69B4', 10, 6);
            if (n.scanHits >= n.maxScanHits) {
              n.scanned = true;
              n.alertLevel = 0;
              stats.scans++;
              awardScore(n.isTarget ? 700 : 240, n.isTarget ? 'SCAN TARGET' : 'SCAN', n.x, n.y - 8);
              if (n.isTarget) addPickup(n.x + n.width / 2 - 15, n.y + 10, 'EVIDENCE');
            } else {
              n.alertLevel = Math.min(100, n.alertLevel + 24);
            }
          }
        });
      });
      projectilesRef.current = projectilesRef.current.filter((pr) => pr.life > 0);

      itemsRef.current.forEach((it) => {
        it.floatOffset = Math.sin(now / 200 + it.id) * 8;
        const itemCircle = getItemPickupCircle(it);
        const pickupHitbox = getPlayerPickupHitbox();
        if (p.magnetTime > 0 && !it.collected) {
          const targetX = pickupHitbox.x + pickupHitbox.width / 2;
          const targetY = pickupHitbox.y + pickupHitbox.height / 2;
          const dx = targetX - itemCircle.x;
          const dy = targetY - itemCircle.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 230 && dist > 1) {
            const pull = Math.min(0.18 * dtScale, 0.42);
            it.x += dx * pull;
            it.y += dy * pull;
          }
        }
        if (!it.collected && circleRectOverlap(getItemPickupCircle(it), pickupHitbox)) collectItem(it);
      });
      itemsRef.current = itemsRef.current.filter((it) => !it.collected);

      particlesRef.current.forEach((part) => { part.x += part.vx * dtScale; part.y += part.vy * dtScale; part.life -= dtScale; });
      particlesRef.current = particlesRef.current.filter((part) => part.life > 0);
      floatingTextsRef.current.forEach((ft) => { ft.y += ft.vy * dtScale; ft.life -= dtScale; });
      floatingTextsRef.current = floatingTextsRef.current.filter((ft) => ft.life > 0);
      if (screenShakeRef.current > 0) screenShakeRef.current = Math.max(0, screenShakeRef.current - 1.2 * dtScale);

      const cleanupLeft = Math.max(RUN_START_X - 120, cameraRef.current.x - CLEAN_FAR_BEHIND);
      const viewRight = cameraRef.current.x + virtualWidth + CLEAN_BEHIND;
      if (cleanupLeft > RUN_START_X - 120) {
        leftAirWallXRef.current = Math.max(
          leftAirWallXRef.current,
          cleanupLeft + virtualWidth * AIR_WALL_CAMERA_SAFE_RATIO,
        );
      }
      platformsRef.current = platformsRef.current.filter((o) => o.x + o.width > cleanupLeft);
      hazardsRef.current = hazardsRef.current.filter((o) => o.x + o.width > cleanupLeft);
      obstaclesRef.current = obstaclesRef.current.filter((o) => o.x + o.width > cleanupLeft);
      pedestriansRef.current = pedestriansRef.current.filter((o) => o.x + o.width > cleanupLeft);
      carsRef.current = carsRef.current.filter((o) => o.occupied || (o.x + o.width > cleanupLeft && o.x < viewRight));
      npcsRef.current = npcsRef.current.filter((o) => o.x + o.width > cleanupLeft);
      itemsRef.current = itemsRef.current.filter((o) => o.x + o.width > cleanupLeft);

      const minCameraX = Math.max(0, leftAirWallXRef.current - virtualWidth * AIR_WALL_CAMERA_SAFE_RATIO);
      const targetCamX = Math.max(minCameraX, getRunCameraX(p.x, virtualWidth));
      cameraRef.current.x += (targetCamX - cameraRef.current.x) * (0.16 * dtScale);
    };

    const drawPlaceholderNpc = (n: NPC, now: number) => {
      const centerX = n.x + n.width / 2;
      const bodyColor = n.scanned ? '#66f2c2' : n.type === NpcType.LEADER ? '#ff9f1c' : n.isTarget ? '#ffd166' : '#94a3b8';
      const accentColor = n.scanned ? '#103c35' : n.isTarget ? '#111827' : '#0f172a';
      ctx.save();
      ctx.translate(centerX, n.y);
      if (n.scanned) {
        ctx.fillStyle = 'rgba(102, 242, 194, 0.22)';
        ctx.beginPath();
        ctx.arc(0, n.height / 2, n.width * 0.72, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        ctx.arc(0, 25, 17, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(-16, 42, 32, 28);
        ctx.strokeStyle = '#0d5c4c';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(18, 55, 16, -Math.PI / 3, Math.PI / 1.5);
        ctx.stroke();
        ctx.restore();
        return;
      }
      if (n.spriteKey) {
        const isPausedForMikuChat = activeConversationTarget?.type === 'npc' && activeConversationTarget.kind === 'miku' && activeConversationTarget.id === n.id;
        const spriteKey = isPausedForMikuChat
          ? n.spriteKey
          : n.spriteKey.startsWith('decor_npc_v2_')
          ? `decor_npc_v2_${Math.floor(now / 130) % 8}`
          : n.spriteKey.startsWith('decor_npc_')
            ? `decor_npc_${Math.floor(now / 130) % 4}`
            : n.spriteKey;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(0, n.height + 5, n.width * 0.52, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        if (n.vx > 0) ctx.scale(-1, 1);
        drawImageSafe(spriteKey, -n.width / 2, 0, n.width, n.height);
        ctx.restore();
        ctx.restore();
        return;
      }
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(0, n.height + 5, n.width * 0.52, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = bodyColor;
      ctx.strokeStyle = n.type === NpcType.LEADER ? '#7c2d12' : '#334155';
      ctx.lineWidth = 3;
      ctx.fillRect(-n.width / 2 + 5, 18, n.width - 10, n.height - 22);
      ctx.strokeRect(-n.width / 2 + 5, 18, n.width - 10, n.height - 22);
      ctx.fillStyle = accentColor;
      ctx.fillRect(-n.width / 2 + 10, 29, n.width - 20, 12);
      ctx.fillStyle = '#00f5ff';
      ctx.fillRect(n.vx >= 0 ? 2 : -16, 32, 14, 5);
      if (n.type === NpcType.LEADER) {
        ctx.fillStyle = '#ff214f';
        ctx.fillRect(-18, 48, 36, 9);
      }
      ctx.restore();
    };

    const draw = () => {
      const scale = Math.max(MIN_VIEWPORT_HEIGHT, dims.height) / BASE_HEIGHT;
      const virtualWidth = getVirtualWidth(dims.width, dims.height);
      const camX = cameraRef.current.x;
      const shake = screenShakeRef.current > 0 ? (Math.random() - 0.5) * screenShakeRef.current : 0;
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(shake, shake * 0.35);
      const skyGradient = ctx.createLinearGradient(0, 0, 0, BASE_HEIGHT);
      skyGradient.addColorStop(0, '#0b1228');
      skyGradient.addColorStop(0.65, '#0f1b2f');
      skyGradient.addColorStop(1, '#101725');
      ctx.fillStyle = skyGradient;
      ctx.fillRect(-20, -20, virtualWidth + 40, BASE_HEIGHT + 40);
      ctx.fillStyle = 'rgba(20, 40, 72, 0.35)';
      for (let i = -2; i < 12; i++) {
        const x = i * 220 - ((camX * 0.12) % 220);
        const h = 80 + ((i % 3 + 3) % 3) * 28;
        ctx.fillRect(x, 390 - h, 140, h);
      }

      const dLayers = layerDimsRef.current;
      const now = Date.now();
      for (const k of LAYER_ORDER) {
        if (k === 'tree') continue;
        const d = dLayers[k];
        if (!d) continue;
        const factor = PARALLAX_SPEEDS[k];
        const offsetX = (-(camX * factor)) % d.w;
        drawImageSafe(k, offsetX, 0, d.w, d.h);
        if (offsetX + d.w < virtualWidth) drawImageSafe(k, offsetX + d.w, 0, d.w, d.h);
        if (offsetX > 0) drawImageSafe(k, offsetX - d.w, 0, d.w, d.h);
      }

      const viewLeft = camX - 120;
      const viewRight = camX + virtualWidth + 160;
      ctx.save();
      ctx.translate(-Math.floor(camX), 0);

      pedestriansRef.current.forEach((ped) => {
        if (ped.x + ped.width < viewLeft || ped.x > viewRight) return;
        const frameCount = ped.spriteSet === 'npc' ? 4 : 8;
        const frame = Math.floor((now + ped.frameOffset) / 130) % frameCount;
        const spriteKey = ped.spriteSet === 'npc' ? `decor_npc_${frame}` : `decor_npc_v2_${frame}`;
        ctx.save();
        ctx.globalAlpha = 0.88;
        ctx.translate(Math.floor(ped.x + ped.width / 2), Math.floor(ped.y + ped.height / 2));
        if (ped.vx > 0) ctx.scale(-1, 1);
        drawImageSafe(spriteKey, -ped.width / 2, -ped.height / 2, ped.width, ped.height);
        ctx.restore();
        if (rectsOverlap(getPlayerHitbox(), getNpcTalkZone(ped))) {
          ctx.save();
          ctx.textAlign = 'center';
          ctx.font = 'bold 12px monospace';
          ctx.fillStyle = '#9ee6ff';
          ctx.fillText('E 对话', ped.x + ped.width / 2, ped.y - 14 + Math.sin(now / 180) * 3);
          ctx.restore();
        }
      });

      platformsRef.current.forEach((plat) => {
        if (plat.x + plat.width < viewLeft || plat.x > viewRight) return;
        ctx.fillStyle = 'rgba(41, 220, 220, 0.28)';
        ctx.strokeStyle = 'rgba(130, 255, 255, 0.75)';
        ctx.lineWidth = 2;
        ctx.fillRect(plat.x, plat.y, plat.width, plat.height);
        ctx.strokeRect(plat.x, plat.y, plat.width, plat.height);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(plat.x + 4, plat.y + 3, plat.width - 8, 2);
      });

      hazardsRef.current.forEach((hazard) => {
        if (hazard.x + hazard.width < viewLeft || hazard.x > viewRight) return;
        const active = isHazardActive(hazard, now);
        ctx.save();
        ctx.globalAlpha = active ? 0.95 : 0.22;
        ctx.fillStyle = active ? '#ff214f' : '#7b2538';
        ctx.shadowColor = active ? '#ff214f' : 'transparent';
        ctx.shadowBlur = active ? 18 : 0;
        ctx.fillRect(hazard.x, hazard.y, hazard.width, hazard.height);
        ctx.shadowBlur = 0;
        ctx.fillStyle = active ? '#ffd1dc' : '#915265';
        ctx.beginPath();
        ctx.arc(hazard.x, hazard.y + hazard.height / 2, 8, 0, Math.PI * 2);
        ctx.arc(hazard.x + hazard.width, hazard.y + hazard.height / 2, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      obstaclesRef.current.forEach((obstacle) => {
        if (obstacle.x + obstacle.width < viewLeft || obstacle.x > viewRight) return;
        if (obstacle.type === 'BARRIER') {
          ctx.fillStyle = '#f97316';
          ctx.strokeStyle = '#fed7aa';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(obstacle.x, obstacle.y + obstacle.height);
          ctx.lineTo(obstacle.x + obstacle.width / 2, obstacle.y);
          ctx.lineTo(obstacle.x + obstacle.width, obstacle.y + obstacle.height);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          const pulse = 0.5 + Math.sin(now / 150 + obstacle.x * 0.01) * 0.5;
          ctx.shadowColor = '#f0abfc';
          ctx.shadowBlur = 5 + pulse * 8;
          ctx.fillStyle = '#7c3aed';
          ctx.strokeStyle = '#fde047';
          ctx.lineWidth = 3;
          ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
          ctx.strokeRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(253,224,71,0.72)';
          for (let stripeX = obstacle.x - obstacle.height; stripeX < obstacle.x + obstacle.width; stripeX += 18) {
            ctx.beginPath();
            ctx.moveTo(stripeX, obstacle.y + obstacle.height);
            ctx.lineTo(stripeX + 10, obstacle.y + obstacle.height);
            ctx.lineTo(stripeX + obstacle.height + 10, obstacle.y);
            ctx.lineTo(stripeX + obstacle.height, obstacle.y);
            ctx.closePath();
            ctx.fill();
          }
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.fillRect(obstacle.x + 8, obstacle.y + 7, obstacle.width - 16, 3);
          ctx.fillStyle = '#fff7ed';
          ctx.font = 'bold 18px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('!', obstacle.x + obstacle.width / 2, obstacle.y + 21);
          ctx.fillStyle = '#fde047';
          ctx.font = 'bold 10px monospace';
          ctx.fillText('危险', obstacle.x + obstacle.width / 2, obstacle.y - 8 + Math.sin(now / 180) * 2);
        }
      });

      npcsRef.current.forEach((n) => {
        if (n.scanned || n.x + n.width < viewLeft - n.visionRange || n.x > viewRight + n.visionRange) return;
        const facing = n.vx >= 0 ? 1 : -1;
        const eyeX = facing === 1 ? n.x + n.width : n.x;
        const eyeY = n.y + n.height * 0.45;
        const farX = eyeX + facing * n.visionRange;
        const halfHeight = n.visionHeight / 2;
        ctx.fillStyle = `rgba(255, ${Math.max(60, 210 - n.alertLevel)}, 50, ${0.08 + (n.alertLevel / 100) * 0.28})`;
        ctx.beginPath();
        ctx.moveTo(eyeX, eyeY);
        ctx.lineTo(farX, eyeY - halfHeight);
        ctx.lineTo(farX, eyeY + halfHeight);
        ctx.closePath();
        ctx.fill();
      });

      npcsRef.current.forEach((n) => {
        if (n.x + n.width < viewLeft || n.x > viewRight) return;
        drawPlaceholderNpc(n, now);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = n.isTarget ? '#FFD700' : '#b6c5d6';
        ctx.fillText(n.scanned ? '已猫化' : n.label, n.x + n.width / 2, n.y - 24);
        if (!n.scanned && n.chatKind === 'miku' && rectsOverlap(getPlayerHitbox(), getNpcTalkZone(n))) {
          ctx.fillStyle = '#67e8f9';
          ctx.font = 'bold 12px monospace';
          ctx.fillText('想聊天', n.x + n.width / 2, n.y - 38 + Math.sin(now / 180) * 3);
        }
        if (!n.scanned) {
          const pipStart = n.x + n.width / 2 - (n.maxScanHits * 9) / 2 + 4;
          for (let i = 0; i < n.maxScanHits; i++) {
            ctx.fillStyle = i < n.scanHits ? '#00ffff' : 'rgba(255,255,255,0.22)';
            ctx.beginPath();
            ctx.arc(pipStart + i * 9, n.y - 13, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          if (n.alertLevel > 1) {
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(n.x - 4, n.y - 7, n.width + 8, 5);
            ctx.fillStyle = '#ff3355';
            ctx.fillRect(n.x - 4, n.y - 7, (n.width + 8) * (n.alertLevel / 100), 5);
          }
        }
        ctx.restore();
      });

      itemsRef.current.forEach((it) => {
        if (it.x + it.width < viewLeft || it.x > viewRight) return;
        ctx.textAlign = 'left';
        const label = it.type === 'HEALTH' ? '+' : it.type === 'MAGNET' ? 'M' : it.type === 'SHIELD' ? 'S' : it.type === 'EVIDENCE' ? 'D' : '•';
        ctx.fillStyle = it.type === 'HEALTH' ? '#00cc88' : it.type === 'MAGNET' ? '#9ee6ff' : it.type === 'SHIELD' ? '#66f2c2' : it.type === 'EVIDENCE' ? COLORS.evidence : '#ffe066';
        ctx.font = 'bold 24px monospace';
        ctx.beginPath();
        ctx.arc(it.x + 15, it.y + 15 + it.floatOffset, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#07111f';
        ctx.textAlign = 'center';
        ctx.fillText(label, it.x + 15, it.y + 23 + it.floatOffset);
      });

      projectilesRef.current.forEach((pr) => {
        if (pr.x < viewLeft || pr.x > viewRight) return;
        ctx.fillStyle = pr.color;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, 8, 0, Math.PI * 2);
        ctx.fill();
      });

      const pl = playerRef.current;
      const playerInCar = carsRef.current.some((car) => car.occupied);
      const isDeathAnimating = deathAnimRef.current.active;
      const isIntroWaiting = introDropRef.current.phase === 'waiting';
      if (pl.isDashing) {
        dashTrailRef.current.push({ x: pl.x, y: pl.y });
        if (dashTrailRef.current.length > 5) dashTrailRef.current.shift();
      } else if (dashTrailRef.current.length > 0) {
        dashTrailRef.current.shift();
      }
      dashTrailRef.current.forEach((t, idx) => {
        ctx.globalAlpha = ((idx + 1) / (dashTrailRef.current.length + 1)) * 0.35;
        ctx.save();
        ctx.translate(Math.floor(t.x + pl.width / 2), Math.floor(t.y + pl.height / 2));
        ctx.scale(-pl.direction, 1);
        drawImageSafe('idle_0', -pl.width / 2, -pl.height / 2, pl.width, pl.height);
        ctx.restore();
        ctx.globalAlpha = 1;
      });

      if (!playerInCar && !isIntroWaiting) {
        ctx.save();
        ctx.translate(Math.floor(pl.x + pl.width / 2), Math.floor(pl.y + pl.height / 2));
        if (isDeathAnimating) {
          const deathElapsed = Math.max(0, now - deathAnimRef.current.startedAt) / 1000;
          ctx.rotate(Math.sin(deathElapsed * 16) * 0.14);
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.beginPath();
          ctx.arc(0, -pl.height * 0.62, 12 + Math.sin(deathElapsed * 12) * 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.scale(-pl.direction, 1);
          drawImageSafe('idle_0', -pl.width / 2, -pl.height / 2, pl.width, pl.height);
        } else {
          ctx.globalAlpha = pl.invulnerableTime > 0 && Math.floor(now / 70) % 2 === 0 ? 0.45 : 1;
          ctx.scale(-pl.direction, 1);
          const frame = Math.abs(pl.vx) > 0.5 ? `walk_${Math.floor(now / 80) % 8}` : `idle_${Math.floor(now / 200) % 4}`;
          if (pl.isSliding) drawImageSafe(frame, -pl.width / 2, -pl.height / 2 + 22, pl.width, pl.height * 0.65);
          else drawImageSafe(frame, -pl.width / 2, -pl.height / 2, pl.width, pl.height);
        }
        ctx.restore();
      }

      const treeLayer = dLayers.tree;
      if (treeLayer) {
        ctx.save();
        ctx.translate(Math.floor(camX), 0);
        const offsetX = (-(camX * PARALLAX_SPEEDS.tree)) % treeLayer.w;
        drawImageSafe('tree', offsetX, 0, treeLayer.w, treeLayer.h);
        if (offsetX + treeLayer.w < virtualWidth) drawImageSafe('tree', offsetX + treeLayer.w, 0, treeLayer.w, treeLayer.h);
        if (offsetX > 0) drawImageSafe('tree', offsetX - treeLayer.w, 0, treeLayer.w, treeLayer.h);
        ctx.restore();
      }

      carsRef.current.forEach((car) => {
        if (car.x + car.width < viewLeft || car.x > viewRight) return;
        const canEnter = car.canRide && !car.occupied && !car.used && rectsOverlap(getPlayerHitbox(), getTaxiBoardingZone(car));
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.beginPath();
        ctx.ellipse(car.x + car.width / 2, car.y + car.height + 5, car.width * 0.46, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        drawImageSafe(`car_${car.spriteKey}`, car.x, car.y, car.width, car.height);
        if (car.occupied) {
          ctx.fillStyle = '#66f2c2';
          ctx.beginPath();
          ctx.arc(car.x + car.width * 0.5, car.y + car.height * 0.38, 5, 0, Math.PI * 2);
          ctx.fill();
        }
        if (canEnter) {
          ctx.textAlign = 'center';
          ctx.font = 'bold 13px monospace';
          ctx.fillStyle = '#66f2c2';
          ctx.fillText('按 E/↓ 搭出租车', car.x + car.width / 2, car.y - 12 + Math.sin(now / 180) * 4);
        }
        ctx.restore();
      });

      particlesRef.current.forEach((pa) => {
        if (pa.x + pa.size < viewLeft || pa.x - pa.size > viewRight) return;
        ctx.globalAlpha = Math.max(0, pa.life / 52);
        ctx.fillStyle = pa.color;
        ctx.beginPath();
        if (pa.shape === 'leaf') {
          ctx.save();
          ctx.translate(pa.x, pa.y);
          ctx.rotate((pa.life + pa.x) * 0.08);
          ctx.ellipse(0, 0, pa.size * 1.45, pa.size * 0.62, 0, 0, Math.PI * 2);
          ctx.restore();
        } else {
          ctx.arc(pa.x, pa.y, pa.size, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      });

      floatingTextsRef.current.forEach((ft) => {
        if (ft.x < viewLeft || ft.x > viewRight) return;
        ctx.globalAlpha = Math.max(0, Math.min(1, ft.life / 30));
        ctx.font = `bold ${ft.size}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = ft.color;
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.globalAlpha = 1;
      });
      ctx.restore();

      const stats = statsRef.current;
      ctx.textAlign = 'left';
      const hudX = 24;
      const hudY = 24;
      const hudW = 318;
      const hudH = 178;
      const hudRadius = 12;
      const hudGradient = ctx.createLinearGradient(hudX, hudY, hudX, hudY + hudH);
      hudGradient.addColorStop(0, 'rgba(8, 17, 38, 0.82)');
      hudGradient.addColorStop(1, 'rgba(2, 6, 23, 0.72)');
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(hudX, hudY, hudW, hudH, hudRadius);
      ctx.fillStyle = hudGradient;
      ctx.fill();
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.34)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.shadowColor = 'rgba(34, 211, 238, 0.18)';
      ctx.shadowBlur = 24;
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.12)';
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#FFD700';
      ctx.font = 'bold 28px monospace';
      ctx.fillText(`${Math.floor(stats.score).toLocaleString()}`, 44, 62);
      ctx.fillStyle = '#dbeafe';
      ctx.font = 'bold 12px monospace';
      ctx.fillText(`DIST ${getDistanceMeters(stats.distance)}m`, 44, 86);
      ctx.fillText(`DATA ${stats.evidence}`, 164, 86);
      ctx.fillText(`NEAR ${stats.nearMisses}`, 254, 86);
      ctx.fillStyle = 'rgba(255,255,255,0.11)';
      ctx.fillRect(44, 106, 232, 12);
      ctx.fillStyle = pl.hp < 35 ? '#ff3355' : COLORS.hpBarPlayer;
      ctx.fillRect(44, 106, 232 * (pl.hp / pl.maxHp), 12);
      ctx.fillStyle = '#dbeafe';
      ctx.fillText(`HP ${Math.ceil(pl.hp)}/${pl.maxHp}`, 44, 101);
      ctx.fillStyle = 'rgba(255,255,255,0.11)';
      ctx.fillRect(44, 136, 232, 8);
      const comboRemain = stats.combo > 0 ? Math.max(0, 1 - (Date.now() - stats.lastComboAt) / COMBO_WINDOW_MS) : 0;
      ctx.fillStyle = '#ffb703';
      ctx.fillRect(44, 136, 232 * comboRemain, 8);
      ctx.fillStyle = stats.combo > 0 ? '#ffb703' : '#64748b';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(`COMBO x${stats.combo}  MULT ${stats.multiplier.toFixed(2)}`, 44, 166);
      if (pl.shieldTime > 0 || pl.magnetTime > 0) {
        ctx.fillStyle = '#66f2c2';
        ctx.font = 'bold 12px monospace';
        const shield = pl.shieldTime > 0 ? `SHIELD ${Math.ceil(pl.shieldTime / 1000)}s` : '';
        const magnet = pl.magnetTime > 0 ? `MAGNET ${Math.ceil(pl.magnetTime / 1000)}s` : '';
        ctx.fillText(`${shield} ${magnet}`.trim(), 44, 190);
      }

      if (pl.dashCooldown > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(24, 216, 132, 10);
        ctx.fillStyle = '#4cc9f0';
        ctx.fillRect(24, 216, 132 * (1 - pl.dashCooldown / DASH_COOLDOWN), 10);
      } else {
        ctx.fillStyle = '#4cc9f0';
        ctx.font = '12px monospace';
        ctx.fillText('DASH READY', 24, 226);
      }

      if (introDropRef.current.phase === 'waiting') {
        const promptX = INTRO_TREE_CENTER_X - camX * PARALLAX_SPEEDS.tree;
        const promptY = INTRO_TREE_PROMPT_Y + Math.sin(now / 320) * 2;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = 'bold 13px monospace';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.66)';
        ctx.fillStyle = 'rgba(236, 253, 245, 0.9)';
        ctx.strokeText('按任意键开始游戏', promptX, promptY);
        ctx.fillText('按任意键开始游戏', promptX, promptY);
        ctx.restore();
      }
      ctx.restore();
    };

    if (gameState === 'PLAYING') scheduleLoop();
    else draw();
    document.addEventListener('visibilitychange', resumeLoop);
    window.addEventListener('focus', resumeLoop);
    window.addEventListener('pageshow', resumeLoop);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', resumeLoop);
      window.removeEventListener('focus', resumeLoop);
      window.removeEventListener('pageshow', resumeLoop);
      if (animationId !== null) cancelAnimationFrame(animationId);
      animationId = null;
    };
  }, [isLoaded, gameState, dims, masterVolume, sfxVolume, onNpcChatStart, activeNpcChatTarget, activeConversationTarget, dismissedMikuIds, onNpcChatAnchorChange]);

  if (!isLoaded) return (
    <div className="flex flex-col items-center justify-center h-screen w-screen bg-[#050510] gap-6">
      <div className="text-cyan-500 font-mono text-2xl animate-pulse tracking-widest uppercase">Initializing CAT_NET...</div>
      <div className="w-64 h-2 bg-slate-800 rounded-full overflow-hidden relative">
        <div className="absolute inset-0 bg-cyan-500/30 animate-[shimmer_2s_infinite]"></div>
        <div className="h-full bg-cyan-500 shadow-[0_0_10px_#06b6d4] transition-all duration-500" style={{ width: '60%' }}></div>
      </div>
      <div className="text-slate-500 font-mono text-xs animate-pulse">正在同步现实世界与猫星通讯...</div>
    </div>
  );

  return <canvas ref={canvasRef} width={dims.width} height={dims.height} onPointerDown={handleCanvasPointerDown} className="block w-full h-full bg-[#050510]" />;
};
