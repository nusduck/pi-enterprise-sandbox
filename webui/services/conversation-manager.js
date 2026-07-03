/**
 * Pi Agent WebUI — Conversation Manager
 *
 * Manages Conversation instances, persistence, and data directory.
 * Supports dual persistence: sandbox DB (primary) and local JSON file (fallback).
 */
import fs from "node:fs";
import { Agent } from "@mariozechner/pi-agent-core";
import { CONVERSATIONS_FILE, WEBUI_DATA_DIR, SYSTEM_PROMPT } from "../config.js";
import { sandboxFetch } from "./sandbox-client.js";
import { createModel, createSandboxTools } from "./agent-factory.js";

// ── Singleton Map ────────────────────────────────────────────────────────
/** @type {Map<string, Conversation>} */
export const conversations = new Map();

// ── Sandbox DB helpers ───────────────────────────────────────────────────

/**
 * Persist a single conversation to the sandbox database via the REST API.
 * Silently falls back to JSON file if the sandbox is unreachable.
 * @param {Conversation} conv
 */
async function saveConvToSandboxDB(conv) {
  try {
    const payload = conv.toPersistedJSON();
    await sandboxFetch(`/conversations/${conv.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        id: conv.id,
        title: payload.title,
        sandbox_session_id: payload.sandboxSessionId,
        messages: payload.messages,
      }),
    });
  } catch {
    // sandbox may not be running; JSON file fallback handles this
  }
}

/**
 * Delete a conversation from the sandbox database.
 * @param {string} convId
 */
async function deleteConvFromSandboxDB(convId) {
  try {
    await sandboxFetch(`/conversations/${convId}`, { method: "DELETE" });
  } catch {
    // best effort
  }
}

/**
 * Load all conversations from the sandbox database.
 * @returns {Promise<Array>} persisted conversation data, or empty array on failure.
 */
async function loadConvsFromSandboxDB() {
  try {
    const items = await sandboxFetch("/conversations");
    if (!Array.isArray(items)) return [];
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      createdAt: new Date(item.created_at).getTime() || Date.now(),
      sandboxSessionId: item.sandbox_session_id,
      messages: item.messages || [],
    }));
  } catch {
    return [];
  }
}

// ── Data directory helpers ───────────────────────────────────────────────
export function ensureDataDir() {
  fs.mkdirSync(WEBUI_DATA_DIR, { recursive: true });
}

export function saveConversations() {
  ensureDataDir();
  const payload = [...conversations.values()].map((conv) => conv.toPersistedJSON());
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(payload, null, 2));
  // Also try sandbox DB for each conversation (fire-and-forget)
  for (const conv of conversations.values()) {
    saveConvToSandboxDB(conv);
  }
}

export async function loadConversations() {
  // 1. Try sandbox DB first
  const dbItems = await loadConvsFromSandboxDB();
  if (dbItems.length > 0) {
    for (const item of dbItems) {
      const conv = new Conversation(item.id, item);
      await conv.init({ restore: true });
      conversations.set(conv.id, conv);
    }
    return;
  }

  // 2. Fallback to local JSON file
  try {
    if (!fs.existsSync(CONVERSATIONS_FILE)) return;
    const payload = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, "utf-8"));
    for (const item of payload) {
      const conv = Conversation.fromPersistedJSON(item);
      await conv.init({ restore: true });
      conversations.set(conv.id, conv);
    }
  } catch (err) {
    console.error("Failed to load persisted conversations:", err);
  }
}

// ── Conversation class ───────────────────────────────────────────────────
export class Conversation {
  constructor(id, persisted = {}) {
    this.id = id;
    this.title = persisted.title || "New conversation";
    this.createdAt = persisted.createdAt || Date.now();
    this.agent = null;
    this.sandboxSessionId = persisted.sandboxSessionId || null;
    this.messages = persisted.messages || []; // kept for frontend
    this.currentTraceId = null;
    this._sandboxCreated = Boolean(persisted.sandboxSessionId);
  }

  async init(options = {}) {
    // 1. Create or restore sandbox session
    if (options.restore && this.sandboxSessionId) {
      try {
        const existing = await sandboxFetch(`/sessions/${this.sandboxSessionId}`);
        this.sandboxSessionId = existing.session_id;
      } catch {
        this.sandboxSessionId = null;
      }
    }

    if (!this.sandboxSessionId) {
      const session = await sandboxFetch("/sessions", {
        method: "POST",
        body: JSON.stringify({
          agent_session_id: this.id,
          enterprise_session_id: this.id,
          caller_id: "agent-webui",
          metadata: { source: "webui", conversation_id: this.id },
        }),
      });
      this.sandboxSessionId = session.session_id;
      this._sandboxCreated = true;
    }

    // 2. Create Pi Agent with API key resolver
    const agent = new Agent({
      getApiKey: (provider) => {
        if (provider === "llmio") return process.env.LLMIO_API_KEY || undefined;
        return undefined;
      },
    });
    agent.setModel(createModel());
    agent.setTools(createSandboxTools(this.sandboxSessionId, () => this.currentTraceId));
    agent.setSystemPrompt(SYSTEM_PROMPT);
    this.agent = agent;

    // 3. Persist this conversation to sandbox DB
    saveConvToSandboxDB(this);

    return this;
  }

  async destroy() {
    // Cleanup sandbox session
    if (this.sandboxSessionId && this._sandboxCreated) {
      try {
        await sandboxFetch(`/sessions/${this.sandboxSessionId}`, { method: "DELETE" });
      } catch { /* best effort */ }
    }
    this.agent?.abort();
    conversations.delete(this.id);
    deleteConvFromSandboxDB(this.id);
    saveConversations();
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      sandboxSessionId: this.sandboxSessionId,
      messageCount: this.messages.length,
    };
  }

  toPersistedJSON() {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      sandboxSessionId: this.sandboxSessionId,
      messages: this.messages,
    };
  }

  static fromPersistedJSON(item) {
    return new Conversation(item.id, item);
  }
}
