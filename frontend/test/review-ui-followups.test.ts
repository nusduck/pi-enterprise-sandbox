/**
 * PR #72 合并后浏览器复核（2026-10-01）发现的四个界面问题的回归用例。
 *
 * 两条是 CSS（没有浏览器，按 `a11y-responsive.test.ts` 的做法读样式源码断言），
 * 一条是文案，一条是单栏布局下「点了任务没反应」的滚动判定（纯函数）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { roleEventSourceLabel } from '../src/pages/settings/memberRoles.ts';
import { shouldScrollDetailIntoView } from '../src/pages/reviews/reviewErrors.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (...parts: string[]) => readFileSync(join(here, '..', 'src', ...parts), 'utf8');

describe('PR #72 合并后复核的界面回归', () => {
  it('开关开启态的滑块是白色（蓝底上用 #fff，与主按钮一致）', () => {
    const css = readSrc('pages', 'settings', 'membersAdmin.module.css');
    const rule = /\.switch input:checked \+ \.slider::before\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, 'checked 态的滑块规则存在');
    assert.match(rule[1], /background:\s*#fff/);
  });

  it('变更记录的来源 console 是「管理界面」，不论授予还是撤销都成立', () => {
    assert.equal(roleEventSourceLabel('console'), '管理界面');
  });

  it('交付卡片的「点击预览」不随元信息一起断行', () => {
    const css = readSrc('widgets', 'turn-stream', 'turnStream.module.css');
    const rule = /\.artPreview\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, '.artPreview 规则存在');
    assert.match(rule[1], /white-space:\s*nowrap/);
    const tsx = readSrc('widgets', 'turn-stream', 'TurnCards.tsx');
    assert.match(tsx, /className=\{s\.artPreview\}>点击预览</);
  });

  it('审核页自己提供滚动容器（工作台外壳 .workbench-center 是 overflow: hidden）', () => {
    // 2026-10-01 浏览器复核：滚轮滚 10 格 scrollTop 仍是 0，第一屏以下的任务、「加载更多」、
    // 单栏布局下的详情都够不着。工作台里的页面要自己滚（同产物库 artifacts.module.css 的 .page）。
    const css = readSrc('pages', 'reviews', 'reviews.module.css');
    const rule = /\.scroll\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, '.scroll 规则存在');
    assert.match(rule[1], /overflow-y:\s*auto/);
    assert.match(rule[1], /min-height:\s*0/);
    const tsx = readSrc('pages', 'reviews', 'ReviewsPage.tsx');
    assert.match(tsx, /<div className=\{s\.scroll\}>\s*<div className=\{a\.page\}>/);
  });

  it('单栏布局下详情面板在视口外时要滚过去；已经看得到时不动', () => {
    // 1100px 实测：详情面板 top=1498，视口高 683 —— 点了任务看起来什么都没发生。
    assert.equal(shouldScrollDetailIntoView({ top: 1498, viewportHeight: 683 }), true);
    assert.equal(shouldScrollDetailIntoView({ top: 690, viewportHeight: 683 }), true);
    // 两栏布局：详情面板就在列表右侧、顶部可见。
    assert.equal(shouldScrollDetailIntoView({ top: 200, viewportHeight: 683 }), false);
    // 已经滚过头（面板顶在视口上方）也要拉回来。
    assert.equal(shouldScrollDetailIntoView({ top: -400, viewportHeight: 683 }), true);
  });
});
