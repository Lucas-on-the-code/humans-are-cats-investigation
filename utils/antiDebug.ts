/**
 * Anti-debugging measures for the game client.
 */

let tamperFlags = 0;
const FLAG_DEBUGGER_TIMING = 1 << 0;
const FLAG_WINDOW_SIZE     = 1 << 1;
const FLAG_CONSOLE_TAMPER  = 1 << 2;
const FLAG_FRAME_ANOMALY   = 1 << 3;

let debuggerTrapActive = false;
let trapIntervalId: number | null = null;
let frameAnomalyCount = 0;
let lastFrameTs = 0;
let lastDebuggerCheck = 0;
let lastWindowCheck = 0;

function checkDebuggerTiming(): boolean {
  const start = performance.now();
  // eslint-disable-next-line no-debugger
  debugger;
  return performance.now() - start > 50;
}

function checkDevToolsWindow(): boolean {
  const wGap = window.outerWidth - window.innerWidth;
  const hGap = window.outerHeight - window.innerHeight;
  return wGap > 200 || hGap > 200;
}

function checkConsoleTampering(): boolean {
  try {
    const nativeLog = Function.prototype.toString.call(console.log);
    return !nativeLog.includes('[native code]');
  } catch {
    return true;
  }
}

export function checkFrameTiming(now: number): void {
  if (lastFrameTs === 0) { lastFrameTs = now; return; }
  const delta = now - lastFrameTs;
  lastFrameTs = now;
  if (delta > 400) {
    frameAnomalyCount++;
    if (frameAnomalyCount >= 4) tamperFlags |= FLAG_FRAME_ANOMALY;
  } else if (delta <= 60) {
    frameAnomalyCount = Math.max(0, frameAnomalyCount - 0.3);
  }
}

function sweep() {
  const now = performance.now();
  if (now - lastDebuggerCheck > 3000) {
    lastDebuggerCheck = now;
    if (checkDebuggerTiming()) tamperFlags |= FLAG_DEBUGGER_TIMING;
  }
  if (now - lastWindowCheck > 5000) {
    lastWindowCheck = now;
    if (checkDevToolsWindow()) tamperFlags |= FLAG_WINDOW_SIZE;
  }
  if (checkConsoleTampering()) tamperFlags |= FLAG_CONSOLE_TAMPER;
}

export function startAntiDebug(): void {
  if (debuggerTrapActive) return;
  debuggerTrapActive = true;
  sweep();
  trapIntervalId = window.setInterval(sweep, 3000);
}

export function stopAntiDebug(): void {
  debuggerTrapActive = false;
  if (trapIntervalId !== null) {
    clearInterval(trapIntervalId);
    trapIntervalId = null;
  }
}

export function getTamperFlags(): number {
  return tamperFlags;
}
