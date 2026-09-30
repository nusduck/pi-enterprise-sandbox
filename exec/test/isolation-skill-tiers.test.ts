/**
 * 系统层 / org 层的**逐包挂载**（ADR 0015 D4/D5；design §8 收紧后只剩逐包）。
 *
 * 这里断言的是「沙箱里到底存在什么」，不是「配置里写了什么」：整树挂载的系统根
 * 会让模型 `ls`/`read` 到未绑定的包——配置说只带 `pdf`、行为却是带全部，
 * 那正是 ADR 0015 拒绝的「发现与挂载不同构」。逐包挂载之后，没进名单的包在
 * `mounts` 里根本不存在。
 *
 * 「没给名单 → 整树挂载」只是滚动升级兼容期的旧 Agent 形状（design §8），
 * 见 `internal-shell-wiring.test.ts` 与 `isolation-preflight.test.ts`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIsolationProfile } from '../src/isolation/build.js';
import {
  AGENT_ORG_SKILL_PATH,
  AGENT_SKILL_PATH,
  AGENT_USER_SKILL_PATH,
  type BindMount,
} from '../src/isolation/profile.js';
import { makeTestWorkspace } from './helpers.js';

function skillMounts(mounts: readonly BindMount[]): BindMount[] {
  return mounts.filter((m) =>
    m.target === AGENT_SKILL_PATH
    || m.target.startsWith(`${AGENT_SKILL_PATH}/`)
    || m.target.startsWith(`${AGENT_USER_SKILL_PATH}/`)
    || m.target.startsWith(`${AGENT_ORG_SKILL_PATH}/`),
  );
}

test('给了系统名单 → 逐包挂载，名单外的包与系统根本身都不在 mounts 里', async () => {
  const ws = await makeTestWorkspace({
    systemSkillNames: ['pdf'],
    systemPackagesNotSelected: ['xlsx'],
  });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    const mounts = skillMounts(profile.mounts as BindMount[]);
    assert.deepEqual(
      mounts.map((m) => [m.target, m.source, m.kind]),
      [[`${AGENT_SKILL_PATH}/pdf`, `${ws.context.systemSkillRoot}/pdf`, 'ro_bind']],
    );
    // 整树挂载会留下 `target === AGENT_SKILL_PATH` 的那一条；逐包模式下它必须消失，
    // 否则名单外的 `xlsx` 依然可见。
    assert.equal(
      mounts.some((m) => m.target === AGENT_SKILL_PATH),
      false,
      'system root must not be mounted as a whole when a name list is given',
    );
  } finally {
    await ws.cleanup();
  }
});

test('系统名单为空数组 → 一个系统包都不挂，但系统根本身也不挂', async () => {
  const ws = await makeTestWorkspace({
    systemSkillNames: [],
    systemPackagesNotSelected: ['pdf', 'xlsx'],
  });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    assert.deepEqual(skillMounts(profile.mounts as BindMount[]), []);
  } finally {
    await ws.cleanup();
  }
});

test('没设系统名单（=空名单）→ 一个系统包都不挂，整树兜底已删除', async () => {
  const ws = await makeTestWorkspace({ systemPackagesNotSelected: ['pdf', 'xlsx'] });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    // 收紧前这条路径会整树 `ro_bind` 系统根——名单外的 `pdf`/`xlsx` 因此可见。
    assert.deepEqual(skillMounts(profile.mounts as BindMount[]), []);
  } finally {
    await ws.cleanup();
  }
});

test('org 层逐包挂到 skill-org，与用户层分开', async () => {
  const ws = await makeTestWorkspace({
    systemSkillNames: ['pdf'],
    enabledPackages: ['mine'],
    orgSkillPackages: ['shared'],
  });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    const mounts = skillMounts(profile.mounts as BindMount[]);
    assert.deepEqual(
      mounts.map((m) => m.target).sort(),
      [
        `${AGENT_SKILL_PATH}/pdf`,
        `${AGENT_USER_SKILL_PATH}/mine`,
        `${AGENT_ORG_SKILL_PATH}/shared`,
      ].sort(),
    );
    // 系统包是硬绑定（release 交付、运行期不可变，design §6.4）；org / user 包不是
    // （一个包挂不上不该让 `pwd` 都用不了）。
    for (const mount of mounts) {
      assert.equal(mount.kind, 'ro_bind');
      assert.equal(
        mount.required,
        mount.target.startsWith(`${AGENT_SKILL_PATH}/`),
        `${mount.target}: only the system tier is a hard mount`,
      );
    }
  } finally {
    await ws.cleanup();
  }
});
