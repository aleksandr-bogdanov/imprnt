-- Platform message effects and frozen-preview confirmations.
--
-- TWO RECORDS, ONE MECHANISM. `platform_effect` is one row per chat message the
-- hub creates and then keeps editing: it is written BEFORE anything is sent, so a
-- door killed between the platform accepting a post and the id being saved leaves
-- a row that says what was sent, under which nonce and marker, and that is what a
-- restarted door needs to look for the original instead of making a second.
-- `confirmation` is one frozen preview and the one approval it can earn.
--
-- Additive only: nothing here changes an existing object. Ordinary replies and the
-- progress line still go through `outbox` and `door_progress`; a consumer of this
-- step has to ask for a row here, and nothing yet does on its own.
--
-- No role but the two definer functions below inserts into either table. They are
-- owned by whoever applies this file, as the tables are, so no role holds an insert
-- it does not need. The door alone updates them, and only the columns it owns.

-- ONE ROW PER MESSAGE.
--
--   not_sent    nothing has left the door, or the platform said no without handling
--               the request (a rate limit). Sent once `retry_at` has passed.
--   in_flight   committed BEFORE the request. A crash here is uncertain, and so is a
--               transport failure or a 5xx. The door reads the chat back for
--               positive evidence, and `retry_at` is when it next does.
--   confirmed   the platform answered with the id, or the door found the message it
--               made and checked it. `platform_id` is saved and never changes.
--   unknown     no positive evidence was found. Nothing in the hub sends this
--               message again: the request may have landed, been deleted or still be
--               in flight, and an empty read proves none of them. Only positive
--               evidence found by a later read moves it, to confirmed.
--   failed      the platform refused without handling the request (a 400, 401, 403,
--               404). Nothing was created.
--   missing     a message the hub made was deleted. It is not replaced by machinery:
--               a caller that wants another records a NEW effect.
--
-- `wanted_content` is the exact text of the latest revision asked for, marker
-- included; `applied_revision` is the newest revision the platform is known to show
-- (`applied_hash` is the hash of that content). The create attempt pins what it sent
-- (`attempt_revision`, `attempt_hash`) so a message found later is adopted only when
-- it is exactly that.
--
-- EDITS HAVE THEIR OWN CLAIM, because a PATCH that was sent and whose answer was lost
-- may still land after a newer one, and nothing the door can read proves it will not.
--
--   idle        no edit request is outstanding that may still land. Only here may the
--               door claim a new edit, and the claim is one compare-and-set that pins
--               the attempt (`edit_attempt_id`, `edit_revision`, `edit_hash`) and
--               commits BEFORE the request is made.
--   in_flight   an edit request was claimed and its outcome is not recorded. Nobody
--               claims another edit of this message while it is. The door that sent it
--               records the answer against the attempt; after `retry_at` any door
--               reads the message back, and content equal to the attempt's is
--               positive evidence the request landed.
--   unknown     the looks found no positive evidence. The request may still land, so no
--               NEWER edit is sent: it could be overwritten by the old one, and a clean
--               "applied the latest" would be false. The row says so (`applied_revision`
--               stays behind `wanted_revision`). A later look that finds the attempt's
--               content settles it. Nothing else does: not time, not a read that finds
--               nothing, and not a statement that the old request is dead, which the
--               hub cannot check. Matching content is evidence only against a known,
--               different `applied_hash`.
create table platform_effect (
  key              text primary key,
  door             text not null,
  chat             text not null,
  -- Messages are the only kind there is. A later kind widens this check in its own
  -- step, with its own states, rather than being reserved here by a column nobody
  -- reads.
  kind             text not null default 'message' check (kind = 'message'),
  owner_ref        text not null,
  frozen           boolean not null default false,
  marker           text not null check (marker <> ''),
  nonce            text not null check (char_length(nonce) between 1 and 25),
  state            text not null default 'not_sent'
                     check (state in ('not_sent', 'in_flight', 'confirmed', 'unknown', 'failed', 'missing')),
  platform_id      text,
  wanted_revision  integer not null default 1 check (wanted_revision >= 1),
  wanted_content   text not null check (wanted_content <> ''),
  applied_revision integer not null default 0 check (applied_revision >= 0 and applied_revision <= wanted_revision),
  applied_hash     text,
  attempt_id       text,
  attempt_revision integer,
  attempt_hash     text,
  attempts         integer not null default 0 check (attempts >= 0),
  reconcile_attempts integer not null default 0 check (reconcile_attempts >= 0),
  edit_state       text not null default 'idle' check (edit_state in ('idle', 'in_flight', 'unknown')),
  edit_attempt_id  text,
  edit_revision    integer,
  edit_hash        text,
  edit_attempts    integer not null default 0 check (edit_attempts >= 0),
  in_flight_at     timestamptz,
  retry_at         timestamptz,
  evidence         jsonb not null default '{}'::jsonb,
  failure          jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint platform_effect_content_has_marker check (position(marker in wanted_content) > 0),
  constraint platform_effect_sent_has_attempt
    check (state in ('not_sent', 'failed') or (attempt_id is not null and attempt_revision is not null and attempt_hash is not null)),
  constraint platform_effect_known_has_id check (state not in ('confirmed', 'missing') or platform_id is not null),
  constraint platform_effect_applied_needs_id check (applied_revision = 0 or platform_id is not null),
  constraint platform_effect_edit_has_attempt
    check (edit_state = 'idle'
           or (state = 'confirmed' and edit_attempt_id is not null and edit_revision is not null and edit_hash is not null))
);
create index platform_effect_live on platform_effect (door, created_at)
  where state in ('not_sent', 'in_flight', 'unknown') or edit_state <> 'idle'
     or (state = 'confirmed' and applied_revision < wanted_revision);
