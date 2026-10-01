-- Confirmed topic deletion, content-free tombstones and the restore barrier (IMP-232).
--
-- Numbered 017, after the movement step (016): `migrate` runs whatever versions are missing, in order. This step reads tables
-- of migrations 001..016 and replaces three of their routines (`hub_ledger_append_only`, `hub_guard_topic`,
-- `hub_topic_channel_missing`), each by the same body plus the one edge named where it is replaced.
--
-- WHAT THIS STEP IS. The store half of "delete the topic, its agent and its ACTIVE history": the durable operation and its
-- stages, the scope a confirmation freezes, the receipts of every location a copy was recorded at, the content-free tombstone
-- and the permanent reservation of the identities, the one narrow path that may remove ledger rows, the erasure generation a
-- backup and a deletion are ordered by, and the control manifest a restore merges BEFORE anything is served. It moves no file,
-- asks no platform and decides nothing about who may ask: the door and the hub do those, and report here.
--
-- WHAT IT IS NOT. Historical backup copies are not rewritten, rebuilt or sanitized: they expire under a retention the owner
-- configures, and this step only keeps the account of them (`retention_state`, the `historical` receipts). A retention it was
-- not given is `not_configured`, never a default. Independent vault knowledge is not in the store and is not touched.
--
-- WHO WRITES. Nobody but the definer functions below inserts into or updates these tables. The two that remove content
-- (`hub_deletion_erase_active`, `hub_erasure_apply`) are granted to the door and the hub only, never to the model's login,
-- and run only for a deletion the owner confirmed (a tombstone exists) or one a returning manifest names.

-- THE ORDER A BACKUP AND A DELETION MEET IN. Every confirmed deletion takes the next number; a restored or returning machine
-- merges the manifest's number forward. It only moves forward.
create table erasure_control (
  singleton  boolean primary key default true check (singleton),
  generation integer not null default 0 check (generation >= 0),
  updated_at timestamptz not null default now()
);
insert into erasure_control default values;

create function hub_guard_erasure_control() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the erasure generation only moves forward and is never removed';
  end if;
  if new.generation < old.generation then
    raise exception 'the erasure generation only moves forward and is never removed';
  end if;
  return new;
end $$;
create trigger erasure_control_forward
  before update or delete on erasure_control
  for each row execute function hub_guard_erasure_control();

-- WHAT IS KEPT OF A DELETED TOPIC, AND NOTHING ELSE: identifiers, never a name, a request or a word of its history. It is what a
-- restore, a stale pull and a returning machine are held against. Permanent, except that `active_deleted_at` is set once.
create table topic_tombstone (
  topic_id             text primary key check (topic_id <> ''),
  person               text not null,
  agent_id             text not null check (agent_id <> ''),
  conversation_id      text not null check (conversation_id <> ''),
  origin               text not null check (origin in ('created', 'legacy')),
  door                 text not null,
  chat                 text,
  machine              text not null,
  runner               text not null,
  worker_conversations jsonb not null default '[]'::jsonb check (jsonb_typeof(worker_conversations) = 'array'),
  deletion_id          text not null check (deletion_id <> ''),
  deletion_generation  integer not null check (deletion_generation >= 1),
  confirmed_at         timestamptz not null default now(),
  active_deleted_at    timestamptz
);
create unique index topic_tombstone_by_agent on topic_tombstone (agent_id);
create unique index topic_tombstone_by_conversation on topic_tombstone (conversation_id);
create unique index topic_tombstone_by_deletion on topic_tombstone (deletion_id);

create function hub_guard_tombstone() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the tombstone of topic % is permanent', old.topic_id;
  end if;
  if (to_jsonb(new) - 'active_deleted_at') is distinct from (to_jsonb(old) - 'active_deleted_at')
     or (old.active_deleted_at is not null and new.active_deleted_at is distinct from old.active_deleted_at) then
    raise exception 'the tombstone of topic % keeps what it recorded for good', old.topic_id;
  end if;
  return new;
end $$;
create trigger topic_tombstone_permanent
  before update or delete on topic_tombstone
  for each row execute function hub_guard_tombstone();

-- ONE DELETION OF ONE TOPIC. `stage`, in the order things happen:
--   awaiting_confirmation  the scope is frozen (`preview`) and nobody approved it
--   quiescing              the owner approved: the identities are reserved, the tombstone is written, the agent, its delegated
--                          conversations and its queued jobs are gated and a stop is asked for what they own. Nothing is erased
--   deleting_active        the stops are shown, and the active rows are being removed (one transaction)
--   verifying_active       the rows are gone; the receipts of the other active copies decide what comes next
--   active_deleted         every inventoried ACTIVE copy has a receipt that says erased. Historical backups may remain
--   pending_machine        a machine that holds an active copy has not reported it erased. Expected, not a failure
--   blocked_scope          a transport cannot do it (`unsupported`) or a copy was refused: said, never called erased
--   failed                 the removal was refused by the store, or rows came back. Retried only by asking again
--   superseded             a newer request for the same topic replaced this preview before anyone approved it
-- `retention_state` is the account of the HISTORICAL copies, kept apart from the stage on purpose:
--   not_configured | tracking | retention_unverified | retention_blocked | historical_copies_expired.
-- `retention_days` is what the owner had configured when the preview was frozen, or null: it is never filled in.
create table topic_deletion (
  id                 text primary key check (id <> ''),
  topic_id           text not null,
  person             text not null,
  agent_id           text not null,
  conversation_id    text not null,
  door               text not null,
  chat               text,
  requested_by       text not null check (requested_by <> ''),
  source             text not null check (source in ('tool', 'discord', 'door')),
  route              jsonb,
  evidence           jsonb not null default '{}'::jsonb,
  stage              text not null default 'awaiting_confirmation'
                       check (stage in ('awaiting_confirmation', 'quiescing', 'deleting_active', 'verifying_active', 'active_deleted',
                                        'pending_machine', 'blocked_scope', 'failed', 'superseded')),
  preview            jsonb not null,
  blocked            jsonb,
  failure            jsonb,
  confirmation_id    text,
  confirmed_by       text,
  confirmed_at       timestamptz,
  deletion_generation integer,
  quiesce            jsonb not null default '{}'::jsonb,
  erased             jsonb,
  retention_days     integer check (retention_days is null or retention_days between 1 and 3650),
  retention_state    text not null default 'not_configured'
                       check (retention_state in ('not_configured', 'tracking', 'retention_unverified', 'retention_blocked', 'historical_copies_expired')),
  backup_retention_until timestamptz,
  retention_detail   jsonb not null default '{}'::jsonb check (octet_length(retention_detail::text) <= 16384),
  active_deleted_at  timestamptz,
  historical_copies_expired_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint topic_deletion_confirmed_has_generation check ((confirmation_id is null) = (deletion_generation is null))
);
create unique index topic_deletion_one_live on topic_deletion (topic_id) where stage not in ('active_deleted', 'superseded');
create index topic_deletion_by_door on topic_deletion (door) where stage not in ('active_deleted', 'superseded', 'awaiting_confirmation');

