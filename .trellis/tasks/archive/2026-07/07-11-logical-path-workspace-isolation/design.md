# Design

## Contracts

业务层只传 `workspace_id` 与逻辑 path。Sandbox storage resolver 独占 `workspace_id → physical root` 映射；path policy 在打开文件前后验证最终 inode/target。执行 worker 把 workspace/Skill bind mount 到稳定逻辑根。

## Lifecycle

Conversation 创建 workspace；Sandbox Session 获取单写租约并启动隔离 worker；Run/长任务续租；Session 结束杀死 worker 和进程组但保留 workspace；新 Session 重新挂载。

## Migration and Rollback

先引入 workspace_id 与 resolver，再迁移 API，最后删除 `_physical_workspace` 对外依赖和 `activate_workspace()` 全局链接。回滚保留 workspace_id 映射；不得重新启用并发不安全 symlink。

