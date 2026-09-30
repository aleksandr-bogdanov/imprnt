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

/**
 * What a chat reference resolved to, and it is one of exactly four answers.
 *
 * A person types the name they gave the chat in the app, or its id. The name is
 * the platform's to resolve, because only the platform knows what its own
 * chats are called, and the id is the floor that needs no discovery at all.
 */
export type ChatResolution =
  | { kind: "chat"; chat: string; name: string }
  | { kind: "absent"; cause: string; detail?: string }
  | { kind: "ambiguous"; cause: string; detail?: string }
  | { kind: "unsupported"; cause: string; detail?: string };

/**
 * What a chat is, asked of the platform. `exists: false` with no failure is a
 * chat that is gone, which is a different thing from a call the platform
 * refused: one is an answer and the other is not knowing.
 */
export interface ChatDescription {
  exists: boolean;
  name: string | null;
  kind: string | null;
  failure?: { code: string; cause: string };
}

/**
 * The administration seam, TWO VERBS WIDE ON PURPOSE.
 *
 * What is deliberately not here: create, rename and delete. Creating a chat
 * needs Manage Channels on Discord and is impossible for a bot on Telegram,
 * renaming needs the same class of permission on both, and each of them widens
 * what a stolen bot token can do to a household's whole server. Deleting a chat
 * deletes history, and a control that deletes history must fail. A person makes
 * and renames a chat in the app, the registry holds its id, and nothing in the
 * hub has to change for a rename at all.
 */
export interface PlatformAdmin {
  resolveChat(ref: string): Promise<ChatResolution>;
  describeChat(chat: string): Promise<ChatDescription>;
}

/** A message as a read of the chat shows it. */
export interface ReadMessage {
  id: string;
  chat: string;
  author: { id: string; bot: boolean };
  content: string;
  /** The platform says somebody, the author included, changed it after it was posted. */
  edited: boolean;
  /** What the platform reports back of the nonce a post carried, and it may report none. */
  nonce: string | null;
}

/**
 * What a failed call carries when the platform said more than a status. The seam
 * throws an ordinary error and these are properties on it, so a caller that knows
 * nothing of them still sees the same error it always saw.
 */
export interface PlatformRefusalDetail {
  status?: number;
  /** The platform's own numeric error code, from the body of the refusal. */
  discordCode?: number;
  /**
   * A rate limit, and how long the platform said to wait, in milliseconds: the body's
   * `retry_after` (seconds, a float) or else the `Retry-After` header.
   */
  retryAfterMs?: number;
  /** The account-wide limit (the body's `global`, the `X-RateLimit-Global` header or the scope `global`). */
  rateLimitGlobal?: boolean;
  /** `X-RateLimit-Scope`: `user`, `global` or `shared`. */
  rateLimitScope?: string;
  /** The request was sent and the answer was lost, so the outcome is not known. */
  sent?: boolean;
  /**
   * The seam did not send this request at all, because a rate limit it already knew of
   * still holds. `status` is 429 and `retryAfterMs` is what is left of the wait. It is
   * a definite refusal: nothing happened on the platform.
   */
  blocked?: boolean;
}

/**
 * The kinds of request a platform's rate limits are kept per, so a caller can ask when
 * one may next be sent without sending it. A route is a verb on one chat, and the
 * account-wide limit holds every verb.
 */
export type PlatformVerb = "post" | "edit" | "get" | "list" | "reactors";

/**
 * Reading a chat back, which the effect ledger and the confirmation poll need and
 * which no other part of the door does. OPTIONAL, the way `admin` is: Telegram and
 * every fake that says nothing about it stay valid, and a door that is handed a
 * platform without it can send an effect but can never reconcile an uncertain one,
 * so it says unknown rather than sending again.
 *
 * Every verb throws for a refusal or a failure it cannot read past, and answers
 * only what the platform actually said. `exists: false` is an ANSWER: the platform
 * named the message or the channel as gone. A 403, a 5xx, a rate limit or a body it
 * cannot read is never that.
 */