create function hub_guard_topic_deletion() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.topic_id is distinct from old.topic_id or new.agent_id is distinct from old.agent_id
     or new.conversation_id is distinct from old.conversation_id or new.requested_by is distinct from old.requested_by
     or new.preview is distinct from old.preview then
    raise exception 'deletion % keeps what was frozen when it was asked for', old.id;
  end if;
  if old.stage in ('active_deleted', 'superseded') and new.stage is distinct from old.stage then
    raise exception 'deletion % is % and stays so', old.id, old.stage;
  end if;
  if old.confirmation_id is not null and new.confirmation_id is distinct from old.confirmation_id then
    raise exception 'deletion % was approved once, and by that approval only', old.id;
  end if;
  if old.stage = 'awaiting_confirmation' and new.stage not in ('awaiting_confirmation', 'quiescing', 'superseded') then
    raise exception 'deletion % cannot go from % to %', old.id, old.stage, new.stage;
  end if;
  return new;
end $$;
create trigger topic_deletion_rules
  before update on topic_deletion
  for each row execute function hub_guard_topic_deletion();

-- The door and the hub of the topic's door hear about a deletion that has work for them, as they do for a topic.
create function hub_notify_deletion() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_project', 'topic:' || new.door);
  perform pg_notify('hub_topic', new.door);
  return null;
end $$;
create trigger topic_deletion_notify
  after insert or update of stage on topic_deletion
  for each row execute function hub_notify_deletion();

