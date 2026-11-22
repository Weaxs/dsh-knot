import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { configuredTransport, LEGACY_SSH_ERROR } from '../config.js';
import type { AgentConfig, HttpRequest, HttpResponse, Transport, TransportKind } from '../types.js';

const MAX_BODY = 16 * 1024 * 1024;

export class NodeHttpTransport implements Transport {
  constructor(
    readonly kind: TransportKind,
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
    const host = this.config.host ?? '127.0.0.1';
    const secure = this.config.tls === true;
    const basePath = this.config.basePath?.replace(/\/+$/, '') ?? '';
    const path = basePath ? `${basePath}${input.path.startsWith('/') ? input.path : `/${input.path}`}` : input.path;
    const options: RequestOptions = {
      protocol: secure ? 'https:' : 'http:',
      host,
      port: this.config.port,
      method: input.method ?? 'GET',
      path,
      agent: false,
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
        if ((response.statusCode ?? 500) >= 400) {
          const decoder = new StringDecoder('utf8');
          let detail = '';
          let settled = false;
          const finish = (err: Error) => {
            if (settled) return;
            settled = true;
            clearHeaderTimer();
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
        clearHeaderTimer();
        resolve(response);
      });
      headerTimer = setTimeout(() => {
        const error = new Error(`request timed out after ${timeoutMs}ms`);
        reject(error);
        request.destroy(error);
      }, timeoutMs);
      request.on('error', (error: Error) => {
        clearHeaderTimer();
        reject(error);
      });
      const signal = input.signal;
      const abort = () => {
        clearHeaderTimer();
        request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('request aborted'));
      };
      if (signal?.aborted) abort();
      else {
        signal?.addEventListener('abort', abort, { once: true });
      }
      responseCleanup(request, () => {
        clearHeaderTimer();
        signal?.removeEventListener('abort', abort);
      });
      request.end(payload);
    });
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
  const kind = configuredTransport(config);
  if (kind === 'ssh') throw new Error(`${config.id}: ${LEGACY_SSH_ERROR}`);
  return new NodeHttpTransport(kind, config);
}
