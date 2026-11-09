import {
  RoleMatrixAuthorizationPolicy,
  type CommandAuthorizationPolicy,
  type CommandRoleMatrix,
  type MembershipRole,
} from '../auth/authorization.js';
import { gameplayCommandCatalog } from './gameplay-command-catalog.js';

/**
 * D04 authorization surface for commands addressed to an already-created save.
 * Bootstrap has a distinct identity/eligibility proof and deliberately cannot
 * be authorized through this save-scoped policy.
 */
export const gameplaySaveScopedCommandRoleMatrix: CommandRoleMatrix = (() => {
  const matrix: Record<string, readonly MembershipRole[]> = Object.create(null);
  for (const entry of gameplayCommandCatalog) {
    if (entry.commandType === 'INITIALIZE_COMPETITIVE_SAVE') continue;
    matrix[entry.commandType] = Object.freeze([...entry.allowedRoles]);
  }
  return Object.freeze(matrix);
})();

export const gameplaySaveScopedCommandAuthorizationPolicy: CommandAuthorizationPolicy =
  new RoleMatrixAuthorizationPolicy(gameplaySaveScopedCommandRoleMatrix);
