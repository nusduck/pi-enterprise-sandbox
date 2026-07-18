/**
 * Minimal in-memory Redis-like client for offline unit tests.
 * Supports SET/GET/DEL/PEXPIRE/EVAL (lease Lua), XADD/XRANGE/XLEN used by PR-03 slice A.
 */

/**
 * @typedef {object} FakeRedisState
 * @property {Map<string, { value: string, expireAt: number | null }>} strings
 * @property {Map<string, Array<{ id: string, fields: string[] }>>} streams
 * @property {number} seqClock
 * @property {Array<{ cmd: string, args: unknown[] }>} calls
 * @property {string} status
 * @property {boolean} destroyed
 */

/**
 * @returns {FakeRedisState}
 */
export function createFakeRedisState() {
  return {
    strings: new Map(),
    streams: new Map(),
    seqClock: 0,
    calls: [],
    status: 'ready',
    destroyed: false,
  };
}

/**
 * @param {FakeRedisState} state
 * @param {string} key
 */
function isExpired(state, key) {
  const entry = state.strings.get(key);
  if (!entry) return true;
  if (entry.expireAt != null && Date.now() >= entry.expireAt) {
    state.strings.delete(key);
    return true;
  }
  return false;
}

/**
 * Very small Lua evaluator for the two lease scripts only.
 * @param {FakeRedisState} state
 * @param {string} script
 * @param {number} numKeys
 * @param {unknown[]} argv
 */
function evalLeaseScript(state, script, numKeys, argv) {
  const keys = argv.slice(0, numKeys).map(String);
  const args = argv.slice(numKeys).map(String);
  const key = keys[0];
  const token = args[0];

  if (script.includes('PEXPIRE')) {
    // renew
    if (isExpired(state, key)) return 0;
    const entry = state.strings.get(key);
    if (!entry || entry.value !== token) return 0;
    const ttlMs = Number(args[1]);
    entry.expireAt = Date.now() + ttlMs;
    return 1;
  }

  if (script.includes('DEL')) {
    // release
    if (isExpired(state, key)) return 0;
    const entry = state.strings.get(key);
    if (!entry || entry.value !== token) return 0;
    state.strings.delete(key);
    return 1;
  }

  throw new Error('fake-redis eval: unsupported script');
}

/**
 * Parse exclusive start id "(ms-seq"
 * @param {string} start
 * @param {string} id
 */
function idGreaterThan(id, boundary) {
  const [aMs, aSeq] = id.split('-').map(Number);
  const [bMs, bSeq] = boundary.split('-').map(Number);
  if (aMs !== bMs) return aMs > bMs;
  return aSeq > bSeq;
}

/**
 * @param {string} id
 * @param {string} boundary
 */
function idGreaterOrEqual(id, boundary) {
  return id === boundary || idGreaterThan(id, boundary);
}

/**
 * @param {string} id
 * @param {string} boundary
 */
function idLessOrEqual(id, boundary) {
  return id === boundary || idGreaterThan(boundary, id);
}

/**
 * @param {FakeRedisState} [state]
 */
