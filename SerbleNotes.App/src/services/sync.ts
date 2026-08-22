import type { SyncEvent } from '../types';
import { deviceId, getToken } from './api';
import { socketUrl } from './platform';

/**
 * The sync socket. It carries notifications only - "vault X is at cursor N" - and the store pulls
 * the actual (encrypted) versions over HTTP. Nothing readable ever crosses this connection.
 */
export class SyncSocket {
  private socket: WebSocket | null = null;
  private reconnectDelay = 1000;
  private closed = false;

  constructor(private readonly onEvent: (event: SyncEvent) => void) {}

  connect(): void {
    const token = getToken();
    if (!token || this.closed) {
      return;
    }

    // A browser can't put an Authorization header on a WebSocket handshake, so the token goes in the
    // query string; the backend accepts it there for this endpoint only.
    const socket = new WebSocket(socketUrl(`/sync?access_token=${encodeURIComponent(token)}`));
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = 1000;
    };

    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as SyncEvent;
        // Our own writes come back to us; acting on them would be a pointless round trip.
        if (event.originDeviceId === deviceId()) {
          return;
        }
        this.onEvent(event);
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.closed) {
        return;
      }
      // Back off so a backend restart doesn't get hammered by every client at once.
      window.setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }
}
