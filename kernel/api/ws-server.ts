// ─── Genesis Kernel: WebSocket API Server ───────────────────────────
// Bidirectional communication with the Command Center frontend.
// Secured with authentication, permission checks, rate limiting,
// payload validation, and origin validation.

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { GenesisKernel } from '../index.js';
import type { EventEnvelope } from '../core/kernel-types.js';
import type { SecurityEnforcer } from '../security/security-enforcer.js';
import type { ClientIdentity } from '../security/auth-manager.js';
import { MESSAGE_PERMISSIONS } from '../security/permission-manager.js';
import { redactSecrets } from '../security/secret-store.js';

// ── Types ──

interface WSMessage {
  type: string;
  payload: Record<string, unknown>;
  id?: string;
}

interface AuthenticatedSocket {
  socket: WebSocket;
  identity: ClientIdentity | null;
  authenticated: boolean;
  connectedAt: number;
}

// ── Protected message types ──

const PROTECTED_MESSAGES = new Set([
  'task.submit',
  'proposal.approve',
  'proposal.reject',
  'system.command',
  'event.subscribe',
  'unsubscribe',       // Treated same as subscribe for auth
  'audit.query',
]);

// ── Public message types (no auth required) ──
const PUBLIC_MESSAGES = new Set([
  'auth',
  'ping',
  'kernel.snapshot',
]);