export interface PlatformReadback {
  /** The account this door posts as, which is who "our" message was authored by. */
  self(): Promise<{ id: string }>;
  getMessage(options: { chat: string; id: string }): Promise<
    { exists: true; message: ReadMessage } | { exists: false; cause: "message" | "channel" }
  >;
  /**
   * ONE page of a chat's messages made after a message id, or after a moment in
   * epoch milliseconds when there is no id yet, oldest first. A page shorter than
   * `limit` is the end; a full one may not be, and the caller asks again from the
   * newest id it has seen.
   */
  listMessages(options: { chat: string; after?: string; since?: number; limit?: number }): Promise<ReadMessage[]>;
  /**
   * ONE page of the users who reacted with `emoji`, after a user id. A full page may
   * not be the end. The order the platform returns them in is not promised, so a
   * caller continues from the greatest id it has seen.
   */
  reactors(options: { chat: string; id: string; emoji: string; after?: string; limit?: number }): Promise<
    { id: string; bot: boolean }[]
  >;
}

export interface Platform {
  readonly name: string;
  /**
   * Present on a platform that can answer about its own chats, absent on one
   * that cannot, which is what the `unsupported` answer is about.
   */
  admin?: PlatformAdmin;
  /** Present on a platform whose chat can be read back. See `PlatformReadback`. */
  readback?: PlatformReadback;
  /**
   * When a request of this verb to this chat may next be sent, as the platform's own
   * rate-limit answers have made known to THIS platform object: an epoch in
   * milliseconds, or null when nothing known holds it. It is the shared boundary every
   * request of the platform goes through, so a limit learned by the outbox, the pull or
   * the progress line holds the effect task too, and the other way about. A request
   * already under way is not stopped by it. OPTIONAL: a platform without it has no
   * such memory, and its callers keep their own.
   */
  blockedUntil?(verb: PlatformVerb, chat: string): number | null;
  fetchMedia?(media: MediaRef): Promise<Response>;
  /**
   * How long ONE typing call shows for, from the platform's own
   * documentation: Telegram's `sendChatAction` sets the status "for 5 seconds
   * or less" and Discord's typing indicator "expires after 10 seconds". The
   * door refreshes inside whichever it is, so the status never lapses, and a
   * door that read a number of its own would show a person a dead chat on
   * whichever platform it guessed wrong about.
   */
  readonly typingSeconds: number;
  /**
   * Present and true only on a platform that renders `||text||` as a spoiler
   * (Discord). The door puts a card's technical detail inside one there and
   * nowhere else: a platform that does not say so is sent plain text, so a
   * person on it never reads raw markup.
   */
  readonly spoilers?: boolean;
  /**
   * A long wait: it returns when a message arrives or when `timeoutMs` passes.
   * That is what Telegram's own long poll does, and it is what keeps the door
   * waiting rather than ticking.
   */
  pull(options: {
    chat: string;
    cursor: string | null;
    timeoutMs: number;
    /**
     * Whether a sender is one this chat's person allows, for a platform that
     * learns something from messages it does not serve. Telegram remembers the
     * names of the groups its bot-wide poll sees, and a group a stranger wrote
     * in must not become the chat a name a person types resolves to.
     */
    allowed?(sender: string): boolean;
  }): Promise<PlatformPull>;
  /**
   * Where `chat` stands NOW, as a cursor: a pull from it
   * returns only what arrives after this call. Null means nothing is there to
   * skip, so a pull from no cursor already reads only new messages.
   *
   * The door asks it once, when an agent is remapped to a chat it has never
   * read, and treats everything before the answer as history. It is the
   * platform's own answer because only the platform knows what its cursor
   * spans: Discord's is one channel, Telegram's is the whole bot.
   */
  highWater(options: { chat: string }): Promise<string | null>;
  /**
   * The id is the platform's own, and it is what an edit needs. `nonce` is for a
   * post whose answer may be lost: a platform that can use it to find or refuse a
   * duplicate does, and one that cannot ignores it. It is never a guarantee, and no
   * caller treats a repeat under one as safe beyond what the platform says.
   *
   * `suppressMentions` asks the platform to notify nobody the text names (Discord's
   * `allowed_mentions` with an empty `parse`). It is for the shared effect and preview
   * messages, which may echo text an owner or a model wrote; the ordinary reply path
   * does not set it and is unchanged. A platform with no such notion ignores it.
   */
  post(options: { chat: string; text: string; nonce?: string; suppressMentions?: boolean }): Promise<{ id: string | null }>;
  /** The progress line is ONE message the door overwrites as the work goes. */
  edit(options: { chat: string; id: string; text: string; suppressMentions?: boolean }): Promise<void>;
  /**
   * REQUIRED. "A turn open with no typing shown" is forbidden (SPEC §2), and a
   * platform that cannot show it is refused by `runDoor` at start rather than
   * silently serving a person who sees nothing.
   */
  typing(options: { chat: string }): Promise<void>;
}