create index platform_effect_by_owner on platform_effect (owner_ref);

-- The hub's own rules about that row, held by the table so no writer can bend them:
-- a message id is saved once and for ever; an applied revision only moves forward;
-- a refusal and a deletion are final; and a create whose outcome is unknown is
-- never made "not sent" again, which is the only thing that could post it twice.
-- The same holds for an edit: while one is outstanding no other attempt can take its
-- place, and one whose outcome is unknown is never claimed again, only settled.
create function hub_guard_platform_effect() returns trigger
language plpgsql as $$
begin
  if old.platform_id is not null and new.platform_id is distinct from old.platform_id then
    raise exception 'effect % already has message %, and it is never replaced', old.key, old.platform_id;
  end if;
  if new.applied_revision < old.applied_revision then
    raise exception 'effect % applied revision only moves forward', old.key;
  end if;
  if old.state in ('failed', 'missing') and new.state <> old.state then
    raise exception 'effect % is % and stays so', old.key, old.state;
  end if;
  if old.state = 'confirmed' and new.state not in ('confirmed', 'missing') then
    raise exception 'effect % is confirmed', old.key;
  end if;
  if old.state = 'unknown' and new.state not in ('unknown', 'confirmed') then
    raise exception 'effect % has an unknown outcome and is never sent again by machinery', old.key;
  end if;
  if old.edit_state = 'unknown' and new.edit_state = 'in_flight' then
    raise exception 'effect % has an edit whose outcome is unknown, and no newer edit is claimed over it', old.key;
  end if;
  if old.edit_state = 'in_flight' and new.edit_state = 'in_flight'
     and new.edit_attempt_id is distinct from old.edit_attempt_id then
    raise exception 'effect % has an edit in flight, and no other attempt takes its place', old.key;
  end if;
  return new;
end $$;
create trigger platform_effect_rules
  before update on platform_effect
  for each row execute function hub_guard_platform_effect();

-- A FROZEN PREVIEW AND THE ONE APPROVAL IT CAN EARN. `payload_hash` is over the exact
-- text the owner saw and the payload the approval will act on. `effect_keys` are the
-- ordered preview parts, in `platform_effect`; the LAST is the confirmation message a
-- reaction is read from and it carries the full hash. A correction inserts revision
-- + 1 and supersedes the older pending row in the same transaction, BEFORE the new
-- message is posted, so an old green check can never approve the new text.
--
-- The approval is the update `pending -> approved`, and the guard below makes every
-- other state final, so a second door, a restart and a repeated poll all meet the
-- same row and change nothing. `observed_at` is the last time the reactions were read
-- successfully, which is what "last checked" is said from.
create table confirmation (
  id             text primary key,
  operation_id   text not null,
  operation_kind text not null,
  revision       integer not null check (revision >= 1),
  person         text not null,
  door           text not null,
  chat           text not null,
  owner_sender   text not null,
  payload        jsonb not null,
  payload_hash   text not null,
  effect_keys    text[] not null check (cardinality(effect_keys) >= 1),
  state          text not null default 'pending'
                   check (state in ('pending', 'approved', 'superseded', 'failed')),
  cause          text,
  approved_by    text,
  approved_at    timestamptz,
  evidence       jsonb not null default '{}'::jsonb,
  observed_at    timestamptz,
  -- The revision this one was asked for in place of, by an explicit replacement.
  replaces       integer,
  created_at     timestamptz not null default now(),
  unique (operation_id, revision),
  constraint confirmation_replaces_previous check (replaces is null or replaces = revision - 1),
  constraint confirmation_approved_has_reactor
    check (state <> 'approved' or (approved_by is not null and approved_at is not null and approved_by = owner_sender))
);
create unique index confirmation_one_pending on confirmation (operation_id) where state = 'pending';
create unique index confirmation_one_approved on confirmation (operation_id) where state = 'approved';
create index confirmation_pending_by_door on confirmation (door) where state = 'pending';

