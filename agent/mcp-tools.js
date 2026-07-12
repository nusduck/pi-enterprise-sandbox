/**
 * MCP tools for pi-coding-agent — discover + execute via Sandbox MCP Manager.
 *
 * Tool names are namespaced: mcp_{server_id}_{raw_tool}.
 * Execution goes through POST /mcp/invoke (authz, approval, ledger, timeout).
 *
 * High-risk tools use the same ensureApproved / ledger path as sandbox tools
 * when wired through createSandboxTools wrapExecute; this module can also
 * stand alone for discovery-only tests.
 */
import { Type } from 'typebox';
import { TOOL_CATEGORY } from './tool-registry.js';

/**
 * Convert a JSON Schema object (from MCP discover) into a TypeBox-ish loose object.
 * We accept free-form properties so MCP tools with varied schemas still work.
 */
function parametersFromSchema(schema) {
  // TypeBox Type.Object with additional properties allowed
  return Type.Object(
    {},
    {
      additionalProperties: true,
      description:
        (schema && schema.description) ||
        'MCP tool arguments (free-form object)',
    },
  );
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./services/sandbox-client.js').createSandboxClient>} opts.client
 * @param {() => string | null | undefined} [opts.getSessionId]
 * @param {() => object} [opts.getMeta]
 * @param {((ev: object) => void) | null} [opts.approvalNotifier]
 * @param {boolean} [opts.approvalEnabled]
 * @param {Array<object>} [opts.discovered] — pre-fetched discover results
 * @param {(toolName: string, executeFn: Function) => Function} [opts.wrapExecute]
 *   optional ledger/approval wrapper from createSandboxTools
 */
export async function createMcpTools(opts = {}) {
  const client = opts.client;
  if (!client) {
    throw new Error('createMcpTools requires client');
  }
  const getSessionId =
    typeof opts.getSessionId === 'function' ? opts.getSessionId : () => null;
  const getMeta = typeof opts.getMeta === 'function' ? opts.getMeta : () => ({});
  const approvalNotifier =
    typeof opts.approvalNotifier === 'function' ? opts.approvalNotifier : null;
  const approvalEnabled = opts.approvalEnabled !== false;
  const wrapExecute =
    typeof opts.wrapExecute === 'function'
      ? opts.wrapExecute
      : (_name, fn) => fn;

  let discovered = Array.isArray(opts.discovered) ? opts.discovered : null;
  if (!discovered) {
    try {
      const meta = getMeta();
      const resp = await client.discoverMcpTools({
        userId: meta.user_id || meta.acting_user_id || null,
        organizationId:
          meta.organization_id || meta.acting_organization_id || null,
        applyAuthz: true,
      });
      discovered = resp?.tools || [];
    } catch (err) {
      console.warn(
        '[agent] MCP discover failed; continuing without MCP tools:',
        err?.message || err,
      );
      discovered = [];
    }
  }

  const tools = [];
  for (const d of discovered) {
    if (!d?.name) continue;
    const toolName = d.name;
    const description =
      d.description ||
      `MCP tool ${d.raw_name || toolName} from server ${d.server_id || '?'}`;
    const requiresApproval = Boolean(d.requires_approval);

    const executeBody = async (_toolCallId, params) => {
      const meta = getMeta();
      const sessionId = getSessionId();
      try {
        // Pre-flight policy for high-risk tools (approval UX)
        if (requiresApproval && approvalEnabled) {
          let policy;
          try {
            policy = await client.mcpToolPolicy(toolName, d.server_id);
          } catch {
            policy = { decision: 'approval_required', risk_level: 'high' };
          }
          if (policy?.decision === 'approval_required' && approvalNotifier) {
            // Invoke will create the approval; surface a hint first
            approvalNotifier({
              type: 'approval_required',
              tool_name: toolName,
              reason: policy.reason || 'high-risk MCP tool',
              risk_level: policy.risk_level || 'high',
              policy_version: policy.policy_version,
            });
          }
        }

        const result = await client.invokeMcpTool({
          tool_name: toolName,
          arguments: params || {},
          server_id: d.server_id || null,
          user_id: meta.user_id || meta.acting_user_id || null,
          organization_id:
            meta.organization_id || meta.acting_organization_id || null,
          run_id: meta.run_id || null,
          session_id: sessionId || meta.session_id || null,
          conversation_id: meta.conversation_id || null,
          workspace_id: meta.workspace_id || null,
          tool_call_id: _toolCallId || null,
          // Agent already gated via wrapExecute ledger; skip double approval
          // when sandbox wrapExecute handled it — for MCP, invoke owns approval.
          skip_approval: false,
        });

        if (result?.status === 'pending_approval') {
          if (approvalNotifier) {
            approvalNotifier({
              type: 'approval_required',
              approval_id: result.approval_id,
              tool_name: toolName,
              reason: result.reason || 'high-risk MCP tool',
              risk_level: result.risk_level || 'high',
            });
          }
          // Poll approval via sandbox getApproval if available
          if (
            result.approval_id &&
            typeof client.getApproval === 'function' &&
            approvalEnabled
          ) {
            const deadline = Date.now() + 5 * 60 * 1000;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 1500));
              try {
                const st = await client.getApproval(result.approval_id);
                if (st.status === 'approved') {
                  const retry = await client.invokeMcpTool({
                    tool_name: toolName,
                    arguments: params || {},
                    server_id: d.server_id || null,
                    user_id: meta.user_id || meta.acting_user_id || null,
                    organization_id:
                      meta.organization_id ||
                      meta.acting_organization_id ||
                      null,
                    run_id: meta.run_id || null,
                    session_id: sessionId || meta.session_id || null,
                    conversation_id: meta.conversation_id || null,
                    workspace_id: meta.workspace_id || null,
                    tool_call_id: _toolCallId || null,
                    approval_id: result.approval_id,
                    skip_approval: false,
                    idempotency_key: result.tool_call_id
                      ? `idem_${result.tool_call_id}`
                      : undefined,
                  });
                  return formatMcpToolResult(retry);
                }
                if (st.status === 'rejected') {
                  return {
                    content: [
                      {
                        type: 'text',
                        text: `MCP tool rejected: ${st.reason || 'operator rejected'}`,
                      },
                    ],
                    details: { isError: true, approval_id: result.approval_id },
                    isError: true,
                  };
                }
              } catch {
                /* keep polling */
              }
            }
            return {
              content: [
                { type: 'text', text: 'MCP tool approval timed out' },
              ],
              details: { isError: true, approval_id: result.approval_id },
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `MCP tool pending approval: ${result.approval_id}`,
              },
            ],
            details: {
              pending_approval: true,
              approval_id: result.approval_id,
            },
          };
        }

        return formatMcpToolResult(result);
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `MCP error: ${err?.message || String(err)}`,
            },
          ],
          details: { isError: true },
          isError: true,
        };
      }
    };

    tools.push({
      name: toolName,
      label: d.raw_name || toolName,
      description,
      parameters: parametersFromSchema(d.input_schema),
      category: TOOL_CATEGORY.MCP,
      meta: {
        server_id: d.server_id,
        raw_name: d.raw_name,
        risk_level: d.risk_level,
        requires_approval: requiresApproval,
      },
      execute: wrapExecute(toolName, executeBody),
    });
  }

  return tools;
}

/**
 * @param {object} result — normalized MCP envelope
 */
export function formatMcpToolResult(result) {
  if (!result) {
    return {
      content: [{ type: 'text', text: 'Empty MCP result' }],
      details: { isError: true },
      isError: true,
    };
  }
  const status = result.status || 'ok';
  const isError = status === 'error' || status === 'denied';
  const text =
    result.error ||
    (typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content ?? result, null, 2));
  return {
    content: [{ type: 'text', text: String(text) }],
    details: {
      status,
      server_id: result.server_id,
      tool_name: result.tool_name,
      duration_ms: result.duration_ms,
      tool_call_id: result.tool_call_id,
      normalized: result.normalized,
      isError,
    },
    isError,
  };
}
