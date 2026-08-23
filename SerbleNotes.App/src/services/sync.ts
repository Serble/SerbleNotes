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

  /**
   * `onReopen` fires every time the connection is established after having been lost - not on the
   * first connect, which the caller has just asked for and is already handling.
   *
   * A device that was offline missed every event sent while it was gone: this socket carries
   * notifications, not a replayable log, and nothing on the server remembers what a client has been
   * told. So a reconnection is not "carry on where we left off", it is "find out what happened",
   * and something has to go and ask. Without this a device came back from a tunnel believing its
   * own head was the vault's, and the next thing it saved forked the note.
   */
  constructor(
    private readonly onEvent: (event: SyncEvent) => void,
    private readonly onReopen?: () => void,
  ) {}

  /** True once a connection has been lost, so the next open is a reconnection rather than the first. */
  private reopening = false;

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
      if (this.reopening) {
        this.reopening = false;
        this.onReopen?.();
      }
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
      this.reopening = true;
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
