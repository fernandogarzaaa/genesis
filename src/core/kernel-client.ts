// ─── Genesis Frontend: Kernel WebSocket Client ──────────────────────
// Connects to the Genesis Kernel's WebSocket API.
// Supports authentication handshake and automatic token management.

type MessageHandler = (payload: Record<string, unknown>) => void;

/** Status of the kernel connection. */
export type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

class KernelClient {
  private _ws: WebSocket | null = null;
  private _url: string;
  private _reconnectDelay = 1000;
  private _maxReconnectDelay = 30000;
  private _handlers: Map<string, Set<MessageHandler>> = new Map();
  private _connected = false;
  private _authenticated = false;
  private _state: ConnectionState = 'disconnected';
  private _snapshot: Record<string, unknown> | null = null;
  private _token: string | null = null;
  private _pendingMessages: Array<Record<string, unknown>> = [];
  private _authTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string = 'ws://localhost:3001') {
    this._url = url;
    this._loadToken();
  }

  // ── Public Properties ──

  get connected(): boolean {
    return this._connected;
  }

  get authenticated(): boolean {
    return this._authenticated;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get snapshot(): Record<string, unknown> | null {
    return this._snapshot;
  }

  get hasToken(): boolean {
    return this._token !== null;
  }

  // ── Token Management ──

  /**
   * Set the authentication token. Will be used on next connect/reconnect.
   * Persisted to localStorage for survival across page reloads.
   */
  setToken(token: string): void {
    this._token = token;
    try {
      localStorage.setItem('genesis_auth_token', token);
    } catch { /* localStorage not available */ }
  }

  /** Clear the stored token. */
  clearToken(): void {
    this._token = null;
    try {
      localStorage.removeItem('genesis_auth_token');
    } catch { /* localStorage not available */ }
  }

  private _loadToken(): void {
    try {
      const stored = localStorage.getItem('genesis_auth_token');
      if (stored) this._token = stored;
    } catch { /* localStorage not available */ }
  }

  // ── Connection ──

  connect(): void {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this._state = 'connecting';
    this._authenticated = false;

    try {
      this._ws = new WebSocket(this._url);

      this._ws.onopen = () => {
        console.log('[KernelClient] Connected to Genesis Kernel');
        this._connected = true;
        this._reconnectDelay = 1000;
        this._emit('connected', {});

        // If we have a token, send auth immediately
        if (this._token) {
          this._state = 'authenticating';
          this._send({ type: 'auth', payload: { token: this._token } });
        }
        // Otherwise wait for auth_required or snapshot (dev mode)
      };

      this._ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data.toString());
          this._handleMessage(msg);
        } catch (err) {
          console.warn('[KernelClient] Failed to parse message:', err);
        }
      };

      this._ws.onclose = () => {
        this._connected = false;
        this._authenticated = false;
        this._state = 'disconnected';
        this._emit('disconnected', {});
        this._scheduleReconnect();
      };

      this._ws.onerror = () => {
        // Connection errors are expected when kernel server is not running.
        // The stores module handles this gracefully with mock data.
      };
    } catch (err) {
      console.error('[KernelClient] Connection failed:', err);
      this._scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this._authTimeout) {
      clearTimeout(this._authTimeout);
      this._authTimeout = null;
    }
    if (this._ws) {
      this._ws.close(1000, 'Client disconnect');
      this._ws = null;
    }
    this._connected = false;
    this._authenticated = false;
    this._state = 'disconnected';
    this._pendingMessages = [];
  }

  // ── Event Subscription ──

  on(type: string, handler: MessageHandler): () => void {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, new Set());
    }
    this._handlers.get(type)!.add(handler);

    return () => {
      const handlers = this._handlers.get(type);
      if (handlers) {
        handlers.delete(handler);
      }
    };
  }

  // ── Kernel API ──

  subscribe(eventType: string): void {
    this._sendOrQueue({ type: 'subscribe', payload: { eventType } });
  }

  unsubscribe(eventType: string): void {
    this._sendOrQueue({ type: 'unsubscribe', payload: { eventType } });
  }

  submitTask(goal: string, context?: string): void {
    this._sendOrQueue({ type: 'task.submit', payload: { goal, context }, id: crypto.randomUUID() });
  }

  requestSnapshot(): void {
    this._sendOrQueue({ type: 'kernel.snapshot', payload: {} });
  }

  approveProposal(proposalId: string): void {
    this._sendOrQueue({ type: 'proposal.approve', payload: { proposalId } });
  }

  rejectProposal(proposalId: string, reason?: string): void {
    this._sendOrQueue({ type: 'proposal.reject', payload: { proposalId, reason } });
  }

  sendSystemCommand(command: string): void {
    this._sendOrQueue({ type: 'system.command', payload: { command } });
  }

  // ── Private: Message Handling ──

  private _handleMessage(msg: { type: string; payload: Record<string, unknown>; id?: string }): void {
    const { type, payload } = msg;

    switch (type) {
      case 'auth_required': {
        // Kernel requires authentication. If we have a token, send it.
        if (this._token) {
          this._state = 'authenticating';
          this._send({ type: 'auth', payload: { token: this._token } });
        } else {
          this._state = 'connected'; // Connected but unauthenticated
          this._emit('auth_required', payload);
        }
        return;
      }

      case 'auth_success': {
        this._authenticated = true;
        this._state = 'connected';
        console.log(`[KernelClient] Authenticated as ${payload.clientId} (${payload.role})`);
        this._emit('auth_success', payload);
        // Flush pending messages
        this._flushPending();
        return;
      }

      case 'error': {
        const code = payload.code as string;
        if (code === 'AUTH_FAILED' || code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
          this._emit('auth_error', payload);
        }
        break;
      }
    }

    // Emit to type-specific handlers
    this._emit(type, payload);

    // If it's a kernel event from subscription, also emit as 'event'
    if (type === 'event') {
      const eventType = payload.eventType as string;
      if (eventType) {
        this._emit(eventType, payload);
      }
    }

    // Store snapshot
    if (type === 'kernel.snapshot') {
      this._snapshot = payload;
    }
  }

  // ── Private: Messaging ──

  /**
   * Send a message if connected, or queue it for later.
   * Messages requiring auth are queued until authenticated.
   */
  private _sendOrQueue(msg: Record<string, unknown>): void {
    if (this._ws?.readyState === WebSocket.OPEN && this._authenticated) {
      this._send(msg);
    } else {
      this._pendingMessages.push(msg);
    }
  }

  private _send(msg: Record<string, unknown>): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  private _flushPending(): void {
    const pending = this._pendingMessages;
    this._pendingMessages = [];
    for (const msg of pending) {
      this._send(msg);
    }
  }

  // ── Private: Helpers ──

  private _emit(type: string, payload: Record<string, unknown>): void {
    const handlers = this._handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[KernelClient] Handler error for '${type}':`, err);
        }
      }
    }
  }

  private _scheduleReconnect(): void {
    setTimeout(() => {
      this.connect();
      this._reconnectDelay = Math.min(
        this._reconnectDelay * 1.5,
        this._maxReconnectDelay,
      );
    }, this._reconnectDelay);
  }
}

// Singleton
export const kernelClient = new KernelClient(
  import.meta.env.DEV ? 'ws://localhost:3001' : `ws://${window.location.hostname}:3001`
);
