// Runs fn(0..count-1) with `limit` in flight; after the first error no new call starts and that error is rethrown
export async function forEachLimit(count, limit, fn) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < count) {
      const i = next++;
      try {
        await fn(i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
}
