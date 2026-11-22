// SPDX-License-Identifier: Apache-2.0

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * @param {ReadonlyArray<{id: string, frames?: number, weight?: number}>} scenes
 * @param {number} totalFrames
 * @returns {{id: string, startFrame: number, endFrame: number}[]}
 */
export function scheduleScenes(scenes, totalFrames) {
  if (!isPositiveInteger(totalFrames)) throw new RangeError('totalFrames must be a positive safe integer');
  if (!Array.isArray(scenes) || scenes.length === 0) throw new TypeError('At least one scene is required');

  const ids = new Set();
  const weighted = [];
  let remaining = totalFrames;
  const durations = Array.from(scenes, (scene, index) => {
    if (!scene || typeof scene.id !== 'string' || !scene.id.trim() || ids.has(scene.id)) {
      throw new TypeError(`Scene ${index + 1} must have a unique, non-empty id`);
    }
    ids.add(scene.id);

    const { frames, weight = 1 } = scene;
    if (frames !== undefined) {
      if (scene.weight !== undefined) throw new TypeError(`Scene '${scene.id}' cannot set both frames and weight`);
      if (!isPositiveInteger(frames)) throw new RangeError(`Scene '${scene.id}' frames must be a positive safe integer`);
      if (frames > remaining) throw new RangeError('Fixed scenes exceed totalFrames');
      remaining -= frames;
      return frames;
    }

    if (!isPositiveInteger(weight)) throw new RangeError(`Scene '${scene.id}' weight must be a positive safe integer`);
    weighted.push({ index, weight: BigInt(weight) });
    return 1;
  });

  if (weighted.length === 0 && remaining !== 0) {
    throw new RangeError('Fixed scenes must fill totalFrames when there are no weighted scenes');
  }
  if (remaining < weighted.length) throw new RangeError('Weighted scenes need at least one frame each');

  if (weighted.length > 0) {
    // Reserve one frame per weighted scene, then apportion the rest exactly.
    let leftover = remaining - weighted.length;
    const budget = BigInt(leftover);
    const totalWeight = weighted.reduce((sum, scene) => sum + scene.weight, 0n);
    const ranked = weighted.map(({ index, weight }) => {
      const scaled = budget * weight;
      const share = Number(scaled / totalWeight);
      durations[index] += share;
      leftover -= share;
      return { index, remainder: scaled % totalWeight };
    }).sort((a, b) => a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder ? -1 : 1);
    for (const { index } of ranked.slice(0, leftover)) durations[index] += 1;
  }

  let frame = 0;
  return durations.map((duration, index) => {
    const startFrame = frame;
    frame += duration;
    return { id: scenes[index].id, startFrame, endFrame: frame };
  });
}
