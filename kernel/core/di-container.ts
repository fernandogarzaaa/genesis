// ─── Genesis Kernel: Dependency Injection Container ──────────────────
// §4.8 — The ONLY mechanism by which components obtain references.
// No `new`, no `require()`, no direct imports of another subsystem's internals.

import { v4 as uuid } from 'uuid';
import type { DIContainer, Lifecycle, Scope } from './kernel-types.js';

interface Registration<T> {
  capabilityId: string;
  factory: () => T;
  lifecycle: Lifecycle;
  singleton?: T;
}

class ScopeImpl implements Scope {
  public readonly id: string;
  public readonly instances: Map<string, unknown> = new Map();
  public readonly parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.id = uuid();
    this.parent = parent;
  }
}

export class DIContainerImpl implements DIContainer {
  private _registrations: Map<string, Registration<unknown>> = new Map();
  private _rootScope: ScopeImpl = new ScopeImpl();
  private _activeScopes: Map<string, ScopeImpl> = new Map();

  constructor() {
    // Register kernel-owned capabilities as singletons
    this._activeScopes.set(this._rootScope.id, this._rootScope);
  }

  // ── Registration ──

  register<T>(
    capabilityId: string,
    factory: () => T,
    lifecycle: Lifecycle = 'singleton'
  ): void {
    if (this._registrations.has(capabilityId)) {
      throw new Error(
        `Capability '${capabilityId}' is already registered. ` +
        `Use an override or unregister first.`
      );
    }

    this._registrations.set(capabilityId, {
      capabilityId,
      factory: factory as () => unknown,
      lifecycle,
    });
  }

  // Override an existing registration (for plugins, testing, etc.)
  override<T>(
    capabilityId: string,
    factory: () => T,
    lifecycle: Lifecycle = 'singleton'
  ): void {
    // Clear any cached singleton
    const existing = this._registrations.get(capabilityId);
    if (existing?.singleton) {
      existing.singleton = undefined;
    }
    this._registrations.set(capabilityId, {
      capabilityId,
      factory: factory as () => unknown,
      lifecycle,
    });
  }

  unregister(capabilityId: string): void {
    this._registrations.delete(capabilityId);
  }

  has(capabilityId: string): boolean {
    return this._registrations.has(capabilityId);
  }

  list(): string[] {
    return Array.from(this._registrations.keys());
  }

  // ── Resolution ──

  resolve<T>(capabilityId: string, scope?: Scope): T {
    const registration = this._registrations.get(capabilityId);
    if (!registration) {
      throw new Error(
        `Capability '${capabilityId}' is not registered. ` +
        `Available: ${Array.from(this._registrations.keys()).join(', ') || 'none'}`
      );
    }

    const targetScope = scope ?? this._rootScope;

    switch (registration.lifecycle) {
      case 'singleton': {
        if (!registration.singleton) {
          registration.singleton = registration.factory();
        }
        return registration.singleton as T;
      }

      case 'subsystem': {
        // One instance per subsystem resolution scope
        const key = `subsystem:${capabilityId}`;
        if (!targetScope.instances.has(key)) {
          targetScope.instances.set(key, registration.factory());
        }
        return targetScope.instances.get(key) as T;
      }

      case 'cognitive_cycle': {
        // New instance per cognitive cycle scope
        const key = `cycle:${capabilityId}`;
        if (!targetScope.instances.has(key)) {
          targetScope.instances.set(key, registration.factory());
        }
        return targetScope.instances.get(key) as T;
      }

      case 'request': {
        // New instance per API request scope
        const key = `request:${capabilityId}`;
        if (!targetScope.instances.has(key)) {
          targetScope.instances.set(key, registration.factory());
        }
        return targetScope.instances.get(key) as T;
      }

      case 'transient': {
        // New instance every time
        return registration.factory() as T;
      }

      default:
        throw new Error(
          `Unknown lifecycle: ${registration.lifecycle}`
        );
    }
  }

  // ── Scopes ──

  createScope(): Scope {
    const scope = new ScopeImpl(this._rootScope);
    this._activeScopes.set(scope.id, scope);
    return scope;
  }

  disposeScope(scope: Scope): void {
    this._activeScopes.delete(scope.id);
  }

  // ── Validation ──

  validate(): {
    valid: boolean;
    errors: string[];
    missingDependencies: string[];
  } {
    const errors: string[] = [];
    const registered = new Set(this._registrations.keys());

    // Check for circular dependencies
    // In this simple DI we don't track dependency graphs yet,
    // but we can check that all registrations are valid
    for (const [id, reg] of this._registrations) {
      try {
        // Attempt to construct to validate
        if (reg.lifecycle === 'singleton' && !reg.singleton) {
          // Don't actually construct singletons during validation
        }
      } catch (e) {
        errors.push(`Registration '${id}' failed validation: ${e}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      missingDependencies: [],
    };
  }
}
