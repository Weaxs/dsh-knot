import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { AsyncQueue } from '../async-queue.js';

interface Pending {
  resolve: (value: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
}

export class GatewayWebSocket {
  private ws?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private events = new AsyncQueue<Record<string, any>>(64);
  private readonly subscribers = new Set<AsyncQueue<Record<string, any>>>();
  private connected = false;

  constructor(private readonly timeoutMs = 30_000) {}

  get isOpen(): boolean {
    return this.connected;
  }

  async openWebSocket(options: {
    host: string;
    port: number;
    tls?: boolean;
    path?: string;
    origin?: string;
  }): Promise<void> {
    if (this.connected) return;
    this.events = new AsyncQueue<Record<string, any>>(64);
    const protocol = options.tls ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${options.host}:${options.port}${options.path ?? '/'}`, 'json', {
      ...(options.origin ? { origin: options.origin } : {}),
      handshakeTimeout: this.timeoutMs,
    });
    this.ws = ws;
    ws.on('message', (data) => this.message(data));
    ws.on('error', (error) => {
      if (this.ws === ws) this.fail(error);
    });
    ws.on('close', () => {
      if (this.ws === ws) this.fail(new Error('Gateway WebSocket closed'));
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onClose);
      };
      const onOpen = () => {
        cleanup();
        this.connected = true;
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Gateway WebSocket closed before handshake opened'));
      };
      const timer = setTimeout(() => {
        cleanup();
        if (this.ws === ws) this.ws = undefined;
        ws.terminate();
        reject(new Error('Gateway WebSocket upgrade timed out'));
      }, this.timeoutMs);
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
    });
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> {
    if (!this.connected || !this.ws) return Promise.reject(new Error('Gateway is not connected'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('request aborted'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let cleanup: (() => void) | undefined;
      const timer = setTimeout(() => {
        cleanup?.();
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(signal.reason ?? new Error('request aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, { resolve, reject, timer, cleanup });
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          cleanup?.();
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async nextEvent(signal?: AbortSignal): Promise<IteratorResult<Record<string, any>>> {
    return this.events.next(signal);
  }

  subscribeEvents(): {
    next: (signal?: AbortSignal) => Promise<IteratorResult<Record<string, any>>>;
    unsubscribe: () => void;
  } {
    const queue = new AsyncQueue<Record<string, any>>(1_024, 'error');
    this.subscribers.add(queue);
    return {
      next: (signal?: AbortSignal) => queue.next(signal),
      unsubscribe: () => {
        this.subscribers.delete(queue);
        queue.finish();
      },
    };
  }

  async close(): Promise<void> {
    this.connected = false;
    this.ws?.close();
    this.ws = undefined;
    this.events.finish();
    for (const queue of this.subscribers) queue.finish();
    this.subscribers.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new Error('Gateway connection closed'));
      this.pending.delete(id);
    }
  }

  private message(data: RawData): void {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame.type === 'event') {
      if (this.subscribers.size > 0) {
        for (const queue of this.subscribers) queue.push(frame);
      } else {
        this.events.push(frame);
      }
      return;
    }
    if (frame.type === 'res' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.cleanup?.();
        this.pending.delete(frame.id);
        if (frame.ok === false)
          pending.reject(new Error(frame.error?.message ?? frame.error?.code ?? 'Gateway request failed'));
        else pending.resolve(frame.payload ?? {});
      }
      return;
    }
    if (frame.type === 'req' && typeof frame.id === 'string') {
      this.ws?.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: { code: 'NOT_SUPPORTED', message: 'This client does not serve reverse requests' },
        }),
      );
    }
  }

  private fail(error: Error): void {
    this.connected = false;
    this.events.fail(error);
    for (const queue of this.subscribers) queue.fail(error);
    this.subscribers.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
