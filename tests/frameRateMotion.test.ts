import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDampedAcceleration } from '../utils/frameRateMotion.ts';

const simulateMovement = (renderHz: number, seconds: number) => {
  const deltaFrames = 60 / renderHz;
  let velocity = 0;
  let distance = 0;

  for (let frame = 0; frame < renderHz * seconds; frame++) {
    velocity = applyDampedAcceleration(velocity, 1, 0.82, 0.94, deltaFrames);
    velocity = Math.min(7.4, velocity);
    distance += velocity * deltaFrames;
  }

  return { velocity, distance };
};

test('movement speed remains stable across browser render cadences', () => {
  const safariLike = simulateMovement(45, 10);
  const midTier = simulateMovement(55, 10);
  const chromeLike = simulateMovement(60, 10);

  assert.equal(safariLike.velocity, chromeLike.velocity);
  assert.equal(midTier.velocity, chromeLike.velocity);
  assert.ok(Math.abs(safariLike.distance - chromeLike.distance) < 2);
  assert.ok(Math.abs(midTier.distance - chromeLike.distance) < 2);
});

test('one 60Hz frame preserves the original acceleration and friction rule', () => {
  const velocity = 3.25;
  const expected = (velocity + 0.82) * 0.94;

  assert.ok(Math.abs(applyDampedAcceleration(velocity, 1, 0.82, 0.94, 1) - expected) < 1e-12);
});
