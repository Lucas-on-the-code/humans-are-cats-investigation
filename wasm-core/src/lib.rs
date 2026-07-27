use getrandom::getrandom;
use wasm_bindgen::prelude::*;

// ── 常量（与 constants.ts 保持同步） ──
const PLAYER_MAX_HP: u32 = 100;
const HEALTH_PACK_HEAL: u32 = 40;
const COMBO_WINDOW_MS: u64 = 4500;
const PIXELS_PER_METER: f64 = 32.0;
const RUN_START_X: f64 = 220.0;

// ── 受保护的内部状态 ──
#[wasm_bindgen]
pub struct GameState {
    // 玩家血量
    hp: u32,
    max_hp: u32,
    panic: f64, // 0~100
    shield_active: bool,

    // 分数与 Combo
    score: f64,
    combo: u32,
    best_combo: u32,
    multiplier: f64,
    last_combo_at: u64,

    // 统计
    evidence: u32,
    scans: u32,
    near_misses: u32,
    taxi_rides: u32,
    distance: f64,

    // 时间
    started_at: u64,

    // 完整性校验
    state_hash: u64,
    mutation_count: u64,

    // 死亡标记
    is_dead: bool,
    run_ended: bool,
}

#[wasm_bindgen]
impl GameState {
    /// 创建新实例（从 JS 调用）
    #[wasm_bindgen(constructor)]
    pub fn new() -> GameState {
        let now = js_sys::Date::now() as u64;
        let mut state = GameState {
            hp: PLAYER_MAX_HP,
            max_hp: PLAYER_MAX_HP,
            panic: 0.0,
            shield_active: false,
            score: 0.0,
            combo: 0,
            best_combo: 0,
            multiplier: 1.0,
            last_combo_at: 0,
            evidence: 0,
            scans: 0,
            near_misses: 0,
            taxi_rides: 0,
            distance: 0.0,
            started_at: now,
            state_hash: 0,
            mutation_count: 0,
            is_dead: false,
            run_ended: false,
        };
        state.rehash();
        state
    }

    // ── 受控的伤害 API ──
    /// 对玩家造成伤害。返回 true 表示玩家死亡。
    pub fn apply_damage(&mut self, amount: u32) -> bool {
        self.assert_not_ended();
        if self.is_dead {
            return true;
        }

        // 护盾抵消
        if self.shield_active {
            self.shield_active = false;
            self.mutated();
            return false;
        }

        self.hp = self.hp.saturating_sub(amount);
        self.panic = (self.panic + 25.0).min(100.0);
        self.combo = 0;
        self.multiplier = 1.0;

        if self.hp == 0 {
            self.is_dead = true;
        }

        self.mutated();
        self.is_dead
    }

    /// 治疗玩家
    pub fn apply_heal(&mut self, amount: u32) -> u32 {
        self.assert_not_ended();
        let healed = amount.min(self.max_hp - self.hp);
        self.hp = (self.hp + amount).min(self.max_hp);
        self.mutated();
        healed
    }

    // ── 受控的道具拾取 API ──
    /// 收集证据。返回实际加分数。
    pub fn collect_evidence(&mut self) -> f64 {
        self.assert_not_ended();
        self.evidence += 1;
        let added = self.add_score_inner(1000.0);
        self.mutated();
        added
    }

    /// 激活护盾（带持续时间由 JS 侧管理位置，WASM 只记 bool）
    pub fn activate_shield(&mut self) {
        self.assert_not_ended();
        self.shield_active = true;
        self.mutated();
    }

    /// 护盾到期（由 JS 调用）
    pub fn deactivate_shield(&mut self) {
        self.shield_active = false;
        self.mutated();
    }

    /// 通用加分（fish/magnet/shield 等）。返回实际加分数。
    pub fn add_score(&mut self, base: f64) -> f64 {
        self.assert_not_ended();
        let added = self.add_score_inner(base);
        self.mutated();
        added
    }

    /// 扫描 NPC 成功。返回实际加分数。
    pub fn record_scan(&mut self, is_target: bool) -> f64 {
        self.assert_not_ended();
        self.scans += 1;
        let base: f64 = if is_target { 700.0 } else { 240.0 };
        let added = self.add_score_inner(base);
        self.mutated();
        added
    }

    /// 擦弹。返回实际加分数。
    pub fn record_near_miss(&mut self) -> f64 {
        self.assert_not_ended();
        self.near_misses += 1;
        let added = self.add_score_inner(180.0);
        self.mutated();
        added
    }

    /// 乘坐出租车
    pub fn record_taxi_ride(&mut self) -> u32 {
        self.assert_not_ended();
        self.taxi_rides += 1;
        self.mutated();
        self.taxi_rides
    }

    // ── 距离驱动分数 ──
    pub fn update_distance(&mut self, player_x: f64) -> f64 {
        self.assert_not_ended();
        let new_dist = (player_x - RUN_START_X).max(0.0);
        if new_dist > self.distance {
            let delta = new_dist - self.distance;
            let heat = (self.distance / PIXELS_PER_METER * 0.008).min(1.0);
            let dist_score = (delta / PIXELS_PER_METER) * (18.0 + heat * 20.0);
            self.score += dist_score;
            self.distance = new_dist;
            self.mutated();
        }
        self.distance
    }

