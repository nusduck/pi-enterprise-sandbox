/**
 * 模型选择：可用模型列表 + 每个会话记住的模型偏好。
 *
 * 从 `ChatContext` 里抽出来的独立职责——它只依赖 EntityBridge（用来看上一轮
 * Run 实际用了哪个模型），不碰会话状态机。抽出的直接原因是结构棘轮
 * （`tests/test_repository_layout.py`）：ChatContext 的行数预算只减不增，
 * 新增能力必须先按职责拆分，而不是把它继续撑大。
 */
import { useCallback, useRef, useState } from 'react';
import {
  lastRunModelIdForConversation,
  loadPersistedConversationId,
  readConversationModelId,
  resolveConversationModelId,
  writeConversationModelId,
} from '../../shared/state';
import { listModels } from '../../shared/api';
import type { ModelItem } from '../../shared/api';
import type { EntityBridge } from './entityBridge';

export interface ModelSelection {
  models: ModelItem[];
  selectedModelId: string | null;
  /** 用户显式换模型；写入当前会话的偏好。 */
  setSelectedModelId: (modelId: string | null) => void;
  /** 拉取启用的模型清单，并按当前会话重算选中项。 */
  refreshModels: () => Promise<void>;
  /** 切换会话时重算选中项：会话偏好 → 上一轮 Run 用的模型 → 第一个可用。 */
  applyModelForConversation: (conversationId: string | null | undefined) => void;
  /** 登出是身份边界：丢掉上一个账号的模型清单。 */
  resetModels: () => void;
}

/**
 * @param currentConversationId 读当前会话 id 的取值器（ChatContext 里是
 *   `stateRef.current.conversationId`）——用函数而不是值，避免每次会话切换都
 *   让下面几个 callback 失效。
 */
export function useModelSelection(
  bridge: EntityBridge,
  currentConversationId: () => string | null,
): ModelSelection {
  const [models, setModels] = useState<ModelItem[]>([]);
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return readConversationModelId(loadPersistedConversationId());
  });
  const modelsRef = useRef(models);
  modelsRef.current = models;

  const applyModelForConversation = useCallback(
    (conversationId: string | null | undefined) => {
      const enabledIds = modelsRef.current
        .map((model) => String(model.model_id || model.id || '').trim())
        .filter(Boolean);
      const stored = readConversationModelId(conversationId);
      const lastRun = lastRunModelIdForConversation(
        bridge.getStore().runsById,
        conversationId,
      );
      const next = resolveConversationModelId({
        stored,
        lastRunModelId: lastRun,
        enabledIds,
      });
      setSelectedModelIdState(next);
      if (next !== stored) writeConversationModelId(conversationId, next);
    },
    [bridge],
  );

  const setSelectedModelId = useCallback(
    (modelId: string | null) => {
      const normalized = String(modelId || '').trim() || null;
      setSelectedModelIdState(normalized);
      writeConversationModelId(currentConversationId(), normalized);
    },
    [currentConversationId],
  );

  const refreshModels = useCallback(async () => {
    const result = await listModels();
    const enabled = result.items.filter(
      (model) => model.enabled !== false && Boolean(model.model_id || model.id),
    );
    setModels(enabled);
    modelsRef.current = enabled;
    applyModelForConversation(
      currentConversationId() || loadPersistedConversationId(),
    );
  }, [applyModelForConversation, currentConversationId]);

  const resetModels = useCallback(() => {
    setModels([]);
    modelsRef.current = [];
  }, []);

  return {
    models,
    selectedModelId,
    setSelectedModelId,
    refreshModels,
    applyModelForConversation,
    resetModels,
  };
}
