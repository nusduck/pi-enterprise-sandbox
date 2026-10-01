/**
 * P6：交付物审核的前端（design `docs/design/agent-output-review.md` §8）。
 *
 * 三组断言，每组都是「写错了会静默出错」的地方：
 *
 * 1. **交付卡片三态**：待审/驳回的交付物**没有下载 URL**（服务端本来 404，但按钮
 *    留在那里就是引导用户去点一个必然失败的链接）；
 * 2. **审核工作台纯逻辑**：错误码到中文、列表三态错误优先、版本冲突要刷新；
 * 3. **页面契约**（源码文本）：`/reviews` 路由存在且在 AppShell 里、导航项只在
 *    reviewer 时出现、review 会话隐藏文件面板、智能体配置页有交付策略单选。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (relative: string) => readFileSync(join(__dirname, '..', relative), 'utf8');

import { createEntityStore } from '../src/entities/index.ts';
import { createArtifact } from '../src/entities/store.ts';
import { reducePlatformEvent } from '../src/shared/state/runReducer.ts';
import { normalizeToRuntimeEvent } from '../src/shared/state/platformEventNormalize.ts';
import { deliveryBadge, artifactView, artifactDownloadId, listedNotShownAsCards } from '../src/widgets/turn-stream/artifactView.ts';
import {
  REVIEW_ERROR_ZH,
  deliveryStateLabel,
  deliveryStateForTask,
  isVersionConflict,
  reportActionFailure,
  keepDraftOnError,
  reviewErrorMessage,
  reviewEventLabel,
  reviewListState,
  reviewStatusLabel,
} from '../src/pages/reviews/reviewErrors.ts';
import {
  deliveryPolicyOf,
  deliveryPolicyStructureIssues,
  setDeliveryPolicyMode,
} from '../src/pages/settings/deliveryPolicyHelpers.ts';
import { hasReviewerRole } from '../src/shared/security/roles.ts';

function platformEvent(partial: {
  eventId: string;
  sequence: number;
  type: string;
  data?: Record<string, unknown>;
}) {
  return {
    eventId: partial.eventId,
    eventVersion: 1,
    sequence: partial.sequence,
    type: partial.type,
    timestamp: '2026-10-01T00:00:00.000Z',
    context: {
      orgId: '01HZORG0000000000000000000',
      userId: '01HZUSER000000000000000000',
      runId: '01HZRUN0000000000000000000',
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
    },
    data: partial.data ?? {},
  };
}

const RUN = '01HZRUN0000000000000000000';
const ARTIFACT = 'art_0123456789abcdef';

/** 平台事件 → RuntimeEvent → 归约（与浏览器同一条链路）。 */
function apply(store: ReturnType<typeof createEntityStore>, event: ReturnType<typeof platformEvent>) {
  const runtime = normalizeToRuntimeEvent(event);
  assert.ok(runtime, `event ${event.type} must normalize`);
  return reducePlatformEvent(store, runtime!).store;
}

function storeWithArtifact(reviewStatus: 'pending' | 'released' | 'rejected' | null) {
  const store = createEntityStore();
  store.artifactsById[ARTIFACT] = createArtifact({
    id: ARTIFACT,
    runId: RUN,
    sessionId: '01HZSESS000000000000000000',
    name: '报告.md',
    mimeType: 'text/markdown',
    size: 12,
    reviewStatus,
  });
  return store;
}

