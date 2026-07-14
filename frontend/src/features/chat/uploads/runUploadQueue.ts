/** Run upload tasks with bounded concurrency while preserving result order. */
export async function runUploadQueue<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency = 3,
): Promise<void> {
  const width = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    }),
  );
}
