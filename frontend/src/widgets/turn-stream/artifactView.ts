/**
 * 交付物卡片的视图投影（design `docs/design/agent-output-review.md` §8）。
 *
 * 从 `TurnCards.tsx` 拆出来是为了**能被单测**：那个文件是 `.tsx` 且 import 了 CSS
 * module，测试运行器（tsx，无 CSS loader）加载不了它。而「待审/驳回的交付物不能有
 * 下载 URL」这条规则写错了会静默放行一个必然 404 的链接，正是最该被钉住的地方。
 *
 * `TurnCards.tsx` 仍然 re-export 这两个函数，既有调用方（TurnStream / ArtifactDrawer）
 * 的导入路径不变。
 */
import type { ArtifactEntity } from '../../entities/types';
import { getArtifactDownloadUrl } from '../../shared/api/client';
import { isDurableArtifactId } from '../../shared/state/runReducer';
import { downloadAttrName, safeApiUrl } from '../../shared/security/url';

export function extLabel(name: string, mime: string | null): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  if (ext) return ext.toUpperCase();
  return mime?.split('/')[1]?.slice(0, 4).toUpperCase() || 'FILE';
}

/**
 * 交付物卡片的三态文案（design §8）。
 *
 * `pending` / `rejected` 一律**不给下载 URL**：服务端本来就会 404（E2），但把按钮
 * 留在那里等于引导用户去点一个必然失败的链接。
 */
export function deliveryBadge(artifact: ArtifactEntity): string | null {
  if (artifact.reviewStatus === 'pending') return '已提交审核';
  if (artifact.reviewStatus === 'rejected') {
    return artifact.reviewFeedback ? `未通过审核：${artifact.reviewFeedback}` : '未通过审核';
  }
  if (artifact.reviewStatus === 'released') {
    return artifact.reviewRevised ? '已交付 · 经审核员修订' : '已交付';
  }
  return null;
}

/** 下载用的 artifact id：审核员修订后放行的是修订版（原件已撤回，下载必然 404）。 */
export function artifactDownloadId(artifact: ArtifactEntity): string {
  return artifact.reviewReleasedId || artifact.id;
}

/**
 * 会话产物列表里**还没有被卡片代表**的行。卡片按原件 id 建，修订放行后指向修订版，
 * 列表里的修订版就是同一件交付物，不能再补一条。
 */
export function listedNotShownAsCards<T extends { artifact_id?: unknown; id?: unknown }>(
  listed: readonly T[],
  cards: readonly ArtifactEntity[],
): T[] {
  const shown = new Set<string>();
  for (const card of cards) {
    shown.add(card.id);
    if (card.reviewReleasedId) shown.add(card.reviewReleasedId);
  }
  return listed.filter((row) => {
    const id = String(row.artifact_id || row.id || '');
    return Boolean(id) && !shown.has(id);
  });
}

/** Download URL and labels of an artifact card; shared with the preview drawer. */
export function artifactView(artifact: ArtifactEntity, sessionId: string | null) {
  const sid = sessionId || artifact.sessionId;
  const durable = isDurableArtifactId(artifact.id, artifact.runId || '');
  const released = artifact.reviewStatus == null || artifact.reviewStatus === 'released';
  const url = safeApiUrl(
    sid && durable && released ? getArtifactDownloadUrl(sid, artifactDownloadId(artifact)) : null,
  );
  const name = artifact.name || artifact.path || '产物';
  return {
    url,
    name,
    label: extLabel(name, artifact.mimeType),
    downloadName: downloadAttrName(artifact.name, artifact.path),
    badge: deliveryBadge(artifact),
    isImage: Boolean(url && artifact.mimeType?.startsWith('image/') && artifact.mimeType !== 'image/svg+xml'),
  };
}