describe('交付卡片三态（design §8）', () => {
  it('待审：没有下载 URL，标注「已提交审核」', () => {
    const artifact = storeWithArtifact('pending').artifactsById[ARTIFACT];
    const view = artifactView(artifact, '01HZSESS000000000000000000');
    assert.equal(view.url, null);
    assert.equal(view.badge, '已提交审核');
  });

  it('驳回：没有下载 URL，标注带反馈', () => {
    const artifact = {
      ...storeWithArtifact('rejected').artifactsById[ARTIFACT],
      reviewFeedback: '数据来源不完整',
    };
    const view = artifactView(artifact, '01HZSESS000000000000000000');
    assert.equal(view.url, null);
    assert.match(String(view.badge), /未通过审核/);
    assert.match(String(view.badge), /数据来源不完整/);
  });

  it('已交付：有下载 URL；经审核员修订时标注出来（正向对照）', () => {
    const artifact = {
      ...storeWithArtifact('released').artifactsById[ARTIFACT],
      reviewRevised: true,
    };
    const view = artifactView(artifact, '01HZSESS000000000000000000');
    assert.ok(view.url);
    assert.equal(view.badge, '已交付 · 经审核员修订');
  });

  it('通过且有修订：按原件 id 找到聊天卡片，标「经审核员修订」，下载指向修订版', () => {
    // 2026-10-01 浏览器实测：放行事件只带修订版 id，原件卡片找不到对应、永远停在「已提交审核」。
    const REVISED_ID = 'art_fedcba9876543210';
    const ready = apply(createEntityStore(), platformEvent({
      eventId: 'evt-ready-r',
      sequence: 1,
      type: 'artifact.ready',
      data: { artifactId: ARTIFACT, name: '报告.md', review_status: 'pending' },
    }));
    const store = apply(ready, platformEvent({
      eventId: 'evt-released',
      sequence: 2,
      type: 'artifact.released',
      data: {
        reviewTaskId: '01HZTASK000000000000000000',
        artifacts: [{ artifactId: REVISED_ID, originalArtifactId: ARTIFACT, name: '报告.md', revised: true }],
      },
    }));
    const card = store.artifactsById[ARTIFACT];
    assert.equal(card.reviewStatus, 'released');
    assert.equal(card.reviewRevised, true);
    const view = artifactView(card, '01HZSESS000000000000000000');
    assert.equal(view.badge, '已交付 · 经审核员修订');
    assert.match(String(view.url), new RegExp(REVISED_ID));
    assert.equal(store.artifactsById[REVISED_ID], undefined, '不凭空多出一张卡片');
  });

  it('交付物栏：下载 id 用放行版本，会话列表里的同一件不重复显示', () => {
    // 2026-10-01 浏览器实测：交付物栏用原件 id 拼下载链接（原件已撤回 → 404），且修订版被列表补成第二条。
    const card = { ...storeWithArtifact('released').artifactsById[ARTIFACT], reviewRevised: true, reviewReleasedId: 'art_fedcba9876543210' };
    assert.equal(artifactDownloadId(card), 'art_fedcba9876543210');
    assert.equal(artifactDownloadId(storeWithArtifact(null).artifactsById[ARTIFACT]), ARTIFACT);
    const listed = [{ artifact_id: 'art_fedcba9876543210' }, { artifact_id: 'art_other00000000000' }, { id: ARTIFACT }];
    assert.deepEqual(
      listedNotShownAsCards(listed, [card]).map((row) => row.artifact_id || row.id),
      ['art_other00000000000'],
    );
  });

  it('有修订后驳回：同样按原件 id 把卡片标成未通过', () => {
    const ready = apply(createEntityStore(), platformEvent({
      eventId: 'evt-ready-j',
      sequence: 1,
      type: 'artifact.ready',
      data: { artifactId: ARTIFACT, name: '报告.md', review_status: 'pending' },
    }));
    const store = apply(ready, platformEvent({
      eventId: 'evt-rejected',
      sequence: 2,
      type: 'review.rejected',
      data: {
        reviewTaskId: '01HZTASK000000000000000000',
        feedback: '数据来源不完整',
        artifacts: [{ artifactId: 'art_fedcba9876543210', originalArtifactId: ARTIFACT, name: '报告.md' }],
      },
    }));
    assert.equal(store.artifactsById[ARTIFACT].reviewStatus, 'rejected');
    assert.equal(artifactView(store.artifactsById[ARTIFACT], '01HZSESS000000000000000000').url, null);
  });

  it('direct 会话（reviewStatus 为 null）：行为与以前一致，没有审核字样', () => {
    const artifact = storeWithArtifact(null).artifactsById[ARTIFACT];
    const view = artifactView(artifact, '01HZSESS000000000000000000');
    assert.ok(view.url);
    assert.equal(view.badge, null);
    assert.equal(deliveryBadge(artifact), null);
  });

  it('三态标签文案与「已通过，正在发布」的中间态区分开', () => {
    assert.equal(deliveryStateLabel('pending', false), '已提交审核');
    assert.equal(deliveryStateLabel('released', false), '已交付');
    assert.equal(deliveryStateLabel('released', true), '已交付（经审核员修订）');
    assert.equal(deliveryStateLabel('rejected', false), '未通过审核');
  });

  it('审核工作台的交付物标签按任务状态推导：待领取/审核中都不是「已交付」', () => {
    // 2026-10-01 浏览器实测：待领取任务的交付物被标成「已交付」（标签曾按 canAct 推导）。
    assert.equal(deliveryStateForTask('PENDING'), 'pending');
    assert.equal(deliveryStateForTask('IN_REVIEW'), 'pending');
    assert.equal(deliveryStateForTask('APPROVED'), 'released');
    assert.equal(deliveryStateForTask('REJECTED'), 'rejected');
    assert.equal(deliveryStateForTask(undefined), 'pending');
  });
});

