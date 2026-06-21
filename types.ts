
export type GameState = 'MENU' | 'PLAYING' | 'DIALOG' | 'ENDING';

export interface Position {
  x: number;
  y: number;
}

export interface Entity extends Position {
  width: number;
  height: number;
  emoji: string;
}

export interface Player extends Entity {
  vx: number;
  vy: number;
  isGrounded: boolean;
  direction: 1 | -1;
  panic: number; 
  isHiding: boolean;
  hp: number;
  maxHp: number;
  attackCooldown: number;
  isAttacking: boolean;
  interactionCooldown?: number;
  evidenceCollected: number;
  // Parkour & Stealth Start
  isDashing: boolean;
  dashCooldown: number;
  dashTime: number;
  canWallJump: boolean;
  wallJumpDirection: number;
  isInitialHiding: boolean; // New: Starting state in the tree
  invulnerableTime: number;
  isSliding: boolean;
  slideTime: number;
  magnetTime: number;
  shieldTime: number;
}

export enum NpcType {
  WORKER = 'WORKER',
  EATER = 'EATER',
  LEADER = 'LEADER'
}

export type NpcChatKind = 'miku' | 'random';
export type NpcChatTargetType = 'npc' | 'pedestrian';

export interface NpcChatTarget {
  type: NpcChatTargetType;
  id: number;
  kind: NpcChatKind;
}

export interface NpcChatSession {
  kind: NpcChatKind;
  speaker: string;
  lines: string[];
  isInvite?: boolean;
  image?: string;
  anchor?: {
    x: number;
    y: number;
  };
  target?: NpcChatTarget;
}

export interface NPC extends Entity {
  id: number;
  type: NpcType;
  scanned: boolean; 
  originalEmoji: string;
  scannedEmoji: string;
  dialogText: string[];
  isTarget: boolean; 
  vx: number;
  vy: number;
  patrolStart: number;
  patrolEnd: number;
  visionRange: number;
  visionHeight: number;
  alertLevel: number;
  damageCooldown: number;
  scanHits: number;
  maxScanHits: number;
  label: string;
  chatKind?: NpcChatKind;
  spriteKey?: string;
}

export interface Platform extends Position {
  width: number;
  height: number;
  type: 'FLOOR' | 'WALL';
}

export interface Hazard extends Position {
  id: number;
  width: number;
  height: number;
  damage: number;
  type: 'LASER' | 'SPIKES';
  phase: number;
  passed?: boolean;
}

export interface Projectile extends Position {
  vx: number;
  life: number;
  color: string;
}

export interface Particle extends Position {
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
  opacity?: number;
  shape?: 'leaf' | 'circle';
}

export interface Item extends Position {
  id: number;
  width: number;
  height: number;
  type: 'EVIDENCE' | 'HEALTH' | 'FISH' | 'MAGNET' | 'SHIELD';
  collected: boolean;
  floatOffset: number;
}

export interface ScoreEvent {
  /** Per-event timestamp (ms since run start). Absent in aggregated events. */
  t?: number;
  type: string;
  base: number;
  /** Combo multiplier in effect when this score was awarded (client authoritative).
   *  Sent by new clients so the server replays exact scoring without recomputing
   *  combo (which drifts — client combo resets on damage, invisible to server). */
  mult?: number;
  /** Aggregated occurrence count. New clients send events aggregated by (type,base,
   *  mult) so a long run (4651m can rack up hundreds of thousands of per-event
   *  entries → multi-MB upload body + GC stall that freezes the page on upload).
   *  Absent on legacy per-event entries (count = 1). */
  count?: number;
}

export interface RunSummary {
  score: number;
  distance: number;
  evidence: number;
  scans: number;
  nearMisses: number;
  bestCombo: number;
  survivalTime: number;
  title: string;
  events?: ScoreEvent[];
}

export interface LeaderboardEntry extends RunSummary {
  id: string;
  playerName: string;
  createdAt: string;
}

export interface TouchInput {
  left: boolean;
  right: boolean;
  up: boolean; 
  down: boolean;
  action: boolean; 
  attack: boolean; 
  interact: boolean;
  dash: boolean;
}

export type ZoneType = 'STREET' | 'OFFICE';

export interface Zone {
  id: ZoneType;
  minX: number;
  maxX: number;
  background: string;
}

export interface Door extends Position {
  width: number;
  height: number;
  targetX: number;
  targetY: number;
  targetZone: ZoneType;
  label: string;
}
