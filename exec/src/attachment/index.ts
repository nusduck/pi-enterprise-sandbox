/**
 * attachment 模块 barrel——薄重导出，不新增行为。
 */
export { AttachmentService, AttachmentError } from './service.js';
export type { AttachmentRecord, AttachmentUploadRequest } from './service.js';
export { sanitizeFilename, isAllowedExtension, extensionOf } from './sanitize.js';
