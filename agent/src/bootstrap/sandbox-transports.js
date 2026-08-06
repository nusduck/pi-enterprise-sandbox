/**
 * Build the Agent's Sandbox transports, all sharing one placement resolver.
 *
 * The Sandbox is sharded, not load balanced: a workspace is a directory on one
 * replica's volume and a managed process is a handle in one replica's memory.
 * Every transport therefore needs the same routing answer, and needs to learn
 * the same corrections — so the resolver is constructed once here and handed to
 * all of them, rather than each keeping a private view of where things live.
 *
 * The base URL passed alongside it is the *discovery* address. It is only used
 * for sessions that have no placement yet; workspace-bound calls resolve to the
 * owning replica.
 */

/**
 * @param {object} args
 * @param {string} args.discoveryUrl Sandbox Service address (any replica)
 * @param {string} args.keyring internal HMAC keyring JSON
 * @param {string} args.activeKid active HMAC key id
 * @param {() => import('knex').Knex | null} args.knexFactory Agent database
 * @returns {Promise<{
 *   placement: object,
 *   createInternalReadTransport: Function,
 *   createInternalExecutionTransport: Function,
 *   createInternalFilesWriteTransport: Function,
 *   createInternalArtifactTransport: Function,
 *   createInternalProcessTransport: Function,
 * }>}
 */
export async function createSandboxTransportFactories({
  discoveryUrl,
  keyring,
  activeKid,
  knexFactory,
}) {
  const { createSandboxPlacementResolver } = await import(
    '../infrastructure/sandbox/placement-resolver.js'
  );
  const placement = createSandboxPlacementResolver({ discoveryUrl, knexFactory });

  /** Options every transport shares; only the trace carrier is per run. */
  const common = (runContext) => ({
    baseUrl: discoveryUrl,
    placement,
    keyring,
    activeKid,
    allowInsecureHttp: true,
    traceState: runContext?.traceState,
  });

  const { createInternalFilesReadTransport, createInternalSkillsReadTransport } =
    await import('../infrastructure/sandbox/internal-files-read-http.js');
  const { createInternalExecutionTransport } = await import(
    '../infrastructure/sandbox/internal-execution-http.js'
  );
  const { createInternalFilesWriteTransport } = await import(
    '../infrastructure/sandbox/internal-files-write-http.js'
  );
  const { createInternalArtifactSubmitTransport } = await import(
    '../infrastructure/sandbox/internal-artifact-submit-http.js'
  );
  const { createInternalProcessTransport } = await import(
    '../infrastructure/sandbox/internal-process-http.js'
  );

  return {
    placement,
    createInternalReadTransport: (runContext) => {
      // Files and skills share one option set but are separate transports:
      // skills read an immutable shared mount, so they are not workspace-bound.
      const options = common(runContext);
      const files = createInternalFilesReadTransport(options);
      const skills = createInternalSkillsReadTransport(options);
      return { ...files, readSkill: skills.readFile };
    },
    createInternalExecutionTransport: (runContext) =>
      createInternalExecutionTransport(common(runContext)),
    createInternalFilesWriteTransport: (runContext) =>
      createInternalFilesWriteTransport(common(runContext)),
    createInternalArtifactTransport: (runContext) =>
      createInternalArtifactSubmitTransport(common(runContext)),
    createInternalProcessTransport: (runContext) =>
      createInternalProcessTransport(common(runContext)),
  };
}
