/**
 * Per-conversation model picker preference.
 *
 * The composer previously stored a single `pi.selectedModelId` for the whole
 * app, so switching chats kept the last picker value. Scope the choice by
 * conversation id. A blank scope is the unsaved "New conversation" draft.
 */

export const LEGACY_MODEL_PREF_KEY = 'pi.selectedModelId';
export const CONVERSATION_MODEL_PREFS_KEY = 'pi.conversationModelIds';
export const DRAFT_CONVERSATION_SCOPE = '';

export function conversationModelScope(
  conversationId: string | null | undefined,
): string {
  return String(conversationId || '').trim();
}

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readPrefsMap(): Record<string, string> {
  const ls = storage();
  if (!ls) return {};
  try {
    const raw = ls.getItem(CONVERSATION_MODEL_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && value.trim()) out[key] = value.trim();
        }
        return out;
      }
    }
    const legacy = ls.getItem(LEGACY_MODEL_PREF_KEY);
    if (legacy && legacy.trim()) {
      const migrated = { [DRAFT_CONVERSATION_SCOPE]: legacy.trim() };
      ls.setItem(CONVERSATION_MODEL_PREFS_KEY, JSON.stringify(migrated));
      ls.removeItem(LEGACY_MODEL_PREF_KEY);
      return migrated;
    }
  } catch {
    /* ignore quota / JSON errors */
  }
  return {};
}

function writePrefsMap(map: Record<string, string>): void {
  const ls = storage();
  if (!ls) return;
  try {
    if (Object.keys(map).length === 0) ls.removeItem(CONVERSATION_MODEL_PREFS_KEY);
    else ls.setItem(CONVERSATION_MODEL_PREFS_KEY, JSON.stringify(map));
    ls.removeItem(LEGACY_MODEL_PREF_KEY);
  } catch {
    /* ignore quota errors */
  }
}

export function readConversationModelId(
  conversationId: string | null | undefined,
): string | null {
  const scope = conversationModelScope(conversationId);
  return readPrefsMap()[scope] || null;
}

export function writeConversationModelId(
  conversationId: string | null | undefined,
  modelId: string | null | undefined,
): void {
  const scope = conversationModelScope(conversationId);
  const map = readPrefsMap();
  const value = String(modelId || '').trim();
  if (value) map[scope] = value;
  else delete map[scope];
  writePrefsMap(map);
}

export function lastRunModelIdForConversation(
  runsById: Record<
    string,
    {
      conversationId?: string | null;
      modelId?: string | null;
      createdAt?: string | null;
      startedAt?: string | null;
    }
  >,
  conversationId: string | null | undefined,
): string | null {
  const id = conversationModelScope(conversationId);
  if (!id) return null;
  const runs = Object.values(runsById).filter(
    (run) =>
      run.conversationId === id && Boolean(String(run.modelId || '').trim()),
  );
  if (runs.length === 0) return null;
  runs.sort((a, b) =>
    String(b.startedAt || b.createdAt || '').localeCompare(
      String(a.startedAt || a.createdAt || ''),
    ),
  );
  return String(runs[0].modelId || '').trim() || null;
}

export function resolveConversationModelId(opts: {
  stored: string | null | undefined;
  lastRunModelId?: string | null;
  enabledIds: Iterable<string>;
}): string | null {
  const enabled = [...opts.enabledIds]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const allow = (id: string | null | undefined): string | null => {
    const value = String(id || '').trim();
    if (!value) return null;
    if (enabled.length === 0) return value;
    return enabled.includes(value) ? value : null;
  };
  return allow(opts.stored) || allow(opts.lastRunModelId);
}
