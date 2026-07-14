import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runUploadQueue } from '../src/features/chat/uploads/runUploadQueue';

describe('upload queue', () => {
  it('limits concurrent uploads', async () => {
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];
    await runUploadQueue(
      [1, 2, 3, 4, 5, 6],
      async (item) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        completed.push(item);
        active -= 1;
      },
      2,
    );
    assert.equal(maximum, 2);
    assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5, 6]);
  });
});
