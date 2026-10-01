/**
 * 会话资料面板的页签可见性（T3 / design `docs/design/agent-output-review.md` §8）。
 *
 * 抽成纯函数是为了能直接单测：review 会话里**「文件」和「进程」两个通道在服务端都会
 * 返回 404**（E5 / E6——否则发起人可以直接读工作区字节或 `cat` 出文件内容绕过审核）。
 * 把页签留在那里等于引导用户去点一个必然失败的链接，所以一并隐藏。
 *
 * 文件页签先这样做；进程页签在 2026-10-01 浏览器实测后对齐——它当时把 404 渲染成了
 * 「这个会话还没有后台进程」。
 */
export function inspectorWorkspaceTabs(reviewSession: boolean): {
  files: boolean;
  processes: boolean;
} {
  return reviewSession
    ? { files: false, processes: false }
    : { files: true, processes: true };
}
