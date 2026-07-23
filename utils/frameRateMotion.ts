export const applyDampedAcceleration = (
  velocity: number,
  input: number,
  acceleration: number,
  friction: number,
  deltaFrames: number,
) => {
  const decay = Math.pow(friction, Math.max(0, deltaFrames));
  if (Math.abs(1 - friction) < Number.EPSILON) {
    return velocity + input * acceleration * deltaFrames;
  }

  const terminalVelocity = (input * acceleration * friction) / (1 - friction);
  return terminalVelocity + (velocity - terminalVelocity) * decay;
};
