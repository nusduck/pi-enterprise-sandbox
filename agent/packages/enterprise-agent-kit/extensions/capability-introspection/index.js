import { Type } from 'typebox';

import { sanitizeUntrustedText } from '../../../../lib/text-redaction.js';

const MAX_QUERY_LEN = 128;
const MAX_NAME_LEN = 128;
const MAX_ID_LEN = 128;
const MAX_CURSOR_LEN = 128;

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: value,
    isError,
  };
}

const DEFAULT_STATUSES = Object.freeze(['active', 'configured', 'failed', 'disabled']);

/**
 * Model-facing capabilities meta-tool (list / search / describe only).
 * Bound to a session-scoped registry via getRegistry closure.
 *
 * @param {{
 *   getRegistry?: () => { list: Function, search: Function, describe: Function } | null,
 *   allowedTools?: string[],
 *   emit?: (e: object) => void,
 *   getMeta?: () => object,
 * }} [options]
 */
export function createCapabilityIntrospectionExtension(options = {}) {
  const allowed = new Set(options.allowedTools || []);
  if (!allowed.has('capabilities')) {
    return function capabilityIntrospectionExtensionDisabled() {
      // Profile did not allow the tool — register nothing.
    };
  }

  return function capabilityIntrospectionExtension(pi) {
    pi.registerTool({
      name: 'capabilities',
      label: 'Capability registry',
      description:
        'Authoritative inventory of skills, tools, extensions, and MCP capabilities ' +
        'for this session. Use action=list to enumerate (paginated — follow next_cursor ' +
        'until null when the user asks for all/every item or a total count), action=search ' +
        'to find by keyword, action=describe for one entry. Always call this tool when asked ' +
        'what skills/tools/extensions are available, how many there are, or to list ' +
        'them all — do not guess from memory. Read-only; never returns secrets or ' +
        'full skill bodies.',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('list'),
          Type.Literal('search'),
          Type.Literal('describe'),
        ]),
        kind: Type.Optional(
          Type.Union([
            Type.Literal('skill'),
            Type.Literal('tool'),
            Type.Literal('extension'),
            Type.Literal('mcp_server'),
            Type.Literal('mcp_tool'),
            Type.Literal('all'),
          ]),
        ),
        status: Type.Optional(
          Type.Union([
            Type.Literal('configured'),
            Type.Literal('active'),
            Type.Literal('disabled'),
            Type.Literal('failed'),
          ]),
        ),
        query: Type.Optional(Type.String({ maxLength: MAX_QUERY_LEN })),
        name: Type.Optional(Type.String({ maxLength: MAX_NAME_LEN })),
        id: Type.Optional(Type.String({ maxLength: MAX_ID_LEN })),
        limit: Type.Optional(Type.Number()),
        cursor: Type.Optional(Type.String({ maxLength: MAX_CURSOR_LEN })),
      }),
      async execute(_toolCallId, input) {
        const registry =
          typeof options.getRegistry === 'function' ? options.getRegistry() : null;
        if (!registry) {
          return result(
            {
              error: 'Capability registry is not available for this session',
            },
            true,
          );
        }

        try {
          const action = input?.action;
          const kind = input.kind === 'all' ? null : input.kind || null;
          if (action === 'list') {
            const payload = registry.list({
              kind,
              status: input.status || undefined,
              statuses: input.status ? undefined : DEFAULT_STATUSES,
              limit: input.limit,
              cursor: input.cursor,
            });
            options.emit?.({
              type: 'capability_registry_queried',
              action: 'list',
              kind: input.kind || 'all',
              returned: payload.returned,
              total: payload.total,
              ...(options.getMeta?.() || {}),
            });
            return result({
              ...payload,
              note:
                'Authoritative live inventory for this session. List results are paginated; ' +
                'follow next_cursor until null for complete inventory. Prefer this over memory of prompt skill lists.',
            });
          }

          if (action === 'search') {
            const query = sanitizeUntrustedText(input.query || '', MAX_QUERY_LEN) || '';
            const payload = registry.search({
              query,
              kind,
              statuses: input.status ? [input.status] : DEFAULT_STATUSES,
              limit: input.limit,
            });
            options.emit?.({
              type: 'capability_registry_queried',
              action: 'search',
              kind: input.kind || 'all',
              query,
              returned: payload.returned,
              ...(options.getMeta?.() || {}),
            });
            return result(payload);
          }

          if (action === 'describe') {
            if (!input.id && !(input.kind && input.name) && !input.name) {
              return result(
                { error: 'describe requires id, or kind+name, or name' },
                true,
              );
            }
            const payload = registry.describe({
              id: input.id,
              kind: input.kind === 'all' ? undefined : input.kind,
              name: input.name,
            });
            if (payload.error) return result(payload, true);
            options.emit?.({
              type: 'capability_registry_queried',
              action: 'describe',
              id: payload.entry?.id,
              ...(options.getMeta?.() || {}),
            });
            return result(payload);
          }

          return result({ error: `Unsupported action: ${action}` }, true);
        } catch (error) {
          const message =
            sanitizeUntrustedText(error?.message || String(error), MAX_QUERY_LEN) ||
            'Capability query failed';
          return result({ error: message }, true);
        }
      },
    });
  };
}