-- ONE LOCATION A COPY WAS RECORDED AT, AND WHAT IS KNOWN OF IT. Written BEFORE anything is erased (at the approval), because
-- what names a location (an attachment's folder, a message in General, a copy another machine holds) is itself erased.
-- `class` says what kind of copy; `machine` is the machine that must report it ('' for a place that is not a machine's).
--   pending                nobody has reported it
--   pending_machine        its machine was asked and has not answered (offline). Kept, never turned into erased
--   erased                 the one that holds it reported it gone, with what it saw (`registry_binding` is the agent's entry in the
--                          registry, removed by the hub of the topic's door)
--   unsupported            the transport cannot do it. Said, and never certified
--   blocked                it was refused, with the reason
--   not_applicable         nothing was ever there
--   retention_unverified | retention_blocked | expired   (`historical` copies only)
-- A receipt is the claim of whoever reported it, bound to the location and the deletion it names. The store keeps it and refuses
-- to change one that says erased; it never manufactures proof about a disk.
create table erasure_receipt (
  deletion_id text not null references topic_deletion (id),
  class       text not null check (class in ('postgres_active', 'registry_binding', 'chatlog', 'inbox_media', 'engine_state', 'move_copy',
                                              'platform_chat', 'platform_message', 'backup_generation')),
  location    text not null check (location <> ''),
  machine     text not null default '',
  historical  boolean not null default false,
  state       text not null default 'pending'
                check (state in ('pending', 'pending_machine', 'erased', 'unsupported', 'blocked', 'not_applicable',
                                 'retention_unverified', 'retention_blocked', 'expired')),
  detail      jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 4096),
  reported_by text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (deletion_id, class, location, machine),
  constraint erasure_receipt_historical_class check (historical = (class = 'backup_generation'))
);
create index erasure_receipt_open on erasure_receipt (deletion_id) where state in ('pending', 'pending_machine');

-- ---------------------------------------------------------------------------------------------------------------------
-- The three routines of 015 and 013 this step has to change, each by one edge.
-- ---------------------------------------------------------------------------------------------------------------------

-- THE DIARY STAYS A DIARY. The one deletion it allows is the confirmed-erasure path: the caller is not one of the four roles
-- the machinery logs in as (so the owner of this routine, never the model's login and never a runner), and a transaction-local
-- name that is the deletion id of an existing tombstone is set. Nothing else is deleted, and nothing is ever updated.
create or replace function hub_ledger_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE'
     and current_user not in ('hub_door', 'hub_runner', 'hub_agent', 'hub_hub')
     and coalesce(current_setting('hub.erasing', true), '') <> ''
     and exists (select 1 from public.topic_tombstone k where k.deletion_id = current_setting('hub.erasing', true)) then
    return old;
  end if;
  raise exception
    'ledger_event is a diary: an entry is never changed and never deleted (seq %)',
    old.seq;
end $$;

-- `deleting`: the lifecycle of a topic whose deletion the owner approved. It is entered from the three lifecycles a deletion may
-- start from, never left (the row is removed by the erasure), and every request that needs an `active` topic (an archive, a move)
-- is therefore refused by the store without being told about it.
do $$
declare
  one record;
begin
  for one in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.topic'::regclass and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%lifecycle = ANY%'
  loop
    execute format('alter table public.topic drop constraint %I', one.conname);
  end loop;
end $$;
alter table topic add constraint topic_lifecycle_known
  check (lifecycle in ('pending', 'active', 'archiving', 'archived', 'reopening', 'channel_missing', 'deleting'));

create or replace function hub_guard_topic() returns trigger
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
           or (old.lifecycle = 'channel_missing' and new.lifecycle = 'active'
               and old.origin = 'legacy' and coalesce(old.missing_from = 'active', false))
           or (old.lifecycle in ('active', 'archived', 'channel_missing') and new.lifecycle = 'deleting')) then
    raise exception 'topic % cannot go from % to %', old.id, old.lifecycle, new.lifecycle;
  end if;
  return new;
end $$;

-- A chat that is gone while its deletion is under way is not a new disappearance: the deletion already holds the topic, so the
-- observation changes nothing and asks nothing. The rest of the routine is 015's, unchanged.
create or replace function hub_topic_channel_missing(topic_in text, proof jsonb, notice jsonb,
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
  if t.lifecycle in ('channel_missing', 'deleting') then
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

-- ---------------------------------------------------------------------------------------------------------------------
-- Scope. What a deletion is about is worked out from selectors (the agent, its master conversation, the worker conversations
-- recorded at the approval), never from a name, so a topic that shares a display name with a deleted one is not in it.
-- ---------------------------------------------------------------------------------------------------------------------

create type erasure_sets as (councils text[], inbound text[], conversations text[], executions text[], moves text[]);

-- The ids a topic owns: its councils, every input addressed to its agent or dispatched by it or made for those councils, the
-- master conversation and the worker conversations of its councils and jobs, the attempts of those, and its moves. A job that
-- belongs independently to another topic is not here: it names another dispatcher.
create function hub_erasure_sets(agent_in text, conversation_in text, workers_in jsonb) returns erasure_sets
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  s public.erasure_sets;
  frozen text[] := array(select jsonb_array_elements_text(coalesce(workers_in, '[]'::jsonb)));
begin
  s.councils := array(select c.id from public.council c where c.agent = agent_in);
  s.inbound := array(
    select i.id from public.inbound i where i.agent = agent_in
    union select i.id from public.inbound i where i.kind = 'job' and i.source -> 'dispatch' ->> 'dispatcher' = agent_in
    union select e.inbound_id from public.council_event e where e.council_id = any (s.councils)
    union select m.inbound_id from public.round_member m where m.council_id = any (s.councils) and m.inbound_id is not null
    union select p.first_inbound from public.council_participant p where p.council_id = any (s.councils) and p.first_inbound is not null);
  s.conversations := array(
    select conversation_in
    union select c.id from public.conversation c where c.agent = agent_in
    union select p.worker_conversation from public.council_participant p where p.council_id = any (s.councils) and p.worker_conversation is not null
    union select c.id from public.conversation c where c.kind = 'worker' and c.owner_ref = any (s.inbound)
    union select unnest(frozen));
  s.executions := array(select e.id from public.execution e where e.conversation_id = any (s.conversations) or e.inbound_id = any (s.inbound));
  s.moves := array(select m.id from public.topic_move m where m.agent = agent_in or m.conversation_id = any (s.conversations));
  return s;
end $$;

-- Whether a state-sheet row belongs to the topic. Closed on purpose: a sheet that is not named here is not guessed at, and the
-- deletion's preview says which sheets it covers.
create function hub_erasure_owns_row(sheet_in text, id_in text, data_in jsonb, agent_in text, person_in text, door_in text,
                                     chat_in text, inbound_in text[]) returns boolean
language sql immutable as $$
  select coalesce(case sheet_in
    when 'agent_wait' then id_in = agent_in
    when 'agent_health' then id_in = agent_in
    when 'harvest' then id_in = person_in || '/' || agent_in
    when 'door_cursor' then chat_in is not null and id_in = door_in || '/' || chat_in
    when 'door_health' then chat_in is not null and id_in = door_in || '/' || chat_in
    when 'move_command' then starts_with(id_in, '["' || agent_in || '",')
    when 'move_command_done' then starts_with(id_in, '["' || agent_in || '",')
    when 'turn_progress' then id_in = any (inbound_in)
    when 'door_progress' then id_in = any (inbound_in) or data_in ->> 'agent' = agent_in
    when 'control' then data_in ->> 'agent' = agent_in
    else false end, false)
$$;

-- The Hub-generated messages a topic left somewhere else: the previews of its creation and its councils' status lines.
create function hub_erasure_linked_effects(topic_in text, councils_in text[]) returns setof public.platform_effect
language sql stable security definer set search_path = pg_catalog, public as $$
  select e.* from public.platform_effect e
   where e.owner_ref in (select 'confirmation:' || cf.id from public.confirmation cf
                          where cf.operation_kind = 'topic.create' and cf.payload ->> 'topic_id' = topic_in)
      or e.key in (select c.status_effect_key from public.council c where c.id = any (councils_in))
$$;

-- What a deletion would remove, as numbers only. This is what the owner confirms, and nothing of it is a word of the history.
create function hub_deletion_inventory(agent_in text, conversation_in text, workers_in jsonb, person_in text, door_in text,
                                       chat_in text, topic_in text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  s public.erasure_sets;
begin
  s := public.hub_erasure_sets(agent_in, conversation_in, workers_in);
  return jsonb_build_object(
    'conversations', (select count(*) from public.conversation where id = any (s.conversations)),
    'conversation_entries', (select count(*) from public.conversation_entry where conversation_id = any (s.conversations)),
    'inbound', cardinality(s.inbound),
    'jobs', (select count(*) from public.inbound where id = any (s.inbound) and kind = 'job'),
    'executions', cardinality(s.executions),
    'councils', cardinality(s.councils),
    'outbox', (select count(*) from public.outbox where inbound_id = any (s.inbound) or agent = agent_in),
    'media_files', (select count(*) from public.media where inbound_id = any (s.inbound)),
    'media_bytes', (select coalesce(sum(octet_length(bytes)), 0) from public.media where inbound_id = any (s.inbound)),
    'ledger_events', (select count(*) from public.ledger_event
                       where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
                          or subject = any (s.conversations) or subject = agent_in),
    'state_rows', (select count(*) from public.state_row r
                    where public.hub_erasure_owns_row(r.sheet, r.id, r.data, agent_in, person_in, door_in, chat_in, s.inbound)),
    'moves', cardinality(s.moves),
    'move_copies', (select count(*) from public.move_copy where move_id = any (s.moves) and state not in ('removed', 'superseded')),
    'effects_in_chat', (select count(*) from public.platform_effect e where chat_in is not null and e.door = door_in and e.chat = chat_in),
    'messages_elsewhere', (select count(*) from public.hub_erasure_linked_effects(topic_in, s.councils) e
                            where e.platform_id is not null and not (e.door = door_in and coalesce(e.chat = chat_in, false)))
  );
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The request, the approval and the stops.
-- ---------------------------------------------------------------------------------------------------------------------

-- ASK FOR A DELETION: the scope is worked out and frozen, and nothing is changed. Answers `ok`, `replay` (the same operation
-- again), `unknown-topic`, `deleted` (a tombstone says it already was), `in-progress` (a deletion, an archive, a reopen or a move is
-- under way) and `not-settled` (the topic is not set up). `machines_in` names the machines that may hold an active copy and
-- `retention_days_in` is what the owner configured, or null: both are frozen in the preview, so what is approved says them.
-- A preview nobody approved is superseded by this one, and the owner's open "this chat is gone, delete it?" request is taken over.
create function hub_deletion_request(op_id text, topic_in text, by_in text, source_in text, route_in jsonb,
                                     retention_days_in integer, machines_in jsonb, evidence_in jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
  who text;
begin
  select tp.agent_id into who from public.topic tp where tp.id = topic_in;
  if not found then
    if exists (select 1 from public.topic_tombstone where topic_id = topic_in) then
      return 'deleted';
    end if;
    return 'unknown-topic';
  end if;
  perform public.hub_gate_order(who);
  perform pg_advisory_xact_lock(682150, hashtext(topic_in));
  select * into t from public.topic where id = topic_in for update;
  if exists (select 1 from public.topic_deletion where id = op_id) then
    return 'replay';
  end if;
  if coalesce(op_id, '') = '' or coalesce(by_in, '') = '' or jsonb_typeof(coalesce(machines_in, 'null'::jsonb)) <> 'array' then
    raise exception 'deletion-invalid: a deletion is asked for with its operation, its requester and the machines it covers';
  end if;
  if retention_days_in is not null and retention_days_in not between 1 and 3650 then
    raise exception 'retention-invalid: the configured retention is a whole number of days from 1 to 3650';
  end if;
  if t.lifecycle = 'deleting' then
    return 'in-progress';
  end if;
  if t.lifecycle not in ('active', 'archived', 'channel_missing') then
    return 'not-settled';
  end if;
  if exists (select 1 from public.topic_move m where m.topic_id = t.id and m.stage not in ('active', 'withdrawn'))
     or exists (select 1 from public.topic_transition x where x.topic_id = t.id and x.state = 'open' and x.kind in ('archive', 'reopen')) then
    return 'in-progress';
  end if;
  update public.topic_deletion set stage = 'superseded', updated_at = now()
   where topic_id = t.id and stage = 'awaiting_confirmation';
  insert into public.topic_deletion (id, topic_id, person, agent_id, conversation_id, door, chat, requested_by, source, route, evidence,
                                     preview, retention_days, retention_state)
  values (op_id, t.id, t.person, t.agent_id, t.conversation_id, t.door, t.chat, by_in, source_in, route_in,
          coalesce(evidence_in, '{}'::jsonb),
          jsonb_build_object('topic', t.id, 'agent', t.agent_id, 'origin', t.origin, 'door', t.door,
            'inventory', public.hub_deletion_inventory(t.agent_id, t.conversation_id, null, t.person, t.door, t.chat, t.id),
            'machines', machines_in,
            'retention', jsonb_build_object('configured_days', retention_days_in)),
          retention_days_in, case when retention_days_in is null then 'not_configured' else 'tracking' end);
  update public.topic_transition
     set state = 'failed', stage = 'taken_by_deletion', completed_at = now(),
         evidence = evidence || jsonb_build_object('taken_by', jsonb_build_object('deletion', op_id, 'at', now())), updated_at = now()
   where topic_id = t.id and kind = 'deletion_request' and state = 'open';
  return 'ok';
end $$;

-- THE APPROVAL, AS THIS DELETION'S OWN: called from the approval hook in the approval's transaction. It refuses anything but the
-- approved preview of a deletion that is still waiting for it, for a topic that still stands as it was shown. It changes nothing
-- else about the world's data: it RESERVES the identities, writes the tombstone and the receipts, gates the agent, the worker
-- conversations and the queued jobs, asks for a stop of what they own, and moves the topic to `deleting`. Every one of those comes
-- BEFORE any content is erased, and the erasure itself waits for the stops (`hub_deletion_erase_active`).
create function hub_deletion_confirm(confirmation_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  c public.confirmation%rowtype;
  d public.topic_deletion%rowtype;
  t public.topic%rowtype;
  s public.erasure_sets;
  gen integer;
  who text;
  rec record;
  one text;
  hashed text;
  tid text;
begin
  select * into c from public.confirmation where id = confirmation_in;
  if not found then
    raise exception 'deletion-approval-unknown: there is no confirmation %', confirmation_in;
  end if;
  if c.operation_kind <> 'topic.delete' or c.state <> 'approved' then
    raise exception 'deletion-approval-invalid: % is not an approved topic deletion', confirmation_in;
  end if;
  select x.agent_id, x.topic_id into who, tid from public.topic_deletion x where x.id = c.operation_id;
  if not found then
    raise exception 'deletion-unknown: no deletion was asked for as %', c.operation_id;
  end if;
  -- The order every topic routine takes its locks in: the agent's, then the topic's, and only then a row.
  perform public.hub_gate_order(who);
  perform pg_advisory_xact_lock(682150, hashtext(tid));
  select * into d from public.topic_deletion where id = c.operation_id for update;
  if d.confirmation_id = c.id then
    return 'replay';
  end if;
  if d.stage <> 'awaiting_confirmation' then
    raise exception 'deletion-closed: deletion % is % and cannot be approved', d.id, d.stage;
  end if;
  if d.preview is distinct from c.payload then
    raise exception 'deletion-changed: the approved preview is not what deletion % holds', d.id;
  end if;
  select * into t from public.topic where id = d.topic_id for update;
  if not found or t.lifecycle not in ('active', 'archived', 'channel_missing') then
    raise exception 'deletion-topic-changed: topic % no longer stands as the preview showed it', d.topic_id;
  end if;
  s := public.hub_erasure_sets(t.agent_id, t.conversation_id, null);
  update public.erasure_control set generation = generation + 1, updated_at = now() returning generation into gen;

  -- THE IDENTITIES ARE RESERVED FIRST, and for good: nothing that reaches them again is let in, whatever else happens.
  perform public.hub_identity_reserve('topic', t.id, 'deleted', jsonb_build_object('deletion', d.id));
  perform public.hub_identity_reserve('agent', t.agent_id, 'deleted', jsonb_build_object('deletion', d.id));
  foreach one in array s.conversations loop
    perform public.hub_identity_reserve('conversation', one, 'deleted', jsonb_build_object('deletion', d.id));
  end loop;
  insert into public.topic_tombstone (topic_id, person, agent_id, conversation_id, origin, door, chat, machine, runner,
                                      worker_conversations, deletion_id, deletion_generation)
  values (t.id, t.person, t.agent_id, t.conversation_id, t.origin, t.door, t.chat, t.machine, t.runner,
          to_jsonb(array(select x from unnest(s.conversations) x where x <> t.conversation_id)), d.id, gen);

  -- THE RECEIPTS, written before anything that names a location is erased.
  insert into public.erasure_receipt (deletion_id, class, location, machine)
  values (d.id, 'postgres_active', 'store', ''), (d.id, 'registry_binding', 'agents/' || t.agent_id, '');
  if t.chat is not null then
    insert into public.erasure_receipt (deletion_id, class, location, machine, detail)
    values (d.id, 'platform_chat', t.chat, '', jsonb_build_object('door', t.door));
  end if;
  insert into public.erasure_receipt (deletion_id, class, location, machine, detail)
  select d.id, 'platform_message', e.chat || '/' || e.platform_id, '', jsonb_build_object('door', e.door, 'chat', e.chat, 'message', e.platform_id)
    from public.hub_erasure_linked_effects(t.id, s.councils) e
   where e.platform_id is not null and not (e.door = t.door and coalesce(e.chat = t.chat, false))
  on conflict do nothing;
  for one in select jsonb_array_elements_text(d.preview -> 'machines') loop
    insert into public.erasure_receipt (deletion_id, class, location, machine)
    values (d.id, 'chatlog', t.agent_id, one), (d.id, 'engine_state', t.agent_id, one)
    on conflict do nothing;
    for rec in select c2.agent, c2.id from public.conversation c2
                where c2.id = any (s.conversations) and c2.id <> t.conversation_id loop
      insert into public.erasure_receipt (deletion_id, class, location, machine)
      values (d.id, 'engine_state', rec.agent || '/' || rec.id, one) on conflict do nothing;
    end loop;
    for rec in select i.id from public.inbound i
                where i.id = any (s.inbound) and (i.media_state is not null or exists (select 1 from public.media m where m.inbound_id = i.id)) loop
      hashed := encode(sha256(convert_to(rec.id, 'UTF8')), 'hex');
      insert into public.erasure_receipt (deletion_id, class, location, machine)
      values (d.id, 'inbox_media', hashed, one) on conflict do nothing;
    end loop;
  end loop;
  insert into public.erasure_receipt (deletion_id, class, location, machine, detail)
  select d.id, 'move_copy', mc.staging_id, mc.machine, jsonb_build_object('kind', mc.kind, 'state', mc.state, 'conversation', mc.conversation_id)
    from public.move_copy mc where mc.move_id = any (s.moves) and mc.state not in ('removed', 'superseded')
  on conflict do nothing;

  -- THE GATES, in ascending agent order and before the stops that go with them: nothing new of this topic's is claimed.
  for rec in
    select x.kind, x.scope from (
      select 'agent'::text as kind, t.agent_id as scope, t.agent_id as agent
      union all select 'conversation', c3.id, c3.agent from public.conversation c3
                 where c3.id = any (s.conversations) and c3.id <> t.conversation_id
      union all select 'row', i2.id, i2.agent from public.inbound i2 where i2.id = any (s.inbound) and i2.kind = 'job') x
     order by x.agent, x.kind, x.scope
  loop
    perform public.hub_gate_place('delete:' || d.id, rec.kind, rec.scope, 'delete', jsonb_build_object('topic', t.id));
  end loop;
  perform public.hub_stop_request('stop:' || d.id || ':agent', 'delete:' || d.id, 'agent', t.agent_id, d.requested_by,
                                  jsonb_build_object('topic', t.id, 'cause', 'delete'));
  for rec in select c4.id from public.conversation c4 where c4.id = any (s.conversations) and c4.id <> t.conversation_id order by c4.id loop
    perform public.hub_stop_request('stop:' || d.id || ':' || rec.id, 'delete:' || d.id, 'conversation', rec.id, d.requested_by,
                                    jsonb_build_object('topic', t.id, 'cause', 'delete'));
  end loop;

  update public.topic
     set lifecycle = 'deleting', lifecycle_generation = lifecycle_generation + 1, delete_operation = d.id, updated_at = now()
   where id = t.id;
  update public.topic_deletion
     set stage = 'quiescing', confirmation_id = c.id, confirmed_by = c.approved_by, confirmed_at = now(),
         deletion_generation = gen, updated_at = now()
   where id = d.id;
  return 'confirmed';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The erasure. One transaction, in dependency order, for one tombstone, and idempotent.
-- ---------------------------------------------------------------------------------------------------------------------

-- THE ONLY PLACE ACTIVE CONTENT IS REMOVED. It is internal (granted to nobody; the two routines below call it as their owner) and
-- it needs a tombstone, so nothing is erased without one. It selects by the tombstone's identifiers, removes what they own from
-- the children up, counts what it removed (numbers only), and refuses to finish while a diary row, a sheet row or an input of the
-- scope is still there: a failure here rolls the whole erasure back.
create function hub_erase_scope(topic_in text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  k public.topic_tombstone%rowtype;
  s public.erasure_sets;
  n integer;
  counts jsonb := '{}'::jsonb;
  stops jsonb;
  left_over bigint;
begin
  select * into k from public.topic_tombstone where topic_id = topic_in;
  if not found then
    raise exception 'erase-unknown: topic % has no tombstone, and nothing is erased without one', topic_in;
  end if;
  perform set_config('hub.erasing', k.deletion_id, true);
  s := public.hub_erasure_sets(k.agent_id, k.conversation_id, k.worker_conversations);

  select coalesce(jsonb_agg(jsonb_build_object('target', r.target_kind || ':' || r.target_id, 'state', r.state, 'outcome', r.outcome) order by r.id), '[]'::jsonb)
    into stops from public.stop_request r where r.operation_id = 'delete:' || k.deletion_id;
  update public.topic_deletion set quiesce = jsonb_build_object('stops', stops), updated_at = now() where id = k.deletion_id;

  delete from public.source_consumption where conversation_id = any (s.conversations) or source_id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('source_consumption', n);
  delete from public.tool_invocation where conversation_id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('tool_invocation', n);
  delete from public.stop_request
   where execution_id = any (s.executions) or conversation_id = any (s.conversations) or agent = k.agent_id
      or (target_kind = 'agent' and target_id = k.agent_id)
      or (target_kind = 'conversation' and target_id = any (s.conversations));
  get diagnostics n = row_count; counts := counts || jsonb_build_object('stop_request', n);
  delete from public.replay_hold
   where inbound_id = any (s.inbound) or conversation_id = any (s.conversations) or execution_id = any (s.executions);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('replay_hold', n);
  delete from public.execution where id = any (s.executions);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('executions', n);
  delete from public.conversation_entry where conversation_id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('conversation_entries', n);

  delete from public.council_event where council_id = any (s.councils);
  delete from public.round_member where council_id = any (s.councils);
  delete from public.council_round where council_id = any (s.councils);
  delete from public.council_decision where council_id = any (s.councils);
  delete from public.council_participant where council_id = any (s.councils);
  delete from public.council where id = any (s.councils);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('councils', n);

  delete from public.move_blob where move_id = any (s.moves);
  delete from public.move_copy where move_id = any (s.moves);
  delete from public.topic_move where id = any (s.moves);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('moves', n);

  delete from public.media where inbound_id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('media', n);
  delete from public.outbox where inbound_id = any (s.inbound) or agent = k.agent_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('outbox', n);
  delete from public.ledger_event
   where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
      or subject = any (s.conversations) or subject = k.agent_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('ledger_events', n);
  delete from public.inbound where id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('inbound', n);
  delete from public.conversation where id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('conversations', n);

  delete from public.platform_effect e
   where (k.chat is not null and e.door = k.door and e.chat = k.chat)
      or e.key in (select l.key from public.hub_erasure_linked_effects(k.topic_id, s.councils) l);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('platform_effects', n);
  delete from public.confirmation cf where cf.operation_kind = 'topic.create' and cf.payload ->> 'topic_id' = k.topic_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('confirmations', n);
  delete from public.state_row r
   where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('state_rows', n);

  delete from public.topic_transition where topic_id = k.topic_id;
  delete from public.topic_channel_seen where topic_id = k.topic_id;
  delete from public.topic where id = k.topic_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('topic', n);

  select (select count(*) from public.ledger_event
           where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
              or subject = any (s.conversations) or subject = k.agent_id)
       + (select count(*) from public.state_row r
           where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound))
       + (select count(*) from public.inbound where id = any (s.inbound))
    into left_over;
  if left_over > 0 then
    raise exception 'erase-incomplete: % rows of topic % are still there', left_over, topic_in;
  end if;
  perform set_config('hub.erasing', '', true);
  return counts;
end $$;

-- ERASE THE ACTIVE ROWS of a confirmed deletion, once its stops are shown. `stop-pending` is not an error: the agent or one of its
-- delegated conversations still owns an attempt that nobody has shown gone, and nothing is erased while it does. The agent's
-- own lock and the maintenance lock a backup also takes are held, so a backup is never assembled across the removal.
create function hub_deletion_erase_active(op_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  d public.topic_deletion%rowtype;
  k public.topic_tombstone%rowtype;
  s public.erasure_sets;
  who text;
  owned integer;
  counts jsonb;
begin
  select x.agent_id into who from public.topic_deletion x where x.id = op_in;
  if not found then
    return 'unknown-deletion';
  end if;
  perform public.hub_gate_order(who);
  perform pg_advisory_xact_lock(682151, 1);
  select * into d from public.topic_deletion where id = op_in for update;
  if d.stage in ('verifying_active', 'active_deleted', 'pending_machine', 'blocked_scope') then
    return 'replay';
  end if;
  if d.stage in ('awaiting_confirmation', 'superseded') then
    return 'not-confirmed';
  end if;
  select * into k from public.topic_tombstone where deletion_id = op_in;
  s := public.hub_erasure_sets(k.agent_id, k.conversation_id, k.worker_conversations);
  select count(*) into owned from public.execution e
   where e.state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
     and (e.agent = k.agent_id or e.conversation_id = any (s.conversations));
  if owned > 0 then
    update public.topic_deletion set stage = 'quiescing', failure = null, updated_at = now() where id = d.id and stage <> 'quiescing';
    return 'stop-pending';
  end if;
  update public.topic_deletion set stage = 'deleting_active', updated_at = now() where id = d.id;
  counts := public.hub_erase_scope(k.topic_id);
  update public.topic_deletion set stage = 'verifying_active', erased = counts, failure = null, updated_at = now() where id = d.id;
  update public.erasure_receipt
     set state = 'erased', reported_by = 'store', detail = jsonb_build_object('removed', counts), updated_at = now()
   where deletion_id = d.id and class = 'postgres_active' and state = 'pending';
  return 'erased';
end $$;

-- The rows of the scope that are there NOW: what a late result, a late input or a restore can bring back.
create function hub_erasure_remaining(topic_in text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  k public.topic_tombstone%rowtype;
  s public.erasure_sets;
begin
  select * into k from public.topic_tombstone where topic_id = topic_in;
  if not found then
    return 0;
  end if;
  s := public.hub_erasure_sets(k.agent_id, k.conversation_id, k.worker_conversations);
  return (select count(*) from public.topic where id = k.topic_id)
       + (select count(*) from public.conversation where id = any (s.conversations))
       + (select count(*) from public.inbound where id = any (s.inbound))
       + (select count(*) from public.execution where id = any (s.executions))
       + (select count(*) from public.council where id = any (s.councils))
       + (select count(*) from public.topic_move where id = any (s.moves))
       + (select count(*) from public.ledger_event
           where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
              or subject = any (s.conversations) or subject = k.agent_id)
       + (select count(*) from public.state_row r
           where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Receipts, the verdict, the one notice, retention.
-- ---------------------------------------------------------------------------------------------------------------------

-- A LOCATION'S OWN ACCOUNT. `erased` and `not_applicable` are final; `unsupported` and `blocked` can still be superseded by a later
-- report that really erased it. A receipt for a deletion nobody approved is refused.
create function hub_deletion_receipt(op_in text, class_in text, location_in text, machine_in text, state_in text, detail_in jsonb, by_in text)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  r public.erasure_receipt%rowtype;
  stage_now text;
begin
  select x.stage into stage_now from public.topic_deletion x where x.id = op_in;
  if not found then
    return 'unknown-deletion';
  end if;
  if stage_now in ('awaiting_confirmation', 'superseded') then
    return 'not-confirmed';
  end if;
  select * into r from public.erasure_receipt
   where deletion_id = op_in and class = class_in and location = location_in and machine = machine_in for update;
  if not found then
    return 'unknown-receipt';
  end if;
  if r.historical then
    return 'historical';
  end if;
  if state_in not in ('pending', 'pending_machine', 'erased', 'unsupported', 'blocked', 'not_applicable') then
    raise exception 'receipt-invalid: % is not a state a report can give', state_in;
  end if;
  if r.state in ('erased', 'not_applicable') then
    return case when r.state = state_in then 'replay' else 'final' end;
  end if;
  update public.erasure_receipt
     set state = state_in, detail = coalesce(detail_in, '{}'::jsonb), reported_by = by_in, updated_at = now()
   where deletion_id = op_in and class = class_in and location = location_in and machine = machine_in;
  return 'recorded';
end $$;

-- THE VERDICT ON THE ACTIVE COPIES, from the receipts and from what is still in the store. `rows-remain` sends the deletion back
-- to `failed` (the removal runs again); `pending-machine` means a machine has not reported; `blocked-scope` means a copy cannot be
-- erased by this Hub; `active_deleted` is only ever said when no inventoried active copy is left unreported, and says nothing
-- about historical copies.
create function hub_deletion_verify(op_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  d public.topic_deletion%rowtype;
  who text;
  waiting jsonb;
  refused jsonb;
  remaining bigint;
begin
  select x.agent_id into who from public.topic_deletion x where x.id = op_in;
  if not found then
    return 'unknown-deletion';
  end if;
  perform public.hub_gate_order(who);
  perform pg_advisory_xact_lock(682151, 1);
  select * into d from public.topic_deletion where id = op_in for update;
  if d.stage = 'active_deleted' then
    return 'replay';
  end if;
  if d.stage not in ('verifying_active', 'pending_machine', 'blocked_scope', 'failed') then
    return 'not-erased';
  end if;
  select public.hub_erasure_remaining(d.topic_id) into remaining;
  if remaining > 0 then
    update public.topic_deletion
       set stage = 'failed', failure = jsonb_build_object('code', 'rows_remain', 'remaining', remaining, 'at', now()), updated_at = now()
     where id = d.id;
    return 'rows-remain';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('class', r.class, 'location', r.location, 'machine', r.machine, 'state', r.state)
                            order by r.class, r.machine, r.location) filter (where r.state in ('pending', 'pending_machine')), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('class', r.class, 'location', r.location, 'machine', r.machine, 'state', r.state,
                                               'detail', r.detail) order by r.class, r.machine, r.location)
                  filter (where r.state in ('unsupported', 'blocked')), '[]'::jsonb)
    into waiting, refused
    from public.erasure_receipt r where r.deletion_id = d.id and not r.historical;
  -- A verdict is written only when it changed: writing a stage again wakes the door, and a verdict that says the same must not.
  if jsonb_array_length(waiting) > 0 then
    if d.stage is distinct from 'pending_machine' or d.blocked is distinct from jsonb_build_object('waiting', waiting, 'refused', refused) then
      update public.topic_deletion set stage = 'pending_machine', failure = null,
             blocked = jsonb_build_object('waiting', waiting, 'refused', refused), updated_at = now() where id = d.id;
    end if;
    return 'pending-machine';
  end if;
  if jsonb_array_length(refused) > 0 then
    if d.stage is distinct from 'blocked_scope' or d.blocked is distinct from jsonb_build_object('waiting', waiting, 'refused', refused) then
      update public.topic_deletion set stage = 'blocked_scope', failure = null,
             blocked = jsonb_build_object('waiting', waiting, 'refused', refused), updated_at = now() where id = d.id;
    end if;
    return 'blocked-scope';
  end if;
  update public.topic_deletion set stage = 'active_deleted', failure = null, blocked = null, active_deleted_at = now(), updated_at = now() where id = d.id;
  update public.topic_tombstone set active_deleted_at = now() where deletion_id = d.id and active_deleted_at is null;
  return 'active_deleted';
end $$;

-- A NOTICE, QUEUED ONCE UNDER ITS KEY. Where it goes (General, normally) is the caller's: it is never the chat that was deleted.
create function hub_deletion_notice(op_in text, key_in text, notice jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if not exists (select 1 from public.topic_deletion where id = op_in) or notice is null then
    return false;
  end if;
  insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
  values ('notice', null, 1, notice ->> 'body', notice ->> 'person', notice ->> 'agent', key_in, notice -> 'route')
  on conflict (notice_key) do nothing;
  return found;
end $$;

-- THE ACCOUNT OF THE HISTORICAL COPIES, kept by whoever can see the backup destinations. `until_in` is the latest expiry of a copy
-- that predates the deletion; `generations_in` is `[{id, state, expires_at}]`, one receipt each, states `pending`,
-- `retention_unverified`, `retention_blocked` or `expired`. `historical_copies_expired` is refused (`unverified`) unless at least one
-- generation was inventoried and every one of them is `expired`: the store never accepts the word on its own.
create function hub_deletion_retention(op_in text, state_in text, until_in timestamptz, detail_in jsonb, generations_in jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  d public.topic_deletion%rowtype;
  g jsonb;
begin
  select * into d from public.topic_deletion where id = op_in for update;
  if not found then
    return 'unknown-deletion';
  end if;
  if d.confirmation_id is null then
    return 'not-confirmed';
  end if;
  if state_in not in ('not_configured', 'tracking', 'retention_unverified', 'retention_blocked', 'historical_copies_expired') then
    raise exception 'retention-invalid: % is not a retention state', state_in;
  end if;
  if generations_in is not null then
    if jsonb_typeof(generations_in) <> 'array' then
      raise exception 'retention-invalid: the generations are a list';
    end if;
    for g in select e from jsonb_array_elements(generations_in) e loop
      if coalesce(g ->> 'id', '') = '' or g ->> 'state' not in ('pending', 'retention_unverified', 'retention_blocked', 'expired') then
        raise exception 'retention-invalid: a generation needs an id and a state';
      end if;
      insert into public.erasure_receipt (deletion_id, class, location, machine, historical, state, detail, reported_by)
      values (d.id, 'backup_generation', g ->> 'id', '', true, g ->> 'state',
              jsonb_build_object('expires_at', g -> 'expires_at'), 'retention')
      on conflict (deletion_id, class, location, machine) do update
         set state = excluded.state, detail = excluded.detail, reported_by = excluded.reported_by, updated_at = now()
       where public.erasure_receipt.state <> 'expired';
    end loop;
  end if;
  if state_in = 'historical_copies_expired'
     and (not exists (select 1 from public.erasure_receipt where deletion_id = d.id and historical)
          or exists (select 1 from public.erasure_receipt where deletion_id = d.id and historical and state <> 'expired')) then
    return 'unverified';
  end if;
  update public.topic_deletion
     set retention_state = state_in, backup_retention_until = coalesce(until_in, backup_retention_until),
         retention_detail = coalesce(detail_in, retention_detail),
         historical_copies_expired_at = case when state_in = 'historical_copies_expired' then now() else historical_copies_expired_at end,
         updated_at = now()
   where id = d.id;
  return 'recorded';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The restore barrier.
-- ---------------------------------------------------------------------------------------------------------------------

-- THE CONTENT-FREE CONTROL MANIFEST: the erasure generation and, for every tombstone, identifiers only. It is what a backup carries
-- and what a returning machine or a restore merges BEFORE it serves anything. There is no name, no request and no word of history
-- in it, by construction: it is built from the tombstone's identifier columns and nothing else.
create function hub_erasure_manifest() returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'version', 1,
    'generation', (select e.generation from public.erasure_control e),
    'tombstones', coalesce((select jsonb_agg(jsonb_build_object(
        'topic_id', k.topic_id, 'person', k.person, 'agent_id', k.agent_id, 'conversation_id', k.conversation_id,
        'origin', k.origin, 'door', k.door, 'chat', k.chat, 'machine', k.machine, 'runner', k.runner,
        'workers', k.worker_conversations, 'deletion_id', k.deletion_id, 'deletion_generation', k.deletion_generation,
        'active_deleted', k.active_deleted_at is not null) order by k.deletion_generation, k.topic_id)
      from public.topic_tombstone k), '[]'::jsonb))
$$;

-- MERGE A MANIFEST INTO THIS STORE, as a restore or a returning machine does before enabling doors, runners or sync. For every
-- tombstone it reserves the identities, records the tombstone if the restored store has never heard of it, and erases whatever of
-- that topic the restored store holds. It is idempotent, it moves the generation forward and never back, and it refuses a manifest
-- it cannot read whole (`manifest-malformed`) rather than apply half of one. Returns what it did, as numbers.
create function hub_erasure_apply(manifest_in jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  one jsonb;
  w text;
  tombstones integer := 0;
  purged integer := 0;
  left_over bigint;
  top_gen integer;
begin
  if manifest_in is null or coalesce(jsonb_typeof(manifest_in), '') <> 'object' or manifest_in ->> 'version' is distinct from '1'
     or coalesce(jsonb_typeof(manifest_in -> 'tombstones'), '') <> 'array' or coalesce(jsonb_typeof(manifest_in -> 'generation'), '') <> 'number' then
    raise exception 'manifest-malformed: it needs version 1, a generation and a list of tombstones';
  end if;
  perform pg_advisory_xact_lock(682151, 1);
  for one in select e from jsonb_array_elements(manifest_in -> 'tombstones') e loop
    if coalesce(one ->> 'topic_id', '') = '' or coalesce(one ->> 'agent_id', '') = '' or coalesce(one ->> 'conversation_id', '') = ''
       or coalesce(one ->> 'deletion_id', '') = '' or coalesce(jsonb_typeof(one -> 'workers'), '') <> 'array'
       or coalesce(one ->> 'deletion_generation', '') !~ '^[0-9]+$' or coalesce(one ->> 'origin', '') not in ('created', 'legacy') then
      raise exception 'manifest-malformed: a tombstone is missing what it is identified by';
    end if;
    perform public.hub_identity_reserve('topic', one ->> 'topic_id', 'deleted', jsonb_build_object('deletion', one ->> 'deletion_id', 'by', 'manifest'));
    perform public.hub_identity_reserve('agent', one ->> 'agent_id', 'deleted', jsonb_build_object('deletion', one ->> 'deletion_id', 'by', 'manifest'));
    perform public.hub_identity_reserve('conversation', one ->> 'conversation_id', 'deleted', jsonb_build_object('deletion', one ->> 'deletion_id', 'by', 'manifest'));
    for w in select jsonb_array_elements_text(one -> 'workers') loop
      perform public.hub_identity_reserve('conversation', w, 'deleted', jsonb_build_object('deletion', one ->> 'deletion_id', 'by', 'manifest'));
    end loop;
    insert into public.topic_tombstone (topic_id, person, agent_id, conversation_id, origin, door, chat, machine, runner,
                                        worker_conversations, deletion_id, deletion_generation, active_deleted_at)
    values (one ->> 'topic_id', coalesce(one ->> 'person', ''), one ->> 'agent_id', one ->> 'conversation_id', one ->> 'origin',
            coalesce(one ->> 'door', ''), one ->> 'chat', coalesce(one ->> 'machine', ''), coalesce(one ->> 'runner', ''),
            one -> 'workers', one ->> 'deletion_id', (one ->> 'deletion_generation')::integer,
            case when one ->> 'active_deleted' = 'true' then now() end)
    on conflict do nothing;
    tombstones := tombstones + 1;
    perform public.hub_erase_scope(one ->> 'topic_id');
    select public.hub_erasure_remaining(one ->> 'topic_id') into left_over;
    purged := purged + 1;
    if left_over > 0 then
      raise exception 'erase-incomplete: % rows of topic % came back with the restore and could not be removed', left_over, one ->> 'topic_id';
    end if;
  end loop;
  top_gen := (manifest_in ->> 'generation')::integer;
  update public.erasure_control set generation = greatest(generation, top_gen), updated_at = now();
  return jsonb_build_object('tombstones', tombstones, 'applied', purged, 'generation', (select e.generation from public.erasure_control e));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Who may call what. The two routines that remove content are the door's and the hub's, never the model's login.
-- ---------------------------------------------------------------------------------------------------------------------

revoke all on function hub_erasure_sets(text, text, jsonb) from public;
revoke all on function hub_erasure_owns_row(text, text, jsonb, text, text, text, text, text[]) from public;
revoke all on function hub_erasure_linked_effects(text, text[]) from public;
revoke all on function hub_deletion_inventory(text, text, jsonb, text, text, text, text) from public;
revoke all on function hub_deletion_request(text, text, text, text, jsonb, integer, jsonb, jsonb) from public;
revoke all on function hub_deletion_confirm(text) from public;
revoke all on function hub_erase_scope(text) from public;
revoke all on function hub_deletion_erase_active(text) from public;
revoke all on function hub_erasure_remaining(text) from public;
revoke all on function hub_deletion_receipt(text, text, text, text, text, jsonb, text) from public;
revoke all on function hub_deletion_verify(text) from public;
revoke all on function hub_deletion_notice(text, text, jsonb) from public;
revoke all on function hub_deletion_retention(text, text, timestamptz, jsonb, jsonb) from public;
revoke all on function hub_erasure_manifest() from public;
revoke all on function hub_erasure_apply(jsonb) from public;
grant execute on function hub_deletion_request(text, text, text, text, jsonb, integer, jsonb, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_deletion_confirm(text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_erasure_manifest() to hub_door, hub_runner, hub_hub;
grant execute on function hub_deletion_erase_active(text) to hub_door, hub_hub;
grant execute on function hub_erasure_remaining(text) to hub_door, hub_hub;
grant execute on function hub_deletion_receipt(text, text, text, text, text, jsonb, text) to hub_door, hub_hub;
grant execute on function hub_deletion_verify(text) to hub_door, hub_hub;
grant execute on function hub_deletion_notice(text, text, jsonb) to hub_door, hub_hub;
grant execute on function hub_deletion_retention(text, text, timestamptz, jsonb, jsonb) to hub_door, hub_hub;
grant execute on function hub_erasure_apply(jsonb) to hub_door, hub_hub;
grant select on erasure_control, topic_tombstone, topic_deletion, erasure_receipt to hub_door, hub_runner, hub_hub;
