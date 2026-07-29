/* @ts-self-types="./game_state_core.d.ts" */

export class GameState {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GameStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gamestate_free(ptr, 0);
    }
    /**
     * 激活护盾（带持续时间由 JS 侧管理位置，WASM 只记 bool）
     */
    activate_shield() {
        wasm.gamestate_activate_shield(this.__wbg_ptr);
    }
    /**
     * @param {number} amount
     * @returns {number}
     */
    add_panic(amount) {
        const ret = wasm.gamestate_add_panic(this.__wbg_ptr, amount);
        return ret;
    }
    /**
     * 通用加分（fish/magnet/shield 等）。返回实际加分数。
     * @param {number} base
     * @returns {number}
     */
    add_score(base) {
        const ret = wasm.gamestate_add_score(this.__wbg_ptr, base);
        return ret;
    }
    /**
     * 对玩家造成伤害。返回 true 表示玩家死亡。
     * @param {number} amount
     * @returns {boolean}
     */
    apply_damage(amount) {
        const ret = wasm.gamestate_apply_damage(this.__wbg_ptr, amount);
        return ret !== 0;
    }
    /**
     * 治疗玩家
     * @param {number} amount
     * @returns {number}
     */
    apply_heal(amount) {
        const ret = wasm.gamestate_apply_heal(this.__wbg_ptr, amount);
        return ret >>> 0;
    }
    /**
     * @param {bigint} now
     * @returns {boolean}
     */
    check_combo_timeout(now) {
        const ret = wasm.gamestate_check_combo_timeout(this.__wbg_ptr, now);
        return ret !== 0;
    }
    /**
     * 收集证据。返回实际加分数。
     * @returns {number}
     */
    collect_evidence() {
        const ret = wasm.gamestate_collect_evidence(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    combo() {
        const ret = wasm.gamestate_combo(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 护盾到期（由 JS 调用）
     */
    deactivate_shield() {
        wasm.gamestate_deactivate_shield(this.__wbg_ptr);
    }
    /**
     * @param {number} dt_scale
     * @returns {number}
     */
    decay_panic(dt_scale) {
        const ret = wasm.gamestate_decay_panic(this.__wbg_ptr, dt_scale);
        return ret;
    }
    /**
     * @returns {number}
     */
    evidence() {
        const ret = wasm.gamestate_evidence(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {bigint} now
     * @returns {any}
     */
    finalize_run(now) {
        const ret = wasm.gamestate_finalize_run(this.__wbg_ptr, now);
        return ret;
    }
    /**
     * 仅生成 integrity 令牌（计分由 JS 侧完成）—— 避免 SCORE_MISMATCH
     * @returns {string}
     */
    get_integrity_token() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.gamestate_get_integrity_token(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    hp() {
        const ret = wasm.gamestate_hp(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    is_dead() {
        const ret = wasm.gamestate_is_dead(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    max_hp() {
        const ret = wasm.gamestate_max_hp(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    multiplier() {
        const ret = wasm.gamestate_multiplier(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    near_misses() {
        const ret = wasm.gamestate_near_misses(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 创建新实例（从 JS 调用）
     */
    constructor() {
        const ret = wasm.gamestate_new();
        this.__wbg_ptr = ret;
        GameStateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    panic() {
        const ret = wasm.gamestate_panic(this.__wbg_ptr);
        return ret;
    }
    /**
     * 擦弹。返回实际加分数。
     * @returns {number}
     */
    record_near_miss() {
        const ret = wasm.gamestate_record_near_miss(this.__wbg_ptr);
        return ret;
    }
    /**
     * 扫描 NPC 成功。返回实际加分数。
     * @param {boolean} is_target
     * @returns {number}
     */
    record_scan(is_target) {
        const ret = wasm.gamestate_record_scan(this.__wbg_ptr, is_target);
        return ret;
    }
    /**
     * 乘坐出租车
     * @returns {number}
     */
    record_taxi_ride() {
        const ret = wasm.gamestate_record_taxi_ride(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    scans() {
        const ret = wasm.gamestate_scans(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    score() {
        const ret = wasm.gamestate_score(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    shield_active() {
        const ret = wasm.gamestate_shield_active(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {number} player_x
     * @returns {number}
     */
    update_distance(player_x) {
        const ret = wasm.gamestate_update_distance(this.__wbg_ptr, player_x);
        return ret;
    }
}
if (Symbol.dispose) GameState.prototype[Symbol.dispose] = GameState.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_7796ffc7ed656783: function() {
            const ret = new Map();
            return ret;
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_86c0d4ba3fa605b8: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_set_575dd786d51585f8: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_8a16b38e4805b298: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_3ed232c8a6baee09: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./game_state_core_bg.js": import0,
    };
}

const GameStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gamestate_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('game_state_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
