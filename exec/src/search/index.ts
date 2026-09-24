/** 搜索面（find / grep）。见 `service.ts` 的两条不变量。 */
export { FileSearchService, fileSearchService, SearchQueryError } from './service.js';
export type { FindOptions, GrepOptions, LsOptions } from './service.js';
export type {
  FileSearchItem,
  FileSearchResponse,
  FileSearchSkipped,
  FileSearchStats,
  GrepMatch,
  GrepResponse,
  SearchRoot,
} from './types.js';
export { globMatches, isBinaryBytes, compileGrepQuery } from './predicates.js';
export * from './limits.js';