export class WSServer {
  private _kernel: GenesisKernel;
  private _security: SecurityEnforcer;
  private _port: number;
  private _wss: WebSocketServer | null = null;
  private _clients: Map<WebSocket, AuthenticatedSocket> = new Map();
  private _subscriptions: Map<string, Set<WebSocket>> = new Map();
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(kernel: GenesisKernel, security: SecurityEnforcer, port: number = 3001) {
    this._kernel = kernel;
    this._security = security;
    this._port = port;
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const serverOpts: Record<string, unknown> = { port: this._port };

        // TLS support
        const tlsConfig = this._security.ws.config.tls;
        if (tlsConfig?.cert && tlsConfig?.key) {
          // In production, load cert/key from files
          serverOpts.cert = tlsConfig.cert;
          serverOpts.key = tlsConfig.key;
        }

        this._wss = new WebSocketServer(serverOpts, () => {
          const protocol = tlsConfig ? 'wss' : 'ws';
          const devNote = this._security.devMode ? ' [DEV MODE — auth disabled]' : '';
          console.log(`[WS] Server listening on ${protocol}://localhost:${this._port}${devNote}`);
          this._setupKernelEventBridge();
          this._startCleanupTimer();
          resolve();
        });

        this._wss.on('connection', (ws, req) => {
          this._handleConnection(ws, req);
        });

        this._wss.on('error', (err) => {
          console.error('[WS] Server error:', redactSecrets(err.message));
          reject(err);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }

    return new Promise((resolve) => {
      // Close all client connections
      for (const [ws, client] of this._clients) {
        if (client.identity) {
          this._security.auditLogger.log({
            timestamp: Date.now(),
            actor: client.identity.clientId,
            action: 'ws.disconnect',
            resource: 'websocket',
            outcome: 'allow',
            details: { reason: 'server_shutdown' },
          });
        }
        ws.close(1001, 'Server shutting down');
      }
      this._clients.clear();
      this._subscriptions.clear();

      if (this._wss) {
        this._wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // ── Broadcast ──

  broadcast(type: string, payload: Record<string, unknown>): void {
    const message = JSON.stringify({ type, payload });
    for (const [ws] of this._clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  broadcastToSubscribers(eventType: string, payload: Record<string, unknown>): void {
    const subscribers = this._subscriptions.get(eventType);
    if (!subscribers) return;

    const message = JSON.stringify({ type: 'event', payload: { eventType, ...payload } });
    for (const client of subscribers) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  // ── Private: Event Bridge ──

  private _setupKernelEventBridge(): void {
    const eventTypes = [
      'system.started',
      'system.stopping',
      'system.stopped',
      'system.degraded',
      'system.recovered',
      'system.health',
      'cog.task.received',
      'cog.task.planned',
      'cog.task.executing',
      'cog.task.step_completed',
      'cog.task.completed',
      'cog.task.failed',
      'cog.task.escalated',
      'cog.model.called',
      'perc.observation.processed',
      'perc.validation.completed',
      'perc.reflection.completed',
      'perc.anomaly.detected',
      'learn.experience.consolidated',
      'learn.proposal.created',
      'learn.proposal.approved',
      'learn.proposal.rejected',
      'learn.proposal.deployed',
      'learn.meta.report',
    ];

    for (const eventType of eventTypes) {
      this._kernel.eventBus.subscribe(eventType, (event: EventEnvelope) => {
        this.broadcastToSubscribers(eventType, {
          eventId: event.eventId,
          correlationId: event.correlationId,
          timestamp: event.timestamp,
          source: event.source,
          ...event.payload as Record<string, unknown>,
        });
      });
    }

    // Subscribe to ALL events for the general stream
    this._kernel.eventBus.subscribe('#', (event: EventEnvelope) => {
      this.broadcastToSubscribers('*', {
        eventType: event.type,
        eventId: event.eventId,
        correlationId: event.correlationId,
        timestamp: event.timestamp,
        source: event.source,
        payload: event.payload,
      });
    });
  }

  // ── Private: Connection Handling ──

  private _handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Origin validation
    const origin = req.headers.origin ?? '';
    const clientIp = req.socket?.remoteAddress ?? 'unknown';

    const connCheck = this._security.ws.checkConnection(origin, clientIp);
    if (!connCheck.allowed) {
      ws.close(connCheck.statusCode ?? 403, connCheck.reason ?? 'Forbidden');
      return;
    }

    const authSocket: AuthenticatedSocket = {
      socket: ws,
      identity: null,
      authenticated: this._security.devMode,
      connectedAt: Date.now(),
    };

    // Dev mode: auto-authenticate
    if (this._security.devMode) {
      authSocket.identity = this._security.auth.devIdentity();
      authSocket.authenticated = true;
    }

    this._clients.set(ws, authSocket);
    console.log(`[WS] Client connected (${this._clients.size} total)`);

    this._security.auditLogger.log({
      timestamp: Date.now(),
      actor: authSocket.identity?.clientId ?? 'unauthenticated',
      action: 'ws.connect',
      resource: 'websocket',
      outcome: 'allow',
      details: { devMode: this._security.devMode, origin: origin || 'none' },
      ip: clientIp,
    });

    // Send auth required message (skip in dev mode)
    if (!this._security.devMode) {
      this._send(ws, {
        type: 'auth_required',
        payload: {
          message: 'Authentication required. Send auth message with token.',
          devMode: false,
        },
      });
    } else {
      // Send initial state snapshot immediately in dev mode
      this._sendSnapshot(ws);
    }

    ws.on('message', (raw) => {
      this._handleMessage(ws, raw.toString());
    });

    ws.on('close', () => {
      const client = this._clients.get(ws);
      if (client?.identity) {
        this._security.auditLogger.log({
          timestamp: Date.now(),
          actor: client.identity.clientId,
          action: 'ws.disconnect',
          resource: 'websocket',
          outcome: 'allow',
          details: {},
        });
      }
      this._clients.delete(ws);
      this._security.ws.onDisconnect();
      // Remove from all subscriptions
      for (const [, subs] of this._subscriptions) {
        subs.delete(ws);
      }
      console.log(`[WS] Client disconnected (${this._clients.size} total)`);
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', redactSecrets(err.message));
      this._clients.delete(ws);
      this._security.ws.onDisconnect();
    });
  }

  // ── Private: Message Handling ──

  private _handleMessage(ws: WebSocket, rawData: string): void {
    const client = this._clients.get(ws);
    if (!client) return;

    // Rate limit check
    const rateCheck = this._security.ws.checkRateLimit(
      client.identity?.clientId ?? ws._socket?.remoteAddress ?? 'unknown'
    );
    if (!rateCheck.allowed) {
      this._send(ws, {
        type: 'error',
        payload: { code: 'RATE_LIMITED', message: rateCheck.reason },
      });
      return;
    }

    // Payload validation
    const payloadCheck = this._security.ws.validatePayload(rawData);
    if (!payloadCheck.allowed) {
      this._send(ws, {
        type: 'error',
        payload: { code: 'INVALID_PAYLOAD', message: payloadCheck.reason },
      });
      return;
    }

    // Schema validation
    const schemaCheck = this._security.ws.validateMessageSchema(payloadCheck.parsed);
    if (!schemaCheck.allowed) {
      this._send(ws, {
        type: 'error',
        payload: { code: 'SCHEMA_ERROR', message: schemaCheck.reason },
      });
      return;
    }

    const msg = payloadCheck.parsed as WSMessage;

    // Auth message: handle before authentication check
    if (msg.type === 'auth') {
      this._handleAuth(ws, client, msg);
      return;
    }

    // Authentication check for protected messages
    if (PROTECTED_MESSAGES.has(msg.type) && !client.authenticated) {
      this._send(ws, {
        type: 'error',
        payload: { code: 'UNAUTHORIZED', message: 'Authentication required. Send auth message first.' },
        id: msg.id,
      });
      return;
    }

    // Permission check for protected messages
    if (PROTECTED_MESSAGES.has(msg.type) && client.identity) {
      const permission = MESSAGE_PERMISSIONS[msg.type];
      if (permission) {
        const check = this._security.permissions.check(client.identity, permission);
        if (!check.allowed) {
          this._send(ws, {
            type: 'error',
            payload: { code: 'FORBIDDEN', message: check.reason },
            id: msg.id,
          });
          return;
        }
      }
    }

    // Route to handler
    this._routeMessage(ws, client, msg);
  }

  private _handleAuth(ws: WebSocket, client: AuthenticatedSocket, msg: WSMessage): void {
    const token = msg.payload.token as string;

    if (!token || typeof token !== 'string') {
      this._send(ws, {
        type: 'error',
        payload: { code: 'AUTH_FAILED', message: 'Invalid token format' },
        id: msg.id,
      });
      return;
    }

    const identity = this._security.auth.authenticate(token);
    if (!identity) {
      this._send(ws, {
        type: 'error',
        payload: { code: 'AUTH_FAILED', message: 'Invalid or expired token' },
        id: msg.id,
      });
      return;
    }

    client.identity = identity;
    client.authenticated = true;

    this._send(ws, {
      type: 'auth_success',
      payload: {
        clientId: identity.clientId,
        role: identity.role,
        expiresAt: identity.expiresAt,
      },
      id: msg.id,
    });

    // Now send the initial snapshot
    this._sendSnapshot(ws);

    console.log(`[WS] Client authenticated: ${identity.clientId} (${identity.role})`);
  }

  private _routeMessage(ws: WebSocket, client: AuthenticatedSocket, msg: WSMessage): void {
    switch (msg.type) {
      case 'subscribe': {
        const eventType = msg.payload.eventType as string;
        if (!eventType) {
          this._send(ws, {
            type: 'error',
            payload: { message: 'Missing eventType in subscribe' },
          });
          return;
        }
        if (!this._subscriptions.has(eventType)) {
          this._subscriptions.set(eventType, new Set());
        }
        this._subscriptions.get(eventType)!.add(ws);
        this._send(ws, {
          type: 'subscribed',
          payload: { eventType },
        });
        break;
      }

      case 'unsubscribe': {
        const eventType = msg.payload.eventType as string;
        const subs = this._subscriptions.get(eventType);
        if (subs) {
          subs.delete(ws);
        }
        this._send(ws, {
          type: 'unsubscribed',
          payload: { eventType },
        });
        break;
      }

      case 'task.submit': {
        const goal = msg.payload.goal as string;
        const context = msg.payload.context as string | undefined;
        if (!goal) {
          this._send(ws, {
            type: 'error',
            payload: { message: 'Missing goal in task.submit' },
          });
          return;
        }
        this._kernel.submitTask(goal, context).then((taskId) => {
          this._send(ws, {
            type: 'task.created',
            payload: { taskId, goal },
            id: msg.id,
          });
        }).catch((err) => {
          this._send(ws, {
            type: 'error',
            payload: { message: redactSecrets(err.message) },
            id: msg.id,
          });
        });
        break;
      }

      case 'kernel.snapshot': {
        this._sendSnapshot(ws, msg.id);
        break;
      }

      case 'proposal.approve': {
        const proposalId = msg.payload.proposalId as string;
        if (this._kernel.adam) {
          this._kernel.adam.approveProposal(proposalId, 'operator');
          this._send(ws, {
            type: 'proposal.approved',
            payload: { proposalId },
            id: msg.id,
          });
        }
        break;
      }

      case 'proposal.reject': {
        const proposalId = msg.payload.proposalId as string;
        const reason = (msg.payload.reason as string) ?? 'Rejected by operator';
        if (this._kernel.adam) {
          this._kernel.adam.rejectProposal(proposalId, reason, 'operator');
          this._send(ws, {
            type: 'proposal.rejected',
            payload: { proposalId, reason },
            id: msg.id,
          });
        }
        break;
      }

      case 'system.command': {
        const command = msg.payload.command as string;
        this._handleSystemCommand(ws, command, msg.id);
        break;
      }

      case 'audit.query': {
        const { from, to, actor, action, limit } = msg.payload as {
          from?: number; to?: number; actor?: string; action?: string; limit?: number;
        };
        const entries = this._security.auditLogger.query({
          from, to, actor,
          action: action as never,
          limit,
        });
        this._send(ws, {
          type: 'audit.result',
          payload: { entries, count: entries.length },
          id: msg.id,
        });
        break;
      }

      case 'ping': {
        this._send(ws, { type: 'pong', payload: { timestamp: Date.now() } });
        break;
      }

      default:
        this._send(ws, {
          type: 'error',
          payload: { message: `Unknown message type: ${msg.type}` },
          id: msg.id,
        });
    }
  }

  private _handleSystemCommand(ws: WebSocket, command: string, msgId?: string): void {
    switch (command) {
      case 'status': {
        this._send(ws, {
          type: 'system.status',
          payload: this._kernel.getSnapshot() as unknown as Record<string, unknown>,
          id: msgId,
        });
        break;
      }
      case 'pause': {
        this._kernel.lifecycle.pause('operator command');
        this._send(ws, {
          type: 'system.paused',
          payload: { state: this._kernel.lifecycle.state },
          id: msgId,
        });
        break;
      }
      case 'resume': {
        this._kernel.lifecycle.resume();
        this._send(ws, {
          type: 'system.resumed',
          payload: { state: this._kernel.lifecycle.state },
          id: msgId,
        });
        break;
      }
      default:
        this._send(ws, {
          type: 'error',
          payload: { message: `Unknown system command: ${command}` },
          id: msgId,
        });
    }
  }

  // ── Private: Helpers ──

  private _sendSnapshot(ws: WebSocket, msgId?: string): void {
    this._send(ws, {
      type: 'kernel.snapshot',
      payload: this._kernel.getSnapshot() as unknown as Record<string, unknown>,
      id: msgId,
    });
  }

  private _send(ws: WebSocket, msg: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private _startCleanupTimer(): void {
    // Clean up rate limiter buckets every 60 seconds
    this._cleanupTimer = setInterval(() => {
      (this._security.ws as unknown as { _rateLimiter: { cleanup: (maxAgeMs: number) => void } })
        ._rateLimiter?.cleanup?.(60_000);
    }, 60_000);
  }
}