create function hub_guard_confirmation() returns trigger
language plpgsql as $$
begin
  if old.state <> 'pending' then
    raise exception 'confirmation % is % and stays so', old.id, old.state;
  end if;
  return new;
end $$;
create trigger confirmation_rules
  before update on confirmation
  for each row execute function hub_guard_confirmation();

-- The door hears about a new message to send, or new content for one, at the commit
-- that made it, on the channel it already listens on for rows it did not write. The
-- payload says which kind of wake it is. Its own state changes do not notify.
create function hub_notify_effect() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_project', 'effect:' || new.door);
  return null;
end $$;
create trigger platform_effect_notify_insert
  after insert on platform_effect
  for each row execute function hub_notify_effect();
create trigger platform_effect_notify_content
  after update of wanted_revision on platform_effect
  for each row execute function hub_notify_effect();
create trigger confirmation_notify
  after insert on confirmation
  for each row execute function hub_notify_effect();

-- WANT ONE MESSAGE: insert it, or move its wanted content forward. The same content
-- moves nothing, so a caller that asks twice (a model that repeats a tool call, a
-- process that restarts) makes no second revision. The same key under another door,
-- chat, owner or marker is a different message and is refused, not merged. A frozen
-- preview part cannot be changed at all. It returns the revision now wanted.
create function hub_effect_want(effect_key text, door_id text, chat_id text, owner text,
                                content text, marker_text text)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  seen public.platform_effect%rowtype;
begin
  insert into public.platform_effect (key, door, chat, owner_ref, marker, nonce, wanted_content)
  values (effect_key, door_id, chat_id, owner, marker_text,
          'h' || substr(encode(sha256(convert_to(effect_key, 'UTF8')), 'hex'), 1, 24), content)
  on conflict (key) do nothing;
  select * into seen from public.platform_effect where key = effect_key for update;
  if seen.door <> door_id or seen.chat <> chat_id or seen.owner_ref <> owner or seen.marker <> marker_text then
    raise exception 'effect-identity-conflict: % is another message', effect_key;
  end if;
  if seen.wanted_content = content then
    return seen.wanted_revision;
  end if;
  if seen.frozen then
    raise exception 'effect-frozen: % is a frozen preview part', effect_key;
  end if;
  update public.platform_effect
     set wanted_content = content, wanted_revision = wanted_revision + 1,
         failure = case when state = 'confirmed' then null else failure end,
         updated_at = now()
   where key = effect_key;
  return seen.wanted_revision + 1;
end $$;
revoke all on function hub_effect_want(text, text, text, text, text, text) from public;
grant execute on function hub_effect_want(text, text, text, text, text, text)
  to hub_door, hub_runner, hub_hub;

-- FREEZE A PREVIEW. One transaction supersedes the operation's pending revision,
-- inserts the next one and wants its ordered parts (each a frozen effect), so the
-- new messages exist only after the old preview can no longer be approved.
-- `preview` is an object whose `parts` is an array of {key, content, marker}, the last
-- being the confirmation message. It returns the id of the confirmation that stands.
--
-- WHAT A REPEATED CALL MAY DO. The same complete binding (kind, owner, person, door,
-- chat, payload and the hash of payload, preview and request line) returns the
-- standing revision in whatever state it is, a failure included: asking again never
-- makes a message. An approved operation returns its approval only for that same
-- binding and refuses any other. A pending preview asked for again with a CHANGED
-- binding is a correction and supersedes it, as always. A failed preview asked for
-- with a changed binding is refused: it is not resurrected by wording.
--
-- ANOTHER PREVIEW is only ever an explicit request: `replace_revision` names the
-- revision the caller saw standing. It is honoured for a failed one, or a pending one
-- with a part that is unknown, failed or missing, and it makes ONE replacement:
-- the same request repeated returns the revision it made. The old row stays as
-- history, the new preview has its own messages and needs its own reaction.
create function hub_confirmation_freeze(confirmation_id text, op_id text, op_kind text, person_id text,
                                        door_id text, chat_id text, owner_id text, body jsonb,
                                        body_hash text, preview jsonb, replace_revision integer)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  latest public.confirmation%rowtype;
  made public.confirmation%rowtype;
  part jsonb;
  keys text[] := '{}';
  next_revision integer;
  same boolean;