describe('artifact.ready 的 review_status 进实体', () => {
  it('review 会话：事件负载带 review_status → 实体是 pending', () => {
    const store = createEntityStore();
    const next = apply(
      store,
      platformEvent({
        eventId: 'evt_1',
        sequence: 1,
        type: 'artifact.ready',
        data: { artifactId: ARTIFACT, name: '报告.md', mimeType: 'text/markdown', size: 12, review_status: 'pending' },
      }),
    );
    assert.equal(next.artifactsById[ARTIFACT].reviewStatus, 'pending');
  });

  it('direct 会话：没有这个键 → reviewStatus 为 null（不显示审核字样）', () => {
    const store = createEntityStore();
    const next = apply(
      store,
      platformEvent({
        eventId: 'evt_2',
        sequence: 1,
        type: 'artifact.ready',
        data: { artifactId: ARTIFACT, name: '报告.md', mimeType: 'text/markdown', size: 12 },
      }),
    );
    assert.equal(next.artifactsById[ARTIFACT].reviewStatus, null);
  });

  it('artifact.released 把已存在的交付物标成 released，并带上「经修订」', () => {
    let store = createEntityStore();
    store = apply(
      store,
      platformEvent({
        eventId: 'evt_3',
        sequence: 1,
        type: 'artifact.ready',
        data: { artifactId: ARTIFACT, name: '报告.md', review_status: 'pending' },
      }),
    );
    store = apply(
      store,
      platformEvent({
        eventId: 'evt_4',
        sequence: 2,
        type: 'artifact.released',
        data: { reviewTaskId: 'rt1', artifacts: [{ artifact_id: ARTIFACT, name: '报告.md', revised: true }] },
      }),
    );
    assert.equal(store.artifactsById[ARTIFACT].reviewStatus, 'released');
    assert.equal(store.artifactsById[ARTIFACT].reviewRevised, true);
    // 放行后卡片重新可下载。
    assert.ok(artifactView(store.artifactsById[ARTIFACT], '01HZSESS000000000000000000').url);
  });

  it('review.rejected 把交付物标成 rejected 并带上反馈', () => {
    let store = createEntityStore();
    store = apply(
      store,
      platformEvent({
        eventId: 'evt_5',
        sequence: 1,
        type: 'artifact.ready',
        data: { artifactId: ARTIFACT, name: '报告.md', review_status: 'pending' },
      }),
    );
    store = apply(
      store,
      platformEvent({
        eventId: 'evt_6',
        sequence: 2,
        type: 'review.rejected',
        data: { reviewTaskId: 'rt1', feedback: '数据不全', artifacts: [{ artifact_id: ARTIFACT, name: '报告.md' }] },
      }),
    );
    assert.equal(store.artifactsById[ARTIFACT].reviewStatus, 'rejected');
    assert.equal(store.artifactsById[ARTIFACT].reviewFeedback, '数据不全');
    assert.equal(artifactView(store.artifactsById[ARTIFACT], '01HZSESS000000000000000000').url, null);
  });

  it('审核事件不会凭空造出一张交付卡片（从没见过 artifact.ready 的 id）', () => {
    const store = apply(
      createEntityStore(),
      platformEvent({
        eventId: 'evt_7',
        sequence: 1,
        type: 'artifact.released',
        data: { artifacts: [{ artifact_id: 'art_never_seen', revised: false }] },
      }),
    );
    assert.equal(store.artifactsById['art_never_seen'], undefined);
  });
});

