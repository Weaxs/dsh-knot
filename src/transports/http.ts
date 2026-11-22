import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { AgentConfig, HttpRequest, HttpResponse, Transport } from '../types.js';
import { openSshSocket, type StdioSocket } from './stdio-socket.js';

const MAX_BODY = 16 * 1024 * 1024;

export class NodeHttpTransport implements Transport {
  constructor(
    readonly kind: 'ssh' | 'direct' | 'local',
    private readonly config: AgentConfig,
  ) {}

  async request(input: HttpRequest): Promise<HttpResponse> {
    const response = await this.stream(input);
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BODY) throw new Error(`response exceeds ${MAX_BODY} bytes`);
        chunks.push(buffer);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const headers = Object.fromEntries(
        Object.entries(response.headers).filter(([key]) => key.toLowerCase() !== 'authorization'),
      );
      return { status: response.statusCode ?? 0, headers, text };
    } finally {
      response.destroy();
    }
  }

  async stream(input: HttpRequest): Promise<IncomingMessage> {
    const payload = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    const host = this.kind === 'ssh' ? '127.0.0.1' : (this.config.host ?? '127.0.0.1');
    const secure = this.kind !== 'ssh' && this.config.tls === true;
    const basePath = this.kind !== 'ssh' && this.config.basePath ? this.config.basePath.replace(/\/+$/, '') : '';
    const path = basePath ? `${basePath}${input.path.startsWith('/') ? input.path : `/${input.path}`}` : input.path;
    let sshSocket: StdioSocket | undefined;
    const factory =
      this.kind === 'ssh'
        ? () => {
            sshSocket = openSshSocket(this.config);
            return sshSocket;
          }
        : undefined;
    const customAgent = factory ? new http.Agent() : undefined;
    if (customAgent && factory) customAgent.createConnection = factory as unknown as () => Socket;
    const options: RequestOptions = {
      protocol: secure ? 'https:' : 'http:',
      host,
      port: this.config.port,
      method: input.method ?? 'GET',
      path,
      agent: customAgent ?? false,
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...input.headers,
      },
    };
    const driver = secure ? https : http;
    const timeoutMs = this.config.connectTimeoutMs ?? 15_000;
    return new Promise<IncomingMessage>((resolve, reject) => {
      let headerTimer: NodeJS.Timeout | undefined;
      const clearHeaderTimer = () => {
        if (headerTimer) {
          clearTimeout(headerTimer);
          headerTimer = undefined;
        }
      };
      const request = driver.request(options, (response) => {
        clearHeaderTimer();
        request.setTimeout(0);
        if ((response.statusCode ?? 500) >= 400) {
          const decoder = new StringDecoder('utf8');
          let detail = '';
          let settled = false;
          const finish = (err: Error) => {
            if (settled) return;
            settled = true;
            reject(err);
          };
          response.on('data', (chunk: Buffer) => {
            detail = (detail + decoder.write(chunk)).slice(-16_384);
          });
          response.on('error', finish);
          response.on('end', () => {
            detail = (detail + decoder.end()).slice(-16_384);
            finish(new Error(`HTTP ${response.statusCode}: ${detail || response.statusMessage || 'request failed'}`));
          });
          response.on('close', () => {
            detail = (detail + decoder.end()).slice(-16_384);
            finish(new Error(`HTTP ${response.statusCode}: ${detail || response.statusMessage || 'response closed'}`));
          });
          return;
        }
        resolve(response);
      });
      headerTimer = setTimeout(() => {
        const stderr = sshSocket?.lastStderr();
        const detail = stderr ? ` (ssh: ${stderr})` : '';
        request.destroy(new Error(`request timed out after ${timeoutMs}ms${detail}`));
      }, timeoutMs);
      request.on('error', (error: Error) => {
        clearHeaderTimer();
        const stderr = sshSocket?.lastStderr();
        if (stderr && !error.message.includes(stderr)) {
          reject(new Error(`${error.message} (ssh: ${stderr})`));
        } else {
          reject(error);
        }
      });
      const signal = input.signal;
      const abort = () => {
        clearHeaderTimer();
        request.destroy(new Error('request aborted'));
      };
      if (signal?.aborted) {
        clearHeaderTimer();
        request.destroy(new Error('request aborted'));
      } else {
        signal?.addEventListener('abort', abort, { once: true });
      }
      responseCleanup(request, () => {
        clearHeaderTimer();
        signal?.removeEventListener('abort', abort);
        customAgent?.destroy();
      });
      request.end(payload);
    });
  }

  socket(): Duplex {
    if (this.kind !== 'ssh') throw new Error('custom sockets are only used by the ssh transport');
    return openSshSocket(this.config);
  }

  async close(): Promise<void> {}
}

function responseCleanup(request: http.ClientRequest, cleanup: () => void): void {
  let done = false;
  let hasResponse = false;
  const onceCleanup = () => {
    if (done) return;
    done = true;
    cleanup();
  };
  request.on('response', (response) => {
    hasResponse = true;
    response.once('close', onceCleanup);
  });
  request.once('close', () => {
    if (!hasResponse) onceCleanup();
  });
}

export function transportFor(config: AgentConfig): NodeHttpTransport {
  return new NodeHttpTransport(config.transport ?? 'ssh', config);
}
