-- Confirmed topic creation, immutable topic identities and mirrored archive / reopen.
--
-- Numbered 015, after the councils step (014): `migrate` runs whatever versions are
-- missing, in order. The two steps replace no object of each other's, so a store that
-- has 014 and not yet 015 is a valid store. Nothing here reads a table that is not in
-- migrations 001..013.
--
-- FOUR RECORDS, AND NOTHING ELSE.
--   identity_reservation  an identity that must never be used again. This step writes
--                         the CHECK (allocation, the conversation and inbound fences,
--                         legacy linking) and the routine that records one. The routine
--                         that decides to record one, a confirmed deletion, is a later
--                         step's, so a store has no reservations until then.
--   topic                 one row per topic master: the identities it was given BEFORE
--                         anything outside the store happened, where it is being made or
--                         is, and its lifecycle.
--   topic_transition      one archive, one reopen or one pending deletion request, with
--                         the exact Discord change it made recorded so it can be undone.
--   topic_channel_seen    the last time the chat was observed to exist, and where.
--
-- WHO WRITES. Nobody but the definer functions below inserts into or updates a topic
-- table, as in 012 and 013: every rule is held where a second writer would meet it.
-- Every role reads them. Nothing here decides who may ask; the caller checks that where
-- it checks it (a tool call's source evidence, the door's sender list, a confirmed
-- preview) and this records what was asked and in whose name.
--
-- Additive only. The old objects touched are two BEFORE INSERT triggers, on
-- `conversation` and on `inbound`, and both do nothing for an identity that is not
-- reserved.

-- AN IDENTITY THAT IS NEVER USED AGAIN. `kind` is what the identity names: a topic, the
-- internal agent id of its master, or its master conversation. A reservation is
-- permanent: the table refuses to change or lose one.
create table identity_reservation (
  kind        text not null check (kind in ('topic', 'agent', 'conversation')),
  id          text not null check (id <> ''),
  reason      text not null check (reason <> ''),
  detail      jsonb not null default '{}'::jsonb,
  reserved_at timestamptz not null default now(),
  primary key (kind, id)
);

create function hub_guard_reservation() returns trigger
language plpgsql as $$
begin
  raise exception 'the reservation of % % is permanent', old.kind, old.id;
end $$;
create trigger identity_reservation_permanent
  before update or delete on identity_reservation
  for each row execute function hub_guard_reservation();

-- Record one. It returns whether this call made it: asking again is not an error.
create function hub_identity_reserve(kind_in text, id_in text, why text, proof jsonb)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.identity_reservation (kind, id, reason, detail)
  values (kind_in, id_in, why, coalesce(proof, '{}'::jsonb))
  on conflict (kind, id) do nothing;
  return found;
end $$;

create function hub_identity_reserved(kind_in text, id_in text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.identity_reservation r where r.kind = kind_in and r.id = id_in)
$$;

-- THE FENCES THAT DO NOT DEPEND ON WHO WROTE THE REGISTRY. A reserved agent id that got
-- into the registry by hand, an old copy or a restore cannot be given a conversation
-- and cannot be given a message: the runner's launch and the door's acceptance are
-- refused at the insert, and both say so by name. A report is not refused here: it is a
-- worker's result, and refusing it would fail the settlement of that worker. Whatever is
-- to happen to a late result is the deleting step's to say.
create function hub_guard_reserved_conversation() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from public.identity_reservation r
              where (r.kind = 'agent' and r.id = new.agent) or (r.kind = 'conversation' and r.id = new.id)) then
    raise exception 'identity-reserved: % was retired and is never used again', new.agent;
  end if;
  return new;
end $$;
create trigger conversation_refuses_reserved
  before insert on conversation
  for each row execute function hub_guard_reserved_conversation();

create function hub_guard_reserved_inbound() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if exists (select 1 from public.identity_reservation r where r.kind = 'agent' and r.id = new.agent) then
    raise exception 'identity-reserved: % was retired and is never used again', new.agent;
  end if;
  return new;
end $$;
create trigger inbound_refuses_reserved
  before insert on inbound
  for each row when (new.kind <> 'report')
  execute function hub_guard_reserved_inbound();

