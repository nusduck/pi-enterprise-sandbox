import type { DshRunExecutorFactoryOptions } from './dsh-run-executor-deps.js';
import { DshRunExecutor } from './dsh-run-executor.js';

/** Per-job factory. Production still injects all authority-bearing dependencies. */
export function createDshRunExecutorFactory(opts: DshRunExecutorFactoryOptions) {
  if (typeof opts?.modelResolver !== 'function') {
    throw new Error('createDshRunExecutorFactory requires modelResolver(agentVersion)');
  }
  if (typeof opts?.workspaceResolver !== 'function') {
    throw new Error('createDshRunExecutorFactory requires workspaceResolver(agentSession)');
  }
  if (!opts.transactionManager || !opts.createRepositories) {
    throw new Error('createDshRunExecutorFactory requires transactionManager and createRepositories');
  }
  if (!opts.sessionLockManager || !opts.piRuntimeFactory) {
    throw new Error('createDshRunExecutorFactory requires sessionLockManager and piRuntimeFactory');
  }
  if (typeof opts.generateId !== 'function') {
    throw new Error('createDshRunExecutorFactory requires generateId');
  }

  return function dshRunExecutorFactory() {
    return new DshRunExecutor({
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

export const createPiRunExecutorFactory = createDshRunExecutorFactory;

