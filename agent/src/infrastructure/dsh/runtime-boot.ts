/**
 * Agent → @pi/runtime 接线入口。Wave 6 用这个取代 infrastructure/pi/pi-runtime-factory。
 *
 * 当前 Pi executor 仍在，本模块是 DSH 组合层的唯一进口：凭据 fail-closed、
 * 远程 fs/shell/jobs 工厂、会话后端。删除 Pi 工厂前，调用方先迁到这里。
 */

export {
  assertBootReady,
  createRemoteProviders,
  createSessionBackend,
  mountSessionPersistence,
  assembleSystemPrompt,
  ENTERPRISE_CLAUSES,
} from '../../runtime/index.js';
