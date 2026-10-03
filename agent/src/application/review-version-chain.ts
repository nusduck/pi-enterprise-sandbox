/**
 * 审核工作台「交付物版本链」的纯逻辑（§3.2.4）。
 *
 * 从 `review-service.ts` 拆出来有两个原因：
 *
 * 1. **行数棘轮**（`tests/test_repository_layout.py`）：应用服务是热点文件，只能减不能增；
 * 2. 这里不碰仓储、事务与传输——输入是审核账本的行，输出是版本表要渲染的形状，
 *    正是最该被单独钉住的部分（哪一版是原件、谁上传的、大小从哪来）。
 *
 * 权威关系：**原件与修订的关系**在 agent 的审核事件里（`revised` 的 from → to），
 * **大小与时间**在 exec 的产物记录里。exec 取不到时留 `null`，界面显示「—」——不猜。
 */
import type { ReviewArtifactMeta } from '../infrastructure/sandbox/internal-review-http.js';
import type { ReviewEventRecord, ReviewItemRecord } from '../infrastructure/mysql/repositories/review-repository.js';

export interface ReviewVersionEntry {
  artifact_id: string;
  current: boolean;
  revision: number;
  uploaded_by_kind: 'agent' | 'reviewer';
  uploaded_by_user_id: string | null;
  created_at: string | null;
  size: number | null;
}

/**
 * 每件交付物的版本链：原件 → … → 当前版本。
 *
 * 原件是智能体在任务创建时提交的；`revised` 事件给出每个修订的目标版本、上传者
 * （actor）与时间。链上一定会有一个 `current`——事件缺失时补当前版本，绝不让表格
 * 少一行。
 */
export function buildVersionChains(input: {
  items: readonly ReviewItemRecord[];
  events: readonly ReviewEventRecord[];
  taskCreatedAt: string | null;
}): Map<number, ReviewVersionEntry[]> {
  const byItem = new Map<number, { artifactId: string; actorUserId: string | null; createdAt: string | null }[]>();
  for (const event of input.events) {
    if (event.eventType !== 'revised' || event.itemNo == null) continue;
    const list = byItem.get(Number(event.itemNo)) ?? [];
    list.push({
      artifactId: String(event.toArtifactId),
      actorUserId: event.actorUserId == null ? null : String(event.actorUserId),
      createdAt: event.createdAt == null ? null : String(event.createdAt),
    });
    byItem.set(Number(event.itemNo), list);
  }

  const chains = new Map<number, ReviewVersionEntry[]>();
  for (const item of input.items) {
    const originalIsCurrent = item.originalArtifactId === item.currentArtifactId;
    const chain: ReviewVersionEntry[] = [
      {
        artifact_id: String(item.originalArtifactId),
        current: originalIsCurrent,
        revision: 0,
        uploaded_by_kind: 'agent',
        uploaded_by_user_id: null,
        created_at: input.taskCreatedAt,
        // 原件仍是当前版本时它的展示元数据就是原件的大小；被替换后要去 exec 取。
        size: originalIsCurrent ? Number(item.sizeBytes) || 0 : null,
      },
    ];
    let revision = 1;
    for (const entry of byItem.get(item.itemNo) ?? []) {
      chain.push({
        artifact_id: entry.artifactId,
        current: entry.artifactId === item.currentArtifactId,
        revision: revision++,
        uploaded_by_kind: 'reviewer',
        uploaded_by_user_id: entry.actorUserId,
        created_at: entry.createdAt,
        size: entry.artifactId === item.currentArtifactId ? Number(item.sizeBytes) || 0 : null,
      });
    }
    if (!chain.some((entry) => entry.current)) {
      chain.push({
        artifact_id: String(item.currentArtifactId),
        current: true,
        revision: revision++,
        uploaded_by_kind: 'agent',
        uploaded_by_user_id: null,
        created_at: null,
        size: Number(item.sizeBytes) || 0,
      });
    }
    chains.set(item.itemNo, chain);
  }
  return chains;
}

/** 版本链里出现的全部 artifact id（去重），用于一次元数据查询。 */
export function collectArtifactIds(chains: Map<number, ReviewVersionEntry[]>): string[] {
  const ids = new Set<string>();
  for (const chain of chains.values()) {
    for (const entry of chain) ids.add(String(entry.artifact_id));
  }
  return [...ids];
}

/**
 * 用 exec 的元数据补齐版本链（大小、上传者类型、时间）。
 *
 * 只在能对上的 id 上覆盖；对不上的保持原样（界面显示「—」）。调用方负责吞掉传输
 * 错误——元数据是增强项，取不到不该让详情打不开。
 */
export function applyArtifactMeta(
  chains: Map<number, ReviewVersionEntry[]>,
  rows: readonly ReviewArtifactMeta[],
): void {
  const byId = new Map(rows.map((row) => [row.artifactId, row]));
  for (const chain of chains.values()) {
    for (const entry of chain) {
      const row = byId.get(String(entry.artifact_id));
      if (!row) continue;
      entry.uploaded_by_kind = row.createdByKind;
      if (Number.isFinite(row.size)) entry.size = row.size;
      if (row.createdAt) entry.created_at = row.createdAt;
    }
  }
}
