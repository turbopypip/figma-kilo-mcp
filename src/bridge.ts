import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export const MAX_MESSAGE = 6 * 1024 * 1024;
export class Bridge {
  private server: WebSocketServer;
  private peer?: WebSocket;
  private pending?: { id: string; finish: (error?: Error, value?: unknown) => void };
  readonly ready: Promise<void>;
  constructor(private secret: string, port = 3055, private timeout = 30_000) {
    this.server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: MAX_MESSAGE,
      perMessageDeflate: false, backlog: 8 });
    this.ready = new Promise((resolve, reject) => {
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });
    this.server.on('error', () => {});
    this.server.on('connection', socket => {
      // Unauthenticated connections have a short lifetime and cannot displace a paired browser extension.
      if (this.server.clients.size > 8) { socket.terminate(); return; }
      let authenticated = false;
      const timer = setTimeout(() => socket.terminate(), 3000);
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(timer);
        if (this.peer === socket) {
          this.peer = undefined;
          this.pending?.finish(new Error('Figma browser extension disconnected. Reconnect the browser extension.'));
        }
      });
      socket.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (!authenticated) {
            const supplied = Buffer.from(typeof msg.secret === 'string' ? msg.secret : '');
            const expected = Buffer.from(this.secret);
            if (msg.type !== 'auth' || supplied.length !== expected.length ||
                !timingSafeEqual(supplied, expected) || this.peer) {
              socket.close(1008, 'Pairing failed or another browser extension is connected'); return;
            }
            authenticated = true;
            clearTimeout(timer);
            this.peer = socket;
            socket.send(JSON.stringify({ type: 'ready' }));
            return;
          }
          if (msg.type !== 'response' || msg.id !== this.pending?.id) return;
          if (typeof msg.error === 'string') this.pending?.finish(new Error(msg.error.slice(0, 500)));
          else this.pending?.finish(undefined, msg.result);
        } catch { socket.close(1008, 'Invalid bridge message'); }
      });
    });
  }
  get port(): number { return (this.server.address() as { port: number }).port; }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error('Request cancelled'));
    const peer = this.peer;
    if (!peer || peer.readyState !== WebSocket.OPEN) return Promise.reject(new Error(
      'Figma browser extension is not connected. Open the file in Chrome, click Figma Kilo Browser Bridge and pair it using the local secret.'));
    if (this.pending) return Promise.reject(new Error('Figma is busy. Wait for the current request.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cancel = () => {
        // Native Figma copy cannot be interrupted. Disconnect so repeated cancellations cannot queue work.
        peer.terminate();
        finish(new Error(signal?.aborted ? 'Request cancelled; reconnect browser extension.' : 'Figma request timed out; reconnect browser extension.'));
      };
      const timer = setTimeout(cancel, this.timeout);
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (this.pending?.id === id) this.pending = undefined;
        if (error) reject(error); else resolve(value);
      };
      this.pending = { id, finish };
      signal?.addEventListener('abort', cancel, { once: true });
      peer.send(JSON.stringify({ type: 'request', id, method, params }), error => {
        if (error) finish(new Error('Could not send request to Figma'));
      });
    });
  }
  async close(): Promise<void> {
    this.pending?.finish(new Error('Server is shutting down'));
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
