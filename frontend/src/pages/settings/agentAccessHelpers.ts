/**
 * 智能体可见范围编辑的纯函数（design docs/design/agent-visibility.md §6）。
 * 服务端是权威：这里只管草稿怎么变、有没有改动、错误怎么说，不判断「谁能用」。
 */
import type { AgentAccess, AgentVisibility } from '../../shared/api/agents';

export type AccessGrant = {
  user_id: string;
  username: string | null;
  display_name: string | null;
};

export type AccessDraft = {
  visibility: AgentVisibility;
  grants: AccessGrant[];
};

export function draftFromAccess(access: AgentAccess): AccessDraft {
  return {
    visibility: access.visibility,
    grants: access.grants.map((g) => ({ user_id: g.user_id, username: g.username, display_name: g.display_name })),
  };
}

/** 名单只在 `restricted` 时有意义；`org` 时比较忽略名单（服务端会清空它）。 */
export function accessDraftChanged(saved: AccessDraft | null, draft: AccessDraft): boolean {
  if (!saved) return false;
  if (saved.visibility !== draft.visibility) return true;
  if (draft.visibility === 'org') return false;
  const a = saved.grants.map((g) => g.user_id).sort();
  const b = draft.grants.map((g) => g.user_id).sort();
  return a.length !== b.length || a.some((id, i) => id !== b[i]);
}

export function addGrant(draft: AccessDraft, member: AccessGrant): AccessDraft {
  if (draft.grants.some((g) => g.user_id === member.user_id)) return draft;
  return { ...draft, grants: [...draft.grants, member] };
}

export function removeGrant(draft: AccessDraft, userId: string): AccessDraft {
  return { ...draft, grants: draft.grants.filter((g) => g.user_id !== userId) };
}

export function accessPayload(draft: AccessDraft): { visibility: AgentVisibility; user_ids: string[] } {
  return {
    visibility: draft.visibility,
    user_ids: draft.visibility === 'restricted' ? draft.grants.map((g) => g.user_id) : [],
  };
}

/** 成员展示：工号（用户名）优先，带上姓名；都没有就显示内部 ID 前缀，不留空。 */
export function memberLabel(member: AccessGrant): string {
  const name = member.display_name && member.display_name !== member.username ? member.display_name : null;
  if (member.username) return name ? `${member.username} · ${name}` : member.username;
  return name ?? member.user_id.slice(0, 10);
}

export function accessErrorMessage(error: unknown): string {
  const status = (error as { status?: unknown })?.status;
  const message = (error as Error)?.message;
  if (status === 403) return '只有管理员可以设置可见范围。';
  if (status === 404) return '这个智能体不存在或已被删除，请刷新列表。';
  if (status === 422 || status === 400) {
    if (typeof message === 'string' && /default agent/i.test(message)) {
      return '默认智能体必须对全员可见。';
    }
    if (typeof message === 'string' && /Not active members/i.test(message)) {
      return '名单里有已停用或不在本组织的成员，请移除后再保存。';
    }
    return `保存被拒绝：${message || '输入不合法'}`;
  }
  return message ? `操作失败：${message}` : '操作失败，请重试。';
}
