import { useMemo, useEffect, type ReactNode } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  getRunArtifacts,
  getRunToolExecutions,
  listDatasetsForConversation,
  listProcessesForSession,
  type ArtifactEntity,
} from '../../entities';
import { fileTypeLabel } from '../../shared/state';
import { isDurableArtifactId } from '../../shared/state/runReducer';
import {
  type InspectorTabId,
  type SelectedEntity,
} from '../runtime-timeline/buildTimeline';
import { ArtifactPanel } from '../artifact-panel/ArtifactPanel';
import { DatasetPanel } from '../dataset-panel/DatasetPanel';
import { ProcessPanel } from '../process-panel/ProcessPanel';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';
import { IconClose, IconLayers } from '../../shared/ui/Icons';

type TabDef = {
  id: InspectorTabId;
  label: string;
  count?: number;
};

type ReferencedFile = {
  path: string;
  name: string;
  toolName: string;
};

const FILE_INPUT_KEYS = new Set([
  'path',
  'file',
  'file_path',
  'filepath',
  'source_path',
  'target_path',
  'destination_path',
  'paths',
  'files',
]);

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

function pathLike(value: string): boolean {
  const clean = value.trim();
  return (
    clean.startsWith('/') ||
    clean.startsWith('./') ||
    clean.startsWith('../') ||
    clean.includes('/workspace/') ||
    /^[^/\s]+\.[a-z0-9]{1,8}$/i.test(clean)
  );
}

function pathsFromInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const found: string[] = [];
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (FILE_INPUT_KEYS.has(key.toLowerCase()) && pathLike(value)) {
        found.push(value.trim());
      }
      return;
    }
    if (Array.isArray(value)) {
      if (FILE_INPUT_KEYS.has(key.toLowerCase())) {
        for (const item of value) {
          if (typeof item === 'string' && pathLike(item)) found.push(item.trim());
        }
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, childKey);
      }
    }
  };
  visit(input);
  return found;
}

export function shouldIncludeListedArtifact(
  runId: string | null | undefined,
  listedRunId: string,
): boolean {
  return !runId || !listedRunId || listedRunId === runId;
}

export function collectReferencedFiles(
  tools: Array<{ name: string; input: unknown }>,
  excludedPaths: Array<string | null | undefined> = [],
): ReferencedFile[] {
  const excluded = new Set(
    excludedPaths
      .filter((path): path is string => Boolean(path))
      .map((path) => path.replace(/\\/g, '/')),
  );
  const seen = new Set<string>();
  const files: ReferencedFile[] = [];
  for (const tool of tools) {
    for (const rawPath of pathsFromInput(tool.input)) {
      const path = rawPath.replace(/\\/g, '/');
      if (excluded.has(path) || seen.has(path)) continue;
      seen.add(path);
      files.push({ path, name: basename(path), toolName: tool.name });
    }
  }
  return files;
}

function EmptyState({
  title,
  body,
  icon,
}: {
  title: string;
  body?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="insp-empty">
      <div className="insp-empty-icon" aria-hidden="true">
        {icon || <IconLayers size={22} />}
      </div>
      <p className="insp-empty-title">{title}</p>
      {body ? <p className="insp-empty-body">{body}</p> : null}
    </div>
  );
}

