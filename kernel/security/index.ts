// ─── Genesis Security: Barrel Exports ────────────────────────────────

export { EncryptedSecretStore, installSecretRedaction, redactSecrets } from './secret-store.js';
export type { SecretStore, SecretEntry } from './secret-store.js';

export { AuthenticationManagerImpl } from './auth-manager.js';
export type {
  AuthenticationManager,
  ClientIdentity,
  AuthToken,
  SessionToken,
  AuthRole,
} from './auth-manager.js';

export { PermissionManagerImpl, MESSAGE_PERMISSIONS } from './permission-manager.js';
export type { PermissionManager, Permission, PermissionCheck } from './permission-manager.js';

export { AuditLoggerImpl } from './audit-logger.js';
export type { AuditLogger, AuditEntry, AuditAction, AuditOutcome, AuditQueryFilter } from './audit-logger.js';

export {
  WSSecurityManager,
  RateLimiter,
  WSMessageSchemas,
  DEFAULT_WS_SECURITY_CONFIG,
} from './ws-security.js';
export type { WSSecurityConfig, WSSecurityResult, ValidatedMessage } from './ws-security.js';

export { SecurityEnforcer, DEFAULT_SECURITY_CONFIG } from './security-enforcer.js';
export type { SecurityConfig } from './security-enforcer.js';
