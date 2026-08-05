// ─── Genesis Security: Permission Manager ────────────────────────────
// Role-based access control for WebSocket operations.
// Every sensitive message type requires a specific permission.

import type { AuthRole, ClientIdentity } from './auth-manager.js';
import type { AuditLogger } from './audit-logger.js';

// ── Types ──

export type Permission =
  | 'task.submit'
  | 'proposal.approve'
  | 'proposal.reject'
  | 'system.command'
  | 'event.subscribe'
  | 'kernel.snapshot'
  | 'audit.read'
  | 'secret.manage'
  | 'dev.access';

export interface PermissionCheck {
  allowed: boolean;
  reason?: string;
}

export interface PermissionManager {
  /** Check if an identity can perform an operation. */
  check(identity: ClientIdentity, permission: Permission): PermissionCheck;

  /** Get all permissions for a role. */
  getRolePermissions(role: AuthRole): Permission[];

  /** Check multiple permissions at once. */
  checkAll(identity: ClientIdentity, permissions: Permission[]): PermissionCheck;
}

// ── Role-Permission Mapping ──

const ROLE_PERMISSIONS: Record<AuthRole, Permission[]> = {
  operator: [
    'task.submit',
    'proposal.approve',
    'proposal.reject',
    'system.command',
    'event.subscribe',
    'kernel.snapshot',
    'audit.read',
    'secret.manage',
    'dev.access',
  ],
  developer: [
    'task.submit',
    'event.subscribe',
    'kernel.snapshot',
    'audit.read',
  ],
  viewer: [
    'event.subscribe',
    'kernel.snapshot',
  ],
};

// ── Message Type → Permission Mapping ──

export const MESSAGE_PERMISSIONS: Record<string, Permission> = {
  'task.submit': 'task.submit',
  'proposal.approve': 'proposal.approve',
  'proposal.reject': 'proposal.reject',
  'system.command': 'system.command',
  'event.subscribe': 'event.subscribe', // subscribe/unsubscribe both use event.subscribe
  'kernel.snapshot': 'kernel.snapshot',
  'audit.query': 'audit.read',
};

// ── Implementation ──

export class PermissionManagerImpl implements PermissionManager {
  private _auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    this._auditLogger = auditLogger;
  }

  check(identity: ClientIdentity, permission: Permission): PermissionCheck {
    const allowedPermissions = ROLE_PERMISSIONS[identity.role] ?? [];

    // Check if token is expired
    if (Date.now() > identity.expiresAt) {
      const result: PermissionCheck = {
        allowed: false,
        reason: 'Token expired',
      };
      this._logCheck(identity, permission, result);
      return result;
    }

    const allowed = allowedPermissions.includes(permission);

    const result: PermissionCheck = allowed
      ? { allowed: true }
      : {
          allowed: false,
          reason: `Role '${identity.role}' does not have permission '${permission}'`,
        };

    this._logCheck(identity, permission, result);
    return result;
  }

  checkAll(identity: ClientIdentity, permissions: Permission[]): PermissionCheck {
    for (const perm of permissions) {
      const check = this.check(identity, perm);
      if (!check.allowed) return check;
    }
    return { allowed: true };
  }

  getRolePermissions(role: AuthRole): Permission[] {
    return [...(ROLE_PERMISSIONS[role] ?? [])];
  }

  private _logCheck(
    identity: ClientIdentity,
    permission: Permission,
    result: PermissionCheck,
  ): void {
    this._auditLogger.log({
      timestamp: Date.now(),
      actor: identity.clientId,
      action: result.allowed ? 'perm.check' : 'perm.denied',
      resource: permission,
      outcome: result.allowed ? 'allow' : 'deny',
      details: {
        role: identity.role,
        reason: result.reason ?? null,
      },
    });
  }
}
