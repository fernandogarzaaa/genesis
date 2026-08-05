// ─── Genesis Kernel: Supervisor System ───────────────────────────────
// Monitors subsystem health, tracks heartbeats, detects crashes,
// applies restart policies, and isolates failure domains.
//
// Every major component registers with the supervisor:
//   { name, healthCheck, restartPolicy, dependencies }

import type { EventBus } from '../events/event-bus.js';
import type { LifecycleManager } from './lifecycle.js';

// ── Types ──

export type RestartPolicy =
  | 'always'           // Restart immediately on crash
  | 'always-backoff'   // Restart with exponential backoff
  | 'max-3'            // Restart up to 3 times, then escalate
  | 'max-5'            // Restart up to 5 times, then escalate
  | 'never';           // Escalate immediately, no restart

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy' | 'starting' | 'stopped';

export interface SupervisedComponent {
  /** Unique name for this component. */
  name: string;
  /** Async health check — returns true if healthy. */
  healthCheck: () => Promise<boolean>;
  /** Restart policy for this component. */
  restartPolicy: RestartPolicy;
  /** Names of components this one depends on. */
  dependencies: string[];
  /** Called to restart the component. */
  onRestart?: () => Promise<void>;
  /** Called when the component should stop. */
  onStop?: () => Promise<void>;
}

interface ComponentState {
  component: SupervisedComponent;
  status: ComponentStatus;
  restartCount: number;
  lastHeartbeat: number;
  lastRestart: number;
  crashWindowStart: number;
  crashesInWindow: number;
  degradedSince: number | null;
}

export interface SupervisorSnapshot {
  components: Array<{
    name: string;
    status: ComponentStatus;
    restartCount: number;
    lastHeartbeat: number;
    degradedSince: number | null;
  }>;
  overallStatus: ComponentStatus;
}

// ── Constants ──

const HEARTBEAT_INTERVAL_MS = 5000;      // Check every 5 seconds
const HEARTBEAT_TIMEOUT_MS = 15000;       // Mark unhealthy after 15s of no heartbeat
const CRASH_WINDOW_MS = 5 * 60 * 1000;   // 5-minute crash loop window
const MAX_CRASHES_PER_WINDOW = 5;         // Escalate after 5 crashes in window
const BACKOFF_BASE_MS = 1000;             // Base backoff: 1s
const BACKOFF_MAX_MS = 60_000;            // Max backoff: 60s

// ── Implementation ──

export class Supervisor {
  private _lifecycle: LifecycleManager;
  private _eventBus: EventBus;
  private _components: Map<string, ComponentState> = new Map();
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _running: boolean = false;
  private _hostId: string;

  constructor(lifecycle: LifecycleManager, eventBus: EventBus, hostId: string = 'genesis-node-1') {
    this._lifecycle = lifecycle;
    this._eventBus = eventBus;
    this._hostId = hostId;
  }

  // ── Registration ──

  /**
   * Register a component for supervision.
   * Call once per component during boot.
   */
  register(component: SupervisedComponent): void {
    if (this._components.has(component.name)) {
      console.warn(`[Supervisor] Component '${component.name}' already registered`);
      return;
    }

    this._components.set(component.name, {
      component,
      status: 'starting',
      restartCount: 0,
      lastHeartbeat: Date.now(),
      lastRestart: 0,
      crashWindowStart: 0,
      crashesInWindow: 0,
      degradedSince: null,
    });

    console.log(`[Supervisor] Registered: ${component.name} (policy: ${component.restartPolicy})`);
  }

  /**
   * Mark a component as started and healthy.
   * Components should call this after initialization.
   */
  markStarted(name: string): void {
    const state = this._components.get(name);
    if (!state) return;
    state.status = 'healthy';
    state.lastHeartbeat = Date.now();
    state.degradedSince = null;
  }

  /**
   * Mark a component as stopped.
   */
  markStopped(name: string): void {
    const state = this._components.get(name);
    if (!state) return;
    state.status = 'stopped';
  }

  // ── Lifecycle ──