describe('审核工作台纯逻辑', () => {
  it('错误码有专门文案，不退化成「操作失败」', () => {
    assert.equal(reviewErrorMessage({ code: 'REVIEW_VERSION_CONFLICT', message: 'conflict' }), '任务已被更新，请刷新后重试');
    assert.equal(reviewErrorMessage({ code: 'REVIEW_SELF_FORBIDDEN' }), '不能审核自己发起的任务');
    assert.equal(REVIEW_ERROR_ZH.REVIEW_ALREADY_CLAIMED, '这个任务已经被领取');
    assert.equal(REVIEW_ERROR_ZH.REVIEW_FEEDBACK_REQUIRED, '驳回必须填写反馈');
    // 未列出的码用服务端文案兜底，最后才是「操作失败」。
    assert.equal(reviewErrorMessage({ code: 'X', message: '服务端说明' }), '服务端说明');
    assert.equal(reviewErrorMessage(null), '操作失败');
  });

  it('列表三态：错误优先（加载失败不能渲染成没有待审任务）', () => {
    assert.equal(reviewListState({ loading: true, error: 'boom', count: 0 }), 'error');
    assert.equal(reviewListState({ loading: true, error: null, count: 0 }), 'loading');
    assert.equal(reviewListState({ loading: false, error: null, count: 0 }), 'empty');
    assert.equal(reviewListState({ loading: false, error: null, count: 2 }), 'ready');
  });

  it('版本冲突要刷新，其余错误保留草稿（已选择的待上传文件不能丢）', () => {
    assert.equal(isVersionConflict({ code: 'REVIEW_VERSION_CONFLICT' }), true);
    assert.equal(isVersionConflict({ code: 'REVIEW_ALREADY_CLAIMED' }), true);
    assert.equal(isVersionConflict({ code: 'REVIEW_FILE_INVALID' }), false);
    assert.equal(keepDraftOnError({ code: 'REVIEW_FILE_INVALID' }), true);
    assert.equal(keepDraftOnError({ code: 'REVIEW_VERSION_CONFLICT' }), false);
  });

  it('状态与事件的中文标签；未知值原样显示，不猜', () => {
    assert.equal(reviewStatusLabel('PENDING'), '待领取');
    assert.equal(reviewStatusLabel('APPROVED'), '已通过');
    assert.equal(reviewStatusLabel('WHATEVER'), 'WHATEVER');
    assert.equal(reviewEventLabel('revised'), '上传修订');
    assert.equal(reviewEventLabel('nope'), 'nope');
  });
});

describe('交付策略配置（design §2/§8）', () => {
  it('direct 时删掉整个键（省略即默认，不改既有 config_hash）', () => {
    const config = { modelPolicy: {}, deliveryPolicy: { mode: 'review' } };
    const next = setDeliveryPolicyMode(config, 'direct');
    assert.equal(Object.hasOwn(next, 'deliveryPolicy'), false);
    assert.equal(deliveryPolicyOf(next), 'direct');
  });

  it('review 写回 { mode }，未知子键原样保留（由服务端报 CONFIG_UNKNOWN_FIELD）', () => {
    const next = setDeliveryPolicyMode({ deliveryPolicy: { future: 1 } }, 'review');
    assert.deepEqual(next.deliveryPolicy, { future: 1, mode: 'review' });
    assert.equal(deliveryPolicyOf(next), 'review');
  });

  it('结构不对时暂停该分类，不覆盖原值', () => {
    assert.deepEqual(deliveryPolicyStructureIssues({ deliveryPolicy: 'review' }), ['deliveryPolicy must be an object']);
    assert.deepEqual(deliveryPolicyStructureIssues({ deliveryPolicy: { mode: 1 } }), ['deliveryPolicy.mode must be a string']);
    const config = { deliveryPolicy: 'review' };
    assert.deepEqual(setDeliveryPolicyMode(config, 'review'), config);
  });

  it('hasReviewerRole 只认 reviewer', () => {
    assert.equal(hasReviewerRole({ roles: ['reviewer'] }), true);
    assert.equal(hasReviewerRole({ roles: ['admin'] }), false);
    assert.equal(hasReviewerRole({ roles: [] }), false);
    assert.equal(hasReviewerRole(null), false);
  });
});

