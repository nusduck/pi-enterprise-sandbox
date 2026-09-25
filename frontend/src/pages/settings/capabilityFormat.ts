/**
 * Status rules for the capabilities tables (pure, so they can be tested).
 */
import type { McpServerItem, ToolRegistryItem } from '../../shared/api/capabilities';

/**
 * The server's canonical `status` wins; `connection_status` is only the
 * transport view and must not override it (a connected server can still be
 * disabled or misconfigured).
 */
export function mcpStatus(item: Pick<McpServerItem, 'status' | 'enabled' | 'connection_status'>): string {
  return item.status || (item.enabled === false ? 'disabled' : item.connection_status || 'configured');
}

export function toolStatus(item: Pick<ToolRegistryItem, 'status' | 'enabled'>): string {
  return item.status || (item.enabled === false ? 'disabled' : 'configured');
}
