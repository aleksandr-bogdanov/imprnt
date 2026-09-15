/**
 * What a chat platform is, to the door. Types only: no platform code lives
 * here, and a door that needed to know which one it was talking to would be a
 * door with a branch in it.
 */
export interface PlatformMessage {
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
  post(options: { chat: string; text: string }): Promise<void>;
  typing?(options: { chat: string }): Promise<void>;
}
