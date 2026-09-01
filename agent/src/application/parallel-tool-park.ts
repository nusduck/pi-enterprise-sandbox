import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';

/** A parked Run aborts its whole turn; every other in-flight outcome is unknown. */
export async function terminalizeParallelToolsForPark(input: {
  tx: { run: (fn: (trx: any) => Promise<any>) => Promise<any> };
  createRepositories: (db: any) => any;
  context: { runId: string; orgId: string; userId: string };
  recordToolUnknown: (input: Record<string, any>) => Promise<unknown>;
}, approvalToolCallId: string): Promise<void> {
  let tools: any[];
  try {
    tools = await input.tx.run((trx) => input.createRepositories(trx).toolExecutions.listByRun(
      input.context.runId,
      { orgId: input.context.orgId, userId: input.context.userId },
    ));
  } catch (error) {
    console.error('[tool-ledger] could not inspect parallel tools while parking:', error);
    return;
  }
  for (const tool of tools) {
    if (tool.toolCallId === approvalToolCallId || tool.status !== TOOL_EXECUTION_STATUS.RUNNING) continue;
    try {
      await input.recordToolUnknown({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        toolSource: tool.toolSource,
        result: { unknown: true, reason: 'RUN_PARKED_PARALLEL_TOOL' },
        errorCode: 'RUN_PARKED_PARALLEL_TOOL_UNKNOWN',
      });
    } catch (error) {
      // A concurrent normal completion may win this race; it is already terminal.
      if (!(error instanceof ConflictError)) {
        console.error('[tool-ledger] could not terminalize parallel tool:', error);
      }
    }
  }
}
