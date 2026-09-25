/**
 * 产物库：本人所有会话的产物（`GET /api/artifacts`，不带 session_id）。
 * 归属由服务端解析，跨用户的产物不会出现。
 */
import { z } from 'zod';
import { parseApi } from '../schemas/api';
import { ApiError } from './client';

export const LibraryArtifactSchema = z
  .object({
    artifact_id: z.string(),
    session_id: z.string(),
    workspace_id: z.string().optional(),
    name: z.string(),
    path: z.string().optional().nullable(),
    mime_type: z.string().optional().nullable(),
    size: z.number().optional().nullable(),
    created_at: z.string().optional().nullable(),
  })
  .passthrough();
export type LibraryArtifact = z.infer<typeof LibraryArtifactSchema>;

const PageSchema = z.object({
  artifacts: z.array(LibraryArtifactSchema).default([]),
  next_cursor: z.string().nullable().optional(),
});

export type ArtifactKind = 'all' | 'document' | 'image' | 'data';

export async function listLibraryArtifacts(opts: {
  q?: string | null;
  kind?: ArtifactKind;
  cursor?: string | null;
  limit?: number;
} = {}): Promise<{ artifacts: LibraryArtifact[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (opts.q) q.set('q', opts.q);
  if (opts.kind && opts.kind !== 'all') q.set('kind', opts.kind);
  if (opts.cursor) q.set('cursor', opts.cursor);
  q.set('limit', String(opts.limit ?? 60));
  const resp = await fetch(`/api/artifacts?${q}`, { credentials: 'same-origin' });
  const body = (await resp.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!resp.ok) {
    throw new ApiError(String(body.error || `Artifact library failed: ${resp.status}`), {
      status: resp.status,
      code: typeof body.code === 'string' ? body.code : null,
    });
  }
  const page = parseApi(PageSchema, body, 'artifact library');
  return { artifacts: page.artifacts, nextCursor: page.next_cursor ?? null };
}

/** Short label for the file type badge ("PNG", "DOCX"); from the name, else the MIME subtype. */
export function artifactTypeLabel(a: Pick<LibraryArtifact, 'name' | 'path' | 'mime_type'>): string {
  const fromName = /\.([A-Za-z0-9]{1,6})$/.exec(a.name) || /\.([A-Za-z0-9]{1,6})$/.exec(a.path || '');
  if (fromName) return fromName[1].toUpperCase();
  const sub = String(a.mime_type || '').split('/')[1] || '';
  return sub ? sub.split(/[.+;-]/).pop()!.slice(0, 6).toUpperCase() : 'FILE';
}

export function isImageArtifact(a: Pick<LibraryArtifact, 'mime_type'>): boolean {
  return String(a.mime_type || '').toLowerCase().startsWith('image/');
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Date bucket for the grid headings, in the viewer's local time. */
export function dateBucket(iso: string | null | undefined, now = new Date()): '今天' | '本周' | '本月' | '更早' {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '更早';
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (t >= day.getTime()) return '今天';
  if (t >= day.getTime() - 6 * 86_400_000) return '本周';
  if (t >= new Date(now.getFullYear(), now.getMonth(), 1).getTime()) return '本月';
  return '更早';
}
