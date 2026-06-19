
export const GRAVITY = 0.6;
export const JUMP_FORCE = -13.5; 
export const MOVE_SPEED = 6; 
export const DASH_SPEED = 18;
export const DASH_DURATION = 200;
export const DASH_COOLDOWN = 800;
export const WALL_JUMP_FORCE_X = 10;
export const WALL_JUMP_FORCE_Y = -12;

export const COMBAT = {
  PLAYER_MAX_HP: 100,
  NPC_MAX_HP: 30, 
  PLAYER_DMG: 10,
  NPC_DMG: 15,
  ATTACK_RANGE: 100,
  ATTACK_COOLDOWN: 300, 
  SHOOT_COOLDOWN: 400, 
  HIT_STUN: 200,
  HP_BAR_VISIBLE_TIME: 3000,
  INTERACTION_COOLDOWN: 1000,
  TOTAL_EVIDENCE_NEEDED: 3,
  HEALTH_PACK_HEAL: 40, 
  ALERT_DAMAGE: 8,
  CONTACT_DAMAGE: 12,
  HAZARD_DAMAGE: 18,
};

export const COLORS = {
  skyTop: '#6DD5FA',       
  skyBottom: '#FFFFFF',    
  road: '#343a40',         
  sidewalk: '#ced4da',     
  zebra: '#ffffff',        
  platform: 'rgba(76, 201, 240, 0.4)',     
  platformBorder: '#4cc9f0', 
  treeTrunk: '#5d4037',
  treeLeaves: '#2d6a4f',
  bush: '#40916c',
  bgTree: '#1b4332',       
  panic: '#ff3333',
  safe: '#00cc44',
  hpBarBg: '#000000',
  hpBarFill: '#e63946',
  hpBarPlayer: '#4cc9f0',
  uiBg: 'rgba(255, 255, 255, 0.95)', 
  uiBorder: '#007bff',
  projectile: '#00FFFF', 
  projectileTrail: '#FFFFFF',
  evidence: '#FFD700', 
  enemy: '#000000', 
  officeBg: '#2c3e50', 
  officeWall: '#34495e',
  door: '#e67e22',
};

export const ZONES = {
  STREET: { id: 'STREET', minX: -10000, maxX: 10000, background: COLORS.skyTop },
  OFFICE: { id: 'OFFICE', minX: 5000, maxX: 7000, background: COLORS.officeBg }
};

export const DOORS = [
  { x: 3800, y: 430, width: 60, height: 100, targetX: 5250, targetY: 430, targetZone: 'OFFICE', label: 'OFFICE' },
  { x: 5050, y: 430, width: 60, height: 100, targetX: 3600, targetY: 430, targetZone: 'STREET', label: 'EXIT' }
];

export const INTERACTION_QUOTES = [
  "这就奇怪了...",
  "我也想吃那个罐头。",
  "这一天天的，都是猫。",
  "甚至连这个路灯看起来都像猫抓板。",
  "我想回火星了。"
];

export const RANDOM_NPC_CHAT_LINES = [
  "我刚刚把伞借给了一朵云。",
  "你有没有听见便利店冰柜在练声？",
  "今天的路灯看起来很有上进心。",
  "如果鱼会坐地铁，它应该刷什么卡？",
  "我不是在发呆，我是在缓存人生。",
  "刚才有辆出租车问我借零钱。",
  "不要相信会转圈的招牌，它知道太多了。",
  "猫可能没有变多，只是世界变小了。"
];

export const MIKU_CHAT_OPENING_LINES = [
  "你好，我是初音未来。要一起聊聊天吗？",
  "我刚好想休息一下，要不要一起说说话？",
  "如果你愿意的话，我们可以站在这里聊一会儿。"
];

export const LYRICS = {
  intro: [
    ">>> 正在建立安全连接...",
    "代号：鼠 (MOUSE)",
    "状态：已潜入树冠区域",
    "--------------------------------",
    "🎮 无尽逃逸模式：",
    "完全手动操纵角色，向右探索越远分数越高。",
    "",
    "🎮 操作指南：",
    "[←/→] 或 [A/D] 移动",
    "[↑/空格] 跳跃 / [↓] 滑行",
    "[Shift/D] 闪现冲刺 (Dash)",
    "[F/鼠标左键/●] 喵喵声波 (探测)",
    "连续收集、擦边闪避、扫描目标会提高连击倍率。",
    "",
    "HP 归零后结算本局分数并进入排行榜。"
  ],
  ending: [
    "📶 任务报告...",
    "全员猫化完成。",
    "潜入非常成功。",
    "MISSION ACCOMPLISHED."
  ]
};

export const IDLE_SPRITE_URLS = [
  "/sprites/idle/idle_0.png",
  "/sprites/idle/idle_1.png",
  "/sprites/idle/idle_2.png",
  "/sprites/idle/idle_3.png"
];

export const WALK_SPRITE_URLS = [
  "/sprites/walk/walk_0.png",
  "/sprites/walk/walk_1.png",
  "/sprites/walk/walk_2.png",
  "/sprites/walk/walk_3.png",
  "/sprites/walk/walk_4.png",
  "/sprites/walk/walk_5.png",
  "/sprites/walk/walk_6.png",
  "/sprites/walk/walk_7.png"
];

export const NPC_SPRITE_URLS = [
  "/sprites/npc/npc_0.png",
  "/sprites/npc/npc_1.png",
  "/sprites/npc/npc_2.png", 
  "/sprites/npc/npc_3.png"
];

export const NPC_VARIANT_2_URLS = [
  "/sprites/npc_v2/npc_v2_0.png", 
  "/sprites/npc_v2/npc_v2_1.png", 
  "/sprites/npc_v2/npc_v2_2.png", 
  "/sprites/npc_v2/npc_v2_3.png", 
  "/sprites/npc_v2/npc_v2_4.png", 
  "/sprites/npc_v2/npc_v2_5.png", 
  "/sprites/npc_v2/npc_v2_6.png", 
  "/sprites/npc_v2/npc_v2_7.png"  
];

export const SCENE_IMAGES = {
  cloud: "/scene/cloud.png",
  tree: "/scene/tree.png",
  house: "/scene/house.png",
  sky: "/scene/sky.png",
  farHouse: "/scene/farHouse.png",
  midHouse: "/scene/midHouse.png",
  sidewalk: "/scene/sidewalk.png",
  lamp: "/scene/lamp.png"
};

export const AUDIO_URLS = {
  death: "/audio/death.mp3",
  damage: "/audio/damage.mp3",
  hit: "/audio/hit.mp3",
  attack: "/audio/attack.mp3",
  jump: "/audio/jump_remote.mp3",
  dash: "/audio/dash.mp3",
  collect: "/audio/data.mp3"
};
