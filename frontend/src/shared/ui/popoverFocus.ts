/**
 * Popover 的焦点规则（纯函数，便于脱离 DOM 单测）。
 *
 * 为什么单独成文件：真实浏览器验收发现，弹层打开时焦点留在触发器上，而 Esc/方向键
 * 只在弹层自身的 onKeyDown 里处理——键盘用户点开后按什么都没反应。修复的关键是
 * 「打开时把焦点放进弹层的哪一个元素」与「方向键怎么移动」，这两件事在这里定死。
 */

/** 只依赖这几个成员，测试里可以用普通对象替身。 */
export interface FocusCandidate {
  tagName: string;
  getAttribute(name: string): string | null;
}

const SELECTED_ATTRS = ['aria-selected', 'aria-checked', 'aria-pressed'] as const;

function isSearchField(el: FocusCandidate): boolean {
  if (el.tagName.toUpperCase() !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return type === 'search' || type === 'text';
}

function isSelected(el: FocusCandidate): boolean {
  return SELECTED_ATTRS.some((attr) => el.getAttribute(attr) === 'true');
}

/**
 * 打开弹层时应获得焦点的元素下标：有搜索框先给搜索框（用户要打字），
 * 否则给当前选中项（键盘用户从当前值出发），再否则给第一个；没有可聚焦元素返回 -1。
 */
export function initialFocusIndex(candidates: readonly FocusCandidate[]): number {
  if (!candidates.length) return -1;
  const search = candidates.findIndex(isSearchField);
  if (search >= 0) return search;
  const selected = candidates.findIndex(isSelected);
  return selected >= 0 ? selected : 0;
}

/** 方向键移动焦点后的下标（首尾循环）；不是方向键或列表为空返回 null。 */
export function arrowFocusIndex(key: string, current: number, length: number): number | null {
  if (length <= 0) return null;
  if (key === 'ArrowDown') return current < length - 1 ? current + 1 : 0;
  if (key === 'ArrowUp') return current > 0 ? current - 1 : length - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return null;
}
