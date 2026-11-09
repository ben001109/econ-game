export const membershipRoles = [
  'OWNER',
  'MANAGER',
  'CASHIER',
  'KITCHEN',
  'INVENTORY',
  'VIEWER',
] as const;

export type MembershipRole = (typeof membershipRoles)[number];

export interface CommandAuthorizationPolicy {
  isAllowed(commandType: string, role: MembershipRole): boolean;
}

export type CommandRoleMatrix = Readonly<Record<string, readonly MembershipRole[]>>;

/** Explicit command-to-role matrix. Unlisted commands and unknown roles deny. */
export class RoleMatrixAuthorizationPolicy implements CommandAuthorizationPolicy {
  private readonly matrix: ReadonlyMap<string, ReadonlySet<MembershipRole>>;

  constructor(matrix: CommandRoleMatrix) {
    this.matrix = new Map(
      Object.entries(matrix).map(([commandType, roles]) => [commandType, new Set(roles)]),
    );
  }

  isAllowed(commandType: string, role: MembershipRole): boolean {
    return this.matrix.get(commandType)?.has(role) ?? false;
  }
}

/**
 * Composes independently owned command policies without allowing one policy to
 * silently replace another command's roles.  A duplicate is a deployment-time
 * configuration error, while commands absent from every matrix remain denied.
 */
export function mergeCommandRoleMatrices(
  ...matrices: readonly CommandRoleMatrix[]
): CommandRoleMatrix {
  const merged: Record<string, readonly MembershipRole[]> = Object.create(null);
  for (const matrix of matrices) {
    for (const [commandType, roles] of Object.entries(matrix)) {
      if (Object.hasOwn(merged, commandType)) {
        throw new Error(`duplicate command authorization policy: ${commandType}`);
      }
      merged[commandType] = Object.freeze([...roles]);
    }
  }
  return Object.freeze(merged);
}

export function isMembershipRole(value: string): value is MembershipRole {
  return (membershipRoles as readonly string[]).includes(value);
}
