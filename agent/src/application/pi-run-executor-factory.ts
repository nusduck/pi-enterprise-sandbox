import type { PiRunExecutorFactoryOptions } from './pi-run-executor-deps.js';
import { PiRunExecutor } from './pi-run-executor.js';

/** Per-job factory. Production still injects all authority-bearing dependencies. */
export function createPiRunExecutorFactory(opts: PiRunExecutorFactoryOptions) {
  if (typeof opts?.modelResolver !== 'function') {
    throw new Error('createPiRunExecutorFactory requires modelResolver(agentVersion)');
  }
  if (typeof opts?.workspaceResolver !== 'function') {
    throw new Error('createPiRunExecutorFactory requires workspaceResolver(agentSession)');
  }
  if (!opts.transactionManager || !opts.createRepositories) {
    throw new Error('createPiRunExecutorFactory requires transactionManager and createRepositories');
  }
  if (!opts.sessionLockManager || !opts.piRuntimeFactory) {
    throw new Error('createPiRunExecutorFactory requires sessionLockManager and piRuntimeFactory');
  }
  if (typeof opts.generateId !== 'function') {
    throw new Error('createPiRunExecutorFactory requires generateId');
  }

  return function piRunExecutorFactory() {
    return new PiRunExecutor({
      transactionManager: opts.transactionManager,
      createRepositories: opts.createRepositories,
      sessionLockManager: opts.sessionLockManager,
      piRuntimeFactory: opts.piRuntimeFactory,
      modelResolver: opts.modelResolver,
      promptImageLoader: opts.promptImageLoader,
      requestAuthResolver: opts.requestAuthResolver,
      workspaceResolver: opts.workspaceResolver,
      sandboxSessionProvisioner: opts.sandboxSessionProvisioner,
      generateId: opts.generateId,
      now: opts.now,
      sessionAdapter: opts.sessionAdapter,
      projector: opts.projector,
      recoveryService: opts.recoveryService,
      sessionLockRenewIntervalMs: opts.sessionLockRenewIntervalMs,
      steerPollIntervalMs: opts.steerPollIntervalMs,
      toolBudget: opts.toolBudget,
      riskOverrides: opts.riskOverrides,
      subagentSpawnPort: opts.subagentSpawnPort,
      eventProjectionMode: opts.eventProjectionMode,
    });
  };
}