begin
  if jsonb_typeof(preview -> 'parts') is distinct from 'array' or jsonb_array_length(preview -> 'parts') < 1 then
    raise exception 'a preview needs at least its confirmation message';
  end if;
  perform pg_advisory_xact_lock(682105, hashtext(op_id));
  select * into latest from public.confirmation where operation_id = op_id order by revision desc limit 1;
  if found then
    same := latest.operation_kind = op_kind and latest.person = person_id and latest.door = door_id
            and latest.chat = chat_id and latest.owner_sender = owner_id
            and latest.payload_hash = body_hash and latest.payload = body;
    if latest.state = 'approved' then
      if same then
        return latest.id;
      end if;
      raise exception 'confirmation-conflict: % is approved for other content, owner, person, door, chat or kind', op_id;
    end if;
    if replace_revision is null then
      if same then
        return latest.id;
      end if;
      if latest.state <> 'pending' then
        raise exception 'confirmation-replace-required: revision % of % is %, and only an explicit replacement makes another preview',
          latest.revision, op_id, latest.state;
      end if;
    else
      select * into made from public.confirmation where operation_id = op_id and revision = replace_revision + 1;
      if found then
        if made.operation_kind = op_kind and made.person = person_id and made.door = door_id
           and made.chat = chat_id and made.owner_sender = owner_id
           and made.payload_hash = body_hash and made.payload = body then
          return made.id;
        end if;
        raise exception 'confirmation-stale-replacement: revision % of % was already replaced by another request', replace_revision, op_id;
      end if;
      if latest.revision <> replace_revision then
        raise exception 'confirmation-stale-replacement: revision % of % is not the standing one (%)', replace_revision, op_id, latest.revision;
      end if;
      if latest.state = 'pending' and same
         and not exists (select 1 from public.platform_effect e
                          where e.key = any(latest.effect_keys) and e.state in ('unknown', 'failed', 'missing')) then
        return latest.id;
      end if;
    end if;
    if latest.state = 'pending' then
      update public.confirmation
         set state = 'superseded', cause = case when replace_revision is null then 'superseded' else 'replaced' end
       where id = latest.id;
    end if;
  elsif replace_revision is not null then
    raise exception 'confirmation-replace-unexpected: % has no preview to replace', op_id;
  end if;
  next_revision := coalesce(latest.revision, 0) + 1;
  for part in select * from jsonb_array_elements(preview -> 'parts') loop
    perform public.hub_effect_want(part ->> 'key', door_id, chat_id, 'confirmation:' || confirmation_id,
                                   part ->> 'content', part ->> 'marker');
    update public.platform_effect set frozen = true where key = part ->> 'key';
    keys := keys || (part ->> 'key');
  end loop;
  insert into public.confirmation (id, operation_id, operation_kind, revision, person, door, chat,
                                   owner_sender, payload, payload_hash, effect_keys, replaces)
  values (confirmation_id, op_id, op_kind, next_revision, person_id, door_id, chat_id,
          owner_id, body, body_hash, keys, replace_revision);
  return confirmation_id;
end $$;
revoke all on function hub_confirmation_freeze(text, text, text, text, text, text, text, jsonb, text, jsonb, integer) from public;
grant execute on function hub_confirmation_freeze(text, text, text, text, text, text, text, jsonb, text, jsonb, integer)
  to hub_door, hub_runner, hub_hub;

-- Everyone who works with these reads them. Only the door writes them, and only the
-- columns that are its own: what it has sent, saw and decided, never what was asked
-- for or what the owner was shown.
grant select on platform_effect, confirmation to hub_door, hub_runner, hub_hub;
grant update (state, platform_id, applied_revision, applied_hash, attempt_id, attempt_revision, attempt_hash, attempts,
              reconcile_attempts, edit_state, edit_attempt_id, edit_revision, edit_hash, edit_attempts,
              in_flight_at, retry_at, evidence, failure, updated_at)
  on platform_effect to hub_door;
grant update (state, cause, approved_by, approved_at, evidence, observed_at) on confirmation to hub_door;
