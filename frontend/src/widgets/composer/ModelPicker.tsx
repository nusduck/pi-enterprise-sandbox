import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { ModelItem } from '../../shared/api';

function modelIdOf(model: ModelItem): string {
  return String(model.model_id || model.id || '');
}

function modelNameOf(model: ModelItem): string {
  const id = modelIdOf(model);
  return String(model.name || id || 'Model');
}

function formatTokenK(n?: number | null): string {
  const v = Number(n || 0);
  if (!v || Number.isNaN(v)) return '';
  if (v >= 1024) return `${Math.round(v / 1024)}k`;
  return String(v);
}

function modelTags(model: ModelItem): string[] {
  const tags: string[] = [];
  const modalities = Array.isArray(model.input_modalities)
    ? model.input_modalities.map(String)
    : [];
  if (modalities.includes('image')) tags.push('Vision');
  if (model.supports_reasoning) tags.push('Thinking');
  if (model.supports_tool_call) tags.push('Tools');
  return tags;
}

function modelLimitsLine(model: ModelItem | null | undefined): string {
  if (!model) return '';
  const context = formatTokenK(model.context_window);
  const output = formatTokenK(model.max_output_tokens);
  return [
    context ? `${context} context` : '',
    output ? `${output} output` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function modelDescription(model: ModelItem): string {
  const tags = modelTags(model);
  const limits = modelLimitsLine(model);
  if (tags.length && limits) return `${tags.join(' · ')} · ${limits}`;
  if (tags.length) return tags.join(' · ');
  if (limits) return limits;
  if (model.provider) return String(model.provider);
  return 'Available model';
}

export type ModelPickerProps = {
  models: ModelItem[];
  selectedModelId: string | null;
  onSelect: (modelId: string | null) => void;
  disabled?: boolean;
};

export function ModelPicker({
  models,
  selectedModelId,
  onSelect,
  disabled = false,
}: ModelPickerProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = useMemo(
    () => models.find((m) => modelIdOf(m) === selectedModelId) ?? null,
    [models, selectedModelId],
  );

  const selectedLabel = selected
    ? modelNameOf(selected)
    : models.length
      ? 'Select model'
      : 'No models';

  const limits = modelLimitsLine(selected);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const openMenu = useCallback(() => {
    if (disabled || models.length === 0) return;
    const idx = Math.max(
      0,
      models.findIndex((m) => modelIdOf(m) === selectedModelId),
    );
    setActiveIndex(idx);
    setOpen(true);
  }, [disabled, models, selectedModelId]);

  const toggle = useCallback(() => {
    if (open) close();
    else openMenu();
  }, [open, close, openMenu]);

  const pick = useCallback(
    (id: string) => {
      onSelect(id);
      close();
      triggerRef.current?.focus();
    },
    [onSelect, close],
  );

  // Click outside
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) close();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, close]);

  // Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Close when disabled (e.g. run starts)
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) openMenu();
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!models.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % models.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + models.length) % models.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(models.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const m = models[activeIndex];
      if (m) pick(modelIdOf(m));
    } else if (e.key === 'Tab') {
      close();
    }
  }

  // Focus active option when menu opens / active index changes
  useEffect(() => {
    if (!open) return;
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-model-index="${activeIndex}"]`,
    );
    el?.focus();
  }, [open, activeIndex]);

  return (
    <div
      className={`model-picker${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className="model-picker-trigger"
        id="composer-model"
        disabled={disabled || models.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Select model"
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="model-picker-trigger-name">{selectedLabel}</span>
        {selected?.context_window ? (
          <span className="model-picker-badge" title={limits}>
            {formatTokenK(selected.context_window)}
          </span>
        ) : null}
        <svg
          className="model-picker-chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <path
            d="M2.5 4.5L6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          className="model-picker-menu"
          id={listId}
          role="listbox"
          aria-label="Models"
          tabIndex={-1}
          onKeyDown={onListKeyDown}
        >
          <div className="model-picker-menu-header">Models</div>
          <div className="model-picker-menu-list">
            {models.map((model, index) => {
              const id = modelIdOf(model);
              const isSelected = id === selectedModelId;
              const isActive = index === activeIndex;
              return (
                <button
                  key={id || index}
                  type="button"
                  role="option"
                  data-model-index={index}
                  className={[
                    'model-picker-option',
                    isSelected ? 'is-selected' : '',
                    isActive ? 'is-active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-selected={isSelected}
                  tabIndex={isActive ? 0 : -1}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => pick(id)}
                >
                  <span className="model-picker-option-body">
                    <span className="model-picker-option-name">
                      {modelNameOf(model)}
                    </span>
                    <span className="model-picker-option-desc">
                      {modelDescription(model)}
                    </span>
                  </span>
                  {isSelected ? (
                    <svg
                      className="model-picker-check"
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                    >
                      <path
                        d="M3.5 8.5l3 3 6-6.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <span className="model-picker-check-spacer" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
