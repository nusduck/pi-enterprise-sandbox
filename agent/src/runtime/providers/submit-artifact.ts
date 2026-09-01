/**
 * `submit_artifact` —— 把工作区里的一个文件提交成一件可下载的产物
 * （ADR 0009 D4 「`submit_artifact` 是我们自建的，保留」/ 计划 H1.1b）。
 *
 * ## 为什么要重新写一个
 *
 * 2026-08-31 起栈实测发现：ADR 说「保留」，但**代码里没有任何插件注册它**——
 * 旧 Pi Extension 删除后没有补。也就是说这个能力在 DSH 重建之后一直是缺的，
 * 只是没有人报错（工具不存在 ≠ 工具报错）。
 *
 * 计划 H1.1b 一度把它按「退役」处理（映射到 `TOOL_RETIRED`）。那是个可逆的
 * 保守默认，但**它让产物提交这个产品能力静默消失**。既然 exec 侧
 * `/internal/v1/artifacts/submit` 一直在，补回工具是更小的代价。
 *
 * 与 `remote-fs-search` 同一形状：自建工具插件 + exec RPC，字节永远在 exec 那边。
 */
import type { Context } from '@deepseek-ai/cordis';
import { ulid } from '../../domain/shared/ulid.js';
import { ExecRpcClient, currentExecRpc, resolveExecRpcConfig } from './exec-rpc.js';
import type { ExecRpcConfig } from './exec-rpc.js';

interface SubmitResponse {
  readonly artifactId: string;
  readonly name: string | null;
  readonly mimeType: string | null;
  readonly sha256: string;
  readonly size: number;
}

export const name = 'submit-artifact';
/** 必须经 inject 取服务；本模块也不能有 default export（见 remote-fs-search 的注释）。 */
export const inject = ['tools'] as const;

export function* apply(ctx: Context & Record<string, any>, config: Partial<ExecRpcConfig> = {}) {
  const fallback = resolveExecRpcConfig(config);

  yield ctx.tools.register({
    name: 'submit_artifact',
    description:
      'Submit a file from the workspace as a downloadable artifact for the user. ' +
      'The file must already exist; this does not create it.',
    parameters: {
      type: 'object',
      // 顶层 `required` 数组——属性上的 `required: true` 是出厂 defineTool() 的
      // 入参写法，直接写进注册 schema 会被模型提供方拒（2026-08-31 实测）。
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path of the file to submit.',
        },
        name: {
          type: 'string',
          description: 'Display name for the artifact. Defaults to the file name.',
        },
        mime_type: {
          type: 'string',
          description: 'MIME type. Inferred from the file when omitted.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          artifact_id: { type: 'string' },
          name: { type: 'string' },
          sha256: { type: 'string' },
          size: { type: 'integer' },
        },
      },
      render: (_args: unknown, value: any) => [
        {
          type: 'text',
          text: `Submitted artifact ${value.name ?? value.artifact_id} (${value.size} bytes).`,
        },
      ],
    },
    async execute(args: any) {
      const rpc = currentExecRpc(fallback);
      const client = new ExecRpcClient(rpc);
      const artifactId = ulid();
      const payload: Record<string, unknown> = {
        sourcePath: String(args?.path ?? ''),
        externalArtifactId: artifactId,
      };
      if (typeof rpc.sandboxSessionId === 'string' && rpc.sandboxSessionId !== '') {
        payload['sessionId'] = rpc.sandboxSessionId;
      }
      if (typeof args?.name === 'string' && args.name !== '') payload['name'] = args.name;
      if (typeof args?.mime_type === 'string' && args.mime_type !== '') {
        payload['mimeType'] = args.mime_type;
      }
      const res = await client.post<Record<string, unknown>, SubmitResponse>(
        '/internal/v1/artifacts/submit',
        payload,
        rpc.physicalRoots,
      );
      const name = res.name ?? '';
      const mimeType = res.mimeType ?? 'application/octet-stream';
      const details = {
        artifactId: res.artifactId,
        displayName: name,
        mimeType,
        size: res.size,
        sha256: res.sha256,
      };
      return {
        artifact_id: res.artifactId,
        artifactId: res.artifactId,
        name,
        mime_type: mimeType,
        mimeType,
        sha256: res.sha256,
        size: res.size,
        details,
      };
    },
  });
}
