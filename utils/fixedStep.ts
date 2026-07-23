export interface FixedStepResult {
  steps: number;
  remainderMs: number;
}

export const consumeFixedSteps = (
  remainderMs: number,
  elapsedMs: number,
  stepMs: number,
  maxSteps: number,
): FixedStepResult => {
  const safeElapsedMs = Math.min(Math.max(0, elapsedMs), stepMs * maxSteps);
  const accumulatedMs = Math.max(0, remainderMs) + safeElapsedMs;
  const steps = Math.min(maxSteps, Math.floor((accumulatedMs + Number.EPSILON * 1000) / stepMs));

  return {
    steps,
    remainderMs: Math.max(0, accumulatedMs - steps * stepMs),
  };
};
