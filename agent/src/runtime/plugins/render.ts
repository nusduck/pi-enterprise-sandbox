/**
 * 把 `manifest.ts` 渲染成 `bundle/cordis.patch.yml`。
 *
 * 自己写而不引 YAML 库：输出形状是完全受控的一小撮结构（id/name/disabled/
 * config/insert），而 patch 里有一个 `!!js (...)` 自定义标签——通用序列化器
 * 反而会把它引号化，那正是"看起来对、实际不生效"的又一种形态。
 *
 * `plugins.test.ts` 断言仓库里的文件与本函数输出逐字节一致：忘了跑生成会让
 * 测试红，而不是让线上跑一份和代码不一致的配置。
 */
import { PLUGIN_MANIFEST, type PatchEntry } from './manifest.js';

const HEADER = `# 我们的组合层——叠在 dsh-base 之上。
#
# ⚠️ **这个文件是生成的，不要手改。** 事实源是 \`src/plugins/manifest.ts\`；
#    改完跑 \`npm run gen:patch\`，\`plugins.test.ts\` 会断言两者一致。
#
# 为什么要生成而不是手写：patch 能静默写错，而写错时没有任何人报错——插件装不上
# 就是出厂实现留在原位。2026-08-30 一天内踩到两种：
#   1. 在已有行上改 \`name\` 想替换插件。dsh-app-boot 把 \`name\` 当**断言**，
#      不匹配就整条跳过，于是 ctx.credentials 一直是出厂的 LocalCredentialProvider
#      ——ADR 0007「必须移除的行」点名不得组合的那个。
#   2. \`name\` 指向 \`../src/*.js\`，而源码是 .ts、产物在 dist/。
# manifest.ts 让这两种都写不出来（替换只有 replaceFactory() 一个入口）。
`;

function comment(text: string, indent = ''): string {
  return text
    .split('\n')
    .map((line) => `${indent}# ${line}`)
    .join('\n');
}

/**
 * 环境变量名的白名单。
 *
 * 这个值会被**原样拼进生成的 JS 表达式**，所以必须约束字符集——否则一个精心
 * 构造的 `MCP_SERVERS_JSON` 就能往 patch 里注入任意代码。密钥引用来自部署配置，
 * 不是终端用户输入，但「配置也可能被写错或被污染」是同一类问题，fail-closed 更省事。
 */
function assertEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `patch render: env reference "${name}" must match [A-Za-z_][A-Za-z0-9_]* ` +
        '(it is spliced into a generated JS expression)',
    );
  }
}

/** 标量渲染。字符串按需加引号；`!!js:` 前缀还原成自定义标签表达式。 */
function scalar(value: unknown): string {
  if (typeof value === 'string') {
    if (value === '!!js:LLMIO_BASE_URL') {
      return "!!js (process.env.LLMIO_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')";
    }
    // `!!js:env:NAME` —— 读一个环境变量。MCP 的密钥只走这条路
    // （ADR 0009 D9 §3：patch YAML 里不得出现明文）。
    if (value.startsWith('!!js:env:')) {
      const name = value.slice('!!js:env:'.length);
      assertEnvName(name);
      return `!!js process.env.${name}`;
    }
    // `!!js:bearer:NAME` —— 拼一个 Authorization 头，同样只带变量名。
    if (value.startsWith('!!js:bearer:')) {
      const name = value.slice('!!js:bearer:'.length);
      assertEnvName(name);
      return '!!js `Bearer ${process.env.' + name + '}`';
    }
    // 需要引号的：路径、含特殊字符、或可能被当作别的类型。
    return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function renderValue(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const lines = renderMapping(item as Record<string, unknown>, `${indent}  `).split('\n');
          const head = lines[0] ?? '';
          return [`${indent}- ${head.slice(indent.length + 2)}`, ...lines.slice(1)].join('\n');
        }
        return `${indent}- ${scalar(item)}`;
      })
      .join('\n');
  }
  if (value !== null && typeof value === 'object') {
    return renderMapping(value as Record<string, unknown>, indent);
  }
  return `${indent}${scalar(value)}`;
}

function renderMapping(obj: Record<string, unknown>, indent: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${indent}${key}: []`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(renderValue(value, `${indent}  `));
    } else if (value !== null && typeof value === 'object') {
      if (Object.keys(value).length === 0) {
        lines.push(`${indent}${key}: {}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(renderMapping(value as Record<string, unknown>, `${indent}  `));
    } else {
      lines.push(`${indent}${key}: ${scalar(value)}`);
    }
  }
  return lines.join('\n');
}

function renderEntry(entry: PatchEntry): string {
  const { comment: note, ...rest } = entry;
  // 以两空格缩进渲染整个映射，再把第一行的缩进换成 `- `，其余行保持缩进。
  const lines = renderMapping(rest as Record<string, unknown>, '  ').split('\n');
  const first = lines[0] ?? '';
  const block = [`- ${first.slice(2)}`, ...lines.slice(1)].join('\n');
  return note ? `${comment(note)}\n${block}` : block;
}

export function renderPatchYaml(entries: readonly PatchEntry[] = PLUGIN_MANIFEST): string {
  return `${HEADER}\n${entries.map(renderEntry).join('\n\n')}\n`;
}
