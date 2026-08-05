// ─── Genesis Kernel: Lifecycle Manager ──────────────────────────────
// The kernel is the ONLY component that starts/restarts other components.
// This implements the full lifecycle state machine from §4.3.

import { v4 as uuid } from 'uuid';
import type {
  KernelState,
  LifecycleTransition,
} from './kernel-types.js';

export type StateChangeCallback = (
  from: KernelState,
  to: KernelState,
  reason: string
) => void | Promise<void>;

const VALID_TRANSITIONS: Record<KernelState, KernelState[]> = {
  uninitialized: ['booting'],
  booting: ['initializing', 'stopping'],
  initializing: ['running', 'degraded', 'stopping'],
  running: ['degraded', 'paused', 'stopping'],
  degraded: ['running', 'paused', 'stopping'],
  paused: ['running', 'stopping'],
  stopping: ['stopped'],
  stopped: ['booting', 'destroyed'],
  destroyed: [],
};

export class LifecycleManager {
  private _state: KernelState = 'uninitialized';
  private _transitions: LifecycleTransition[] = [];
  private _listeners: Map<string, StateChangeCallback> = new Map();
  private _instanceId: string;

  constructor() {
    this._instanceId = uuid();
  }

  // ── Read state ──

  get state(): KernelState {
    return this._state;
  }

  get instanceId(): string {
    return this._instanceId;
  }

  get isRunning(): boolean {
    return this._state === 'running' || this._state === 'degraded';
  }

  get isAlive(): boolean {
    return !['stopped', 'destroyed'].includes(this._state);
  }

  get transitions(): ReadonlyArray<LifecycleTransition> {
    return this._transitions;
  }

  // ── State mutations ──

  async transition(to: KernelState, reason: string): Promise<void> {
    const from = this._state;

    if (from === to) return;

    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid lifecycle transition: ${from} → ${to}. ` +
        `Allowed: ${allowed.join(', ') || 'none'}`
      );
    }

    const transition: LifecycleTransition = {
      from,
      to,
      timestamp: Date.now(),
      reason,
    };

    this._state = to;
    this._transitions.push(transition);

    // Notify listeners
    const promises: Promise<void>[] = [];
    for (const listener of this._listeners.values()) {
      promises.push(Promise.resolve(listener(from, to, reason)));
    }
    await Promise.all(promises);
  }

  // ── Convenience methods ──

  async start(): Promise<void> {
    if (this._state !== 'uninitialized') {
      throw new Error(`Cannot start from state: ${this._state}`);
    }
    await this.transition('booting', 'kernel.start() called');
  }

  async bootComplete(): Promise<void> {
    await this.transition('initializing', 'preflight complete');
  }

  async initComplete(): Promise<void> {
    await this.transition('running', 'all subsystems started');
  }

  async degraded(reason: string): Promise<void> {
    await this.transition('degraded', reason);
  }

  async recover(): Promise<void> {
    if (this._state !== 'degraded') {
      throw new Error(`Cannot recover from state: ${this._state}`);
    }
    await this.transition('running', 'health recovered');
  }

  async pause(reason: string): Promise<void> {
    await this.transition('paused', reason);
  }

  async resume(): Promise<void> {
    if (this._state !== 'paused') {
      throw new Error(`Cannot resume from state: ${this._state}`);
    }
    await this.transition('running', 'operator resumed');
  }

  async stop(reason: string): Promise<void> {
    await this.transition('stopping', reason);
  }

  async stopComplete(): Promise<void> {
    await this.transition('stopped', 'shutdown complete');
  }

  async restart(): Promise<void> {
    if (this._state !== 'stopped') {
      throw new Error(`Cannot restart from state: ${this._state}`);
    }
    await this.transition('booting', 'operator restart');
  }

  async destroy(): Promise<void> {
    await this.transition('destroyed', 'kernel.destroy()');
  }

  // ── Listeners ──

  onStateChange(id: string, callback: StateChangeCallback): void {
    this._listeners.set(id, callback);
  }

  offStateChange(id: string): void {
    this._listeners.delete(id);
  }

  // ── Snapshot (for crash recovery) ──

  snapshot(): {
    state: KernelState;
    instanceId: string;
    transitionCount: number;
    lastTransition: LifecycleTransition | null;
  } {
    return {
      state: this._state,
      instanceId: this._instanceId,
      transitionCount: this._transitions.length,
      lastTransition:
        this._transitions.length > 0
          ? this._transitions[this._transitions.length - 1]
          : null,
    };
  }
}
