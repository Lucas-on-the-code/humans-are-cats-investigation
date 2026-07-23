import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeFixedSteps } from '../utils/fixedStep.ts';

const STEP_MS = 1000 / 60;

const countPhysicsSteps = (renderHz: number, seconds: number) => {
  let remainderMs = 0;
  let steps = 0;
  const renderFrames = renderHz * seconds;

  for (let frame = 0; frame < renderFrames; frame++) {
    const result = consumeFixedSteps(remainderMs, 1000 / renderHz, STEP_MS, 5);
    remainderMs = result.remainderMs;
    steps += result.steps;
  }

  return steps;
};

test('physics advances at 60Hz regardless of browser render cadence', () => {
  const safariLikeSteps = countPhysicsSteps(45, 10);
  const chromeLikeSteps = countPhysicsSteps(60, 10);
  const midTierSteps = countPhysicsSteps(55, 10);

  assert.equal(safariLikeSteps, 600);
  assert.equal(chromeLikeSteps, 600);
  assert.equal(midTierSteps, 600);
});

test('large frame gaps are bounded to avoid a catch-up spiral', () => {
  const result = consumeFixedSteps(0, 500, STEP_MS, 5);

  assert.equal(result.steps, 5);
  assert.ok(result.remainderMs < STEP_MS);
});