  /**
   * Start the heartbeat monitoring loop.
   * Called after boot is complete.
   */
  start(): void {
    if (this._running) return;
    this._running = true;

    this._heartbeatTimer = setInterval(() => {
      this._heartbeatLoop();
    }, HEARTBEAT_INTERVAL_MS);

    console.log('[Supervisor] Heartbeat monitoring started');
  }

  /**
   * Stop the supervisor. Called during shutdown.
   */
  async stop(): Promise<void> {
    this._running = false;

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // Stop all components in reverse dependency order
    for (const [name] of this._components) {
      await this._stopComponent(name);
    }

    console.log('[Supervisor] Stopped');
  }

  // ── Snapshot ──

  snapshot(): SupervisorSnapshot {
    const entries: SupervisorSnapshot['components'] = [];

    for (const [name, state] of this._components) {
      entries.push({
        name,
        status: state.status,
        restartCount: state.restartCount,
        lastHeartbeat: state.lastHeartbeat,
        degradedSince: state.degradedSince,
      });
    }

    const hasUnhealthy = entries.some(e => e.status === 'unhealthy');
    const hasDegraded = entries.some(e => e.status === 'degraded');

    return {
      components: entries,
      overallStatus: hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy',
    };
  }

  // ── Private: Heartbeat Loop ──

