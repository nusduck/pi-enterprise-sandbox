/**
 * SSO 主按钮的文字：「使用 + 标签 + 登录」。
 *
 * 标签由部署配置（`SSO_LABEL`），可能是「公司 SSO」「Okta」「统一认证」。中文与
 * 拉丁字母/数字相邻处留一个空格，汉字之间不留——所以不能写死模板里的空格：
 * 「使用 公司 SSO 登录」多了一个，「使用公司 SSO登录」又少了一个。
 */
const LATIN_EDGE = /[A-Za-z0-9]/;

export function ssoButtonText(label: string): string {
  const text = label.trim();
  const before = LATIN_EDGE.test(text.charAt(0)) ? ' ' : '';
  const after = LATIN_EDGE.test(text.charAt(text.length - 1)) ? ' ' : '';
  return `使用${before}${text}${after}登录`;
}
