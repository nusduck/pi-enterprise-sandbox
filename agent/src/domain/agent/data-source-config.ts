/**
 * AgentVersion `configJson.dataSources`：本 Agent 的 Run 可以在沙箱里连接哪些业务库
 * （docs/design/sandbox-data-sources.md §3.2）。
 *
 * 纯解析，三处共用：
 * - `bindAgentVersionConfig` —— 保存与 Run 启动两个时点 fail-closed；
 * - `AgentConfigValidator` —— 给配置面逐字段诊断；
 * - Run 执行期 —— 投影成随 shell 请求交给 exec 的 id 清单。
 *
 * 条目只有 `id`。地址、账号、口令属于 exec 的数据源目录，出现在这里即拒绝——
 * 与 MCP 条目不收连接材料同一原则。id 是否在目录里由 `AgentCatalogService` 保存时
 * 向 exec 核对（这里没有 I/O）。缺省（键不存在、空数组）= 不连任何库。
 */

import { DATA_SOURCE_ID_PATTERN, ENABLED_DATA_SOURCES_MAX } from '@dsh/contract/data-sources.js';

export const DATA_SOURCE_ENTRY_KEYS = Object.freeze(['id']);

export interface DataSourceDiagnostic {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export const EMPTY_DATA_SOURCES: readonly string[] = Object.freeze([]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析并逐字段诊断。有任何诊断时 `ids` 为 `null`——调用方不得拿半个清单去跑。
 * 重复 id 报错而不是去重：配置面上看到两条同名，说明管理员以为自己配了两个不同的库。
 */
export function parseDataSourceConfig(raw: unknown): {
  ids: readonly string[] | null;
  errors: DataSourceDiagnostic[];
} {
  const errors: DataSourceDiagnostic[] = [];
  if (raw === undefined || raw === null) return { ids: EMPTY_DATA_SOURCES, errors };
  if (!Array.isArray(raw)) {
    errors.push({ path: 'dataSources', code: 'CONFIG_TYPE', message: 'dataSources must be an array of { id }' });
    return { ids: null, errors };
  }
  if (raw.length > ENABLED_DATA_SOURCES_MAX) {
    errors.push({
      path: 'dataSources',
      code: 'CONFIG_LIMIT',
      message: `dataSources allows at most ${ENABLED_DATA_SOURCES_MAX} entries`,
    });
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  raw.forEach((entry, index) => {
    const path = `dataSources[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push({ path, code: 'CONFIG_TYPE', message: `${path} must be an object with an id` });
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!DATA_SOURCE_ENTRY_KEYS.includes(key)) {
        errors.push({
          path: `${path}.${key}`,
          code: 'CONFIG_UNKNOWN_FIELD',
          message: `Unknown field "${path}.${key}"; connection details belong to the platform data source catalog`,
        });
      }
    }
    const id = entry.id;
    if (typeof id !== 'string' || !DATA_SOURCE_ID_PATTERN.test(id)) {
      errors.push({ path: `${path}.id`, code: 'CONFIG_TYPE', message: `${path}.id must be a data source id` });
      return;
    }
    if (seen.has(id)) {
      errors.push({ path: `${path}.id`, code: 'CONFIG_DUPLICATE', message: `Data source "${id}" is listed twice` });
      return;
    }
    seen.add(id);
    ids.push(id);
  });
  return errors.length > 0 ? { ids: null, errors } : { ids: Object.freeze(ids), errors };
}

/** 不在平台数据源目录里的 id：配置面诊断与保存时拒绝共用同一个码。 */
export function unknownDataSources(
  ids: readonly string[],
  catalog: readonly { readonly id: string }[],
): DataSourceDiagnostic[] {
  const known = new Set(catalog.map((entry) => entry.id));
  return ids.flatMap((id, index) => (known.has(id)
    ? []
    : [{
        path: `dataSources[${index}].id`,
        code: 'DATA_SOURCE_UNKNOWN',
        message: `Data source "${id}" is not registered on this platform`,
      }]));
}

/** 规范形态：`[{ id }]`，按配置顺序。空清单返回 `undefined`（不写这个键）。 */
export function normalizedDataSources(ids: readonly string[]): Array<{ id: string }> | undefined {
  return ids.length > 0 ? ids.map((id) => ({ id })) : undefined;
}