describe('页面契约（源码文本断言：没有组件渲染测试）', () => {
  it('/reviews 路由挂在 AppShell 里（reviewer 不一定是 admin）', () => {
    const router = src('src/app/router/index.tsx');
    assert.match(router, /path="\/reviews"/);
    assert.match(router, /<AppShell><ReviewsPage \/><\/AppShell>/);
  });

  it('主导航的审核入口只在 reviewer 时渲染', () => {
    const sidebar = src('src/widgets/conversation-sidebar/ConversationSidebar.tsx');
    assert.match(sidebar, /hasReviewerRole/);
    assert.match(sidebar, /go\('\/reviews'\)/);
    assert.match(sidebar, /交付物审核/);
  });

  it('review 会话隐藏工作区文件面板并说明原因', () => {
    const inspector = src('src/widgets/context-inspector/ContextInspector.tsx');
    assert.match(inspector, /delivery_mode === 'review'/);
    assert.match(inspector, /工作区文件在审核通过前不对发起人开放/);
  });

  it('智能体配置页有「交付策略」分类与两个单选', () => {
    const editor = src('src/pages/settings/AgentConfigEditor.tsx');
    assert.match(editor, /DeliveryPolicyFields/);
    assert.match(editor, /deliveryPolicyStructureIssues/);
    const agents = src('src/pages/settings/AgentsPage.tsx');
    assert.match(agents, /\['deliveryPolicy', '交付策略'\]/);
    const fields = src('src/pages/settings/DeliveryPolicyFields.tsx');
    assert.match(fields, /直接交付/);
    assert.match(fields, /交付物需人工审核/);
  });

  it('审核工作台的驳回按钮在反馈为空时禁用（与 422 REVIEW_FEEDBACK_REQUIRED 对齐）', () => {
    const page = src('src/pages/reviews/ReviewsPage.tsx');
    assert.match(page, /驳回必须填写原因/);
    assert.match(page, /读取审核队列失败/);
    assert.match(page, /重试/);
    // 加载失败不能渲染成空队列。
    assert.match(page, /没有待领取的审核任务/);
  });

  it('三个交付物渲染点都按审核状态挡下载（漏一个就会出现「卡片说待审、chip 却能下载」）', () => {
    assert.match(src('src/widgets/turn-stream/artifactView.ts'), /reviewStatus == null \|\| artifact\.reviewStatus === 'released'/);
    assert.match(src('src/widgets/deliverables/DeliverablesPanel.tsx'), /artifact-chip-held/);
    assert.match(src('src/widgets/artifact-panel/ArtifactPanel.tsx'), /a\.reviewStatus == null \|\| a\.reviewStatus === 'released'/);
  });
});

describe('审核工作台：动作失败的提示不能被随后的刷新清掉', () => {
  it('版本冲突：先刷新（刷新会清空提示），再写入冲突提示，最终留下的是冲突文案', async () => {
    // 2026-10-01 浏览器实测：409 的提示被紧随其后的列表刷新（load 先清 actionError）抹掉，用户看不到。
    let shown: string | null = null;
    let refreshed = 0;
    await reportActionFailure({ code: 'REVIEW_VERSION_CONFLICT' }, {
      refresh: async () => { refreshed += 1; shown = null; },
      setError: (message) => { shown = message; },
    });
    assert.equal(refreshed, 1);
    assert.equal(shown, '任务已被更新，请刷新后重试');
  });

  it('非冲突错误：不刷新（保留现状与草稿），直接给提示', async () => {
    let refreshed = 0;
    let shown: string | null = null;
    await reportActionFailure({ code: 'REVIEW_FILE_INVALID' }, {
      refresh: async () => { refreshed += 1; },
      setError: (message) => { shown = message; },
    });
    assert.equal(refreshed, 0);
    assert.equal(shown, '修订文件不合法（可能为空或超过 100 MiB）');
  });
});
