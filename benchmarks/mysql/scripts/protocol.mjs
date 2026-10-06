import { shouldRunThirdRun } from "./analytics.mjs";

export async function measureRepeats({ repeatCount, thresholdPercent, beforeRepeat, measure, onThird }) {
  const runs = [];
  const execute = async repeat => {
    await beforeRepeat?.(repeat);
    runs.push(await measure(repeat));
  };
  for (let repeat = 1; repeat <= repeatCount; repeat++) await execute(repeat);
  if (repeatCount === 2 && shouldRunThirdRun(runs,thresholdPercent)) {
    onThird?.();
    await execute(3);
  }
  return runs;
}