    // ── Panic 衰减 ──
    pub fn decay_panic(&mut self, dt_scale: f64) -> f64 {
        if self.is_dead {
            return self.panic;
        }
        self.panic = (self.panic - 0.35 * dt_scale).max(0.0);
        self.mutated();
        self.panic
    }

    pub fn add_panic(&mut self, amount: f64) -> f64 {
        self.panic = (self.panic + amount).min(100.0);
        self.mutated();
        self.panic
    }

    // ── Combo 超时检查 ──
    pub fn check_combo_timeout(&mut self, now: u64) -> bool {
        if self.combo > 0 && now - self.last_combo_at > COMBO_WINDOW_MS {
            self.combo = 0;
            self.multiplier = 1.0;
            self.mutated();
            return true;
        }
        false
    }

    // ── 生成 RunSummary（防篡改签名） ──
    pub fn finalize_run(&mut self, now: u64) -> JsValue {
        self.assert_not_ended();
        self.run_ended = true;

        let taxi_bonus = if self.taxi_rides >= 3 { 8000.0 } else { 0.0 };
        let final_score = (self.score + taxi_bonus).floor() as u64;
        let survival_time = (now - self.started_at) / 1000;

        let summary = serde_json::json!({
            "score": final_score,
            "distance": (self.distance / PIXELS_PER_METER).floor(),
            "evidence": self.evidence,
            "scans": self.scans,
            "nearMisses": self.near_misses,
            "bestCombo": self.best_combo,
            "survivalTime": survival_time,
            "title": self.compute_title(),
            // 内嵌校验哈希，服务端可验
            "integrity": self.compute_integrity_token(),
        });

        serde_wasm_bindgen::to_value(&summary).unwrap_or(JsValue::NULL)
    }

    // ── 只读查询（不暴露内部结构） ──
    pub fn hp(&self) -> u32 {
        self.hp
    }
    pub fn max_hp(&self) -> u32 {
        self.max_hp
    }
    pub fn panic(&self) -> f64 {
        self.panic
    }
    pub fn score(&self) -> f64 {
        self.score
    }
    pub fn combo(&self) -> u32 {
        self.combo
    }
    pub fn multiplier(&self) -> f64 {
        self.multiplier
    }
    pub fn evidence(&self) -> u32 {
        self.evidence
    }
    pub fn scans(&self) -> u32 {
        self.scans
    }
    pub fn near_misses(&self) -> u32 {
        self.near_misses
    }
    pub fn is_dead(&self) -> bool {
        self.is_dead
    }
    pub fn shield_active(&self) -> bool {
        self.shield_active
    }
}

// ── 内部辅助方法 ──
impl GameState {
    fn add_score_inner(&mut self, base: f64) -> f64 {
        self.combo += 1;
        self.best_combo = self.best_combo.max(self.combo);
        self.multiplier = (1.0 + (self.combo as f64 / 4.0).floor() * 0.25).min(5.0);
        let now = js_sys::Date::now() as u64;
        self.last_combo_at = now;
        let added = (base * self.multiplier).round();
        self.score += added;
        added
    }

    fn compute_title(&self) -> String {
        if self.taxi_rides >= 3 {
            return "taxi_king".into();
        }
        if self.best_combo >= 28 {
            return "combo_frenzy".into();
        }
        if self.near_misses >= 8 {
            return "graze_master".into();
        }
        if self.distance / PIXELS_PER_METER >= 180.0 {
            return "long_distance".into();
        }
        if self.evidence >= 6 {
            return "evidence_hunter".into();
        }
        "trainee".into()
    }

    fn rehash(&mut self) {
        // 简单哈希混合所有关键字段
        let mut h: u64 = 0x517cc1b727220a95;
        h ^= self.hp as u64;
        h = h.rotate_left(13) ^ self.score.to_bits();
        h = h.rotate_left(13) ^ self.evidence as u64;
        h = h.rotate_left(13) ^ self.scans as u64;
        h = h.rotate_left(13) ^ self.near_misses as u64;
        h = h.rotate_left(13) ^ self.combo as u64;
        h = h.rotate_left(13) ^ self.mutation_count;
        self.state_hash = h;
    }

    fn mutated(&mut self) {
        self.mutation_count += 1;
        self.rehash();
    }

    fn assert_not_ended(&self) {
        // debug 模式下 panic，release 下静默忽略
        #[cfg(debug_assertions)]
        if self.run_ended {
            panic!("GameState: attempted mutation after run ended");
        }
    }

    fn compute_integrity_token(&self) -> String {
        let mut seed = [0u8; 16];
        let _ = getrandom(&mut seed);
        // 把 state_hash + mutation_count + random seed 混合
        let token = format!(
            "{:x}.{:x}.{:x}",
            self.state_hash,
            self.mutation_count,
            u64::from_le_bytes(seed[..8].try_into().unwrap_or([0; 8]))
        );
        token
    }
}
