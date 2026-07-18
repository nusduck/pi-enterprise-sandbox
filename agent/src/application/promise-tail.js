/**
 * Sequential promise tail with first-error latch.
 *
 * Enqueued work always runs in order (even after a failure).
 * flush() awaits the full chain and always rethrows the first error.
 */

/**
 * @returns {{
 *   enqueue: (fn: () => Promise<void> | void) => Promise<void>,
 *   flush: () => Promise<void>,
 *   error: () => unknown | null,
 * }}
 */
export function createPromiseTail() {
  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  /** @type {unknown | null} */
  let firstError = null;

  return {
    /**
     * @param {() => Promise<void> | void} fn
     */
    enqueue(fn) {
      tail = tail.then(
        async () => {
          try {
            await fn();
          } catch (err) {
            if (firstError == null) firstError = err;
            // Do not rethrow here — allow subsequent work to run.
          }
        },
        // Previous link should not reject (we swallow into firstError).
        async () => {
          try {
            await fn();
          } catch (err) {
            if (firstError == null) firstError = err;
          }
        },
      );
      return tail;
    },

    async flush() {
      await tail;
      if (firstError != null) {
        const err = firstError;
        // Keep latched so subsequent flush still throws the same error.
        throw err;
      }
    },

    error() {
      return firstError;
    },
  };
}