export function createFakeRedis(state = createFakeRedisState()) {
  const client = {
    get status() {
      return state.status;
    },

    /**
     * @param {string} key
     * @param {string} value
     * @param {...unknown} args
     */
    async set(key, value, ...args) {
      state.calls.push({ cmd: 'set', args: [key, value, ...args] });
      let px = null;
      let nx = false;
      for (let i = 0; i < args.length; i++) {
        const a = String(args[i]).toUpperCase();
        if (a === 'PX') {
          px = Number(args[++i]);
        } else if (a === 'NX') {
          nx = true;
        } else if (a === 'EX') {
          px = Number(args[++i]) * 1000;
        }
      }
      isExpired(state, key);
      if (nx && state.strings.has(key)) {
        return null;
      }
      state.strings.set(String(key), {
        value: String(value),
        expireAt: px != null ? Date.now() + px : null,
      });
      return 'OK';
    },

    /**
     * @param {string} key
     */
    async get(key) {
      state.calls.push({ cmd: 'get', args: [key] });
      if (isExpired(state, key)) return null;
      const entry = state.strings.get(String(key));
      return entry ? entry.value : null;
    },

    /**
     * @param {...string} keys
     */
    async del(...keys) {
      const flat = keys.flat().map(String);
      state.calls.push({ cmd: 'del', args: flat });
      let n = 0;
      for (const k of flat) {
        if (state.strings.has(k)) {
          state.strings.delete(k);
          n++;
        }
        if (state.streams.has(k)) {
          state.streams.delete(k);
          n++;
        }
      }
      return n;
    },

    /**
     * @param {string} key
     * @param {number} ms
     */
    async pexpire(key, ms) {
      state.calls.push({ cmd: 'pexpire', args: [key, ms] });
      if (isExpired(state, key)) return 0;
      const entry = state.strings.get(String(key));
      if (!entry) return 0;
      entry.expireAt = Date.now() + Number(ms);
      return 1;
    },

    /**
     * @param {string} key
     */
    async exists(key) {
      state.calls.push({ cmd: 'exists', args: [key] });
      if (isExpired(state, key)) return 0;
      return state.strings.has(String(key)) || state.streams.has(String(key)) ? 1 : 0;
    },

    /**
     * @param {string} script
     * @param {number} numKeys
     * @param {...unknown} argv
     */
    async eval(script, numKeys, ...argv) {
      state.calls.push({ cmd: 'eval', args: [script, numKeys, ...argv] });
      return evalLeaseScript(state, String(script), Number(numKeys), argv);
    },

    /**
     * @param {string} key
     * @param {...unknown} args
     */
    async xadd(key, ...args) {
      state.calls.push({ cmd: 'xadd', args: [key, ...args] });
      let i = 0;
      let maxLen = null;
      let approx = false;
      if (String(args[i]).toUpperCase() === 'MAXLEN') {
        i++;
        if (args[i] === '~') {
          approx = true;
          i++;
        }
        maxLen = Number(args[i++]);
      }
      const idToken = String(args[i++]);
      const fieldArgs = args.slice(i).map(String);
      if (!state.streams.has(String(key))) {
        state.streams.set(String(key), []);
      }
      const list = state.streams.get(String(key));
      state.seqClock += 1;
      const id =
        idToken === '*'
          ? `${Date.now()}-${state.seqClock}`
          : idToken;
      list.push({ id, fields: fieldArgs });
      if (maxLen != null && list.length > maxLen) {
        // Approximate trim: drop oldest until at/under maxLen
        while (list.length > maxLen) {
          list.shift();
        }
      }
      void approx;
      return id;
    },

    /**
     * @param {string} key
     * @param {string} start
     * @param {string} end
     * @param {...unknown} rest
     */
    async xrange(key, start, end, ...rest) {
      state.calls.push({ cmd: 'xrange', args: [key, start, end, ...rest] });
      const list = state.streams.get(String(key)) || [];
      let count = Infinity;
      for (let i = 0; i < rest.length; i++) {
        if (String(rest[i]).toUpperCase() === 'COUNT') {
          count = Number(rest[++i]);
        }
      }

      const startStr = String(start);
      const endStr = String(end);
      const exclusive = startStr.startsWith('(');
      const startBound = exclusive ? startStr.slice(1) : startStr;

      const out = [];
      for (const entry of list) {
        if (startBound !== '-' && startBound !== '0-0') {
          if (exclusive) {
            if (!idGreaterThan(entry.id, startBound)) continue;
          } else if (startBound !== '-') {
            if (!idGreaterOrEqual(entry.id, startBound)) continue;
          }
        }
        if (endStr !== '+') {
          if (!idLessOrEqual(entry.id, endStr)) continue;
        }
        out.push([entry.id, entry.fields]);
        if (out.length >= count) break;
      }
      return out;
    },

    /**
     * @param {string} key
     */
    async xlen(key) {
      state.calls.push({ cmd: 'xlen', args: [key] });
      const list = state.streams.get(String(key));
      return list ? list.length : 0;
    },

    async quit() {
      state.status = 'end';
      state.destroyed = true;
      return 'OK';
    },

    disconnect() {
      state.status = 'end';
      state.destroyed = true;
    },
  };

  return client;
}