export function ContextInspector({
  open,
  onClose,
  tab,
  onTabChange,
  selected,
}: {
  open: boolean;
  onClose: () => void;
  tab: InspectorTabId;
  onTabChange: (t: InspectorTabId) => void;
  selected: SelectedEntity;
}) {
  const {
    entityStore,
    activeRunId,
    activeSessionId,
    state,
    importArtifactToConversation,
  } = useChat();
  const { openProcessConsole } = useWorkbenchSelection();
  const runId = activeRunId;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const tools = useMemo(
    () => (runId ? getRunToolExecutions(entityStore, runId) : []),
    [entityStore, runId],
  );
  const processes = useMemo(
    () => listProcessesForSession(entityStore, activeSessionId),
    [entityStore, activeSessionId],
  );
  const artifacts = useMemo(
    () => (runId ? getRunArtifacts(entityStore, runId) : []),
    [entityStore, runId],
  );
  const datasets = useMemo(
    () => listDatasetsForConversation(entityStore, state.conversationId),
    [entityStore, state.conversationId],
  );
  const listedArtifacts = state.artifacts || [];

  const importableArtifacts = useMemo((): ArtifactEntity[] => {
    const convId = state.conversationId;
    const runIds = new Set<string>();
    if (runId) {
      runIds.add(runId);
    } else if (convId) {
      for (const r of Object.values(entityStore.runsById)) {
        if (r.conversationId === convId) runIds.add(r.id);
      }
    }

    const seen = new Set<string>();
    const out: ArtifactEntity[] = [];

    for (const art of Object.values(entityStore.artifactsById)) {
      if (art.source !== 'submit_artifact') continue;
      if (!isDurableArtifactId(art.id, art.runId || '')) continue;
      if (art.runId && runIds.size > 0 && !runIds.has(art.runId)) continue;
      if (seen.has(art.id)) continue;
      seen.add(art.id);
      out.push(art);
    }

    for (const listed of listedArtifacts) {
      const id = String(listed.artifact_id || listed.id || '').trim();
      if (!id || seen.has(id)) continue;
      const listedRunId = String(
        listed.run_id || listed.runId || '',
      ).trim();
      if (!shouldIncludeListedArtifact(runId, listedRunId)) continue;
      if (!isDurableArtifactId(id, runId || '')) continue;
      seen.add(id);
      out.push({
        id,
        runId: runId,
        sessionId: activeSessionId,
        name: String(listed.name || listed.path || id),
        path: listed.path != null ? String(listed.path) : null,
        mimeType:
          listed.mime_type != null
            ? String(listed.mime_type)
            : listed.mimeType != null
              ? String(listed.mimeType)
              : null,
        size:
          typeof listed.size === 'number' && Number.isFinite(listed.size)
            ? listed.size
            : null,
        sha256:
          listed.sha256 != null
            ? String(listed.sha256)
            : listed.sha_256 != null
              ? String(listed.sha_256)
              : null,
        description: null,
        source: 'submit_artifact',
        createdAt:
          listed.created_at != null
            ? String(listed.created_at)
            : listed.createdAt != null
              ? String(listed.createdAt)
              : null,
      });
    }

    return out;
  }, [
    entityStore,
    runId,
    state.conversationId,
    artifacts,
    listedArtifacts,
    activeSessionId,
  ]);

  const referencedFiles = useMemo(
    () =>
      collectReferencedFiles(tools, [
        ...artifacts.map((artifact) => artifact.path),
        ...listedArtifacts.map((artifact) =>
          artifact.path == null ? null : String(artifact.path),
        ),
      ]),
    [tools, artifacts, listedArtifacts],
  );

  const tabs: TabDef[] = [
    { id: 'artifacts', label: '产物', count: importableArtifacts.length || undefined },
    { id: 'files', label: '文件', count: referencedFiles.length || undefined },
    { id: 'datasets', label: '数据集', count: datasets.length || undefined },
    { id: 'processes', label: '进程', count: processes.length || undefined },
  ];

  const panelClass = [
    'context-inspector',
    open ? 'open' : 'closed',
  ]
    .filter(Boolean)
    .join(' ');


  return (
    <>
      <aside
        id="context-inspector"
        className={panelClass}
        aria-label="会话资料"
        aria-hidden={!open}
      >
        <div className="inspector-head">
          <div className="inspector-head-text">
            <div className="inspector-title-row">
              <IconLayers size={16} className="inspector-title-icon" />
              <h2 className="inspector-title">会话资料</h2>
            </div>
            <p className="inspector-subtitle">
              产物、引用的文件、数据集与后台进程
            </p>
          </div>
          <button
            type="button"
            className="btn-icon inspector-close-desktop"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
          <button
            type="button"
            className="btn-icon inspector-close"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="inspector-tabs">
          <div className="inspector-tabs-track" role="tablist" aria-label="会话资料分类">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`inspector-tab${tab === t.id ? ' active' : ''}`}
                onClick={() => onTabChange(t.id)}
              >
                <span>{t.label}</span>
                {t.count != null && t.count > 0 ? (
                  <span className="inspector-tab-count">{t.count}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="inspector-body" role="tabpanel">
          {tab === 'files' ? (
            <FilesPanel files={referencedFiles} />
          ) : null}

          {tab === 'processes' ? (
            <ProcessPanel
              processes={processes}
              selectedId={selected?.kind === 'process' ? selected.id : null}
              onOpenConsole={openProcessConsole}
              emptyHint="这个会话还没有后台进程。"
            />
          ) : null}

          {tab === 'artifacts' ? (
            <ArtifactPanel
              artifacts={importableArtifacts}
              sessionId={activeSessionId}
              selectedId={selected?.kind === 'artifact' ? selected.id : null}
              submitOnly
              conversations={state.conversations}
              currentConversationId={state.conversationId}
              onImport={importArtifactToConversation}
            />
          ) : null}

          {tab === 'datasets' ? (
            <DatasetPanel datasets={datasets} />
          ) : null}

        </div>
      </aside>
      <div
        className="inspector-backdrop"
        hidden={!open}
        onClick={onClose}
        aria-hidden="true"
      />
    </>
  );
}

function FilesPanel({
  files,
}: {
  files: ReferencedFile[];
}) {
  if (!files.length) {
    return (
      <EmptyState
        title="还没有引用文件"
        body="本轮工具读写过的文件会列在这里；最终交付物在“产物”里。"
      />
    );
  }

  return (
    <div className="insp-stack">
      <div className="insp-section-intro">
        <span>工作区引用</span>
        <span>{files.length}</span>
      </div>
      <ul className="insp-file-list">
        {files.map((file) => (
          <li key={file.path} className="insp-file-row">
            <span className="file-type-tile" aria-hidden="true">
              {fileTypeLabel(file.name)}
            </span>
            <span className="insp-file-copy">
              <span className="insp-file-name">{file.name}</span>
              <span className="insp-file-path mono" title={file.path}>
                {file.path}
              </span>
            </span>
            <span className="insp-file-source" title={`Referenced by ${file.toolName}`}>
              {file.toolName}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

