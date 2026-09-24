/** DSH `ctx.sessionPersistence` backed by the owner-scoped MySQL storage hooks. */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionPreparation,
} from '@deepseek-ai/dsh-session';
import {
  PersistenceCoordinator,
  SessionPersistence,
  type PersistenceBackend,
  type SessionInspection,
  type SessionPersistenceSnapshot,
  type SessionLocation,
  type StoredPrefix,
  type StoredSuffix,
  type SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence';
import type { SessionStoreOwner } from './mysql-session-store.js';

type Binding = SessionStoreOwner & { refs: number };

export class SessionOwnerBindings {
  private readonly owners = new Map<string, Binding>();
  private readonly active = new AsyncLocalStorage<SessionStoreOwner>();

  bind(sessionId: string, owner: SessionStoreOwner): () => void {
    const id = String(sessionId).trim();
    const orgId = String(owner.orgId).trim();
    const userId = String(owner.userId).trim();
    if (!id || !orgId || !userId) throw new Error('session persistence owner is required');
    const existing = this.owners.get(id);
    if (existing) {
      if (existing.orgId !== orgId || existing.userId !== userId) {
        throw new Error('session persistence owner mismatch');
      }
      existing.refs += 1;
    } else {
      this.owners.set(id, { orgId, userId, refs: 1 });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const binding = this.owners.get(id);
      if (!binding) return;
      binding.refs -= 1;
      if (binding.refs === 0) this.owners.delete(id);
    };
  }

  ownerForSession(sessionId: string): SessionStoreOwner {
    const bound = this.owners.get(String(sessionId));
    if (bound) return { orgId: bound.orgId, userId: bound.userId };
    return this.currentOwner();
  }

  currentOwner(): SessionStoreOwner {
    const owner = this.active.getStore();
    if (!owner) throw new Error('session persistence owner scope is not active');
    return owner;
  }

  run<T>(owner: SessionStoreOwner, fn: () => T): T {
    return this.active.run(owner, fn);
  }
}

export class MysqlSessionPersistence extends SessionPersistence implements PersistenceBackend<string> {
  readonly name = 'session-persistence-mysql';
  readonly supportsRawArtifacts = false;
  private readonly coordinator: PersistenceCoordinator<string>;

  constructor(
    ctx: Context,
    private readonly backend: PersistenceBackend<string>,
    private readonly bindings: SessionOwnerBindings,
  ) {
    super(ctx);
    this.coordinator = new PersistenceCoordinator(ctx, this);
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined;
  }

  bindOwner(sessionId: string, owner: SessionStoreOwner): () => void {
    return this.bindings.bind(sessionId, owner);
  }

  runAsOwner<T>(owner: SessionStoreOwner, fn: () => T): T {
    return this.bindings.run(owner, fn);
  }

  async has(id: SessionId | string): Promise<boolean> {
    return (await this.readStoredRevision(id as SessionId)) !== undefined;
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta);
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal);
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id);
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal);
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }

  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<string> | undefined> {
    return this.backend.loadStored(id, signal);
  }

  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    return this.backend.readStoredRevision(id, signal);
  }

  loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    return this.backend.loadStoredFrom?.(id, fromSeq, signal)
      ?? this.backend.loadStored(id, signal).then((stored) => stored && ({
        meta: stored.meta,
        events: stored.events.filter((event) => event.seq >= fromSeq),
      }));
  }

  appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    return this.backend.appendBatch(meta, events, isMaterialized);
  }

  commitRepair(meta: SessionHeader, tornMarker: string | undefined, closers: readonly SessionEvent[]): Promise<void> {
    return this.backend.commitRepair(meta, tornMarker, closers);
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.backend.list(signal);
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const snapshots: SessionPersistenceSnapshot[] = [];
    for (const header of await this.list(signal)) {
      signal?.throwIfAborted();
      const revision = await this.readStoredRevision(header.id, signal);
      if (revision !== undefined) snapshots.push({ header, revision });
    }
    return snapshots;
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }
}
