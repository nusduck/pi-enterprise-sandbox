/**
 * 身份代次（identity revision）：登录/注册/退出的成功切换会让代次前进一次。
 *
 * 所有账号作用域的异步响应（`me`/config/catalog/会话/profile）在发请求前记下
 * 当时的代次，落地前再对一次；代次变了就直接丢弃。**过期响应绝不能灌回新身份**：
 * 旧账号的目录/资料/会话响应在新账号界面上出现，比少显示一条更糟。
 *
 * 刻意不放在 React state 里：代次是同步可读的守卫值，读的时候不能等一次渲染。
 */
export function createIdentityRevision() {
  let revision = 0;
  return {
    /** 身份边界（切换成功/退出）：旧请求的落地许可立刻作废。 */
    bump(): number {
      revision += 1;
      return revision;
    },
    /** 发请求前取快照。 */
    current(): number {
      return revision;
    },
    /** 落地前核对：true 表示这个响应仍属于当前身份。 */
    isCurrent(snapshot: number): boolean {
      return snapshot === revision;
    },
  };
}

export type IdentityRevision = ReturnType<typeof createIdentityRevision>;

/**
 * 便捷读法：`isCurrentIdentity(revision, snapshot)`。等价于
 * `revision.isCurrent(snapshot)`，但让「过期响应不许灌回新身份」的判定在调用点
 * 一眼可读，不必先展开 revision 对象。
 */
export function isCurrentIdentity(revision: IdentityRevision, snapshot: number): boolean {
  return revision.isCurrent(snapshot);
}
