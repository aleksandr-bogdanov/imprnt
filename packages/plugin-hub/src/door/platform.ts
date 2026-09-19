/**
 * What a chat platform is, to the door. Types only: no platform code lives
 * here, and a door that needed to know which one it was talking to would be a
 * door with a branch in it.
 */
export interface MediaRef {
  kind: "voice" | "photo" | "file" | "sticker" | "video";
  remote_id: string;
  name: string;
  mime: string | null;
  bytes: number | null;
  caption: string | null;
}

export interface PlatformMessage {
  /** Missing identity is refused at acceptance, including older transports. */
  sender_id?: string;
  media?: MediaRef[];
  platform_message_id: string;
  chat: string;
  from: string;
  text: string;
  /** ISO 8601, the platform's own time for the message. */
  at: string;
}

export interface PlatformPull {
  messages: PlatformMessage[];
  cursor: string | null;
}

export interface Platform {
  readonly name: string;
  fetchMedia?(media: MediaRef): Promise<Response>;
  /**
   * D-125. How long ONE typing call shows for, from the platform's own
   * documentation: Telegram's `sendChatAction` sets the status "for 5 seconds
   * or less" and Discord's typing indicator "expires after 10 seconds". The
   * door refreshes inside whichever it is, so the status never lapses, and a
   * door that read a number of its own would show a person a dead chat on
   * whichever platform it guessed wrong about.
   */
  readonly typingSeconds: number;
  /**
   * A long wait: it returns when a message arrives or when `timeoutMs` passes.
   * That is what Telegram's own long poll does, and it is what keeps the door
   * waiting rather than ticking.
   */
  pull(options: {
    chat: string;
    cursor: string | null;
    timeoutMs: number;
  }): Promise<PlatformPull>;
  /**
   * D-178, IMP-163. Where `chat` stands NOW, as a cursor: a pull from it
   * returns only what arrives after this call. Null means nothing is there to
   * skip, so a pull from no cursor already reads only new messages.
   *
   * The door asks it once, when an agent is remapped to a chat it has never
   * read, and treats everything before the answer as history. It is the
   * platform's own answer because only the platform knows what its cursor
   * spans: Discord's is one channel, Telegram's is the whole bot.
   */
  highWater(options: { chat: string }): Promise<string | null>;
  /** The id is the platform's own, and it is what an edit needs. */
  post(options: { chat: string; text: string }): Promise<{ id: string | null }>;
  /** The progress line is ONE message the door overwrites as the work goes. */
  edit(options: { chat: string; id: string; text: string }): Promise<void>;
  /**
   * REQUIRED. "A turn open with no typing shown" is forbidden (SPEC §2), and a
   * platform that cannot show it is refused by `runDoor` at start rather than
   * silently serving a person who sees nothing.
   */
  typing(options: { chat: string }): Promise<void>;
}