  private async _heartbeatLoop(): Promise<void> {
    if (!this._running) return;

    // Only run when the kernel is in a running-like state
    const state = this._lifecycle.state;
    if (state !== 'running' && state !== 'degraded') return;

    for (const [name, compState] of this._components) {
      if (compState.status === 'stopped' || compState.status === 'starting') continue;

      try {
        const healthy = await compState.component.healthCheck();
        compState.lastHeartbeat = Date.now();

        if (healthy) {
          if (compState.status === 'unhealthy' || compState.status === 'degraded') {
            // Component recovered
            compState.status = 'healthy';
            compState.degradedSince = null;
            await this._eventBus.publish('system.recovered', {
              component: name,
              timestamp: Date.now(),
            });
            console.log(`[Supervisor] ${name} recovered → healthy`);
          }
        } else {
          // Health check returned false — component is degraded
          this._handleUnhealthy(name, compState, 'health_check_failed');
        }
      } catch (err) {
        // Health check threw — component may have crashed
        this._handleUnhealthy(
          name,
          compState,
          `health_check_error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private async _handleUnhealthy(
    name: string,
    state: ComponentState,
    reason: string,
  ): Promise<void> {
    const now = Date.now();
    const timeSinceHeartbeat = now - state.lastHeartbeat;

    // Only escalate if heartbeat is actually stale
    if (timeSinceHeartbeat < HEARTBEAT_TIMEOUT_MS) {
      // Still within timeout — mark degraded but don't restart yet
      if (state.status === 'healthy') {
        state.status = 'degraded';
        state.degradedSince = now;
        await this._eventBus.publish('system.degraded', {
          component: name,
          timestamp: now,
          reason,
        });
        console.warn(`[Supervisor] ${name} degraded: ${reason}`);

        // Cascade: mark dependents as degraded too
        this._cascadeDegradation(name);
      }
      return;
    }

    // Component is truly unhealthy — apply restart policy
    console.error(`[Supervisor] ${name} unhealthy (${reason}) — applying restart policy: ${state.component.restartPolicy}`);

    state.status = 'unhealthy';
    if (!state.degradedSince) {
      state.degradedSince = now;
    }

    await this._eventBus.publish('system.degraded', {
      component: name,
      timestamp: now,
      reason: `unhealthy: ${reason}`,
    });

    this._cascadeDegradation(name);

    // Apply restart policy
    const shouldRestart = this._evaluateRestartPolicy(state);
    if (shouldRestart) {
      await this._restartComponent(name, state);
    }
  }

  private _evaluateRestartPolicy(state: ComponentState): boolean {
    const policy = state.component.restartPolicy;

    // Update crash window tracking
    const now = Date.now();
    if (now - state.crashWindowStart > CRASH_WINDOW_MS) {
      state.crashWindowStart = now;
      state.crashesInWindow = 0;
    }
    state.crashesInWindow++;

    // Check crash loop
    if (state.crashesInWindow > MAX_CRASHES_PER_WINDOW) {
      const event = `${state.component.name} crash loop detected: ${state.crashesInWindow} crashes in ${CRASH_WINDOW_MS / 1000}s window`;
      console.error(`[Supervisor] ${event}`);
      this._eventBus.publish('system.crash_loop', {
        component: state.component.name,
        count: state.crashesInWindow,
        windowMs: CRASH_WINDOW_MS,
      });
      return false; // Escalate, stop restarting
    }

    switch (policy) {
      case 'always':
      case 'always-backoff':
        return true;
      case 'max-3':
        return state.restartCount < 3;
      case 'max-5':
        return state.restartCount < 5;
      case 'never':
        return false;
      default:
        return false;
    }
  }

  private async _restartComponent(name: string, state: ComponentState): Promise<void> {
    state.restartCount++;
    state.lastRestart = Date.now();
    state.status = 'starting';

    // Calculate backoff delay
    let delay = 0;
    if (state.component.restartPolicy === 'always-backoff') {
      delay = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, state.restartCount - 1),
        BACKOFF_MAX_MS,
      );
    }

    console.log(`[Supervisor] Restarting ${name} (attempt ${state.restartCount}, delay: ${delay}ms)`);

    await this._eventBus.publish('system.component.restarting', {
      component: name,
      attempt: state.restartCount,
      delayMs: delay,
    });

    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      // Stop if still partially running
      if (state.component.onStop) {
        await state.component.onStop();
      }

      // Restart
      if (state.component.onRestart) {
        await state.component.onRestart();
      }

      // Verify health
      const healthy = await state.component.healthCheck();
      if (healthy) {
        state.status = 'healthy';
        state.degradedSince = null;
        state.crashesInWindow = 0;
        state.lastHeartbeat = Date.now();

        await this._eventBus.publish('system.recovered', {
          component: name,
          timestamp: Date.now(),
          afterRestart: true,
          attempt: state.restartCount,
        });

        console.log(`[Supervisor] ${name} restarted successfully`);
      } else {
        state.status = 'unhealthy';
        console.error(`[Supervisor] ${name} restart failed — health check still failing`);
      }
    } catch (err) {
      state.status = 'unhealthy';
      console.error(`[Supervisor] ${name} restart failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  private async _stopComponent(name: string): Promise<void> {
    const state = this._components.get(name);
    if (!state) return;

    if (state.component.onStop) {
      try {
        await state.component.onStop();
      } catch (err) {
        console.error(`[Supervisor] Error stopping ${name}:`, err);
      }
    }
    state.status = 'stopped';
  }

  private _cascadeDegradation(unhealthyComponent: string): void {
    // Find all components that depend on the unhealthy one
    for (const [name, state] of this._components) {
      if (state.component.dependencies.includes(unhealthyComponent)) {
        if (state.status === 'healthy') {
          state.status = 'degraded';
          state.degradedSince = Date.now();
          console.warn(`[Supervisor] ${name} degraded (dependency ${unhealthyComponent} unhealthy)`);
          // Recursively cascade
          this._cascadeDegradation(name);
        }
      }
    }
  }

  // ── Lifecycle-Aware Scheduling ──

  /**
   * Schedule a recurring task that is lifecycle-aware.
   * The task will only run when the kernel is in RUNNING or DEGRADED state.
   * Replaces raw setInterval calls.
   */
  scheduleRecurring(
    name: string,
    fn: () => Promise<void>,
    intervalMs: number,
  ): () => void {
    const timer = setInterval(async () => {
      const state = this._lifecycle.state;
      if (state !== 'running' && state !== 'degraded') return;

      try {
        await fn();
      } catch (err) {
        console.error(`[Supervisor] Scheduled task '${name}' error:`, err);
      }
    }, intervalMs);

    // Return a cleanup function
    return () => clearInterval(timer);
  }
}
