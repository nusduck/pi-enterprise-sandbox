/**
 * Web/RPC host bindings for Pi extensions.
 *
 * Pi owns the ExtensionContext shape. Enterprise run context is injected into
 * extension factories separately; this adapter only implements Pi's host/UI
 * contract and projects UI/lifecycle activity onto the run event stream.
 */

function noop() {}

function safeEmit(emit, event) {
  if (typeof emit !== 'function') return;
  try {
    emit(event);
  } catch {
    // Extension UI must never fail because an observer disconnected.
  }
}

function serializableWidget(content) {
  if (Array.isArray(content)) return content.map((line) => String(line));
  if (content == null) return null;
  return null;
}

/**
 * @param {{
 *   runId?: string|null,
 *   conversationId?: string|null,
 *   workspaceId?: string|null,
 *   emit?: (event: object) => void,
 *   interactionManager?: object|null,
 *   abortHandler?: () => void,
 *   shutdownHandler?: () => void,
 * }} [options]
 */
export function createExtensionHostAdapter(options = {}) {
  const emit = options.emit;
  const interactionManager = options.interactionManager || null;
  const editorState = { text: '' };
  let toolsExpanded = false;

  const meta = () => ({
    run_id: options.runId || null,
    conversation_id: options.conversationId || null,
    workspace_id: options.workspaceId || null,
  });

  async function request(kind, payload, fallback) {
    const handler = interactionManager?.[kind];
    if (typeof handler === 'function') {
      return handler({ ...payload, ...meta() });
    }
    safeEmit(emit, {
      type: 'interaction_requested',
      interaction_type: kind,
      durable: false,
      unsupported: true,
      ...meta(),
      ...payload,
    });
    return fallback;
  }

  const uiContext = {
    select(title, choices, opts) {
      return request(
        'select',
        { title, options: Array.isArray(choices) ? choices : [], opts: opts || null },
        undefined,
      );
    },
    confirm(title, message, opts) {
      return request('confirm', { title, message, opts: opts || null }, false);
    },
    input(title, placeholder, opts) {
      return request('input', { title, placeholder, opts: opts || null }, undefined);
    },
    notify(message, level = 'info') {
      safeEmit(emit, {
        type: 'extension_notification',
        level,
        message: String(message || ''),
        ...meta(),
      });
    },
    onTerminalInput() {
      return noop;
    },
    setStatus(key, text) {
      safeEmit(emit, {
        type: 'extension_status',
        key,
        text: text == null ? null : String(text),
        ...meta(),
      });
    },
    setWorkingMessage(message) {
      safeEmit(emit, {
        type: 'extension_working_message',
        message: message == null ? null : String(message),
        ...meta(),
      });
    },
    setWorkingVisible(visible) {
      safeEmit(emit, {
        type: 'extension_working_visible',
        visible: Boolean(visible),
        ...meta(),
      });
    },
    setWorkingIndicator(indicator) {
      safeEmit(emit, {
        type: 'extension_working_indicator',
        indicator: indicator || null,
        ...meta(),
      });
    },
    setHiddenThinkingLabel(label) {
      safeEmit(emit, {
        type: 'extension_thinking_label',
        label: label == null ? null : String(label),
        ...meta(),
      });
    },
    setWidget(key, content, widgetOptions) {
      safeEmit(emit, {
        type: 'extension_widget',
        key,
        content: serializableWidget(content),
        unsupported_component: typeof content === 'function',
        options: widgetOptions || null,
        ...meta(),
      });
    },
    setFooter(factory) {
      safeEmit(emit, {
        type: 'extension_ui_unsupported',
        capability: 'footer',
        enabled: Boolean(factory),
        ...meta(),
      });
    },
    setHeader(factory) {
      safeEmit(emit, {
        type: 'extension_ui_unsupported',
        capability: 'header',
        enabled: Boolean(factory),
        ...meta(),
      });
    },
    setTitle(title) {
      safeEmit(emit, { type: 'extension_title', title: String(title || ''), ...meta() });
    },
    custom(_factory, customOptions) {
      return request('custom', { options: customOptions || null }, undefined);
    },
    pasteToEditor(text) {
      editorState.text += String(text || '');
      safeEmit(emit, { type: 'extension_editor_text', text: editorState.text, ...meta() });
    },
    setEditorText(text) {
      editorState.text = String(text || '');
      safeEmit(emit, { type: 'extension_editor_text', text: editorState.text, ...meta() });
    },
    getEditorText() {
      return editorState.text;
    },
    editor(title, prefill) {
      return request('editor', { title, prefill: prefill || '' }, undefined);
    },
    addAutocompleteProvider() {
      // Browser autocomplete is owned by the product UI.
    },
    setEditorComponent(factory) {
      safeEmit(emit, {
        type: 'extension_ui_unsupported',
        capability: 'editor_component',
        enabled: Boolean(factory),
        ...meta(),
      });
    },
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      return undefined;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: 'Theme switching is not supported in RPC mode' };
    },
    getToolsExpanded() {
      return toolsExpanded;
    },
    setToolsExpanded(expanded) {
      toolsExpanded = Boolean(expanded);
    },
  };

  return {
    mode: 'rpc',
    uiContext,
    abortHandler: typeof options.abortHandler === 'function' ? options.abortHandler : noop,
    shutdownHandler:
      typeof options.shutdownHandler === 'function' ? options.shutdownHandler : noop,
    onError(error) {
      safeEmit(emit, {
        type: 'extension_error',
        extension: error?.extensionPath || null,
        event: error?.event || null,
        error: error?.error || String(error || 'Unknown extension error'),
        ...meta(),
      });
    },
  };
}

/** Emit deterministic loader diagnostics before binding lifecycle handlers. */
export function emitExtensionDiagnostics(extensionsResult, emit, meta = {}) {
  for (const extension of extensionsResult?.extensions || []) {
    safeEmit(emit, {
      type: 'extension_loaded',
      extension: extension.path || extension.resolvedPath || null,
      resolved_path: extension.resolvedPath || null,
      ...meta,
    });
  }
  for (const error of extensionsResult?.errors || []) {
    safeEmit(emit, {
      type: 'extension_error',
      extension: error.path || null,
      event: 'load',
      error: error.error || 'Extension load failed',
      ...meta,
    });
  }
}
