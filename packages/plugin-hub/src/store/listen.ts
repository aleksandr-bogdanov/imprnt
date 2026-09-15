import { connect, type Socket } from "bun";

/**
 * A connection that does nothing but LISTEN.
 *
 * Bun's SQL client has no callback for an asynchronous notification, so this
 * speaks the Postgres wire protocol itself: connect, one LISTEN, then read
 * NotificationResponse messages as the server pushes them. After the LISTEN it
 * issues no statement at all, which is what makes a wake tellable apart from a
 * poll: the server's own statement log stays empty while a runner waits.
 */
export class ListenRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListenRefused";
  }
}

export interface Listener {
  close(): Promise<void>;
}

const AUTH = 0x52;
const ERROR_RESPONSE = 0x45;
const READY_FOR_QUERY = 0x5a;
const NOTIFICATION = 0x41;

const AUTH_METHODS: Record<number, string> = {
  2: "Kerberos",
  3: "a cleartext password",
  5: "an md5 password",
  7: "GSSAPI",
  10: "SASL, which is how scram-sha-256 asks",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

function cstring(bytes: Uint8Array, from: number): [string, number] {
  let end = from;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return [decoder.decode(bytes.subarray(from, end)), end + 1];
}

function startup(user: string, database: string): Uint8Array {
  const body = encoder.encode(`user\0${user}\0database\0${database}\0\0`);
  const message = new Uint8Array(8 + body.length);
  const head = new DataView(message.buffer);
  head.setInt32(0, message.length);
  head.setInt32(4, 196608);
  message.set(body, 8);
  return message;
}

function query(text: string): Uint8Array {
  const body = encoder.encode(`${text}\0`);
  const message = new Uint8Array(5 + body.length);
  message[0] = 0x51;
  new DataView(message.buffer).setInt32(1, 4 + body.length);
  message.set(body, 5);
  return message;
}

/** The message field of an ErrorResponse, which is the line a human needs. */
function errorText(body: Uint8Array): string {
  let at = 0;
  const fields: string[] = [];
  while (at < body.length && body[at] !== 0) {
    const code = body[at];
    const [value, next] = cstring(body, at + 1);
    if (code === 0x4d) return value;
    fields.push(value);
    at = next;
  }
  return fields.join(" ") || "the server refused the connection";
}

function place(url: string) {
  const parsed = new URL(url);
  return {
    hostname: parsed.hostname || "127.0.0.1",
    port: Number(parsed.port || "5432"),
    user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

export async function listenForWork(options: {
  url: string;
  channel: string;
  onNotify(payload: string): void;
  /**
   * The connection went away on its own rather than being closed by its owner.
   * Every notification after that point is gone, so a caller that holds one
   * listener across many waits has to be told, or it goes deaf in silence.
   */
  onLost?(): void;
}): Promise<Listener> {
  if (!/^[a-z_][a-z0-9_]*$/.test(options.channel)) {
    throw new ListenRefused(`${options.channel} is not a channel name`);
  }
  const where = place(options.url);

  let buffer = new Uint8Array(0);
  let step: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let closed = false;
  let ended = false;

  const settle = (error?: Error) => {
    const waiting = step;
    step = null;
    if (!waiting) return;
    if (error) waiting.reject(error);
    else waiting.resolve();
  };

  const read = (chunk: Uint8Array) => {
    buffer = concat(buffer, chunk);
    while (buffer.length >= 5) {
      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset + 1,
        4,
      ).getInt32(0);
      if (buffer.length < length + 1) break;
      const type = buffer[0];
      const body = buffer.subarray(5, length + 1);
      buffer = buffer.slice(length + 1);

      if (type === AUTH) {
        const method = new DataView(body.buffer, body.byteOffset, 4).getInt32(0);
        if (method !== 0) {
          settle(
            new ListenRefused(
              `this server asks for ${AUTH_METHODS[method] ?? `authentication method ${method}`}, ` +
                `and the notification connection only offers a trusted one`,
            ),
          );
        }
      } else if (type === ERROR_RESPONSE) {
        settle(new ListenRefused(errorText(body)));
      } else if (type === READY_FOR_QUERY) {
        settle();
      } else if (type === NOTIFICATION) {
        const [, afterChannel] = cstring(body, 4);
        const [payload] = cstring(body, afterChannel);
        options.onNotify(payload);
      }
    }
  };

  const socket: Socket = await connect({
    hostname: where.hostname,
    port: where.port,
    socket: {
      data(_socket, chunk) {
        read(chunk as unknown as Uint8Array);
      },
      close() {
        closed = true;
        settle(new ListenRefused("the server closed the notification connection"));
        if (!ended) options.onLost?.();
      },
      error(_socket, error) {
        settle(new ListenRefused(String(error)));
        if (!ended) options.onLost?.();
      },
    },
  });

  const reply = () =>
    new Promise<void>((resolve, reject) => {
      if (closed) {
        reject(new ListenRefused("the notification connection is closed"));
        return;
      }
      step = { resolve, reject };
    });

  try {
    const ready = reply();
    socket.write(startup(where.user, where.database));
    await ready;

    const listening = reply();
    socket.write(query(`listen ${options.channel}`));
    await listening;
  } catch (error) {
    socket.end();
    throw error;
  }

  return {
    async close() {
      closed = true;
      ended = true;
      step = null;
      socket.end();
    },
  };
}
