import type { ChannelInfo, ChannelOverwrite, PlatformAdmin, PlatformRefusalDetail } from "../platform.ts";

/**
 * The four administration verbs a topic chat's lifecycle needs from Discord, kept in a file of
 * their own so `discord.ts` gains one line for them and a change to either does not touch the
 * other. They are given the seam's own request boundary and refusal reader, so every request
 * here is held by a rate limit any other request learned, and none of them has a second copy
 * of a header, a timeout or a 429.
 *
 * WHAT THEY WILL NOT DO. Delete a channel. Retry anything: a transport failure on the create
 * carries `sent`, and the caller decides what a request that may have landed means. Guess
 * what "gone" is: only the platform's own answer for an unknown channel is that, and a 403, a
 * 5xx, a rate limit and a body that cannot be read are thrown as what they are.
 */

/** Discord's error code for a channel that does not exist, the one thing a 404 has to say to mean "gone". */
const UNKNOWN_CHANNEL = 10003;

/** Discord's channel types, in the seam's own words. Anything else is a channel and says so. */
const KINDS: Record<number, string> = { 0: "text", 2: "voice", 4: "category", 5: "announcement", 11: "thread", 12: "thread", 15: "forum" };

/** A guild text channel, which is the one type the hub makes. */
const TEXT_CHANNEL = 0;

export interface ChannelSeam {
  api: string;
  /** The server the door's channels live in. Without one the two verbs that address the server are absent. */
  guild?: string;
  headers: Record<string, string>;
  /** The seam's one request boundary. `sent` marks a transport error as one the request may have left before. */
  request(route: string, input: string | URL, init: RequestInit, sent?: boolean): Promise<Response>;
  refusal(what: string, answer: Response): Promise<Error & PlatformRefusalDetail>;
  /** How long one call may take, from the seam. */
  timeoutMs: number;
}

/** A channel object off the wire in the seam's own shape, or null when it is not one. */
export function readChannelInfo(raw: unknown): ChannelInfo | null {
  const one = raw as { id?: unknown; name?: unknown; type?: unknown; topic?: unknown; parent_id?: unknown; permission_overwrites?: unknown } | null;
  if (!one || typeof one.id !== "string" || typeof one.name !== "string") return null;
  const overwrites: ChannelOverwrite[] = [];
  if (Array.isArray(one.permission_overwrites)) {
    for (const entry of one.permission_overwrites) {
      const each = entry as { id?: unknown; type?: unknown; allow?: unknown; deny?: unknown } | null;
      if (!each || typeof each.id !== "string") return null;
      overwrites.push({
        id: each.id,
        type: Number(each.type) === 1 ? 1 : 0,
        allow: each.allow === undefined || each.allow === null ? "0" : String(each.allow),
        deny: each.deny === undefined || each.deny === null ? "0" : String(each.deny),
      });
    }
  }
  return {
    id: one.id,
    name: one.name,
    kind: KINDS[Number(one.type)] ?? "channel",
    topic: typeof one.topic === "string" ? one.topic : null,
    parent_id: typeof one.parent_id === "string" ? one.parent_id : null,
    permission_overwrites: overwrites,
  };
}

export function channelAdmin(seam: ChannelSeam): Pick<PlatformAdmin, "readChannel" | "editChannel" | "listChannels" | "createChannel"> {
  const { api, headers } = seam;
  const signal = (): AbortSignal => AbortSignal.timeout(seam.timeoutMs);

  const readChannel: NonNullable<PlatformAdmin["readChannel"]> = async (chat) => {
    const answer = await seam.request(`GET /channels/${chat}`, `${api}/channels/${encodeURIComponent(chat)}`, { headers, signal: signal() });
    if (!answer.ok) {
      const failed = await seam.refusal("a channel read", answer);
      if (failed.status === 404 && failed.discordCode === UNKNOWN_CHANNEL) return { exists: false };
      throw failed;
    }
    const channel = readChannelInfo(await answer.json());
    if (!channel) throw new Error("invalid channel response");
    return { exists: true, channel };
  };

  const editChannel: NonNullable<PlatformAdmin["editChannel"]> = async ({ chat, parent_id, permission_overwrites }) => {
    // Only what is asked for is sent, so an edit of the category never touches the overwrites and back.
    const body: Record<string, unknown> = {};
    if (parent_id !== undefined) body.parent_id = parent_id;
    if (permission_overwrites !== undefined) body.permission_overwrites = permission_overwrites;
    const answer = await seam.request(`PATCH /channels/${chat}`, `${api}/channels/${encodeURIComponent(chat)}`,
      { method: "PATCH", headers, body: JSON.stringify(body), signal: signal() }, true);
    if (!answer.ok) throw await seam.refusal("a channel edit", answer);
    const channel = readChannelInfo(await answer.json());
    if (!channel) throw new Error("invalid channel response");
    return channel;
  };

  const { guild } = seam;
  if (guild === undefined) return { readChannel, editChannel };

  const listChannels: NonNullable<PlatformAdmin["listChannels"]> = async () => {
    const answer = await seam.request(`GET /guilds/${guild}/channels`, `${api}/guilds/${encodeURIComponent(guild)}/channels`,
      { headers, signal: signal() });
    if (!answer.ok) throw await seam.refusal("a channel listing", answer);
    const raw = await answer.json();
    if (!Array.isArray(raw)) throw new Error("invalid channel listing");
    const channels: ChannelInfo[] = [];
    for (const one of raw) {
      const channel = readChannelInfo(one);
      // A listing with an entry that cannot be read is not a complete listing, and absence from it means nothing.
      if (!channel) throw new Error("invalid channel listing");
      channels.push(channel);
    }
    return channels;
  };

  const createChannel: NonNullable<PlatformAdmin["createChannel"]> = async ({ name, parent_id, topic }) => {
    const answer = await seam.request(`POST /guilds/${guild}/channels`, `${api}/guilds/${encodeURIComponent(guild)}/channels`, {
      method: "POST", headers, signal: signal(),
      body: JSON.stringify({ name, type: TEXT_CHANNEL, topic, ...(parent_id === undefined || parent_id === null ? {} : { parent_id }) }),
    }, true);
    if (!answer.ok) throw await seam.refusal("a channel creation", answer);
    const channel = readChannelInfo(await answer.json());
    // An answer with no usable channel may still have made one: the outcome is not known.
    if (!channel) throw Object.assign(new Error("a channel creation answered with no channel"), { sent: true });
    return channel;
  };

  return { readChannel, editChannel, listChannels, createChannel };
}
