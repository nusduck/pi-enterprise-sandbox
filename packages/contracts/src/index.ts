/**
 * @pi-enterprise/contracts
 *
 * Shared architecture contracts for the Pi Enterprise Sandbox refactor (PR-01).
 * Zero runtime dependencies so Agent / BFF / Frontend / tests can adopt independently.
 */

export * from './ids.ts';
export * from './domain/index.ts';
export * from './errors/index.ts';
export * from './events/index.ts';
export * from './context/index.ts';
export * from './architecture/index.ts';