-- ONE TOPIC MASTER. Its identities (`id`, `agent_id`, `conversation_id`) are made before the
-- owner sees a preview and never change; `display_name` is what the chat is called and
-- may be the name of a chat that was deleted.
--
-- `create_state`, in the order things happen:
--   previewed         identities allocated, the exact preview frozen, nobody approved it
--   confirmed         the owner's approval and this row committed together. Nothing has
--                     been asked of the platform
--   create_intent     committed BEFORE the platform is asked to make the channel. A crash
--                     after this is uncertain, and nothing makes a second one
--   creation_unknown  the outcome could not be established. Nothing makes another channel;
--                     only a found channel, or an explicit decision, moves it
--   channel_known     the channel exists and the owner's request is stored as this
--                     topic's first input in the same transaction
--   bind_intent       committed BEFORE the registry is written
--   bound             the agent is in the registry, bound to that chat, on the machine
--                     the owner selected. Whether that machine is running is not stored
--                     here: it is asked
--   failed            the platform refused the create for a reason that says nothing was
--                     made. Nothing retries it but an explicit decision
--   legacy            an agent that was adopted before topics: the same row, no creation
--
-- `lifecycle`: pending (not bound yet), active, archiving, archived, reopening, and
-- channel_missing (the chat is gone from Discord and nothing has been erased).
create table topic (
  id                   text primary key,
  person               text not null,
  display_name         text not null check (display_name <> ''),
  agent_id             text not null unique,
  conversation_id      text not null unique,
  origin               text not null check (origin in ('created', 'legacy')),
  operation_id         text unique,
  door                 text not null,
  chat                 text,
  machine              text not null,
  runner               text not null,
  preset               text not null,
  setup                jsonb not null default '{}'::jsonb,
  marker               text not null check (marker <> ''),
  initial_input_id     text,
  create_state         text not null default 'previewed'
                         check (create_state in ('previewed', 'confirmed', 'create_intent', 'creation_unknown',
                                                 'channel_known', 'bind_intent', 'bound', 'failed', 'legacy')),
  create_attempt       text,
  create_attempts      integer not null default 0 check (create_attempts >= 0),
  create_intent_at     timestamptz,
  create_retry_at      timestamptz,
  reconcile_attempts   integer not null default 0 check (reconcile_attempts >= 0),
  create_evidence      jsonb not null default '{}'::jsonb,
  create_failure       jsonb,
  confirmation_id      text,
  confirmed_by         text,
  confirmed_at         timestamptz,
  lifecycle            text not null default 'pending'
                         check (lifecycle in ('pending', 'active', 'archiving', 'archived', 'reopening', 'channel_missing')),
  lifecycle_generation integer not null default 0 check (lifecycle_generation >= 0),
  -- The operation whose gates hold this master while it is archived, kept so a reopen
  -- releases exactly those and no other operation's.
  archive_operation    text,
  -- Set by a later step when a deletion the Hub itself asked for is in flight, so a
  -- channel that then disappears does not ask the same question a second time.
  delete_operation     text,
  -- The revision of the owner's latest decision about an unsettled create. A lookup the door
  -- began for one decision can only commit while that decision still stands.
  decision_seq         integer not null default 0 check (decision_seq >= 0),
  -- When the channel became known. Set once and never moved by a retry, so how long an agent
  -- has been waiting to be connected is measured from its start and not from its last attempt.
  channel_known_at     timestamptz,
  -- What the lifecycle was when the chat was found gone: whether an explicit repair may bring
  -- the topic back is decided by it, and only a chat that was active is brought back.
  missing_from         text check (missing_from in ('active', 'archiving', 'archived', 'reopening')),
  -- The disappearance that holds this topic NOW: each time the chat is found gone is its own operation, named after the
  -- lifecycle generation it began at, and its gate, its pending request and its notice all carry that name. A repaired chat
  -- that vanishes again is therefore a new disappearance with a gate of its own (a released gate is never reopened), and not
  -- a repeat of the first.
  missing_operation    text,
  -- The last number given to an attention gap (`hub_topic_attention`): the identity of one occurrence of "this could not be
  -- told", so that a later gap of the same kind is not mistaken for the one that was already caught up with.
  attention_seq        integer not null default 0 check (attention_seq >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint topic_lifecycle_follows_create
    check ((lifecycle = 'pending') = (create_state not in ('bound', 'legacy'))),
  constraint topic_created_has_operation check (origin = 'legacy' or operation_id is not null),
  constraint topic_chat_when_known
    check ((chat is null) = (create_state in ('previewed', 'confirmed', 'create_intent', 'creation_unknown', 'failed')))
);
create unique index topic_one_per_chat on topic (door, chat) where chat is not null;
create index topic_by_door on topic (door);

-- What a topic may go through, held by the table. Identity never changes, a created
-- topic's chat is set once, the creation moves only along the legal edges, and the
-- lifecycle moves only along its own. A `confirmed` row that was `create_intent` is the
-- one edge that lets a create be asked again, and only the definer functions below
-- (which are told the platform did not handle it, or an explicit choice) take it.
--
-- The one identity that is not for good is an ADOPTED master's door: a registry edit that puts the agent behind another door
-- is followed by its topic (`hub_topic_rebind`, which checks everything else), and nothing else may move a door. A topic the
-- Hub made keeps the door it was made through.
create function hub_guard_topic() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.person is distinct from old.person
     or new.agent_id is distinct from old.agent_id or new.conversation_id is distinct from old.conversation_id
     or new.origin is distinct from old.origin or (new.door is distinct from old.door and old.origin = 'created')
     or new.marker is distinct from old.marker or new.operation_id is distinct from old.operation_id then
    raise exception 'topic % keeps its identity for good', old.id;
  end if;
  if old.chat is not null and new.chat is distinct from old.chat and old.origin = 'created' then
    raise exception 'the chat of topic % is set once', old.id;
  end if;
  if new.create_state is distinct from old.create_state
     and not ((old.create_state = 'previewed' and new.create_state = 'confirmed')
           or (old.create_state = 'confirmed' and new.create_state = 'create_intent')
           or (old.create_state = 'create_intent' and new.create_state in ('confirmed', 'channel_known', 'creation_unknown', 'failed'))
           or (old.create_state = 'creation_unknown' and new.create_state in ('confirmed', 'channel_known'))
           or (old.create_state = 'failed' and new.create_state = 'confirmed')
           or (old.create_state = 'failed' and new.create_state = 'channel_known'
               and coalesce(new.create_evidence -> 'decision' ->> 'choice' = 'adopt', false)
               and coalesce(new.create_evidence -> 'decision' ->> 'chat' = new.chat, false))
           or (old.create_state = 'channel_known' and new.create_state = 'bind_intent')
           or (old.create_state = 'bind_intent' and new.create_state in ('channel_known', 'bound'))) then
    raise exception 'topic % cannot be made to go from % to %', old.id, old.create_state, new.create_state;
  end if;
  if new.lifecycle is distinct from old.lifecycle
     and not ((old.lifecycle = 'pending' and new.lifecycle = 'active')
           or (old.lifecycle = 'active' and new.lifecycle in ('archiving', 'channel_missing'))
           or (old.lifecycle = 'archiving' and new.lifecycle in ('archived', 'channel_missing'))
           or (old.lifecycle = 'archived' and new.lifecycle in ('reopening', 'channel_missing'))
           or (old.lifecycle = 'reopening' and new.lifecycle in ('active', 'channel_missing'))
           -- The one way back: an adopted master whose chat vanished while it was ACTIVE and that the owner repaired
           -- onto a chat (`hub_topic_rebind`). A chat that vanished mid-archive keeps its archive and its gates.
           or (old.lifecycle = 'channel_missing' and new.lifecycle = 'active'
               and old.origin = 'legacy' and coalesce(old.missing_from = 'active', false))) then
    raise exception 'topic % cannot go from % to %', old.id, old.lifecycle, new.lifecycle;
  end if;
  return new;
end $$;
create trigger topic_rules
  before update on topic
  for each row execute function hub_guard_topic();

-- ONE ARCHIVE, ONE REOPEN, OR ONE PENDING DELETION REQUEST OF ONE TOPIC. `id` is the
-- operation's own: a tool call's (`operationFor`), or an observed change's, derived from
-- the topic and its generation so seeing the same change twice is one operation.
--
-- `channel_state` is what is known of the Discord half:
--   none      nothing has been asked of the platform
--   intent    the change (`channel_plan`) is committed and may or may not have landed. A
--             repeat is a request for the same values, so it is safe to make again
--   applied   the channel was read back and shows the change
--   conflict  somebody else changed what this operation would have changed: it did not
--             overwrite them, and `channel_result` says what it found
--   failed    the platform refused
--   unknown   the platform could not be read
--
-- `channel_plan` holds the exact prior parent and the exact overwrite entries the Hub
-- changed, which is what a reopen restores, and only what the Hub changed.
create table topic_transition (
  id             text primary key,
  topic_id       text not null references topic (id),
  kind           text not null check (kind in ('archive', 'reopen', 'deletion_request')),
  seq            integer not null check (seq >= 1),
  source         text not null check (source in ('tool', 'discord', 'door')),
  requested_by   text not null check (requested_by <> ''),
  route          jsonb,
  evidence       jsonb not null default '{}'::jsonb,
  state          text not null default 'open' check (state in ('open', 'complete', 'failed')),
  stage          text not null default 'requested',
  channel_state  text not null default 'none'
                   check (channel_state in ('none', 'intent', 'applied', 'conflict', 'failed', 'unknown')),
  channel_plan   jsonb,
  channel_result jsonb,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (topic_id, seq),
  constraint topic_transition_done_has_time check ((state = 'open') = (completed_at is null)),
  constraint topic_transition_plan_when_asked
    check (channel_state in ('none', 'failed', 'unknown') or channel_plan is not null)
);
create unique index topic_transition_one_open on topic_transition (topic_id)
  where state = 'open' and kind in ('archive', 'reopen');
create unique index topic_transition_one_deletion_request on topic_transition (topic_id)
  where state = 'open' and kind = 'deletion_request';
create index topic_transition_open on topic_transition (topic_id) where state = 'open';

create function hub_guard_topic_transition() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.topic_id is distinct from old.topic_id or new.kind is distinct from old.kind
     or new.seq is distinct from old.seq or new.source is distinct from old.source
     or new.requested_by is distinct from old.requested_by then
    raise exception 'transition % is identified by what asked for it, and none of it changes', old.id;
  end if;
  if old.state <> 'open' and new.state is distinct from old.state then
    raise exception 'transition % is % and stays so', old.id, old.state;
  end if;
  if old.channel_state = 'conflict' and new.channel_state is distinct from old.channel_state then
    raise exception 'transition % found a conflicting change and does not overwrite it', old.id;
  end if;
  return new;
end $$;
create trigger topic_transition_rules
  before update on topic_transition
  for each row execute function hub_guard_topic_transition();

-- WHAT THE PLATFORM LAST SHOWED OF A CHAT. Only a successful, complete observation moves
-- `seen_at`, `parent_id` and `present`; a refused, failed or partial read moves
-- `checked_at` and says why in `last_error` and changes nothing about the chat. It is what
-- lets a category change be told from no change after a restart, and lets an unreadable
-- chat be told from a deleted one.
create table topic_channel_seen (
  topic_id   text primary key references topic (id),
  present    boolean,
  parent_id  text,
  name       text,
  seen_at    timestamptz,
  checked_at timestamptz,
  last_error jsonb
);

-- The door hears about a topic that has something for it to do at the commit, on the
-- channel it already listens on for rows it did not write, and the hub of the door's
-- machine on a channel of its own (the payload is the door). Neither notifies for the
-- door's own state changes. An owner's decision about an unsettled create is one of the
-- changes it hears (`decision_seq`), because it is work the door owes and nothing else wakes it. So is a change of where
-- an adopted master is watched (`door`, `chat`): the door it left hears it too, so neither goes on watching what it was.
create function hub_notify_topic() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_project', 'topic:' || new.door);
  perform pg_notify('hub_topic', new.door);
  if tg_op = 'UPDATE' and old.door is distinct from new.door then
    perform pg_notify('hub_project', 'topic:' || old.door);
    perform pg_notify('hub_topic', old.door);
  end if;
  return null;
end $$;
create trigger topic_notify
  after insert or update of create_state, lifecycle, decision_seq, door, chat on topic
  for each row execute function hub_notify_topic();

create function hub_notify_topic_transition() returns trigger
language plpgsql as $$
declare
  where_door text;
begin
  select t.door into where_door from public.topic t where t.id = new.topic_id;
  if where_door is not null then
    perform pg_notify('hub_project', 'topic:' || where_door);
  end if;
  return null;
end $$;
create trigger topic_transition_notify
  after insert on topic_transition
  for each row execute function hub_notify_topic_transition();

-- ALLOCATE THE IDENTITIES OF A NEW TOPIC, ONCE PER OPERATION. Called in the same
-- transaction as the first preview is frozen, so nothing outside the store has happened
-- and nothing is left behind if the preview is refused. Reserved identities are refused
-- BEFORE anything is written. The master conversation is made now, under its own id, so
-- the id the owner's first input will be held in is this one and not another the runner
-- mints later. The same operation asked again returns the topic it made.
create function hub_topic_allocate(topic_in text, person_in text, display text, agent_in text, conversation_in text,
                                   op_id text, door_in text, machine_in text, runner_in text, preset_in text,
                                   adapter_in text, session_in text, marker_in text, body jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  standing public.topic%rowtype;
begin
  perform pg_advisory_xact_lock(682150, hashtext(op_id));
  select * into standing from public.topic where operation_id = op_id;
  if found then
    return standing.id;
  end if;
  if exists (select 1 from public.identity_reservation where kind = 'topic' and id = topic_in) then
    raise exception 'identity-reserved: topic %', topic_in;
  end if;
  if exists (select 1 from public.identity_reservation where kind = 'agent' and id = agent_in) then
    raise exception 'identity-reserved: agent %', agent_in;
  end if;
  if exists (select 1 from public.identity_reservation where kind = 'conversation' and id = conversation_in) then
    raise exception 'identity-reserved: conversation %', conversation_in;
  end if;
  insert into public.conversation (id, person, agent, kind, adapter, machine, native_session)
  values (conversation_in, person_in, agent_in, 'master', adapter_in, machine_in, session_in);
  insert into public.topic (id, person, display_name, agent_id, conversation_id, origin, operation_id, door,
                            machine, runner, preset, setup, marker)
  values (topic_in, person_in, display, agent_in, conversation_in, 'created', op_id, door_in,
          machine_in, runner_in, preset_in, body, marker_in);
  return topic_in;
end $$;

-- A CORRECTED PREVIEW changes what is chosen, never who the topic is. Only while nobody
-- has approved it. The conversation follows the preset's engine and the machine until it
-- has been launched, which it cannot have been.
create function hub_topic_revise(op_id text, display text, machine_in text, runner_in text, preset_in text,
                                 adapter_in text, body jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  perform pg_advisory_xact_lock(682150, hashtext(op_id));
  select * into t from public.topic where operation_id = op_id for update;
  if not found then
    raise exception 'topic-unknown: no topic was made for %', op_id;
  end if;
  if t.create_state <> 'previewed' then
    raise exception 'topic-closed: topic % is % and can no longer be corrected', t.id, t.create_state;
  end if;
  update public.topic
     set display_name = display, machine = machine_in, runner = runner_in, preset = preset_in,
         setup = body, updated_at = now()
   where id = t.id;
  update public.conversation set adapter = adapter_in, machine = machine_in
   where id = t.conversation_id and native_state = 'new';
  return t.id;
end $$;

-- THE APPROVAL, AS THIS TOPIC'S OWN: called from the approval hook in the approval's
-- transaction, so the two commit or neither does. It refuses anything but the approved
-- preview of a topic that is still waiting for it, and what was approved has to be
-- exactly what the topic holds. It never returns success for something else.
create function hub_topic_confirm(confirmation_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  c public.confirmation%rowtype;
  t public.topic%rowtype;
begin
  select * into c from public.confirmation where id = confirmation_in;
  if not found then
    raise exception 'topic-approval-unknown: there is no confirmation %', confirmation_in;
  end if;
  if c.operation_kind <> 'topic.create' or c.state <> 'approved' then
    raise exception 'topic-approval-invalid: % is not an approved topic setup', confirmation_in;
  end if;
  perform pg_advisory_xact_lock(682150, hashtext(c.operation_id));
  select * into t from public.topic where operation_id = c.operation_id for update;
  if not found then
    raise exception 'topic-unknown: no topic was made for %', c.operation_id;
  end if;
  if t.confirmation_id = c.id then
    return 'replay';
  end if;
  if t.create_state <> 'previewed' then
    raise exception 'topic-closed: topic % is % and cannot be approved again', t.id, t.create_state;
  end if;
  if t.setup is distinct from c.payload then
    raise exception 'topic-changed: the approved preview is not what topic % holds', t.id;
  end if;
  update public.topic
     set create_state = 'confirmed', confirmation_id = c.id, confirmed_by = c.approved_by,
         confirmed_at = now(), updated_at = now()
   where id = t.id;
  return 'confirmed';
end $$;

-- ASK TO MAKE THE CHANNEL: the intent, committed BEFORE the platform is asked. Only the
-- call that moves `confirmed` to `create_intent` gets `intent`, and it owns the attempt;
-- every other answer is the state the topic is in, and means somebody else did.
create function hub_topic_create_intent(topic_in text, attempt_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state = 'confirmed' then
    update public.topic
       set create_state = 'create_intent', create_attempt = attempt_in, create_attempts = create_attempts + 1,
           create_intent_at = now(), create_retry_at = null, reconcile_attempts = 0, create_failure = null,
           updated_at = now()
     where id = topic_in;
    return 'intent';
  end if;
  return t.create_state;
end $$;

-- THE PLATFORM DID NOT HANDLE THE REQUEST (a rate limit, or the door's own hold on one),
-- so the create is asked for again after `retry`. Only for the attempt that was made.
create function hub_topic_create_unsent(topic_in text, attempt_in text, retry timestamptz, proof jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state <> 'create_intent' or t.create_attempt is distinct from attempt_in then
    return t.create_state;
  end if;
  update public.topic
     set create_state = 'confirmed', create_retry_at = retry,
         create_evidence = create_evidence || coalesce(proof, '{}'::jsonb), updated_at = now()
   where id = topic_in;
  return 'confirmed';
end $$;

-- A LOOK FOR A CHANNEL THAT MAY HAVE BEEN MADE. It records what was seen and when the
-- next look is due, and, when the looks have run out or cannot be made, moves the topic
-- to `creation_unknown`. An empty look is never proof that nothing was made.
create function hub_topic_create_look(topic_in text, attempt_in text, proof jsonb, retry timestamptz, unknown_in boolean)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state <> 'create_intent' or t.create_attempt is distinct from attempt_in then
    return t.create_state;
  end if;
  update public.topic
     set reconcile_attempts = reconcile_attempts + 1, create_retry_at = retry,
         create_evidence = create_evidence || coalesce(proof, '{}'::jsonb),
         create_state = case when unknown_in then 'creation_unknown' else create_state end,
         updated_at = now()
   where id = topic_in;
  return case when unknown_in then 'creation_unknown' else 'create_intent' end;
end $$;

-- THE PLATFORM REFUSED THE CREATE without handling it (a 400, 403). Nothing was made.
create function hub_topic_create_failed(topic_in text, attempt_in text, proof jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state <> 'create_intent' or t.create_attempt is distinct from attempt_in then
    return t.create_state;
  end if;
  update public.topic set create_state = 'failed', create_failure = coalesce(proof, '{}'::jsonb),
         create_retry_at = null, updated_at = now()
   where id = topic_in;
  return 'failed';
end $$;

-- THE CHANNEL IS KNOWN. The door calls this in ONE transaction with the insert of the
-- owner's request as this topic's first input and the first read position of the chat, so
-- either the chat is known with its input or it is not known. `chat` is set once.
create function hub_topic_channel_known(topic_in text, chat_in text, proof jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state in ('channel_known', 'bind_intent', 'bound') then
    if t.chat is distinct from chat_in then
      raise exception 'topic-chat-conflict: topic % already has another chat', t.id;
    end if;
    return t.create_state;
  end if;
  if t.create_state not in ('create_intent', 'creation_unknown') then
    raise exception 'topic-not-creating: topic % is %', t.id, t.create_state;
  end if;
  update public.topic
     set create_state = 'channel_known', chat = chat_in, initial_input_id = 'topic-create:' || t.id,
         create_retry_at = null, channel_known_at = now(),
         create_evidence = create_evidence || coalesce(proof, '{}'::jsonb), updated_at = now()
   where id = topic_in;
  return 'channel_known';
end $$;

-- AN EXPLICIT DECISION about a create nobody could settle (`creation_unknown`) or one the
-- platform refused (`failed`). `recreate` lets the create be asked for again and is only
-- ever this call's; `adopt` names a channel the owner says is the one, which the door
-- reads and checks before it uses it. Neither is made by machinery. Each decision is a
-- revision (`decision_seq`): the door is woken by it, and whatever it looks up for one
-- decision commits only while that decision still stands (`hub_topic_adopt_named`).
create function hub_topic_create_decision(topic_in text, choice text, chat_in text, by_in text, proof jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state not in ('creation_unknown', 'failed') then
    return t.create_state;
  end if;
  if choice = 'recreate' then
    update public.topic
       set create_state = 'confirmed', create_retry_at = null, create_failure = null, decision_seq = decision_seq + 1,
           create_evidence = create_evidence || jsonb_build_object('decision',
             jsonb_build_object('choice', 'recreate', 'by', by_in) || coalesce(proof, '{}'::jsonb)
               || jsonb_build_object('seq', t.decision_seq + 1)),
           updated_at = now()
     where id = topic_in;
    return 'confirmed';
  elsif choice = 'adopt' and chat_in is not null and chat_in <> '' then
    update public.topic
       set decision_seq = decision_seq + 1,
           create_evidence = create_evidence || jsonb_build_object('decision',
             jsonb_build_object('choice', 'adopt', 'chat', chat_in, 'by', by_in) || coalesce(proof, '{}'::jsonb)
               || jsonb_build_object('seq', t.decision_seq + 1)),
           updated_at = now()
     where id = topic_in;
    return t.create_state;
  end if;
  raise exception 'topic-decision-invalid: % is not a choice about a create', choice;
end $$;

-- THE CHANNEL THE OWNER NAMED IS THE ONE: the door read it, checked it, and commits it here
-- together with the owner's request as the first input. It commits only for the decision it
-- read (`seq_in`): a newer decision, another channel or a recreate, has moved the revision
-- on, and the older answer is `stale` and changes nothing. This is the one way a create the
-- platform refused becomes a known channel, and the table allows that edge only for an
-- `adopt` decision naming this very chat.
create function hub_topic_adopt_named(topic_in text, chat_in text, seq_in integer, proof jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state in ('channel_known', 'bind_intent', 'bound') then
    return case when t.chat = chat_in then t.create_state else 'stale' end;
  end if;
  if t.create_state not in ('creation_unknown', 'failed') or t.decision_seq <> seq_in
     or t.create_evidence -> 'decision' ->> 'choice' is distinct from 'adopt'
     or t.create_evidence -> 'decision' ->> 'chat' is distinct from chat_in then
    return 'stale';
  end if;
  update public.topic
     set create_state = 'channel_known', chat = chat_in, initial_input_id = 'topic-create:' || t.id,
         create_retry_at = null, create_failure = null, channel_known_at = now(),
         create_evidence = create_evidence || coalesce(proof, '{}'::jsonb), updated_at = now()
   where id = topic_in;
  return 'channel_known';
end $$;

-- THE CHANNEL THE OWNER NAMED CANNOT BE USED, and why, kept on the topic for the decision it
-- was named in: not a channel, not a text channel, not there, or already somebody's. The
-- topic stays as it is, so the owner can decide again; the door does not look again for a
-- decision it has already refused.
create function hub_topic_adopt_refused(topic_in text, seq_in integer, code_in text, cause_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state not in ('creation_unknown', 'failed') or t.decision_seq <> seq_in then
    return 'stale';
  end if;
  update public.topic
     set create_evidence = create_evidence || jsonb_build_object('adopt_refused', jsonb_build_object(
           'seq', seq_in, 'chat', t.create_evidence -> 'decision' ->> 'chat', 'code', code_in, 'cause', cause_in, 'at', now())),
         updated_at = now()
   where id = topic_in;
  return 'refused';
end $$;

-- THE REGISTRY WRITE: intent first, committed BEFORE the file is edited.
create function hub_topic_bind_intent(topic_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state = 'channel_known' then
    if exists (select 1 from public.identity_reservation where kind = 'agent' and id = t.agent_id) then
      raise exception 'identity-reserved: agent %', t.agent_id;
    end if;
    update public.topic set create_state = 'bind_intent', updated_at = now() where id = topic_in;
    return 'bind_intent';
  end if;
  return t.create_state;
end $$;

create function hub_topic_bound(topic_in text, proof jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state = 'bind_intent' then
    update public.topic
       set create_state = 'bound', lifecycle = 'active', create_failure = null,
           create_evidence = create_evidence || jsonb_build_object('bound', coalesce(proof, '{}'::jsonb)),
           updated_at = now()
     where id = topic_in;
    return 'bound';
  end if;
  return t.create_state;
end $$;

-- THE REGISTRY WRITE WAS REFUSED, so nothing was written: the topic goes back to
-- `channel_known` with what was refused, and the binder tries again when it is told to.
create function hub_topic_bind_refused(topic_in text, proof jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if t.create_state = 'bind_intent' then
    update public.topic set create_state = 'channel_known', create_failure = coalesce(proof, '{}'::jsonb), updated_at = now()
     where id = topic_in;
    return 'channel_known';
  end if;
  return t.create_state;
end $$;

-- AN ADOPTED MASTER BECOMES A TOPIC, once, keeping the conversation it already has. It is
-- refused for an identity that is reserved. The machine, runner and preset are what the
-- registry says the agent is.
create function hub_topic_link_legacy(topic_in text, person_in text, agent_in text, conversation_in text, door_in text,
                                      chat_in text, machine_in text, runner_in text, preset_in text, adapter_in text,
                                      session_in text, display text, marker_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  standing public.topic%rowtype;
  own text;
begin
  perform pg_advisory_xact_lock(682150, hashtext('legacy:' || agent_in));
  select * into standing from public.topic where agent_id = agent_in;
  if found then
    return standing.id;
  end if;
  if exists (select 1 from public.identity_reservation where kind = 'agent' and id = agent_in) then
    raise exception 'identity-reserved: agent %', agent_in;
  end if;
  select c.id into own from public.conversation c where c.kind = 'master' and c.agent = agent_in;
  if own is null then
    if exists (select 1 from public.identity_reservation where kind = 'conversation' and id = conversation_in) then
      raise exception 'identity-reserved: conversation %', conversation_in;
    end if;
    insert into public.conversation (id, person, agent, kind, adapter, machine, native_session)
    values (conversation_in, person_in, agent_in, 'master', adapter_in, null, session_in);
    own := conversation_in;
  end if;
  insert into public.topic (id, person, display_name, agent_id, conversation_id, origin, door, chat, machine, runner,
                            preset, marker, create_state, lifecycle)
  values (topic_in, person_in, display, agent_in, own, 'legacy', door_in, chat_in, machine_in, runner_in,
          preset_in, marker_in, 'legacy', 'active');
  return topic_in;
end $$;

-- A LEGACY MASTER WAS REPAIRED ONTO ANOTHER CHAT, or its registry entry was edited onto another chat or another door (the
-- old adopt verb, or the door noticing that the registry no longer says what its topic does). Its topic follows. A topic the
-- Hub made keeps the chat it made, and says so.
--
--   * An ACTIVE legacy topic takes the route (`door_in`, when given, and the chat). What was seen of the old chat is dropped, so
--     the new chat is looked at as a first sight, and the generation moves, so an observation that was on its way about the
--     old chat is refused by the fence of whatever it wanted to write (`fence_generation` below). It is the same topic,
--     agent, conversation and history: no second topic is made.
--   * A legacy topic whose chat vanished while it was ACTIVE (`missing_from`) is repaired
--     the same way and brought back: it keeps its identity, its conversation and its
--     history, the gate of the disappearance that holds it (`missing_operation`) is the only gate released (a hold
--     or another operation's gate over the same agent stays), and the request that disappearance made for the shared
--     deletion flow is closed as superseded by the repair, so it is never again an open question about a chat that was
--     replaced. `require_change` is for a caller that infers the repair from the registry and not from the owner's word: an
--     agent that reappears on the very route it vanished from repairs nothing (`unchanged`).
--   * One that vanished while archiving, archived or reopening is `missing-gated`: its archive
--     and its gates belong to the old chat, and nothing here applies them to another. Nor does an archived, archiving or
--     reopening topic move (`not-active`).
--   * Asked again for the route it already has, it answers `rebound` and changes nothing, so
--     a registry edit that landed before this was recorded is recovered by asking again.
--
-- WHAT IT REFUSES, BY NAME, WHOEVER ASKS: another person's agent (`person-mismatch`, when the caller says whose it is), a topic,
-- agent or conversation identity that was retired (`identity-reserved`, even for a topic that is already linked), and a route
-- another topic has (`chat-taken`).
--
-- LOCK ORDER as in `hub_topic_channel_missing`: the agent's ordering lock first, then the
-- topic's, then its row.
create function hub_topic_rebind(agent_in text, chat_in text, door_in text default null, person_in text default null,
                                 require_change boolean default false) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
  which text;
  target text;
  moved boolean;
begin
  select tp.id into which from public.topic tp where tp.agent_id = agent_in;
  if not found then
    return 'not-a-topic';
  end if;
  perform public.hub_gate_order(agent_in);
  perform pg_advisory_xact_lock(682150, hashtext(which));
  select * into t from public.topic where id = which for update;
  if t.origin <> 'legacy' then
    return 'managed';
  end if;
  if person_in is not null and person_in <> t.person then
    return 'person-mismatch';
  end if;
  if exists (select 1 from public.identity_reservation r
              where (r.kind = 'topic' and r.id = t.id) or (r.kind = 'agent' and r.id = t.agent_id)
                 or (r.kind = 'conversation' and r.id = t.conversation_id)) then
    return 'identity-reserved';
  end if;
  target := coalesce(door_in, t.door);
  moved := t.chat is distinct from chat_in or t.door <> target;
  if t.lifecycle = 'active' then
    if moved then
      if exists (select 1 from public.topic o where o.door = target and o.chat = chat_in and o.id <> t.id) then
        return 'chat-taken';
      end if;
      update public.topic
         set door = target, chat = chat_in, lifecycle_generation = lifecycle_generation + 1, updated_at = now()
       where id = t.id;
      delete from public.topic_channel_seen where topic_id = t.id;
    end if;
    return 'rebound';
  end if;
  if t.lifecycle = 'channel_missing' then
    if t.missing_from is distinct from 'active' then
      return 'missing-gated';
    end if;
    if require_change and not moved then
      return 'unchanged';
    end if;
    if exists (select 1 from public.topic o where o.door = target and o.chat = chat_in and o.id <> t.id) then
      return 'chat-taken';
    end if;
    update public.topic
       set door = target, chat = chat_in, lifecycle = 'active', lifecycle_generation = lifecycle_generation + 1,
           missing_from = null, missing_operation = null, updated_at = now()
     where id = t.id;
    delete from public.topic_channel_seen where topic_id = t.id;
    perform public.hub_gate_release(coalesce(t.missing_operation, 'missing:' || t.id), null, null);
    update public.topic_transition
       set state = 'failed', stage = 'repaired', completed_at = now(),
           evidence = evidence || jsonb_build_object('superseded', jsonb_build_object('by', 'repair', 'door', target, 'chat', chat_in, 'at', now())),
           updated_at = now()
     where topic_id = t.id and kind = 'deletion_request' and state = 'open';
    return 'rebound';
  end if;
  return 'not-active';
end $$;

-- ONE ARCHIVE OR ONE REOPEN, made once per operation. The answer is a word and never an
-- error for what a caller reports back: `ok`, `replay` (the same operation again),
-- `unknown-topic`, `not-active`, `not-archived`, `already-archived`, `in-progress`,
-- `missing` and `stale` (a fenced caller's, below).
--
-- ARCHIVE gates the master's agent and asks for a stop of whatever attempt it owns right
-- now, in this one transaction, gate first (the order the openings rely on). Nothing
-- waits for a drain. A stop is a request for ONE attempt, frozen at this moment, and it
-- only ever says what that attempt says. The topic is `archiving` until the channel
-- shows the change AND no attempt of the agent is owned any more.
--
-- REOPEN takes nothing but its own record: the gates are released when the channel has
-- been restored (or found changed by somebody else) and the topic is active again.
--
-- A CALLER THAT ASKS BECAUSE OF WHAT IT SAW OF A CHANNEL (the door, from an observation) names the chat and the lifecycle
-- generation it looked at (`fence_chat`, `fence_generation`); if the topic has been moved on since (repaired onto another
-- chat, archived, gone) the answer is `stale` and nothing is asked, so a look at a chat the topic no longer stands on
-- cannot archive the one it does. A caller that is asked by the owner names none.
create function hub_topic_transition_request(op_id text, topic_in text, kind_in text, source_in text, by_in text,
                                             stop_id text, route_in jsonb, proof jsonb,
                                             fence_chat text default null, fence_generation integer default null)
returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
  next_seq integer;
  who text;
begin
  -- The order the openings of attempts rely on (see `hub_gate_order`): the agent's ordering
  -- lock is taken before any row lock of this transaction.
  select tp.agent_id into who from public.topic tp where tp.id = topic_in;
  if not found then
    return 'unknown-topic';
  end if;
  perform public.hub_gate_order(who);
  perform pg_advisory_xact_lock(682150, hashtext(topic_in));
  select * into t from public.topic where id = topic_in for update;
  if exists (select 1 from public.topic_transition where id = op_id) then
    return 'replay';
  end if;
  if fence_generation is not null and (t.lifecycle_generation <> fence_generation or t.chat is distinct from fence_chat) then
    return 'stale';
  end if;
  if t.lifecycle = 'channel_missing' then
    return 'missing';
  end if;
  if kind_in = 'archive' then
    if t.lifecycle in ('archiving', 'reopening') then
      return 'in-progress';
    end if;
    if t.lifecycle = 'archived' then
      return 'already-archived';
    end if;
    if t.lifecycle <> 'active' then
      return 'not-active';
    end if;
    select coalesce(max(seq), 0) + 1 into next_seq from public.topic_transition where topic_id = t.id;
    update public.topic
       set lifecycle = 'archiving', lifecycle_generation = lifecycle_generation + 1,
           archive_operation = op_id, updated_at = now()
     where id = t.id;
    insert into public.topic_transition (id, topic_id, kind, seq, source, requested_by, route, evidence, stage)
    values (op_id, t.id, 'archive', next_seq, source_in, by_in, route_in, coalesce(proof, '{}'::jsonb), 'gated');
    perform public.hub_gate_place(op_id, 'agent', t.agent_id, 'archive', jsonb_build_object('topic', t.id));
    perform public.hub_stop_request(stop_id, op_id, 'agent', t.agent_id, by_in,
                                    jsonb_build_object('topic', t.id, 'cause', 'archive'));
    return 'ok';
  elsif kind_in = 'reopen' then
    if t.lifecycle in ('archiving', 'reopening') then
      return 'in-progress';
    end if;
    if t.lifecycle = 'active' then
      return 'not-archived';
    end if;
    if t.lifecycle <> 'archived' then
      return 'not-active';
    end if;
    select coalesce(max(seq), 0) + 1 into next_seq from public.topic_transition where topic_id = t.id;
    update public.topic
       set lifecycle = 'reopening', lifecycle_generation = lifecycle_generation + 1, updated_at = now()
     where id = t.id;
    insert into public.topic_transition (id, topic_id, kind, seq, source, requested_by, route, evidence, stage)
    values (op_id, t.id, 'reopen', next_seq, source_in, by_in, route_in, coalesce(proof, '{}'::jsonb), 'requested');
    return 'ok';
  end if;
  raise exception 'transition-invalid: % is not a lifecycle request', kind_in;
end $$;

-- THE DISCORD HALF OF A TRANSITION, journaled: `intent` with the plan is committed BEFORE
-- the platform is asked, and the answer is recorded against it. `conflict` is final.
create function hub_topic_transition_channel(op_id text, state_in text, plan_in jsonb, result_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  tr public.topic_transition%rowtype;
begin
  select * into tr from public.topic_transition where id = op_id for update;
  if not found then
    return 'unknown-operation';
  end if;
  if tr.state <> 'open' then
    return tr.state;
  end if;
  if state_in not in ('intent', 'applied', 'conflict', 'failed', 'unknown', 'none') then
    raise exception 'transition-invalid: % is not a channel state', state_in;
  end if;
  if tr.channel_state = 'conflict' then
    return 'conflict';
  end if;
  update public.topic_transition
     set channel_state = state_in,
         channel_plan = coalesce(plan_in, channel_plan),
         channel_result = coalesce(result_in, channel_result),
         stage = case when state_in = 'applied' then 'channel_done'
                      when state_in = 'intent' then 'channel_intent'
                      else stage end,
         updated_at = now()
   where id = op_id;
  return state_in;
end $$;

-- COMPLETION IS THE STORE'S TO SAY. An archive is complete only when the channel was
-- read back showing the change AND no attempt of the agent is owned (running, or not
-- shown to be gone), whoever asks; a reopen when the channel was restored or found
-- changed by somebody else. The completion notice, when there is one, is queued in
-- the same transaction, once, under its own key.
create function hub_topic_transition_complete(op_id text, proof jsonb, notice jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  tr public.topic_transition%rowtype;
  t public.topic%rowtype;
  owned integer;
begin
  select * into tr from public.topic_transition where id = op_id for update;
  if not found then
    return 'unknown-operation';
  end if;
  if tr.state <> 'open' then
    return tr.state;
  end if;
  select * into t from public.topic where id = tr.topic_id for update;
  if tr.kind = 'archive' then
    if tr.channel_state <> 'applied' then
      return 'channel-pending';
    end if;
    select count(*) into owned from public.execution e
     where e.agent = t.agent_id
       and e.state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown');
    if owned > 0 then
      return 'stop-pending';
    end if;
    update public.topic set lifecycle = 'archived', updated_at = now() where id = t.id and lifecycle = 'archiving';
  elsif tr.kind = 'reopen' then
    if tr.channel_state not in ('applied', 'conflict', 'none') then
      return 'channel-pending';
    end if;
    update public.topic set lifecycle = 'active', updated_at = now() where id = t.id and lifecycle = 'reopening';
    perform public.hub_gate_release(t.archive_operation, null, null);
  else
    return 'not-completable';
  end if;
  update public.topic_transition
     set state = 'complete', stage = 'complete', completed_at = now(),
         evidence = evidence || coalesce(proof, '{}'::jsonb), updated_at = now()
   where id = op_id;
  if notice is not null then
    insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
    values ('notice', null, 1, notice ->> 'body', notice ->> 'person', notice ->> 'agent', notice ->> 'key', notice -> 'route')
    on conflict (notice_key) do nothing;
  end if;
  return 'complete';
end $$;

-- WHAT THE PLATFORM SHOWED OF A CHAT. See `topic_channel_seen`: an error changes nothing
-- about the chat.
--
-- A look that names the chat and generation it was made of (`fence_chat`, `fence_generation`) is written only while the topic
-- still stands there, under a share lock on the row, so a look at a chat the topic has been moved off (a repair takes
-- the row lock, and drops what was seen) is never written over the record of the chat it has now. It says whether it wrote.
create function hub_topic_observe(topic_in text, present_in boolean, parent_in text, name_in text, error_in jsonb,
                                  fence_chat text default null, fence_generation integer default null)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  select * into t from public.topic where id = topic_in for share;
  if not found then
    return false;
  end if;
  if fence_generation is not null and (t.lifecycle_generation <> fence_generation or t.chat is distinct from fence_chat) then
    return false;
  end if;
  insert into public.topic_channel_seen (topic_id, present, parent_id, name, seen_at, checked_at, last_error)
  values (topic_in, case when error_in is null then present_in end, case when error_in is null then parent_in end,
          case when error_in is null then name_in end, case when error_in is null then now() end, now(), error_in)
  on conflict (topic_id) do update
     set present = case when error_in is null then present_in else topic_channel_seen.present end,
         parent_id = case when error_in is null then parent_in else topic_channel_seen.parent_id end,
         name = case when error_in is null then name_in else topic_channel_seen.name end,
         seen_at = case when error_in is null then now() else topic_channel_seen.seen_at end,
         checked_at = now(),
         last_error = error_in;
  return true;
end $$;

-- THE CHAT IS GONE FROM DISCORD, established by the door (a complete listing without it
-- and a targeted read that named it as gone). The vanished master is gated so nothing new
-- runs, the topic says so, and ONE request for the shared deletion flow is recorded, with
-- its notice, unless a deletion the Hub itself asked for is already in flight for this
-- topic. NOTHING IS ERASED and nothing here can approve an erasure: the request is
-- `pending_setup` until the deleting step exists to take it.
--
-- EVERY DISAPPEARANCE IS AN OPERATION OF ITS OWN. It is named after the topic and the lifecycle generation it begins at
-- (`missing:<topic>:<generation>`, allocated here under the agent's ordering lock and the topic's, and kept on the topic as
-- `missing_operation`), and its gate, its request (`deletion-request:<topic>:<generation>`) and its notice
-- (`topic:missing:<topic>:<generation>`, whatever key the caller wrote) all carry it. A gate that was released is never
-- placed again, so the disappearance of a chat that was repaired and then vanished a second time needs a gate of its own,
-- and so do its request and its notice: the first are closed and told, and are not the second. Asked again about the
-- disappearance that stands, it answers `already` and writes nothing, however often and across restarts.
--
-- A CALLER THAT ESTABLISHED IT FROM WHAT IT SAW OF A CHANNEL names the chat and the generation it looked at (`fence_chat`,
-- `fence_generation`). A topic that has been moved on since, repaired onto another chat above all, answers `stale` and
-- nothing happens: the read of a chat the topic no longer stands on cannot gate the one it does, or open a new
-- disappearance for it.
create function hub_topic_channel_missing(topic_in text, proof jsonb, notice jsonb,
                                          fence_chat text default null, fence_generation integer default null) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
  next_seq integer;
  who text;
  occurrence text;
begin
  select tp.agent_id into who from public.topic tp where tp.id = topic_in;
  if not found then
    return 'unknown-topic';
  end if;
  perform public.hub_gate_order(who);
  perform pg_advisory_xact_lock(682150, hashtext(topic_in));
  select * into t from public.topic where id = topic_in for update;
  if fence_generation is not null and (t.lifecycle_generation <> fence_generation or t.chat is distinct from fence_chat) then
    return 'stale';
  end if;
  if t.lifecycle = 'channel_missing' then
    return 'already';
  end if;
  if t.lifecycle = 'pending' then
    return 'not-bound';
  end if;
  occurrence := t.id || ':' || (t.lifecycle_generation + 1);
  perform public.hub_gate_place('missing:' || occurrence, 'agent', t.agent_id, 'channel_missing',
                                jsonb_build_object('topic', t.id, 'generation', t.lifecycle_generation + 1));
  update public.topic
     set lifecycle = 'channel_missing', lifecycle_generation = lifecycle_generation + 1,
         missing_from = t.lifecycle, missing_operation = 'missing:' || occurrence, updated_at = now()
   where id = t.id;
  update public.topic_transition
     set state = 'failed', stage = 'channel_missing', completed_at = now(), updated_at = now()
   where topic_id = t.id and state = 'open' and kind in ('archive', 'reopen');
  if t.delete_operation is not null then
    return 'suppressed';
  end if;
  select coalesce(max(seq), 0) + 1 into next_seq from public.topic_transition where topic_id = t.id;
  insert into public.topic_transition (id, topic_id, kind, seq, source, requested_by, route, evidence, stage)
  values ('deletion-request:' || occurrence, t.id, 'deletion_request', next_seq, 'discord', 'discord:observed',
          case when notice is null then null else notice -> 'route' end,
          coalesce(proof, '{}'::jsonb) || jsonb_build_object('missing_operation', 'missing:' || occurrence), 'pending_setup')
  on conflict (id) do nothing;
  if notice is not null then
    insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
    values ('notice', null, 1, notice ->> 'body', notice ->> 'person', notice ->> 'agent', 'topic:missing:' || occurrence, notice -> 'route')
    on conflict (notice_key) do nothing;
  end if;
  return 'ok';
end $$;

-- SAY IT ONCE. A topic that has just been bound is announced where it was asked for and
-- given its one status line, exactly once: the notice (when there is one) and the fact that it
-- was said commit together, so a door that dies between them says it again for nothing and a
-- second door says nothing. `status_in` is what the chat's status line stood at, `waiting` or
-- `running`, and `hub_topic_status` moves it, which is all a status line ever does.
--
-- `running` IS A ONE-TIME MILESTONE, NOT TELEMETRY: it is recorded only once something showed
-- the agent's first input picked up by its runner (the door decides that; nothing here can),
-- only for a chat that is ACTIVE, and nothing tracks it afterwards. `reason_in` is why the
-- line still says waiting, kept for `inspect`. Whether a notice was queued or had nowhere to
-- go is recorded beside the fact that it was announced, so an announcement that reached
-- nobody is never recorded as one that did.
create function hub_topic_announce(topic_in text, notice jsonb, status_in text, reason_in text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
begin
  if status_in not in ('waiting', 'running') then
    raise exception 'topic-status-invalid: % is not a status', status_in;
  end if;
  select * into t from public.topic where id = topic_in for update;
  if not found or t.create_state <> 'bound' or jsonb_exists(t.create_evidence, 'announced') then
    return false;
  end if;
  if status_in = 'running' and t.lifecycle <> 'active' then
    return false;
  end if;
  update public.topic
     set create_evidence = create_evidence
           || jsonb_build_object('announced', true, 'status', status_in,
                                 'notice', case when notice is null then 'unroutable' else 'queued' end)
           || case when reason_in is null or status_in = 'running' then '{}'::jsonb
                   else jsonb_build_object('status_reason', reason_in) end,
         updated_at = now()
   where id = topic_in;
  if notice is not null then
    insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
    values ('notice', null, 1, notice ->> 'body', notice ->> 'person', notice ->> 'agent', notice ->> 'key', notice -> 'route')
    on conflict (notice_key) do nothing;
  end if;
  return true;
end $$;

-- Moves the status line, and says whether it did: a chat that is archiving, archived, being
-- reopened or gone is not moved, so a status is never published for one.
create function hub_topic_status(topic_in text, status_in text, reason_in text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if status_in not in ('waiting', 'running') then
    raise exception 'topic-status-invalid: % is not a status', status_in;
  end if;
  update public.topic
     set create_evidence = (case when status_in = 'running' then create_evidence - 'status_reason' else create_evidence end)
           || jsonb_build_object('status', status_in)
           || case when reason_in is null or status_in = 'running' then '{}'::jsonb
                   else jsonb_build_object('status_reason', reason_in) end,
         updated_at = now()
   where id = topic_in and create_state = 'bound' and lifecycle = 'active' and jsonb_exists(create_evidence, 'announced');
  return found;
end $$;

-- WHAT THE PERSON NEEDED TO BE TOLD AND NOTHING COULD TAKE IT: neither the chat it belongs to
-- nor the person's General was somewhere a notice could be delivered. `kind_in` is the sort
-- of notice, and `cause_in` the reason, kept on the topic under the attention map so `check`
-- and `inspect` can say it; a null cause clears it once a notice of that kind is routed. A
-- repeat of the same cause changes nothing, so the moment it first happened stays.
--
-- EACH GAP IS AN OCCURRENCE, AND IS NUMBERED (`seq`, from the topic's own `attention_seq`) when it opens: a change of cause
-- keeps the occurrence, and a gap that was cleared and opens again is a later one. That number is what a catch-up (below) names
-- and clears, so a gap that opens after one was read is never the one that was caught up with.
create function hub_topic_attention(topic_in text, kind_in text, cause_in text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if cause_in is null then
    update public.topic set create_evidence = create_evidence #- array['attention', kind_in]
     where id = topic_in and create_evidence #> array['attention', kind_in] is not null;
    return;
  end if;
  update public.topic
     set attention_seq = case when create_evidence #>> array['attention', kind_in, 'seq'] is null then attention_seq + 1 else attention_seq end,
         create_evidence = jsonb_set(create_evidence, array['attention'],
           coalesce(create_evidence -> 'attention', '{}'::jsonb)
             || jsonb_build_object(kind_in, jsonb_build_object('cause', cause_in, 'at', now(),
                  'seq', coalesce((create_evidence #>> array['attention', kind_in, 'seq'])::integer, attention_seq + 1))), true)
   where id = topic_in and create_evidence #>> array['attention', kind_in, 'cause'] is distinct from cause_in;
end $$;

-- WHAT WAS OWED AND COULD NOT BE TOLD IS TOLD ONCE, WHEN A ROUTE CAN TAKE IT: one notice for the gaps the caller read
-- (`represented`: `[{kind, seq}]`), and exactly those gaps cleared, in the same transaction. The topic row is locked and every
-- gap is read again first; if any of them is not standing as it was read (cleared, or opened again since, under another `seq`)
-- the answer is `stale` and NOTHING is queued or cleared, so an older catch-up can never erase a newer gap and a gap that opened
-- meanwhile is left for the next one. The notice's key names the occurrences it stands for
-- (`topic:attention-catchup:<topic>:<kind>.<seq>,...`): asked again for the same ones it queues nothing more, and a later
-- occurrence of the same kind has another key and is caught up with on its own. Nothing here says the notice was delivered:
-- it is queued in the outbox, whose delivery is its own.
create function hub_topic_attention_catchup(topic_in text, represented jsonb, notice jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
  one jsonb;
  named text;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if represented is null or jsonb_typeof(represented) <> 'array' or jsonb_array_length(represented) = 0 or notice is null then
    return 'nothing';
  end if;
  for one in select e from jsonb_array_elements(represented) e loop
    if coalesce((t.create_evidence #>> array['attention', one ->> 'kind', 'seq'])::integer, -1)
         is distinct from coalesce((one ->> 'seq')::integer, -2) then
      return 'stale';
    end if;
  end loop;
  select string_agg((e ->> 'kind') || '.' || (e ->> 'seq'), ',' order by e ->> 'kind') into named
    from jsonb_array_elements(represented) e;
  insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
  values ('notice', null, 1, notice ->> 'body', notice ->> 'person', notice ->> 'agent',
          'topic:attention-catchup:' || t.id || ':' || named, notice -> 'route')
  on conflict (notice_key) do nothing;
  for one in select e from jsonb_array_elements(represented) e loop
    update public.topic set create_evidence = create_evidence #- array['attention', one ->> 'kind'] where id = t.id;
  end loop;
  return 'queued';
end $$;

-- Everyone who works with these reads them; only the routines above write them.
revoke all on function hub_topic_announce(text, jsonb, text, text) from public;
revoke all on function hub_topic_status(text, text, text) from public;
revoke all on function hub_topic_attention(text, text, text) from public;
grant execute on function hub_topic_announce(text, jsonb, text, text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_status(text, text, text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_attention(text, text, text) to hub_door, hub_runner, hub_hub;
revoke all on function hub_identity_reserve(text, text, text, jsonb) from public;
revoke all on function hub_identity_reserved(text, text) from public;
revoke all on function hub_topic_allocate(text, text, text, text, text, text, text, text, text, text, text, text, text, jsonb) from public;
revoke all on function hub_topic_revise(text, text, text, text, text, text, jsonb) from public;
revoke all on function hub_topic_confirm(text) from public;
revoke all on function hub_topic_create_intent(text, text) from public;
revoke all on function hub_topic_create_unsent(text, text, timestamptz, jsonb) from public;
revoke all on function hub_topic_create_look(text, text, jsonb, timestamptz, boolean) from public;
revoke all on function hub_topic_create_failed(text, text, jsonb) from public;
revoke all on function hub_topic_channel_known(text, text, jsonb) from public;
revoke all on function hub_topic_create_decision(text, text, text, text, jsonb) from public;
revoke all on function hub_topic_adopt_named(text, text, integer, jsonb) from public;
revoke all on function hub_topic_adopt_refused(text, integer, text, text) from public;
revoke all on function hub_topic_bind_intent(text) from public;
revoke all on function hub_topic_bound(text, jsonb) from public;
revoke all on function hub_topic_bind_refused(text, jsonb) from public;
revoke all on function hub_topic_link_legacy(text, text, text, text, text, text, text, text, text, text, text, text, text) from public;
revoke all on function hub_topic_rebind(text, text, text, text, boolean) from public;
revoke all on function hub_topic_transition_request(text, text, text, text, text, text, jsonb, jsonb, text, integer) from public;
revoke all on function hub_topic_transition_channel(text, text, jsonb, jsonb) from public;
revoke all on function hub_topic_transition_complete(text, jsonb, jsonb) from public;
revoke all on function hub_topic_observe(text, boolean, text, text, jsonb, text, integer) from public;
revoke all on function hub_topic_channel_missing(text, jsonb, jsonb, text, integer) from public;
revoke all on function hub_topic_attention_catchup(text, jsonb, jsonb) from public;
grant execute on function hub_identity_reserve(text, text, text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_identity_reserved(text, text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_allocate(text, text, text, text, text, text, text, text, text, text, text, text, text, jsonb)
  to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_revise(text, text, text, text, text, text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_confirm(text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_create_intent(text, text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_create_unsent(text, text, timestamptz, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_create_look(text, text, jsonb, timestamptz, boolean) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_create_failed(text, text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_channel_known(text, text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_create_decision(text, text, text, text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_adopt_named(text, text, integer, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_adopt_refused(text, integer, text, text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_bind_intent(text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_bound(text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_bind_refused(text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_link_legacy(text, text, text, text, text, text, text, text, text, text, text, text, text)
  to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_rebind(text, text, text, text, boolean) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_transition_request(text, text, text, text, text, text, jsonb, jsonb, text, integer)
  to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_transition_channel(text, text, jsonb, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_transition_complete(text, jsonb, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_observe(text, boolean, text, text, jsonb, text, integer) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_channel_missing(text, jsonb, jsonb, text, integer) to hub_door, hub_runner, hub_hub;
grant execute on function hub_topic_attention_catchup(text, jsonb, jsonb) to hub_door, hub_runner, hub_hub;
grant select on identity_reservation, topic, topic_transition, topic_channel_seen to hub_door, hub_runner, hub_hub;
