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

import { createEntityStore, processPanelState, setProcessListState } from '../src/entities/index.ts';
import { createArtifact, createRun } from '../src/entities/store.ts';
import { reduceRuntimeEvent } from '../src/shared/state/runReducer.ts';
import { normalizeToRuntimeEvent } from '../src/shared/state/platformEventNormalize.ts';
import { deliveryBadge, deliveryHint, artifactView, artifactDownloadId, listedNotShownAsCards } from '../src/widgets/turn-stream/artifactView.ts';
import {
  REVIEW_ERROR_ZH,
  REVIEW_LIST_FILTERS,
  deliveryStateLabel,
  deliveryStateForTask,
  deliveryTone,
  isVersionConflict,
  reportActionFailure,
  keepDraftOnError,
  reviewDetailTitle,
  reviewErrorMessage,
  reviewEventDetail,
  reviewEventLabel,
  reviewListState,
  reviewStatusLabel,
  reviewStatusTone,
  reviewTaskItemLabel,
  reviewVersionUploader,
} from '../src/pages/reviews/reviewErrors.ts';
import {
  deliveryPolicyOf,
  deliveryPolicyStructureIssues,
  setDeliveryPolicyMode,
} from '../src/pages/settings/deliveryPolicyHelpers.ts';
import { hasReviewerRole } from '../src/shared/security/roles.ts';
import { inspectorWorkspaceTabs } from '../src/widgets/context-inspector/inspectorTabs.ts';
import {
  REVIEW_RESULT_POLL_MS,
  createReviewResultPoller,
  hasPendingReviewArtifact,
  shouldPollReviewResults,
} from '../src/features/chat/reviewResultPolling.ts';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';

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
  return reduceRuntimeEvent(store, runtime!).store;
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

  it('已提交审核：卡片上有一句话说明「审核通过后可下载」（§3.3.2）', () => {
    const pending = storeWithArtifact('pending').artifactsById[ARTIFACT];
    assert.equal(deliveryHint(pending), '审核通过后可下载');
    assert.equal(artifactView(pending, '01HZSESS000000000000000000').hint, '审核通过后可下载');
    // 其余状态不需要这句（已交付/未通过各自有明确文案）。
    assert.equal(deliveryHint(storeWithArtifact('released').artifactsById[ARTIFACT]), null);
    assert.equal(deliveryHint(storeWithArtifact('rejected').artifactsById[ARTIFACT]), null);
    assert.equal(deliveryHint(storeWithArtifact(null).artifactsById[ARTIFACT]), null);
  });

  it('修订放行后卡片显示修订版大小，而不是原件大小（§3.3.1）', () => {
    // 2026-10-01 浏览器实测：审核员修订后放行，聊天卡片仍显示原件的 44 B。
    const REVISED_ID = 'art_fedcba9876543210';
    let store = apply(createEntityStore(), platformEvent({
      eventId: 'evt-ready-size',
      sequence: 1,
      type: 'artifact.ready',
      data: { artifactId: ARTIFACT, name: '报告.md', size: 44, review_status: 'pending' },
    }));
    assert.equal(store.artifactsById[ARTIFACT].size, 44);
    store = apply(store, platformEvent({
      eventId: 'evt-released-size',
      sequence: 2,
      type: 'artifact.released',
      data: {
        reviewTaskId: '01HZTASK000000000000000000',
        artifacts: [{
          artifactId: REVISED_ID,
          originalArtifactId: ARTIFACT,
          name: '报告.md',
          size: 12345,
          revised: true,
        }],
      },
    }));
    assert.equal(store.artifactsById[ARTIFACT].size, 12345);
    assert.equal(store.artifactsById[ARTIFACT].reviewRevised, true);
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

  it('review 会话同时隐藏进程页签；进程面板有独立的错误态（T3）', () => {
    const inspector = src('src/widgets/context-inspector/ContextInspector.tsx');
    assert.match(inspector, /inspectorWorkspaceTabs\(reviewSession\)/);
    assert.match(inspector, /读取后台进程失败/);
    assert.match(inspector, /这不代表「这个会话没有后台进程」/);
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

describe('审计时间线的事件详情（T4）', () => {
  it('提交审核：把 {"items":N,"materials":M} 格式化成中文，而不是原样显示 JSON', () => {
    assert.equal(
      reviewEventDetail({ event_type: 'created', detail: '{"items":1,"materials":0}', item_no: null }),
      '1 件交付物，0 个附件',
    );
    assert.equal(
      reviewEventDetail({ event_type: 'created', detail: '{"items":3,"materials":2}', item_no: null }),
      '3 件交付物，2 个附件',
    );
  });

  it('上传修订：件数由列表的「第 N 件」渲染，详情不重复', () => {
    assert.equal(reviewEventDetail({ event_type: 'revised', detail: null, item_no: 1 }), null);
  });

  it('未知结构时宁可不显示详情，也绝不显示 JSON', () => {
    assert.equal(reviewEventDetail({ event_type: 'created', detail: '{"foo":1}', item_no: null }), null);
    assert.equal(reviewEventDetail({ event_type: 'mystery', detail: '{"a":[1,2]}', item_no: null }), null);
    assert.equal(reviewEventDetail({ event_type: 'created', detail: 'not json', item_no: null }), null);
    assert.equal(reviewEventDetail({ event_type: 'created', detail: '[1,2]', item_no: null }), null);
    assert.equal(reviewEventDetail(null), null);
  });

  it('管理员释放领取的英文 detail 翻成中文；普通释放没有详情', () => {
    assert.equal(
      reviewEventDetail({ event_type: 'released_claim', detail: 'admin released the claim', item_no: null }),
      '管理员释放了领取',
    );
    assert.equal(reviewEventDetail({ event_type: 'released_claim', detail: null, item_no: null }), null);
  });

  it('通过备注 / 驳回反馈作为纯文本显示（带标签），空白不显示', () => {
    assert.equal(reviewEventDetail({ event_type: 'approved', detail: '可以交付', item_no: null }), '备注：可以交付');
    assert.equal(reviewEventDetail({ event_type: 'rejected', detail: '数据不全', item_no: null }), '反馈：数据不全');
    assert.equal(reviewEventDetail({ event_type: 'approved', detail: '   ', item_no: null }), null);
    assert.equal(reviewEventDetail({ event_type: 'rejected', detail: null, item_no: null }), null);
  });
});

describe('会话资料面板的进程页签（T3）', () => {
  it('review 会话隐藏「文件」与「进程」两个页签（服务端两个通道都 404）', () => {
    // 2026-10-01 浏览器实测：review 会话的进程接口按设计 404，面板却显示「还没有后台进程」。
    assert.deepEqual(inspectorWorkspaceTabs(true), { files: false, processes: false });
    assert.deepEqual(inspectorWorkspaceTabs(false), { files: true, processes: true });
  });

  it('进程列表拉取失败 → 错误态，不是「还没有后台进程」；空列表才是空状态', () => {
    assert.equal(processPanelState({ state: 'error', count: 0 }), 'error');
    assert.equal(processPanelState({ state: 'loading', count: 0 }), 'loading');
    assert.equal(processPanelState({ state: 'ready', count: 0 }), 'empty');
    assert.equal(processPanelState({ state: 'ready', count: 2 }), 'ready');
    // 还没拉取过：沿用既有空状态，不假装在加载。
    assert.equal(processPanelState({ state: null, count: 0 }), 'empty');
    // 已经有数据时，一次刷新失败不能让已经看到的进程消失。
    assert.equal(processPanelState({ state: 'error', count: 2 }), 'ready');
  });

  it('setProcessListState 是纯函数，按会话记录状态', () => {
    const before = createEntityStore();
    assert.equal(before.processListStateById['sess_1'], undefined);
    const after = setProcessListState(before, 'sess_1', 'error');
    assert.equal(after.processListStateById['sess_1'], 'error');
    assert.equal(before.processListStateById['sess_1'], undefined, '不就地改原 store');
  });
});

describe('审核工作台列表与详情的信息设计（§3.2）', () => {
  it('列表的交付物列：首件名（多件时带件数）；没有名字时只给件数', () => {
    assert.equal(reviewTaskItemLabel({ first_item_name: '报告.md', item_count: 1 }), '报告.md');
    assert.equal(reviewTaskItemLabel({ first_item_name: '报告.md', item_count: 3 }), '报告.md 等 3 件');
    assert.equal(reviewTaskItemLabel({ first_item_name: null, item_count: 2 }), '2 件');
    assert.equal(reviewTaskItemLabel({ item_count: 0 }), '—');
    assert.equal(reviewTaskItemLabel(null), '—');
  });

  it('详情标题不用 ULID：交付物名优先，其次「智能体名 · 发起人」', () => {
    assert.equal(
      reviewDetailTitle({ items: [{ name: '报告.md' }], agent: { name: '分析智能体' }, requester: { display_name: '发起人' } }),
      '报告.md',
    );
    assert.equal(
      reviewDetailTitle({ items: [{ name: 'a.md' }, { name: 'b.md' }], agent: { name: '分析智能体' }, requester: { display_name: '发起人' } }),
      'a.md 等 2 件',
    );
    assert.equal(
      reviewDetailTitle({ items: [], agent: { name: '分析智能体' }, requester: { display_name: '发起人' } }),
      '分析智能体 · 发起人',
    );
    assert.equal(reviewDetailTitle({ items: [], agent: null, requester: null }), '智能体');
    assert.equal(reviewDetailTitle(null), '审核任务');
  });

  it('版本表的上传者：修订显示审核员显示名，原件显示智能体', () => {
    assert.equal(reviewVersionUploader({ uploaded_by_kind: 'agent' }), '智能体');
    assert.equal(reviewVersionUploader({ uploaded_by_kind: 'reviewer', uploaded_by_display_name: '审核员甲' }), '审核员甲');
    assert.equal(reviewVersionUploader({ uploaded_by_kind: 'reviewer', uploaded_by_display_name: null }), '审核员');
    assert.equal(reviewVersionUploader({}), '智能体');
  });

  it('任务状态与交付物状态共用同一套颜色语义（驳回/未通过同色，通过/已交付同色）', () => {
    // 2026-10-01 浏览器实测：任务是红色「已驳回」，交付物却是蓝色「未通过审核」。
    assert.equal(reviewStatusTone('REJECTED'), 'err');
    assert.equal(deliveryTone(deliveryStateForTask('REJECTED')), 'err');
    assert.equal(reviewStatusTone('APPROVED'), 'ok');
    assert.equal(deliveryTone(deliveryStateForTask('APPROVED')), 'ok');
    assert.equal(deliveryTone(deliveryStateForTask('PENDING')), 'warn');
    assert.equal(reviewStatusTone('IN_REVIEW'), 'warn');
    assert.equal(reviewStatusTone('WHATEVER'), 'mute');
  });

  it('列表/详情/版本表都用了新投影；「Run」列头改成中文；提问标出触发的一条', () => {
    const page = src('src/pages/reviews/ReviewsPage.tsx');
    assert.match(page, /reviewTaskItemLabel/);
    assert.match(page, /reviewDetailTitle/);
    assert.match(page, /reviewVersionUploader/);
    assert.match(page, /运行结果/);
    assert.doesNotMatch(page, /<th>Run<\/th>/);
    assert.match(page, /本次/);
    // 读取失败不能渲染成空队列；三态与 RunsPage 同款 class。
    assert.match(page, /读取审核队列失败/);
    assert.match(page, /重试/);
    // artifact id 降级为悬停提示，不再是版本表的主列。
    assert.match(page, /artifact_id/);
    assert.match(page, /title=\{.*artifact_id/s);
  });

  it('详情面板吸顶并可独立滚动（列表很长时点下面的行也看得到详情）', () => {
    const css = src('src/pages/reviews/reviews.module.css');
    assert.match(css, /\.detailPane\s*\{[^}]*position:\s*sticky/);
    assert.match(css, /\.detailPane\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('详情里的版本表短字段不换行、两栏布局不会把面板挤出视口（R5）', () => {
    const css = src('src/pages/reviews/reviews.module.css');
    // 不加这条，「下载」会竖排成「下 / 载」、「13 B」也会断行。
    assert.match(css, /\.detailPane\s+th,\s*\n?\s*\.detailPane\s+td\s*\{[^}]*white-space:\s*nowrap/);
    // 详情给足最小宽度，列表可收缩（列表用固定列宽 + 省略号，缩得起）。
    assert.match(css, /\.layout\s*\{[^}]*minmax\(420px/);
    // 窄屏单栏：minmax 的下限在 1100px 会把面板顶出视口。
    assert.match(
      css,
      /@media\s*\(max-width:\s*1200px\)\s*\{[\s\S]*?\.layout\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
    const page = src('src/pages/reviews/ReviewsPage.tsx');
    // 版本表的单元格都带上可省略的类，长 artifact id 不撑破列。
    assert.match(page, /shortArtifactId/);
  });

  it('DTO 收下列表与版本表要用的字段（契约漂移会抛错，不会静默降级）', () => {
    const api = src('src/shared/api/reviews.ts');
    assert.match(api, /first_item_name/);
    assert.match(api, /agent_name/);
    assert.match(api, /uploaded_by_kind/);
    assert.match(api, /uploaded_by_display_name/);
    assert.match(api, /triggering/);
    assert.match(api, /name:\s*nullableString/);
  });
});

describe('发起人页面的审核结果轮询（T1）', () => {
  function storeWithReviewArtifact(reviewStatus: 'pending' | 'released' | 'rejected' | null, conversationId = 'conv_1') {
    const store = createEntityStore();
    store.runsById[RUN] = createRun({ id: RUN, conversationId });
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

  it('只有当前会话里还有待审交付物时才轮询', () => {
    // 2026-10-01：Run 终态后 SSE 关闭，审核结果之后才追加到已结束的 Run 上。
    assert.equal(hasPendingReviewArtifact(storeWithReviewArtifact('pending'), 'conv_1'), true);
    assert.equal(hasPendingReviewArtifact(storeWithReviewArtifact('released'), 'conv_1'), false);
    assert.equal(hasPendingReviewArtifact(storeWithReviewArtifact('rejected'), 'conv_1'), false);
    assert.equal(hasPendingReviewArtifact(storeWithReviewArtifact(null), 'conv_1'), false);
    // 别的会话的待审交付物不该让这个页面发请求。
    assert.equal(hasPendingReviewArtifact(storeWithReviewArtifact('pending', 'conv_2'), 'conv_1'), false);
    assert.equal(hasPendingReviewArtifact(createEntityStore(), 'conv_1'), false);
    assert.equal(hasPendingReviewArtifact(storeWithReviewArtifact('pending'), null), false);
  });

  it('页面不可见时不轮询；没有待审交付物就停', () => {
    assert.equal(shouldPollReviewResults({ pending: true, visible: true }), true);
    assert.equal(shouldPollReviewResults({ pending: true, visible: false }), false);
    assert.equal(shouldPollReviewResults({ pending: false, visible: true }), false);
    assert.equal(shouldPollReviewResults({ pending: false, visible: false }), false);
  });

  it('轮询间隔在任务单要求的 15–30 秒之间', () => {
    assert.ok(REVIEW_RESULT_POLL_MS >= 15_000 && REVIEW_RESULT_POLL_MS <= 30_000, `间隔是 ${REVIEW_RESULT_POLL_MS}`);
  });

  it('轮询接在 ChatContext 上：重放会话事件、跟随页面可见性、离开时清理定时器', () => {
    const ctx = src('src/features/chat/ChatContext.tsx');
    assert.match(ctx, /useReviewResultPolling\(bridge, entityStore, state\.conversationId\)/);
    const hook = src('src/features/chat/useReviewResultPolling.ts');
    assert.match(hook, /hasPendingReviewArtifact/);
    assert.match(hook, /createReviewResultPoller/);
    assert.match(hook, /pollReviewDecisions/);
    assert.match(hook, /document\.addEventListener\('visibilitychange'/);
    assert.match(hook, /removeEventListener\('visibilitychange'/);
    // R2 的根因：不能因为「此刻不可见」就整体 return（那样监听永远装不上）。
    assert.doesNotMatch(hook, /shouldPollReviewResults\(\{[\s\S]*?\}\)\) return;/);
  });

  it('页面在后台时出现待审交付物：不排定时器，切回前台立即开始（R2）', () => {
    // 场景：发起任务后切走等结果，Run 在后台结束、pending 变真。
    let visible = false;
    const polls: number[] = [];
    let intervalFn: (() => void) | null = null;
    const poller = createReviewResultPoller({
      poll: () => polls.push(1),
      isVisible: () => visible,
      setInterval: (fn) => {
        intervalFn = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        intervalFn = null;
      },
    });

    poller.start(); // 后台启动：监听已装好，但不该发请求
    assert.equal(polls.length, 0, '不可见时不发请求');
    assert.equal(intervalFn, null, '不可见时不排定时器');

    visible = true;
    poller.onVisibilityChange();
    assert.equal(polls.length, 1, '切回前台立即拉一次，不必等满 20 秒');
    assert.ok(intervalFn, '并开始排定时器');
  });

  it('切到后台停止、再切回来重启；dispose 后不再启动（R2）', () => {
    let visible = true;
    const polls: number[] = [];
    let intervalFn: (() => void) | null = null;
    let cleared = 0;
    const poller = createReviewResultPoller({
      poll: () => polls.push(1),
      isVisible: () => visible,
      setInterval: (fn) => {
        intervalFn = fn;
        return 7 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        cleared += 1;
        intervalFn = null;
      },
    });

    poller.start();
    assert.equal(polls.length, 1);
    const tick = intervalFn as unknown as () => void;
    tick();
    assert.equal(polls.length, 2, '定时器到点会再拉');

    visible = false;
    poller.onVisibilityChange();
    assert.equal(intervalFn, null, '隐藏时停表');
    assert.equal(cleared, 1);

    visible = true;
    poller.onVisibilityChange();
    assert.equal(polls.length, 3, '再切回来立刻拉一次');

    poller.dispose();
    assert.equal(intervalFn, null);
    poller.start();
    assert.equal(polls.length, 3, 'dispose 之后不再启动');
  });

  it('轮询一次只发 1 个请求，只归约审核结果事件、不动其他 Run（R3）', async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/api/conversations/conv_r3/events')) {
        return new Response(
          JSON.stringify({
            runs: [
              { run_id: RUN, conversation_id: 'conv_r3', status: 'succeeded' },
              { run_id: 'run_live', conversation_id: 'conv_r3', status: 'running' },
            ],
            events: [
              // 非审核事件：轮询不该处理（Run 状态由 SSE / 打开会话时的重放负责）。
              { run_id: RUN, type: 'message.delta', sequence: 4, event_id: 'evt_msg', payload: { text: 'hi' } },
              // 审核结果：要处理。
              {
                run_id: RUN,
                type: 'artifact.released',
                sequence: 3,
                event_id: 'evt_released',
                payload: {
                  reviewTaskId: '01HZTASK000000000000000000',
                  artifacts: [{ artifactId: 'art_new', originalArtifactId: ARTIFACT, name: '报告.md', size: 123, revised: true }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      const bridge = createEntityBridge();
      // 造出待审交付物与一个正在流式的 Run。
      bridge.manager.handleEvent(platformEvent({
        eventId: 'evt_start',
        sequence: 1,
        type: 'run.started',
        data: { conversation_id: 'conv_r3' },
      }));
      bridge.manager.handleEvent(platformEvent({
        eventId: 'evt_ready',
        sequence: 2,
        type: 'artifact.ready',
        data: { artifactId: ARTIFACT, name: '报告.md', size: 44, review_status: 'pending' },
      }));
      const beforeLive = bridge.getStore().runsById[RUN]?.lastSequence;

      const applied = await bridge.pollReviewDecisions('conv_r3');

      assert.equal(requests.length, 1, '一次轮询只发一个请求');
      assert.match(requests[0], /\/api\/conversations\/conv_r3\/events$/);
      assert.equal(applied, 1, '只应用了那一条审核结果事件');
      const artifact = bridge.getStore().artifactsById[ARTIFACT];
      assert.equal(artifact.reviewStatus, 'released');
      assert.equal(artifact.reviewRevised, true);
      assert.equal(artifact.size, 123);
      assert.equal(artifact.reviewReleasedId, 'art_new');
      // 非审核事件没有被处理：Run 的游标只推进到审核结果那一条。
      assert.equal(bridge.getStore().runsById[RUN].lastSequence, 3);
      assert.ok(beforeLive !== undefined);

      // 再轮询一次：同一条事件被去重，不再应用。
      requests.length = 0;
      const again = await bridge.pollReviewDecisions('conv_r3');
      assert.equal(requests.length, 1);
      assert.equal(again, 0, '重复事件被 event_id 去重');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('交付策略单选排版（T2）', () => {
  it('两个选项共用同一套单选行：圆圈与标题同列、说明是独立文本列（长说明不挤开圆圈）', () => {
    // 2026-10-01 浏览器实测：第二个选项的说明换行时，单选框被挤到单独一行。
    const fields = src('src/pages/settings/DeliveryPolicyFields.tsx');
    // 两个选项来自同一个列表、共用同一行样式，排版不会各自漂移。
    assert.match(fields, /DELIVERY_POLICY_OPTIONS\.map/);
    assert.match(fields, /className=\{s\.deliveryOption\}/);
    assert.match(fields, /s\.deliveryOptionText/);
    const css = src('src/pages/settings/agents.module.css');
    assert.match(css, /\.deliveryOption\s*\{[^}]*align-items:\s*flex-start/);
    assert.match(css, /\.deliveryOptionText\s*\{[^}]*min-width:\s*0/);
  });
});

describe('审核列表页签（T5）', () => {
  it('历史页签传「已通过,已驳回」多值，而不是空值（等于不筛选）', () => {
    // 2026-10-01 浏览器实测：「历史」页签列出了待领取/审核中的任务，因为它传 status=null。
    const history = REVIEW_LIST_FILTERS.find((f) => f.id === 'history');
    assert.equal(history?.status, 'APPROVED,REJECTED');
  });

  it('待领取/我领取的仍是单值（单值筛选行为不变）', () => {
    const pending = REVIEW_LIST_FILTERS.find((f) => f.id === 'pending');
    const mine = REVIEW_LIST_FILTERS.find((f) => f.id === 'mine');
    assert.equal(pending?.status, 'PENDING');
    assert.equal(mine?.status, 'IN_REVIEW');
    assert.equal(mine?.mine, true);
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
