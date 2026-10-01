-- Topic movement, store half (IMP-231): runner protocol 4, the durable move, its copies and blobs, and the relocation note.
--
-- THIS STEP IS THE STATE MACHINE AND ITS FENCES, NOT THE MOVEMENT. It moves no file, runs no process, edits no registry and
-- decides nothing about what a native session is. The runner, the hub and the transfer library come after it and call the
-- routines below. What the store does is hold what was asked, what was frozen, what each side ASSERTED it did, and refuse
-- every write that does not match what the store itself can check. The routines say, in their comments, which is which:
--   * a FACT the store validates itself (stages, incarnations, placement generations, entry and attempt counts, hold
--     revisions, blob bytes and their sha256, manifest equals blobs, digests compared for EQUALITY);
--   * an ASSERTION only the runtime can make (the process is gone, the files were written, the registry was edited, the
--     adapter may carry this native session). The store records the assertion, binds it to identities it can check, and
--     refuses an assertion that is incomplete or names another identity. It never manufactures proof of the operating system.
--
-- Additive, except the two objects a protocol change has to touch (`hub_protocol`'s check and the claim guard).

-- PROTOCOL 4. `hub_protocol` accepts 4; the claim guard keeps its COUNCIL-specific refusal at `said < 3` and moves its GLOBAL
-- comparison to `said < 4`, so a runner that registered at protocol 3 BEFORE the activation of 4 and is still running is refused
-- a new claim from the activation on, on whichever connection it comes (its attempts already open finish under their own
-- fences: activation stops nothing). The claim and the activation stay ordered by the same `for share` row lock as before.
-- The registration guard compares integers and needs no change: a protocol 3 registration is refused once 4 is active.
do $$
declare
  one record;
begin
  for one in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.hub_protocol'::regclass and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%runner_protocol%'
  loop
    execute format('alter table public.hub_protocol drop constraint %I', one.conname);
  end loop;
end $$;
alter table hub_protocol add constraint hub_protocol_runner_protocol_check check (runner_protocol in (1, 2, 3, 4));

create or replace function hub_guard_inbound_claim() returns trigger
language plpgsql as $$
declare
  active integer;
  said integer;
  unavailable boolean;
begin
  if new.claimed_by is not null
     and (new.claimed_by is distinct from old.claimed_by
          or new.claim_deadline is distinct from old.claim_deadline)
  then
    if current_user = 'hub_runner' then
      said := case coalesce(current_setting('hub.runner_protocol', true), '')
                when '4' then 4 when '3' then 3 when '2' then 2 else 1 end;
      if said < 3 and (new.source -> 'dispatch' -> 'council_round' is not null
                       or new.source -> 'council_event' is not null) then
        raise exception
          'inbound % belongs to a council and is claimed by a runner that does not speak protocol 3: it is not claimable', new.id;
      end if;
      if said < 4 then
        select p.runner_protocol into active from public.hub_protocol p for share;
        if active > said then
          raise exception
            'inbound % is claimed by a runner that does not speak protocol %: it is not claimable', new.id, active;
        end if;
      end if;
    end if;
    unavailable := hub_row_held(new.id)
      or (case when new.kind = 'harvest' then hub_harvest_blocked(new.agent, new.claimed_by)
               else hub_agent_blocked(new.agent) end);
    if unavailable then
      raise exception
        'inbound % is held, or its agent has an unresolved execution: it is not claimable', new.id;
    end if;
  end if;
  return new;
end $$;

-- ONE MOVE OF ONE TOPIC'S MASTER. `stage`:
--   waiting           requested; the agent gate is ALREADY placed (same transaction as the request). The destination prepares and
--                     the source finishes the turn it had fed, closes its resident child and proves it gone
--   awaiting_owner    a NEW drain failure (an attempt that ended interrupted or unresolved since the request) needs the owner
--   source_released   the source's export is sealed: blobs equal the manifest, the snapshot is frozen
--   importing         the destination owns an import generation (persisted BEFORE any file is written)
--   activated         placement moved (conversation and topic now name the destination, generation + 1). Too late to withdraw
--   registry_written  the hub recorded the registry receipt (digest and semantic binding)
--   active            the destination served and every check held: the gate is released. Terminal
--   withdrawn         the owner withdrew before activation: only this move's gate was released. Terminal
-- `block` is a NOTE on the current stage ({code, detail, since, by}). It never touches the gate, and nothing releases the gate
-- but `active` and `withdrawn`: no block and no failure puts the topic back on the source.
-- What is frozen at the request and never changes: the master conversation, its native identity, the placement, the attempts
-- that were still owned (`drain_attempts`) and the holds that already existed (`preexisting_holds`, with their revisions).
create table topic_move (
  id                    text primary key check (id <> ''),
  operation_id          text not null unique check (operation_id <> ''),
  topic_id              text not null references topic (id),
  agent                 text not null,
  person                text not null,
  requested_by          text not null check (requested_by <> ''),
  route                 jsonb,
  evidence              jsonb not null default '{}'::jsonb,
  stage                 text not null default 'waiting' check (stage in (
                          'waiting', 'source_released', 'importing', 'activated', 'registry_written', 'active',
                          'awaiting_owner', 'withdrawn')),
  block                 jsonb check (block is null or (jsonb_typeof(block) = 'object' and block ->> 'code' ~ '^[a-z][a-z0-9_]{0,59}$'
                                                        and octet_length(block::text) <= 4096)),
  source_runner         text not null,
  source_machine        text not null,
  dest_runner           text not null,
  dest_machine          text not null,
  conversation_id       text not null references conversation (id),
  adapter               text not null,
  native_session        text not null,
  native_state          text not null,
  source_generation     integer not null check (source_generation >= 1),
  dest_generation       integer check (dest_generation is null or dest_generation >= 2),
  source_facts          jsonb not null default '{}'::jsonb,
  source_incarnation    jsonb not null default '{"known": false}'::jsonb,
  drain_attempts        jsonb not null default '[]'::jsonb,
  preexisting_holds     jsonb not null default '[]'::jsonb,
  acknowledged_failures jsonb not null default '[]'::jsonb,
  failure               jsonb,
  drain_intents         jsonb not null default '[]'::jsonb,
  drain_resolutions     jsonb not null default '[]'::jsonb,
  export_generation     integer not null default 0 check (export_generation >= 0),
  drain                 jsonb,
  snapshot              jsonb,
  manifest              jsonb,
  dest_facts            jsonb,
  dest_ready_at         timestamptz,
  import_generation     integer not null default 0 check (import_generation >= 0),
  verification          jsonb,
  registry_receipt      jsonb,
  note_state            text check (note_state in ('pending', 'delivered')),
  note_digest           text,
  note_attempt          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  source_released_at    timestamptz,
  activated_at          timestamptz,
  finished_at           timestamptz,
  constraint topic_move_released_has_manifest check (stage in ('waiting', 'awaiting_owner', 'withdrawn') or (manifest is not null and snapshot is not null)),
  constraint topic_move_placed_has_generation check (stage not in ('activated', 'registry_written', 'active') or dest_generation is not null),
  constraint topic_move_note_only_when_active check (note_state is null or stage = 'active'),
  constraint topic_move_bounded check (octet_length(coalesce(manifest::text, '')) <= 262144
    and octet_length(coalesce(dest_facts::text, '')) <= 16384 and octet_length(coalesce(verification::text, '')) <= 8192
    and octet_length(coalesce(registry_receipt::text, '')) <= 8192 and octet_length(drain_intents::text) <= 16384
    and octet_length(coalesce(drain::text, '')) <= 8192 and octet_length(preexisting_holds::text) <= 65536
    and octet_length(drain_attempts::text) <= 65536 and octet_length(acknowledged_failures::text) <= 65536
    and octet_length(source_incarnation::text) <= 2048 and octet_length(drain_resolutions::text) <= 32768)
);
-- ONE NON-TERMINAL MOVE PER TOPIC, by the table.
create unique index topic_move_one_open on topic_move (topic_id) where stage not in ('active', 'withdrawn');
create index topic_move_by_agent on topic_move (agent);
create index topic_move_by_conversation on topic_move (conversation_id) where stage in ('waiting', 'awaiting_owner');
create index topic_move_open_by_source on topic_move (source_runner) where stage not in ('active', 'withdrawn');
create index topic_move_open_by_dest on topic_move (dest_runner) where stage not in ('active', 'withdrawn');

-- THE BYTES A MOVE CARRIES, OPAQUE. The store never reads a blob: it keeps the bytes, recomputes their sha256, and compares the
-- set with the manifest the source sealed. `kind` and `rel_path` are the transfer library's words; `rel_path` is relative and
-- cannot climb. No absolute location is stored anywhere in a move: a path is derived by each machine from its own registry.
-- Limits (the store's, because postgres.js holds a bytea in memory): 16 MiB a file, 64 MiB a move.
-- `generation` is the EXPORT GENERATION the blob was written under (`topic_move.export_generation`): a new genuine drain starts a
-- new generation and removes the unsealed blobs of the previous one, and a write or a seal that names an older generation is refused.
create table move_blob (
  move_id  text not null references topic_move (id),
  kind     text not null check (kind ~ '^[a-z][a-z0-9_:.-]{0,63}$'),
  rel_path text not null check (rel_path <> '' and char_length(rel_path) <= 512 and rel_path !~ '^/' and rel_path !~ '(^|/)\.\.(/|$)' and rel_path !~ '\\'),
  sha256   text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mode     integer not null check (mode between 0 and 511),
  size     integer not null check (size between 0 and 16777216),
  bytes    bytea not null,
  generation integer not null check (generation >= 1),
  primary key (move_id, kind, rel_path),
  constraint move_blob_size_is_bytes check (octet_length(bytes) = size)
);

create function hub_guard_move_blob() returns trigger
language plpgsql as $$
begin
  if coalesce((select sum(b.size) from public.move_blob b where b.move_id = new.move_id), 0) + new.size > 67108864 then
    raise exception 'move-too-large: move % carries more than 64 MiB', new.move_id;
  end if;
  return new;
end $$;
create trigger move_blob_limits
  before insert on move_blob
  for each row execute function hub_guard_move_blob();

-- PHYSICAL COPIES AND THEIR OWNERSHIP. A row is written BEFORE the filesystem is touched, and it names who owns what is about
-- to be written: the move, the machine, the generation and a staging identity the STORE makes (`move-<id>-g<n>`, never a path).
--   dest_import                intent -> verified -> promote_intent -> promoted -> active        (the destination's files)
--                              any of them -> cleanup_due (withdrawn, or the import failed) -> removed (the owner reported it)
--   source_session_retained    retained -> source_owned (withdrawn: the source stays the owner) | retained_stale (moved)
--                              retained_stale -> cleanup_due (retired by a later move that needs the location) -> removed
--   any live claim             -> superseded when a later move's source release takes the same location over
-- THE LOCATION IS THE UNIT OF OWNERSHIP, NOT THE MOVE. The session directory a machine derives for a conversation is
-- `<state>/<person>/sessions/<agent>/<conversation id>`: it depends on the conversation, not on the move and not on the native
-- session (which can change between moves: a minted or re-verified native session names other files INSIDE the same directory), so
-- two moves of one conversation that land on one machine share it. A row is a LIVE CLAIM on its location (conversation, machine)
-- in every state but `removed` and `superseded`, and the table allows ONE live claim per location. `native_session` stays on the
-- row as evidence of what the copy held, never as part of where it is: a later move cannot begin an import on a location an earlier move's copy still claims
-- (`cleanup-pending` while that copy is owed its removal, `copy-occupied` for a stale retained source copy, which has to be retired
-- first), so an earlier cleanup can never meet a later owner's files, and a removal report names the copy's own staging identity.
-- A late completion for another generation, another incarnation or a finished move is refused by the stage and generation
-- checks. Only `cleanup_due` can be reported `removed`; an `active` or `promoted` copy has no path to deletion in this table.
-- What the rows are NOT: proof of what is on a disk. They record who claims a location and what its owner reported; the serialization
-- of a writer against a cleaner on the machine itself, and the truth of a report, stay the runtime's.
create table move_copy (
  move_id     text not null references topic_move (id),
  machine     text not null,
  kind        text not null check (kind in ('dest_import', 'source_session_retained')),
  generation  integer not null check (generation >= 1),
  state       text not null check (state in (
                'intent', 'verified', 'promote_intent', 'promoted', 'active', 'cleanup_due', 'removed',
                'retained', 'source_owned', 'retained_stale', 'superseded')),
  staging_id  text not null check (staging_id <> ''),
  runner      text not null,
  incarnation text not null,
  conversation_id    text not null references conversation (id),
  native_session     text not null,
  placement_generation integer not null check (placement_generation >= 1),
  digest      text,
  file_count  integer,
  bytes       bigint,
  evidence    jsonb not null default '{}'::jsonb check (octet_length(evidence::text) <= 8192),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (move_id, machine, kind, generation)
);
create index move_copy_cleanup on move_copy (move_id) where state = 'cleanup_due';
create unique index move_copy_one_live_claim on move_copy (conversation_id, machine)
  where state in ('intent', 'verified', 'promote_intent', 'promoted', 'active', 'cleanup_due', 'retained', 'source_owned', 'retained_stale');

-- What a move keeps for good, and the edges a stage may take. A finished move is frozen except the relocation note's own
-- bookkeeping, so a late write (a stale import, an old drain) cannot touch it even if a routine forgot to ask the stage.
create function hub_guard_topic_move() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.operation_id is distinct from old.operation_id or new.topic_id is distinct from old.topic_id
     or new.agent is distinct from old.agent or new.person is distinct from old.person or new.requested_by is distinct from old.requested_by
     or new.source_runner is distinct from old.source_runner or new.source_machine is distinct from old.source_machine
     or new.dest_runner is distinct from old.dest_runner or new.dest_machine is distinct from old.dest_machine
     or new.conversation_id is distinct from old.conversation_id or new.adapter is distinct from old.adapter
     or new.native_session is distinct from old.native_session or new.native_state is distinct from old.native_state
     or new.source_generation is distinct from old.source_generation or new.source_facts is distinct from old.source_facts
     or new.source_incarnation is distinct from old.source_incarnation
     or new.drain_attempts is distinct from old.drain_attempts or new.preexisting_holds is distinct from old.preexisting_holds
     or new.created_at is distinct from old.created_at then
    raise exception 'move % keeps what was frozen when it was requested', old.id;
  end if;
  if (old.manifest is not null and new.manifest is distinct from old.manifest)
     or (old.snapshot is not null and new.snapshot is distinct from old.snapshot)
     or (old.dest_generation is not null and new.dest_generation is distinct from old.dest_generation)
     or (old.note_digest is not null and new.note_digest is distinct from old.note_digest) then
    raise exception 'move % keeps its sealed manifest, snapshot, placement and note for good', old.id;
  end if;
  if old.stage in ('active', 'withdrawn')
     and (to_jsonb(new) - array['note_state', 'note_attempt', 'updated_at']) is distinct from (to_jsonb(old) - array['note_state', 'note_attempt', 'updated_at']) then
    raise exception 'move % is % and stays so', old.id, old.stage;
  end if;
  if old.note_state = 'delivered' and new.note_state is distinct from old.note_state then
    raise exception 'the relocation note of move % was delivered and stays so', old.id;
  end if;
  if new.stage is distinct from old.stage
     and not ((old.stage = 'waiting' and new.stage in ('source_released', 'awaiting_owner', 'withdrawn'))
           or (old.stage = 'awaiting_owner' and new.stage in ('waiting', 'withdrawn'))
           or (old.stage = 'source_released' and new.stage in ('importing', 'withdrawn'))
           or (old.stage = 'importing' and new.stage in ('source_released', 'activated', 'withdrawn'))
           or (old.stage = 'activated' and new.stage = 'registry_written')
           or (old.stage = 'registry_written' and new.stage = 'active')) then
    raise exception 'move % cannot go from % to %', old.id, old.stage, new.stage;
  end if;
  return new;
end $$;
create trigger topic_move_rules
  before update on topic_move
  for each row execute function hub_guard_topic_move();

-- The runners of a move, and the hub, hear about it at the commit (payload: the runner, or `hub`).
create function hub_notify_move() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_move', new.source_runner);
  perform pg_notify('hub_move', new.dest_runner);
  perform pg_notify('hub_move', 'hub');
  return null;
end $$;
create trigger topic_move_notify
  after insert or update of stage, block on topic_move
  for each row execute function hub_notify_move();

-- ---------------------------------------------------------------------------------------------------------------------
-- Helpers. None is granted: the routines below call them as their owner.
-- ---------------------------------------------------------------------------------------------------------------------

create function hub_move_bounded(doc jsonb, limit_bytes integer) returns boolean
language sql immutable as $$
  select doc is null or octet_length(doc::text) <= limit_bytes
$$;

create function hub_move_hex64(word text) returns boolean
language sql immutable as $$
  select word ~ '^[0-9a-f]{64}$'
$$;

-- THE CALLER IS THE CURRENT PROTOCOL-4 INCARNATION OF THIS RUNNER ON THIS MACHINE, and it stays so until the caller's transaction
-- ends: the row is read `for share`, so a newer registration (an update of it) waits. The store's global protocol is not enough:
-- a resident process that registered at 3 before the activation of 4 is not a process that knows moves.
create function hub_move_runner_current(runner_in text, inc_in text, machine_in text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform 1 from public.runner_incarnation r
   where r.runner = runner_in and r.incarnation = inc_in and r.protocol >= 4 and r.machine = machine_in
     for share;
  return found;
end $$;

-- THE ORDER EVERY MOVE ROUTINE TAKES ITS LOCKS IN: the agent's ordering lock (the lock a gate placement and the opening of an
-- attempt take), then the topic's, then the move's row. Whatever reads the gates after it sees what was committed before it.
create function hub_move_enter(move_in text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  who text;
  owner_topic text;
begin
  select tm.agent, tm.topic_id into who, owner_topic from public.topic_move tm where tm.id = move_in;
  if not found then
    return false;
  end if;
  perform public.hub_gate_order(who);
  perform pg_advisory_xact_lock(682150, hashtext(owner_topic));
  perform 1 from public.topic_move tm where tm.id = move_in for update;
  return true;
end $$;

create function hub_move_unresolved(agent_in text) returns integer
language sql stable as $$
  select count(*)::integer from public.execution e
   where e.agent = agent_in
     and e.state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
$$;

create function hub_move_topic_open(topic_in text) returns boolean
language sql stable as $$
  select exists (select 1 from public.topic t where t.id = topic_in and t.lifecycle = 'active')
     and not exists (select 1 from public.topic_transition x where x.topic_id = topic_in and x.state = 'open')
$$;

-- A NOTE THE STORE ITSELF WRITES ON A MOVE, for a condition it validated (the topic is not active, the source's predecessor is
-- unknown). It is written only where there is NO block: another party's reason is never replaced by the store's. It is cleared by
-- `hub_move_unblock`, or by the next forward step (`hub_move_gate_progress`) once its own condition is gone. It never touches the gate.
create function hub_move_annotate(move_in text, code_in text, detail_in jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.topic_move
     set block = jsonb_build_object('code', code_in, 'detail', coalesce(detail_in, '{}'::jsonb), 'since', now(), 'by', 'store'), updated_at = now()
   where id = move_in and stage not in ('active', 'withdrawn') and block is null;
end $$;

-- THE BOOT THE RUNNER REGISTERED FOR ONE INCARNATION (null when it could not read one). It is the only anchor for a boot the store
-- accepts from a caller: evidence about a boot has to equal what the registration machinery holds for the incarnation that speaks.
create function hub_move_runner_boot(runner_in text, inc_in text) returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select r.boot_id from public.runner_incarnation r where r.runner = runner_in and r.incarnation = inc_in
$$;

-- WHAT THE STORE KNEW OF THE SOURCE AT THE REQUEST, frozen with the move: the incarnation then registered for the source runner on
-- the source machine, the boot it registered with and its protocol. When there is none (the runner never registered, or its
-- registration names another machine) it says `known: false` and why; nothing is invented and nothing later is substituted for it.
-- The row is read `for share`, so a registration that races the request is ordered against it.
create function hub_move_source_baseline(runner_in text, machine_in text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  r public.runner_incarnation%rowtype;
begin
  select * into r from public.runner_incarnation where runner = runner_in for share;
  if not found then
    return jsonb_build_object('known', false, 'reason', 'unregistered');
  end if;
  if r.machine is distinct from machine_in then
    return jsonb_build_object('known', false, 'reason', 'registered-elsewhere', 'registered_machine', r.machine);
  end if;
  return jsonb_build_object('known', true, 'incarnation', r.incarnation, 'boot_id', r.boot_id, 'machine', r.machine,
                            'protocol', r.protocol, 'registered_at', r.started_at);
end $$;

-- THE ONE DECISION EVERY STEP THAT ADVANCES THE HANDOFF ASKS FIRST, on the move as it is now (the caller holds its row lock):
-- null when the step may go on, otherwise the word to answer. Any block stops it, whoever set it, and the gate is never touched by
-- asking. The store's own `topic_not_active` is re-read here: once the topic is active again with no open transition it clears
-- itself (and only that code, and only when `by` is the store, so a source, hub or destination block that happens to use the same
-- name is never cleared by this), and while the topic is not active a step is refused and the note is written if nobody's is there.
-- Repairs are not steps: a block does not stop a reconciliation, a cleanup, a failure report, the owner's unblock or a withdrawal.
create function hub_move_gate_progress(move_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
begin
  select * into m from public.topic_move where id = move_in;
  if m.block is not null and m.block ->> 'by' = 'store' and m.block ->> 'code' = 'topic_not_active' and public.hub_move_topic_open(m.topic_id) then
    update public.topic_move set block = null, updated_at = now() where id = m.id;
    m.block := null;
  end if;
  if m.block is not null then
    return case when m.block ->> 'by' = 'store' and m.block ->> 'code' = 'topic_not_active' then 'topic-not-active' else 'blocked' end;
  end if;
  if not public.hub_move_topic_open(m.topic_id) then
    perform public.hub_move_annotate(m.id, 'topic_not_active', '{}'::jsonb);
    return 'topic-not-active';
  end if;
  return null;
end $$;

-- EVERYTHING THAT MUST BE SHOWN GONE BEFORE THE EXPORT, from what the store holds: one item for each drain intent ever recorded,
-- for the incarnation that was the source's at the request when it recorded none (an unknown one is an item nothing can resolve),
-- and for the incarnation speaking now when it recorded none. An item carries the boot it belongs to when that is known. The
-- attempts of the agent are not items: the execution machinery resolves them, and `hub_move_unresolved` says so.
create function hub_move_drain_items(m public.topic_move, inc_in text, boot_in text) returns jsonb
language plpgsql stable as $$
declare
  items jsonb := '[]'::jsonb;
  owners text[] := '{}';
  intent jsonb;
begin
  for intent in select e.v from jsonb_array_elements(m.drain_intents) as e(v) loop
    items := items || jsonb_build_array(jsonb_build_object('kind', 'intent', 'id', intent ->> 'id',
                                                           'incarnation', intent ->> 'incarnation', 'boot_id', intent ->> 'boot_id'));
    owners := owners || (intent ->> 'incarnation');
  end loop;
  if m.source_incarnation ->> 'known' = 'true' then
    if not ((m.source_incarnation ->> 'incarnation') = any (owners)) then
      items := items || jsonb_build_array(jsonb_build_object('kind', 'owner', 'id', m.source_incarnation ->> 'incarnation',
                                                             'incarnation', m.source_incarnation ->> 'incarnation', 'boot_id', m.source_incarnation -> 'boot_id'));
      owners := owners || (m.source_incarnation ->> 'incarnation');
    end if;
  else
    items := items || jsonb_build_array(jsonb_build_object('kind', 'owner', 'id', 'unknown', 'incarnation', null, 'boot_id', null, 'unknown', true));
  end if;
  if inc_in is not null and not (inc_in = any (owners)) then
    items := items || jsonb_build_array(jsonb_build_object('kind', 'owner', 'id', inc_in, 'incarnation', inc_in, 'boot_id', boot_in));
  end if;
  return items;
end $$;

-- The items no accepted resolution covers.
create function hub_move_drain_pending(m public.topic_move, inc_in text, boot_in text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(i.v), '[]'::jsonb)
    from jsonb_array_elements(public.hub_move_drain_items(m, inc_in, boot_in)) as i(v)
   where not exists (select 1 from jsonb_array_elements(m.drain_resolutions) as r(v)
                      where r.v ->> 'kind' = i.v ->> 'kind' and r.v ->> 'id' = i.v ->> 'id')
$$;

-- THE FIRST FAILURE OF THE DRAIN THAT THE OWNER HAS NOT SEEN. An unreleased hold on the master conversation is a failure of
-- this move unless it already existed when the move was requested (same input, same attempt: a held conversation is admitted,
-- it is not a fresh failure) or the owner acknowledged exactly this attempt at exactly this revision. A hold whose revision
-- moved (more was learned about the same attempt) is the same attempt at a new revision, so it is shown again at that revision.
create function hub_move_new_failure(m public.topic_move) returns jsonb
language sql stable as $$
  select jsonb_build_object('inbound', h.inbound_id, 'execution', h.execution_id, 'revision', h.revision, 'cause', h.cause, 'state', h.state)
    from public.replay_hold h
   where h.conversation_id = m.conversation_id and h.state <> 'released'
     and not exists (select 1 from jsonb_array_elements(m.preexisting_holds) p
                      where p ->> 'inbound' = h.inbound_id and p ->> 'execution' = h.execution_id)
     and not exists (select 1 from jsonb_array_elements(m.acknowledged_failures) a
                      where a ->> 'execution' = h.execution_id and a ->> 'revision' = h.revision::text)
   order by h.created_at, h.inbound_id
   limit 1
$$;

-- LOOK AGAIN, AT THIS INSTANT, and make the answer durable: the move is read as it is now (the caller holds its row lock, or the
-- trigger below took it), the failure is worked out from the acknowledgements THAT READ holds, and when there is a failure the
-- owner has not seen at its revision the move goes to `awaiting_owner` showing exactly that execution and revision. Returns the
-- failure seen (null for none). A move that is not in its drain is not looked at. It touches no hold and takes no other lock.
create function hub_move_fail_check(move_in text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  seen jsonb;
begin
  select * into m from public.topic_move where id = move_in;
  if not found or m.stage not in ('waiting', 'awaiting_owner') then
    return null;
  end if;
  seen := public.hub_move_new_failure(m);
  if seen is null then
    return null;
  end if;
  if not (m.stage = 'awaiting_owner' and m.failure ->> 'execution' = seen ->> 'execution' and m.failure ->> 'revision' = seen ->> 'revision') then
    update public.topic_move
       set stage = 'awaiting_owner', failure = seen || jsonb_build_object('since', now()), updated_at = now()
     where id = m.id;
  end if;
  return seen;
end $$;

-- The same failure seen in the transaction that wrote the hold (`endAttempt`), so a failed drain and its awaiting_owner commit
-- together. Only a move still in its drain (`waiting`, or already `awaiting_owner` and showing an older revision) is looked at.
-- THE DECISION IS MADE AFTER THE MOVE'S ROW IS LOCKED: a movement `continue` that acknowledged this very failure holds that lock
-- until it commits, this waits for it and then reads the acknowledgement it wrote, so a stale reading can never put a move back
-- into `awaiting_owner` for a failure the owner already answered. LOCK ORDER: `endAttempt` already holds the attempt, the input and
-- the hold when it gets here, and a feed takes the agent's ordering lock BEFORE the attempt, so this takes NOTHING but the move's
-- row: it does not enter through `hub_move_enter`, takes no ordering lock and no topic lock, and no execution or hold row lock after
-- the move's. That is a bounded reading of the paths that can hold a `waiting` or `awaiting_owner` move's row (the drain, the
-- continue, the release): they read attempts, inputs and holds as snapshot reads and lock only the conversation row `for no key
-- update`, which a hold's foreign-key check does not conflict with. It is not a claim that no move routine ever waits on another
-- lock: the activation's stronger conversation lock belongs to a later stage, which this trigger never looks at.
create function hub_move_hold_noted() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  one text;
begin
  for one in select tm.id from public.topic_move tm
              where tm.conversation_id = new.conversation_id and tm.stage in ('waiting', 'awaiting_owner')
              order by tm.id for update loop
    perform public.hub_move_fail_check(one);
  end loop;
  return null;
end $$;
create trigger replay_hold_move_failure
  after insert or update of revision, state on replay_hold
  for each row execute function hub_move_hold_noted();

-- Every registry receipt names the same binding: the agent, the exact destination runner and machine, the placement generation
-- the activation set, and the profile the destination recorded at preflight. Digests are compared for equality and never ordered.
create function hub_move_receipt_ok(m public.topic_move, receipt jsonb) returns boolean
language sql stable as $$
  select receipt is not null and jsonb_typeof(receipt) = 'object' and octet_length(receipt::text) <= 8192
     and public.hub_move_hex64(receipt ->> 'digest')
     and receipt ->> 'agent' = m.agent and receipt ->> 'runner' = m.dest_runner and receipt ->> 'machine' = m.dest_machine
     and receipt -> 'placement_generation' = to_jsonb(m.dest_generation)
     and jsonb_typeof(receipt -> 'profile') = 'object' and receipt -> 'profile' = m.dest_facts -> 'profile'
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The request. Places the gate in the SAME transaction, so the destination may be offline and the source still takes nothing new.
-- ---------------------------------------------------------------------------------------------------------------------

-- Refuses by name (and places nothing): `unknown-topic`, `protocol-inactive` (the store has not activated protocol 4: a runner
-- that does not know moves could serve after the gate), `not-active`, `in-progress` (an open move, an open archive/reopen or a
-- pending deletion request), `same-machine`. Open councils, jobs and holds are ADMITTED and counted in `source_facts`.
-- The agent's ordering lock comes first, so a request and the first feed intent of an unfed attempt are ordered: whichever
-- commits first is what the other sees (`markFeedIntent` takes the same lock before it reads the gate). An attempt already fed
-- finishes; one not yet fed is refused its first feed and stays queued. Only the master moves; no worker conversation is touched.
create function hub_move_request(move_in text, op_id text, topic_in text, dest_runner_in text, dest_machine_in text,
                                 by_in text, route_in jsonb, proof_in jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
  c public.conversation%rowtype;
  active_protocol integer;
  from_machine text;
  holds jsonb;
  attempts jsonb;
  baseline jsonb;
begin
  select tp.* into t from public.topic tp where tp.id = topic_in;
  if not found then
    return 'unknown-topic';
  end if;
  perform public.hub_gate_order(t.agent_id);
  perform pg_advisory_xact_lock(682150, hashtext(topic_in));
  select * into t from public.topic where id = topic_in for update;
  if exists (select 1 from public.topic_move where operation_id = op_id) then
    return 'replay';
  end if;
  if coalesce(move_in, '') = '' or coalesce(op_id, '') = '' or coalesce(dest_runner_in, '') = '' or coalesce(dest_machine_in, '') = ''
     or coalesce(by_in, '') = '' or not public.hub_move_bounded(route_in, 2048) or not public.hub_move_bounded(proof_in, 4096) then
    raise exception 'move-invalid: a move is asked for with its id, operation, destination and requester';
  end if;
  select p.runner_protocol into active_protocol from public.hub_protocol p;
  if active_protocol < 4 then
    return 'protocol-inactive';
  end if;
  if t.lifecycle <> 'active' then
    return 'not-active';
  end if;
  if exists (select 1 from public.topic_move m where m.topic_id = t.id and m.stage not in ('active', 'withdrawn'))
     or exists (select 1 from public.topic_transition x where x.topic_id = t.id and x.state = 'open') then
    return 'in-progress';
  end if;
  select * into c from public.conversation where id = t.conversation_id for no key update;
  if not found then
    return 'not-active';
  end if;
  from_machine := coalesce(c.machine, t.machine);
  if dest_machine_in = from_machine or dest_runner_in = t.runner then
    return 'same-machine';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('inbound', h.inbound_id, 'execution', h.execution_id, 'revision', h.revision,
                                               'state', h.state, 'cause', h.cause) order by h.created_at, h.inbound_id), '[]'::jsonb)
    into holds from public.replay_hold h where h.conversation_id = c.id and h.state <> 'released';
  select coalesce(jsonb_agg(jsonb_build_object('execution', e.id, 'state', e.state, 'purpose', e.purpose, 'runner', e.runner,
                                               'incarnation', e.incarnation, 'inbound', e.inbound_id) order by e.started_at, e.id), '[]'::jsonb)
    into attempts from public.execution e
   where e.agent = t.agent_id
     and e.state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown');
  -- WHAT THE SOURCE WAS AT THIS INSTANT, honestly: the incarnation and boot its runner registered, or that nothing is known. A request
  -- is admitted either way (the source may be offline, or may never have registered), and an unknown predecessor is named at once as
  -- an ownership block, which the drain can never be taken past by a later caller's own word (see `hub_move_drain_done`).
  baseline := public.hub_move_source_baseline(t.runner, from_machine);
  insert into public.topic_move (id, operation_id, topic_id, agent, person, requested_by, route, evidence, source_runner, source_machine,
                                 dest_runner, dest_machine, conversation_id, adapter, native_session, native_state, source_generation,
                                 source_facts, source_incarnation, block, drain_attempts, preexisting_holds)
  values (move_in, op_id, t.id, t.agent_id, t.person, by_in, route_in, coalesce(proof_in, '{}'::jsonb), t.runner, from_machine,
          dest_runner_in, dest_machine_in, c.id, c.adapter, c.native_session, c.native_state, c.placement_generation,
          jsonb_build_object(
            'holds', jsonb_array_length(holds), 'attempts', jsonb_array_length(attempts),
            'councils', (select count(*) from public.council k where k.agent = t.agent_id and k.lifecycle not in ('complete', 'stopped')),
            'jobs', (select count(*) from public.inbound i where i.agent = t.agent_id and i.kind = 'job' and i.state not in ('answered', 'delivered'))),
          baseline,
          case when baseline ->> 'known' = 'true' then null
               else jsonb_build_object('code', 'drain_owner_unknown', 'detail', baseline, 'since', now(), 'by', 'store') end,
          attempts, holds);
  perform public.hub_gate_place('move:' || move_in, 'agent', t.agent_id, 'move', jsonb_build_object('topic', t.id, 'move', move_in));
  return 'requested';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Blocks: a named note on the stage. The gate stays. Each side clears its own; the store's own clear when the condition is gone.
-- ---------------------------------------------------------------------------------------------------------------------

-- `runner_in` null is the hub (the session's role must be the hub's); otherwise it is the source or the destination runner and its
-- current incarnation. `dependency_unverified` and every other code are just names: nothing here can acknowledge one away.
create function hub_move_block(move_in text, runner_in text, inc_in text, code_in text, detail_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  side text;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if runner_in is null then
    if session_user <> 'hub_hub' then
      return 'not-party';
    end if;
    side := 'hub';
  elsif runner_in = m.source_runner and public.hub_move_runner_current(runner_in, inc_in, m.source_machine) then
    side := 'source';
  elsif runner_in = m.dest_runner and public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    side := 'dest';
  else
    return 'not-party';
  end if;
  if code_in is null or code_in !~ '^[a-z][a-z0-9_]{0,59}$' or not public.hub_move_bounded(detail_in, 2048) then
    return 'block-invalid';
  end if;
  -- ANOTHER PARTY'S BLOCK IS NEVER REPLACED: the reason it was set for is the owner's to read, and only its own side (or the store,
  -- for the condition it validated) clears it. A side may restate or replace its own.
  if m.block is not null then
    if m.block ->> 'code' = code_in and m.block ->> 'by' = side then
      return 'replay';
    end if;
    if m.block ->> 'by' is distinct from side then
      return 'occupied';
    end if;
  end if;
  update public.topic_move
     set block = jsonb_build_object('code', code_in, 'detail', coalesce(detail_in, '{}'::jsonb), 'since', now(), 'by', side), updated_at = now()
   where id = m.id;
  return 'blocked';
end $$;

create function hub_move_unblock(move_in text, runner_in text, inc_in text, code_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  side text;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if runner_in is null then
    if session_user <> 'hub_hub' then
      return 'not-party';
    end if;
    side := 'hub';
  elsif runner_in = m.source_runner and public.hub_move_runner_current(runner_in, inc_in, m.source_machine) then
    side := 'source';
  elsif runner_in = m.dest_runner and public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    side := 'dest';
  else
    return 'not-party';
  end if;
  if m.block is null or m.block ->> 'code' is distinct from code_in then
    return 'none';
  end if;
  if m.block ->> 'by' = 'store' then
    -- Only a condition the store itself validated, and only once it is gone: the topic is active again. The unknown predecessor of
    -- the source (`drain_owner_unknown`) is not a condition anyone can clear: the move ends by its withdrawal.
    if m.block ->> 'code' is distinct from 'topic_not_active' or not public.hub_move_topic_open(m.topic_id) then
      return 'still-blocked';
    end if;
  elsif m.block ->> 'by' <> side then
    return 'not-yours';
  end if;
  update public.topic_move set block = null, updated_at = now() where id = m.id;
  return 'cleared';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Destination preflight. `facts` carries `profile` and `capabilities` (objects): what serve compares the loaded side against.
-- What they say is the runtime's assertion; the store keeps them and binds them by equality.
-- ---------------------------------------------------------------------------------------------------------------------

create function hub_move_dest_ready(move_in text, runner_in text, inc_in text, facts_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'waiting' then
    return 'stage';
  end if;
  if runner_in is distinct from m.dest_runner or not public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    return 'not-destination';
  end if;
  if facts_in is null or jsonb_typeof(facts_in) <> 'object' or not public.hub_move_bounded(facts_in, 16384)
     or jsonb_typeof(facts_in -> 'profile') is distinct from 'object' or jsonb_typeof(facts_in -> 'capabilities') is distinct from 'object' then
    return 'facts-invalid';
  end if;
  if m.dest_facts = facts_in then
    return 'replay';
  end if;
  update public.topic_move set dest_facts = facts_in, dest_ready_at = now(), updated_at = now() where id = m.id;
  return 'ready';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The drain. Persist the INTENT before closing the source's child, then record the EVIDENCE that it is gone.
-- ---------------------------------------------------------------------------------------------------------------------

-- The intent names the boot and the processes the source is about to close (`id`, `boot_id`, `machine`, and what is known:
-- `leader`, `group`, `pids`). It is durable before anything is closed, so a restarted runner finds what its predecessor was
-- closing. The boot it names is the boot the incarnation REGISTERED (`boot-unknown` when the registration could not read one,
-- `boot-mismatch` when the intent names another): a caller's own string is not an anchor. A genuinely new intent (a restarted source
-- that has another child) makes the drain evidence stale AND starts a new export: the blobs of the previous, unsealed export are
-- removed (see `hub_move_blob_put`). What the OTHER intents and owners had proved stays proved: only the same intent again is a
-- replay, it changes nothing, and another intent of the same id is refused rather than taken for it.
create function hub_move_drain_intent(move_in text, runner_in text, inc_in text, intent_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  boot text;
  same jsonb;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'waiting' then
    return 'stage';
  end if;
  if runner_in is distinct from m.source_runner or not public.hub_move_runner_current(runner_in, inc_in, m.source_machine) then
    return 'not-source';
  end if;
  if intent_in is null or jsonb_typeof(intent_in) <> 'object' or not public.hub_move_bounded(intent_in, 4096)
     or coalesce(intent_in ->> 'id', '') = '' or coalesce(intent_in ->> 'boot_id', '') = ''
     or intent_in ->> 'machine' is distinct from m.source_machine then
    return 'intent-invalid';
  end if;
  boot := public.hub_move_runner_boot(runner_in, inc_in);
  if coalesce(boot, '') = '' then
    return 'boot-unknown';
  end if;
  if intent_in ->> 'boot_id' is distinct from boot then
    return 'boot-mismatch';
  end if;
  select e.v into same from jsonb_array_elements(m.drain_intents) as e(v) where e.v ->> 'id' = intent_in ->> 'id' limit 1;
  if same is not null then
    return case when same ->> 'incarnation' = inc_in and (same - 'incarnation' - 'at') = (intent_in - 'incarnation' - 'at') then 'replay'
                else 'intent-invalid' end;
  end if;
  if jsonb_array_length(m.drain_intents) >= 8 then
    return 'intent-limit';
  end if;
  delete from public.move_blob where move_id = m.id;
  update public.topic_move
     set drain_intents = drain_intents || jsonb_build_array((intent_in - 'incarnation' - 'at') || jsonb_build_object('incarnation', inc_in, 'at', now())),
         drain = null, updated_at = now()
   where id = m.id;
  return 'intent';
end $$;

-- THE EVIDENCE THE DRAIN IS OVER, ONE OWNER AT A TIME. The drain is over when EVERY item `hub_move_drain_items` lists is resolved:
-- each drain intent ever recorded, the incarnation that was the source's at the request (when it recorded none), and the incarnation
-- that speaks now (when it recorded none). Each call resolves what its evidence covers and the answer says what remains: `partial`,
-- `owner-unknown` (the source's predecessor at the request was never known: nothing the store can check resolves it, it is named on
-- the move as `drain_owner_unknown`, and the move ends by its withdrawal) or `drained`. A restarted source cannot prove only its own
-- intent and ignore its predecessor's: the predecessor's items stay pending until they are covered.
--   facts the store checks: the source is the current protocol-4 incarnation; no attempt of the agent is owned and no new failure
--   stands; the evidence's boot IS the boot that incarnation registered; the evidence names this move, the conversation, its CURRENT
--   native identity, the placement generation, the source runner, machine and incarnation.
--   assertions it records (the runtime's): that a process tree is gone, with `exit.confirmed`, a `via`, and one basis -
--     `process-group`  the very group a named intent recorded, in the same boot (`intent`): that intent only
--     `boot`           the machine booted again since the item was recorded: EVERY pending item whose boot is known and is not this
--                      one (the store compares the recorded boots itself; the same boot is not a reboot)
--     `no-child`       this incarnation has no child and closed its spawns (`children: none`, `spawn_closed: true`): its OWN lifetime
--                      only, and only while it has recorded no intent. It covers no predecessor, and it is never a substitute for one.
-- A new drain (the first evidence that completes the items, or completes them again for another incarnation) starts a new EXPORT
-- GENERATION and removes the unsealed blobs of the previous one. The same evidence again changes nothing (`replay`).
create function hub_move_drain_done(move_in text, runner_in text, inc_in text, evidence_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  c public.conversation%rowtype;
  intent jsonb;
  item jsonb;
  exit_doc jsonb;
  basis text;
  boot text;
  fresh jsonb := '[]'::jsonb;
  pending jsonb;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'waiting' then
    return 'stage';
  end if;
  if runner_in is distinct from m.source_runner or not public.hub_move_runner_current(runner_in, inc_in, m.source_machine) then
    return 'not-source';
  end if;
  if evidence_in is null or jsonb_typeof(evidence_in) <> 'object' or not public.hub_move_bounded(evidence_in, 4096) then
    return 'evidence-invalid';
  end if;
  if public.hub_move_fail_check(m.id) is not null then
    return 'failure-unacknowledged';
  end if;
  if public.hub_move_unresolved(m.agent) > 0 then
    return 'busy';
  end if;
  boot := public.hub_move_runner_boot(runner_in, inc_in);
  if coalesce(boot, '') = '' then
    return 'boot-unknown';
  end if;
  if evidence_in ->> 'boot_id' is distinct from boot then
    return 'boot-mismatch';
  end if;
  select * into c from public.conversation where id = m.conversation_id;
  if evidence_in ->> 'move' is distinct from m.id or evidence_in ->> 'conversation' is distinct from c.id
     or evidence_in ->> 'native_session' is distinct from c.native_session
     or evidence_in -> 'placement_generation' is distinct from to_jsonb(m.source_generation)
     or evidence_in ->> 'runner' is distinct from m.source_runner or evidence_in ->> 'machine' is distinct from m.source_machine
     or evidence_in ->> 'incarnation' is distinct from inc_in then
    return 'drain-identity-mismatch';
  end if;
  exit_doc := evidence_in -> 'exit';
  basis := exit_doc ->> 'basis';
  if jsonb_typeof(exit_doc) is distinct from 'object' or exit_doc -> 'confirmed' is distinct from 'true'::jsonb
     or coalesce(exit_doc ->> 'via', '') = '' then
    return 'drain-proof-incomplete';
  end if;
  if basis = 'process-group' then
    select e.v into intent from jsonb_array_elements(m.drain_intents) as e(v) where e.v ->> 'id' = evidence_in ->> 'intent' limit 1;
    if intent is null then
      return 'no-intent';
    end if;
    if exit_doc ->> 'leader' is distinct from 'exited' or exit_doc ->> 'descendants' is distinct from 'none'
       or intent ->> 'boot_id' is distinct from boot or intent ->> 'machine' is distinct from m.source_machine
       or jsonb_typeof(intent -> 'group') is distinct from 'number' or exit_doc -> 'group' is distinct from intent -> 'group' then
      return 'drain-proof-incomplete';
    end if;
    item := jsonb_build_object('kind', 'intent', 'id', intent ->> 'id');
    if not exists (select 1 from jsonb_array_elements(m.drain_resolutions) as r(v) where r.v ->> 'kind' = 'intent' and r.v ->> 'id' = intent ->> 'id') then
      fresh := jsonb_build_array(item);
    end if;
  elsif basis = 'boot' then
    if exit_doc ->> 'leader' is distinct from 'exited' or exit_doc ->> 'descendants' is distinct from 'none' then
      return 'drain-proof-incomplete';
    end if;
    -- Every item of another boot of this machine, resolved or not (a replay finds them resolved). The same boot covers nothing.
    if not exists (select 1 from jsonb_array_elements(public.hub_move_drain_items(m, inc_in, boot)) as i(v)
                    where coalesce(i.v ->> 'boot_id', '') <> '' and i.v ->> 'boot_id' <> boot) then
      return 'drain-proof-incomplete';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('kind', p.v ->> 'kind', 'id', p.v ->> 'id')), '[]'::jsonb) into fresh
      from jsonb_array_elements(public.hub_move_drain_pending(m, inc_in, boot)) as p(v)
     where coalesce(p.v ->> 'boot_id', '') <> '' and p.v ->> 'boot_id' <> boot;
  elsif basis = 'no-child' then
    if exit_doc ->> 'children' is distinct from 'none' or exit_doc -> 'spawn_closed' is distinct from 'true'::jsonb
       or coalesce(evidence_in ->> 'owner', inc_in) <> inc_in
       or exists (select 1 from jsonb_array_elements(m.drain_intents) as e(v) where e.v ->> 'incarnation' = inc_in) then
      return 'drain-proof-incomplete';
    end if;
    item := jsonb_build_object('kind', 'owner', 'id', inc_in);
    if not exists (select 1 from jsonb_array_elements(m.drain_resolutions) as r(v) where r.v ->> 'kind' = 'owner' and r.v ->> 'id' = inc_in) then
      fresh := jsonb_build_array(item);
    end if;
  else
    return 'drain-proof-incomplete';
  end if;
  if jsonb_array_length(fresh) > 0 then
    update public.topic_move
       set drain_resolutions = drain_resolutions || (select jsonb_agg(f.v || jsonb_build_object('basis', basis, 'via', exit_doc ->> 'via', 'boot_id', boot,
                                                                                               'by', inc_in, 'at', now()))
                                                       from jsonb_array_elements(fresh) as f(v)),
           updated_at = now()
     where id = m.id;
    select * into m from public.topic_move where id = move_in;
  end if;
  pending := public.hub_move_drain_pending(m, inc_in, boot);
  if jsonb_array_length(pending) > 0 then
    if exists (select 1 from jsonb_array_elements(pending) as p(v) where p.v -> 'unknown' = 'true'::jsonb) then
      perform public.hub_move_annotate(m.id, 'drain_owner_unknown', m.source_incarnation);
      return 'owner-unknown';
    end if;
    return 'partial';
  end if;
  if jsonb_array_length(fresh) = 0 and m.drain is not null and m.drain ->> 'incarnation' = inc_in then
    return 'replay';
  end if;
  delete from public.move_blob where move_id = m.id;
  update public.topic_move
     set drain = jsonb_build_object('incarnation', inc_in, 'boot_id', boot, 'runner', runner_in, 'machine', m.source_machine,
                                    'export_generation', m.export_generation + 1, 'resolved', jsonb_array_length(m.drain_resolutions), 'recorded', now()),
         export_generation = m.export_generation + 1, updated_at = now()
   where id = m.id;
  return 'drained';
end $$;

-- LOOK AGAIN FOR A FAILURE (a reconciler that did not write the hold). The trigger on `replay_hold` does this in the writing
-- transaction; this is the same rule for a caller that only has the move.
create function hub_move_check_failure(move_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  seen jsonb;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage not in ('waiting', 'awaiting_owner') then
    return m.stage;
  end if;
  seen := public.hub_move_fail_check(m.id);
  if seen is null then
    return m.stage;
  end if;
  return 'awaiting_owner';
end $$;

-- THE OWNER'S `continue` FOR THIS MOVE, bound to the failure and the revision it was shown. It needs ownership resolved (no
-- attempt of the agent is owned), acknowledges exactly that failure, and returns the move to `waiting`. It writes NOTHING about the
-- hold: it chooses no `/recover` path, releases no hold, authorizes nothing to be fed, and the same unchanged hold is never a new
-- failure. A distinct failure that is already there, or comes later, still blocks.
create function hub_move_continue(move_in text, by_in text, exec_in text, revision_in integer, proof_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  seen jsonb;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if exists (select 1 from jsonb_array_elements(m.acknowledged_failures) a
              where a ->> 'execution' = exec_in and a ->> 'revision' = revision_in::text) and m.stage <> 'awaiting_owner' then
    return 'replay';
  end if;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'awaiting_owner' then
    return 'stage';
  end if;
  if coalesce(by_in, '') = '' or not public.hub_move_bounded(proof_in, 4096) then
    return 'continue-invalid';
  end if;
  if m.failure ->> 'execution' is distinct from exec_in or m.failure ->> 'revision' is distinct from revision_in::text
     or not exists (select 1 from public.replay_hold h where h.execution_id = exec_in and h.revision = revision_in) then
    return 'stale';
  end if;
  if public.hub_move_unresolved(m.agent) > 0 then
    return 'ownership-unresolved';
  end if;
  update public.topic_move
     set stage = 'waiting', failure = null,
         acknowledged_failures = acknowledged_failures || jsonb_build_array(jsonb_build_object(
           'execution', exec_in, 'revision', revision_in, 'inbound', m.failure ->> 'inbound', 'by', by_in, 'at', now())),
         updated_at = now()
   where id = m.id;
  select * into m from public.topic_move where id = move_in;
  seen := public.hub_move_new_failure(m);
  if seen is not null then
    update public.topic_move set stage = 'awaiting_owner', failure = seen || jsonb_build_object('since', now()), updated_at = now() where id = m.id;
    return 'awaiting_owner';
  end if;
  return 'waiting';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Export. Blobs first (each one is checked against its own bytes), then the release that seals them against the manifest.
-- ---------------------------------------------------------------------------------------------------------------------

-- One opaque file. Only the source, only after its drain evidence (recorded by THIS incarnation) and with nothing owned: an
-- export begins after quiescence. The sha256 is recomputed here, never taken from the caller.
-- THE WRITE NAMES THE EXPORT GENERATION IT BELONGS TO (`topic_move.export_generation`, which the drain that completed gave it): a
-- late writer of an earlier generation, even of the same incarnation, meets `stale-export` and writes nothing. The same file again
-- (same bytes AND same mode) is a `replay`; anything else at that path is a `blob-conflict`.
create function hub_move_blob_put(move_in text, runner_in text, inc_in text, generation_in integer, kind_in text, path_in text, mode_in integer, bytes_in bytea)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  sum_in text := encode(sha256(bytes_in), 'hex');
  was public.move_blob%rowtype;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'waiting' then
    return 'stage';
  end if;
  if runner_in is distinct from m.source_runner or not public.hub_move_runner_current(runner_in, inc_in, m.source_machine) then
    return 'not-source';
  end if;
  if m.drain is null or m.drain ->> 'incarnation' is distinct from inc_in then
    return 'drain-stale';
  end if;
  if generation_in is distinct from m.export_generation then
    return 'stale-export';
  end if;
  if public.hub_move_unresolved(m.agent) > 0 then
    return 'busy';
  end if;
  select * into was from public.move_blob b where b.move_id = m.id and b.kind = kind_in and b.rel_path = path_in;
  if found then
    return case when was.sha256 = sum_in and was.mode = mode_in and was.generation = generation_in then 'replay' else 'blob-conflict' end;
  end if;
  insert into public.move_blob (move_id, kind, rel_path, sha256, mode, size, bytes, generation)
  values (m.id, kind_in, path_in, sum_in, mode_in, octet_length(bytes_in), bytes_in, generation_in);
  return 'stored';
end $$;

-- Whether the manifest's file list IS the set of stored blobs (kind, path, sha256, size, mode), each once. A malformed entry is
-- a mismatch and never an error.
create function hub_move_manifest_matches(move_in text, files jsonb) returns boolean
language plpgsql stable as $$
begin
  if jsonb_typeof(files) is distinct from 'array' then
    return false;
  end if;
  return (select count(*) from jsonb_array_elements(files)) = (select count(*) from public.move_blob b where b.move_id = move_in)
     and (select count(distinct (f ->> 'kind') || chr(31) || (f ->> 'path')) from jsonb_array_elements(files) f)
         = (select count(*) from jsonb_array_elements(files))
     and not exists (select 1 from public.move_blob b
                      where b.move_id = move_in
                        and not exists (select 1 from jsonb_array_elements(files) f
                                         where f ->> 'kind' = b.kind and f ->> 'path' = b.rel_path and f ->> 'sha256' = b.sha256
                                           and f -> 'size' = to_jsonb(b.size) and f -> 'mode' = to_jsonb(b.mode)));
exception when others then
  return false;
end $$;

-- SEAL THE EXPORT. Facts the store checks: the source is the current protocol-4 incarnation and its drain evidence is THIS
-- incarnation's; the destination has recorded its preflight; no block and no unacknowledged failure; the topic is active with no
-- open transition; nothing of the agent is owned; the checkpoint equals the master's OWN consumed state (`entry_seq` is the maximum
-- of THIS conversation's entries, `last_completed` its last completed turn, plus the native identity and placement), and the
-- manifest's files are exactly the stored blobs, with their sizes and sha256 recomputed. What it does NOT use: the council
-- events, the inbound high-water mark or any council revision. A worker's result arriving during the export is queued for the
-- master under the gate and is not part of any snapshot. Assertions it records (the runtime's): the manifest's own `digest` (the
-- transfer library's algorithm), and, for a conversation the engine has seen (`native_state` not `new`), `native` and
-- `portability` evidence the adapter produced. A started conversation with none of it is refused: nothing falls back to a fresh one.
-- The seal names the EXPORT GENERATION it seals (`stale-export` for any other, blobs of another generation included), and finds the
-- source's own copy of the session: an earlier move's claim on that location that the source still owns (the copy an earlier move
-- imported, or one a withdrawn move left with its source) passes to this move's retained copy (`superseded`); anything else that
-- still claims it is an unresolved copy, and the release waits for it (`source-copy-unresolved`).
create function hub_move_source_release(move_in text, runner_in text, inc_in text, generation_in integer, checkpoint_in jsonb, manifest_in jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  c public.conversation%rowtype;
  seq_now integer;
  done_turn text;
  total bigint;
  refusal text;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('source_released', 'importing', 'activated', 'registry_written', 'active') and m.manifest = manifest_in then
    return 'replay';
  end if;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'waiting' then
    return 'stage';
  end if;
  if runner_in is distinct from m.source_runner or not public.hub_move_runner_current(runner_in, inc_in, m.source_machine) then
    return 'not-source';
  end if;
  refusal := public.hub_move_gate_progress(m.id);
  if refusal is not null then
    return refusal;
  end if;
  if m.dest_ready_at is null then
    return 'dest-not-ready';
  end if;
  if m.drain is null or m.drain ->> 'incarnation' is distinct from inc_in then
    return 'drain-stale';
  end if;
  if generation_in is distinct from m.export_generation
     or exists (select 1 from public.move_blob b where b.move_id = m.id and b.generation <> generation_in) then
    return 'stale-export';
  end if;
  if public.hub_move_fail_check(m.id) is not null then
    return 'failure-unacknowledged';
  end if;
  if public.hub_move_unresolved(m.agent) > 0 then
    return 'busy';
  end if;
  select * into c from public.conversation where id = m.conversation_id for no key update;
  select coalesce(max(e.seq), 0) into seq_now from public.conversation_entry e where e.conversation_id = c.id;
  select x.id into done_turn from public.execution x where x.conversation_id = c.id and x.state = 'completed' order by x.ended_at desc, x.id desc limit 1;
  if c.placement_generation <> m.source_generation or coalesce(c.machine, m.source_machine) <> m.source_machine then
    return 'placement-changed';
  end if;
  if checkpoint_in is null or jsonb_typeof(checkpoint_in) <> 'object'
     or checkpoint_in ->> 'conversation' is distinct from c.id or checkpoint_in ->> 'native_session' is distinct from c.native_session
     or checkpoint_in ->> 'native_state' is distinct from c.native_state
     or checkpoint_in -> 'placement_generation' is distinct from to_jsonb(c.placement_generation)
     or checkpoint_in -> 'entry_seq' is distinct from to_jsonb(seq_now)
     or checkpoint_in ->> 'last_completed' is distinct from done_turn then
    return 'checkpoint-mismatch';
  end if;
  if manifest_in is null or jsonb_typeof(manifest_in) <> 'object' or not public.hub_move_bounded(manifest_in, 262144)
     or not public.hub_move_hex64(manifest_in ->> 'digest') or jsonb_typeof(manifest_in -> 'files') is distinct from 'array'
     or jsonb_array_length(manifest_in -> 'files') > 4096 then
    return 'manifest-invalid';
  end if;
  select coalesce(sum(b.size), 0) into total from public.move_blob b where b.move_id = m.id;
  if not public.hub_move_manifest_matches(m.id, manifest_in -> 'files') or manifest_in -> 'bytes' is distinct from to_jsonb(total) then
    return 'manifest-mismatch';
  end if;
  if c.native_state <> 'new' then
    if jsonb_typeof(manifest_in -> 'native') is distinct from 'object' or manifest_in -> 'native' ->> 'native_session' is distinct from c.native_session
       or not public.hub_move_hex64(manifest_in -> 'native' ->> 'native_manifest_digest')
       or jsonb_typeof(manifest_in -> 'portability') is distinct from 'object'
       or coalesce(manifest_in -> 'portability' ->> 'adapter', '') = '' or coalesce(manifest_in -> 'portability' ->> 'evidence', '') = ''
       or coalesce(manifest_in -> 'portability' ->> 'from', '') = '' or coalesce(manifest_in -> 'portability' ->> 'to', '') = '' then
      return 'native-evidence-missing';
    end if;
  end if;
  -- The source's own copy of the session. Answered BEFORE anything is written (an answer commits what the routine wrote).
  if exists (select 1 from public.move_copy x
              where x.conversation_id = m.conversation_id and x.machine = m.source_machine
                and x.move_id <> m.id
                and x.state in ('intent', 'verified', 'promote_intent', 'promoted', 'cleanup_due', 'retained', 'retained_stale')) then
    return 'source-copy-unresolved';
  end if;
  update public.topic_move
     set stage = 'source_released', manifest = manifest_in, source_released_at = now(), updated_at = now(),
         snapshot = jsonb_build_object('conversation', c.id, 'native_session', c.native_session, 'native_state', c.native_state,
                                       'placement_generation', c.placement_generation, 'entry_seq', seq_now, 'last_completed', done_turn)
   where id = m.id;
  update public.move_copy set state = 'superseded', updated_at = now()
   where conversation_id = m.conversation_id and machine = m.source_machine
     and move_id <> m.id and state in ('active', 'source_owned');
  insert into public.move_copy (move_id, machine, kind, generation, state, staging_id, runner, incarnation, conversation_id, native_session, placement_generation)
  values (m.id, m.source_machine, 'source_session_retained', 1, 'retained', 'source-' || m.id, m.source_runner, inc_in,
          m.conversation_id, c.native_session, m.source_generation)
  on conflict (move_id, machine, kind, generation) do nothing;
  return 'released';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Import. The destination owns a generation (and its staging identity) BEFORE it writes a file.
-- ---------------------------------------------------------------------------------------------------------------------

-- Returns `{answer, generation, staging}`. `intent`: a new generation, persisted now. `resumed`: this destination's own earlier
-- generation after a restart (its files are recognised by the same staging identity, not taken for a foreign collision). Both ask
-- the shared block and lifecycle decision first (`hub_move_gate_progress`): a resumed import does not go on under a block.
-- A generation cannot begin while ANY copy claims the same location (this conversation on the destination machine, whichever
-- move made it and whatever native session it recorded): `cleanup-pending` while the claim is owed its removal, `copy-occupied` for anything else, with
-- the claim named in `occupant` (a stale retained source copy is retired with `hub_move_copy_retire` and then removed).
create function hub_move_import_begin(move_in text, runner_in text, inc_in text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  cp public.move_copy%rowtype;
  occupant public.move_copy%rowtype;
  refusal text;
  gen integer;
  staging text;
begin
  if not public.hub_move_enter(move_in) then
    return jsonb_build_object('answer', 'unknown-move');
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return jsonb_build_object('answer', 'terminal');
  end if;
  if m.stage not in ('source_released', 'importing') then
    return jsonb_build_object('answer', 'stage');
  end if;
  if runner_in is distinct from m.dest_runner or not public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    return jsonb_build_object('answer', 'not-destination');
  end if;
  refusal := public.hub_move_gate_progress(m.id);
  if refusal is not null then
    return jsonb_build_object('answer', refusal);
  end if;
  if m.stage = 'importing' then
    select * into cp from public.move_copy where move_id = m.id and kind = 'dest_import' and generation = m.import_generation for update;
    if found and cp.state in ('intent', 'verified', 'promote_intent', 'promoted') then
      update public.move_copy set runner = runner_in, incarnation = inc_in, updated_at = now()
       where move_id = m.id and kind = 'dest_import' and generation = cp.generation and machine = cp.machine;
      return jsonb_build_object('answer', 'resumed', 'generation', cp.generation, 'staging', cp.staging_id);
    end if;
    return jsonb_build_object('answer', 'stage');
  end if;
  select * into occupant from public.move_copy x
   where x.conversation_id = m.conversation_id and x.machine = m.dest_machine
     and x.state in ('intent', 'verified', 'promote_intent', 'promoted', 'active', 'cleanup_due', 'retained', 'source_owned', 'retained_stale')
   order by (x.state = 'cleanup_due') desc, x.created_at, x.move_id
   limit 1;
  if found then
    return jsonb_build_object('answer', case when occupant.state = 'cleanup_due' then 'cleanup-pending' else 'copy-occupied' end,
                              'occupant', jsonb_build_object('move', occupant.move_id, 'kind', occupant.kind, 'generation', occupant.generation,
                                                             'state', occupant.state, 'machine', occupant.machine));
  end if;
  gen := m.import_generation + 1;
  staging := 'move-' || m.id || '-g' || gen;
  insert into public.move_copy (move_id, machine, kind, generation, state, staging_id, runner, incarnation, conversation_id, native_session, placement_generation)
  values (m.id, m.dest_machine, 'dest_import', gen, 'intent', staging, runner_in, inc_in,
          m.conversation_id, m.snapshot ->> 'native_session', m.source_generation + 1);
  update public.topic_move set stage = 'importing', import_generation = gen, updated_at = now() where id = m.id;
  return jsonb_build_object('answer', 'intent', 'generation', gen, 'staging', staging);
end $$;

-- One step of the current generation's own copy: intent -> verified -> promote_intent -> promoted. Committed at each step for THIS
-- stage, generation and incarnation; a late write after a withdraw, for another generation, or by a replaced incarnation is refused.
-- `verified` carries the read-back: the manifest digest, the generation, this staging identity, and the file and byte counts the
-- manifest says. For a conversation the engine has seen it also carries `native` equal to the manifest's. The verification itself
-- (that the files on disk hash to the manifest) is the destination's assertion; the store refuses one that names other things.
create function hub_move_import_advance(move_in text, runner_in text, inc_in text, generation_in integer, to_in text, evidence_in jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  cp public.move_copy%rowtype;
  refusal text;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'importing' then
    return 'stage';
  end if;
  if runner_in is distinct from m.dest_runner or not public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    return 'not-destination';
  end if;
  if generation_in is distinct from m.import_generation then
    return 'stale-generation';
  end if;
  select * into cp from public.move_copy where move_id = m.id and machine = m.dest_machine and kind = 'dest_import' and generation = generation_in for update;
  if not found then
    return 'unknown-copy';
  end if;
  if cp.incarnation is distinct from inc_in then
    return 'stale-generation';
  end if;
  if cp.state = to_in then
    return 'replay';
  end if;
  -- A step of the handoff like any other: under a block, or while the topic is not active, the copy does not advance (its owner's
  -- cleanup, its failure report and the owner's unblock are not steps and go on).
  refusal := public.hub_move_gate_progress(m.id);
  if refusal is not null then
    return refusal;
  end if;
  if not ((cp.state = 'intent' and to_in = 'verified') or (cp.state = 'verified' and to_in = 'promote_intent')
       or (cp.state = 'promote_intent' and to_in = 'promoted')) then
    return 'bad-transition';
  end if;
  if not public.hub_move_bounded(evidence_in, 8192) then
    return 'evidence-invalid';
  end if;
  if to_in = 'verified' then
    if evidence_in is null or evidence_in ->> 'manifest_digest' is distinct from m.manifest ->> 'digest'
       or evidence_in -> 'generation' is distinct from to_jsonb(generation_in) or evidence_in ->> 'staging' is distinct from cp.staging_id
       or evidence_in -> 'files' is distinct from to_jsonb(jsonb_array_length(m.manifest -> 'files'))
       or evidence_in -> 'bytes' is distinct from m.manifest -> 'bytes'
       or (m.snapshot ->> 'native_state' <> 'new' and evidence_in -> 'native' is distinct from m.manifest -> 'native') then
      return 'verification-mismatch';
    end if;
    update public.move_copy set state = 'verified', digest = m.manifest ->> 'digest', file_count = jsonb_array_length(m.manifest -> 'files'),
           bytes = (m.manifest ->> 'bytes')::bigint, evidence = coalesce(evidence_in, '{}'::jsonb), updated_at = now()
     where move_id = m.id and machine = cp.machine and kind = cp.kind and generation = cp.generation;
  else
    update public.move_copy set state = to_in, evidence = evidence || jsonb_build_object(to_in, coalesce(evidence_in, '{}'::jsonb)), updated_at = now()
     where move_id = m.id and machine = cp.machine and kind = cp.kind and generation = cp.generation;
  end if;
  return to_in;
end $$;

-- THE IMPORT FAILED (verification failed, or the destination gave it up): this generation's copy is due for the owner's cleanup,
-- the move goes back to `source_released` with a named block, and the gate stays. The block is the destination's to clear.
create function hub_move_import_failed(move_in text, runner_in text, inc_in text, generation_in integer, code_in text, detail_in jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'importing' then
    return 'stage';
  end if;
  if runner_in is distinct from m.dest_runner or not public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    return 'not-destination';
  end if;
  if generation_in is distinct from m.import_generation then
    return 'stale-generation';
  end if;
  if code_in is null or code_in !~ '^[a-z][a-z0-9_]{0,59}$' or not public.hub_move_bounded(detail_in, 2048) then
    return 'block-invalid';
  end if;
  -- The cleanup debt is recorded whatever else is on the move, with the destination's own reason kept on the copy. The move's block is
  -- the destination's only when there is none: a reason another party set is preserved, and this failure stays readable on the copy.
  update public.move_copy set state = 'cleanup_due', updated_at = now(),
         evidence = evidence || jsonb_build_object('failure', jsonb_build_object('code', code_in, 'detail', coalesce(detail_in, '{}'::jsonb), 'by', inc_in))
   where move_id = m.id and machine = m.dest_machine and kind = 'dest_import' and generation = generation_in
     and state in ('intent', 'verified', 'promote_intent', 'promoted');
  update public.topic_move
     set stage = 'source_released', updated_at = now(),
         block = coalesce(block, jsonb_build_object('code', code_in, 'detail', coalesce(detail_in, '{}'::jsonb), 'since', now(), 'by', 'dest'))
   where id = m.id;
  return 'failed';
end $$;

-- The owner reports that it removed what it owned (`cleanup_due` only). A copy that is promoted or active has no way here.
-- THE REPORT IS OF ONE COPY, named by its move, its kind and its generation, and it carries a `receipt` that names that copy's own
-- staging identity (and nothing else would certify it): a cleaner that holds an earlier move's identity cannot certify, or release, a
-- later owner's copy, and a copy the owner has not been told to remove is `not-due`. The store records the receipt; that the files are
-- gone, and that a cleaner did not race a writer on the machine, is the runtime's to have made true.
-- The reporter is the owner of the copy's side: the destination runner of the move for an import, its source runner for a retained
-- source copy, in both cases as the current protocol-4 incarnation on that machine.
create function hub_move_copy_removed(move_in text, runner_in text, inc_in text, kind_in text, generation_in integer, receipt_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  cp public.move_copy%rowtype;
  owner_runner text;
  owner_machine text;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if kind_in = 'dest_import' then
    owner_runner := m.dest_runner;
    owner_machine := m.dest_machine;
  elsif kind_in = 'source_session_retained' then
    owner_runner := m.source_runner;
    owner_machine := m.source_machine;
  else
    return 'unknown-copy';
  end if;
  if runner_in is distinct from owner_runner or not public.hub_move_runner_current(runner_in, inc_in, owner_machine) then
    return 'not-owner';
  end if;
  select * into cp from public.move_copy where move_id = m.id and machine = owner_machine and kind = kind_in and generation = generation_in for update;
  if not found then
    return 'unknown-copy';
  end if;
  if cp.state = 'removed' then
    return 'replay';
  end if;
  if cp.state <> 'cleanup_due' then
    return 'not-due';
  end if;
  if receipt_in is null or jsonb_typeof(receipt_in) <> 'object' or not public.hub_move_bounded(receipt_in, 8192)
     or receipt_in ->> 'staging' is distinct from cp.staging_id then
    return 'receipt-mismatch';
  end if;
  update public.move_copy set state = 'removed', evidence = evidence || jsonb_build_object('removed', receipt_in || jsonb_build_object('by', inc_in)), updated_at = now()
   where move_id = m.id and machine = cp.machine and kind = cp.kind and generation = cp.generation;
  return 'removed';
end $$;

-- RETIRE A STALE RETAINED SOURCE COPY so that a later move can use its location. A move that went through leaves the source's copy
-- behind as `retained_stale`; when the conversation comes back (A to B to A) the destination would import into that very location,
-- and `hub_move_import_begin` answers `copy-occupied`. The destination runner of the move that needs it says so here, bound to that
-- move (before its import, `source_released`, under its own destination incarnation and machine), to the location (this
-- conversation on the destination machine), and to the stale copy by move, kind and generation. The copy becomes `cleanup_due`
-- (recorded, not removed: its owner removes it and reports it with `hub_move_copy_removed`). What is refused is what must not go: the requesting
-- move's own copies, a copy that is not stale, and a copy on the machine the conversation is placed on now (`needed`: the source copy
-- the current handoff, or a withdrawal, still depends on is `retained` or `source_owned` and is never retirable).
create function hub_move_copy_retire(move_in text, runner_in text, inc_in text, stale_move_in text, stale_kind_in text, stale_generation_in integer)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  cp public.move_copy%rowtype;
  c public.conversation%rowtype;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'source_released' then
    return 'stage';
  end if;
  if runner_in is distinct from m.dest_runner or not public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    return 'not-destination';
  end if;
  select * into cp from public.move_copy
   where move_id = stale_move_in and kind = stale_kind_in and generation = stale_generation_in for update;
  if not found then
    return 'unknown-copy';
  end if;
  if cp.move_id = m.id then
    return 'needed';
  end if;
  if cp.machine is distinct from m.dest_machine or cp.conversation_id is distinct from m.conversation_id then
    return 'unknown-copy';
  end if;
  if cp.state = 'cleanup_due' then
    return 'replay';
  end if;
  select * into c from public.conversation where id = m.conversation_id;
  if cp.state <> 'retained_stale' or c.machine is not distinct from cp.machine then
    return 'needed';
  end if;
  update public.move_copy set state = 'cleanup_due', updated_at = now(),
         evidence = evidence || jsonb_build_object('retired', jsonb_build_object('by_move', m.id, 'runner', runner_in, 'incarnation', inc_in, 'at', now()))
   where move_id = cp.move_id and machine = cp.machine and kind = cp.kind and generation = cp.generation;
  return 'retired';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Activation: the placement moves. Nothing here releases the gate.
-- ---------------------------------------------------------------------------------------------------------------------

-- Facts the store checks at this commit: the destination is the current protocol-4 incarnation; the import generation is the
-- current one and its copy is `promoted`; the verification names that generation, that staging, the sealed manifest digest and
-- (for a started conversation) exactly the manifest's native identity; the topic is active with no open transition; the gate is
-- still open; and the source is exactly the snapshot sealed at release: same conversation, placement generation, native
-- identity, master's entry maximum and last completed turn, nothing owned. Only then do the conversation and the topic name
-- the destination and the placement generation move up by one, so a source at the older generation is refused by `place` and
-- `openExecution`. A stale or late caller meets the stage. Replays of the same verification are `replay`.
create function hub_move_activate(move_in text, runner_in text, inc_in text, generation_in integer, verification_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  cp public.move_copy%rowtype;
  c public.conversation%rowtype;
  seq_now integer;
  done_turn text;
  refusal text;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('activated', 'registry_written', 'active') then
    return case when m.verification = verification_in then 'replay' else 'stage' end;
  end if;
  if m.stage = 'withdrawn' then
    return 'terminal';
  end if;
  if m.stage <> 'importing' then
    return 'stage';
  end if;
  if runner_in is distinct from m.dest_runner or not public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    return 'not-destination';
  end if;
  if generation_in is distinct from m.import_generation then
    return 'stale-generation';
  end if;
  select * into cp from public.move_copy where move_id = m.id and machine = m.dest_machine and kind = 'dest_import' and generation = generation_in for update;
  if not found or cp.state <> 'promoted' or cp.incarnation is distinct from inc_in then
    return 'import-incomplete';
  end if;
  if verification_in is null or jsonb_typeof(verification_in) <> 'object' or not public.hub_move_bounded(verification_in, 8192)
     or verification_in -> 'generation' is distinct from to_jsonb(generation_in) or verification_in ->> 'staging' is distinct from cp.staging_id
     or verification_in ->> 'manifest_digest' is distinct from m.manifest ->> 'digest'
     or verification_in ->> 'dest_runner' is distinct from m.dest_runner or verification_in ->> 'dest_machine' is distinct from m.dest_machine
     or (m.snapshot ->> 'native_state' <> 'new' and verification_in -> 'native' is distinct from m.manifest -> 'native') then
    return 'verification-mismatch';
  end if;
  refusal := public.hub_move_gate_progress(m.id);
  if refusal is not null then
    return refusal;
  end if;
  if not exists (select 1 from public.claim_gate g where g.operation_id = 'move:' || m.id and g.scope_kind = 'agent' and g.scope_id = m.agent and g.state = 'open') then
    return 'gate-lost';
  end if;
  select * into c from public.conversation where id = m.conversation_id for update;
  select coalesce(max(e.seq), 0) into seq_now from public.conversation_entry e where e.conversation_id = c.id;
  select x.id into done_turn from public.execution x where x.conversation_id = c.id and x.state = 'completed' order by x.ended_at desc, x.id desc limit 1;
  if c.id is distinct from m.snapshot ->> 'conversation' or c.native_session is distinct from m.snapshot ->> 'native_session'
     or c.native_state is distinct from m.snapshot ->> 'native_state' or to_jsonb(c.placement_generation) is distinct from m.snapshot -> 'placement_generation'
     or coalesce(c.machine, m.source_machine) <> m.source_machine or to_jsonb(seq_now) is distinct from m.snapshot -> 'entry_seq'
     or done_turn is distinct from m.snapshot ->> 'last_completed' then
    return 'snapshot-changed';
  end if;
  if public.hub_move_unresolved(m.agent) > 0 then
    return 'busy';
  end if;
  update public.conversation set machine = m.dest_machine, placement_generation = c.placement_generation + 1 where id = c.id;
  update public.topic set machine = m.dest_machine, runner = m.dest_runner, updated_at = now() where id = m.topic_id;
  update public.topic_move
     set stage = 'activated', dest_generation = c.placement_generation + 1, verification = verification_in, activated_at = now(), updated_at = now()
   where id = m.id;
  return 'activated';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The registry receipt (the hub) and serve (the destination). Digests are compared for EQUALITY; nothing is ordered.
-- ---------------------------------------------------------------------------------------------------------------------

-- The hub records what it observed after it wrote the registry: the authoritative digest of those very bytes and the semantic
-- binding (agent, destination runner and machine, the placement generation activation set, the destination's recorded profile).
-- A write of the runner key alone is never readiness: only `serve` moves on.
create function hub_move_registry_written(move_in text, receipt_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  refusal text;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage = 'registry_written' or m.stage = 'active' then
    return case when m.registry_receipt = receipt_in then 'replay' else 'use-refresh' end;
  end if;
  if m.stage = 'withdrawn' then
    return 'terminal';
  end if;
  if m.stage <> 'activated' then
    return 'stage';
  end if;
  -- The receipt is a step of the handoff (a refresh of it, before serve, is a reconciliation and is not stopped by a block).
  refusal := public.hub_move_gate_progress(m.id);
  if refusal is not null then
    return refusal;
  end if;
  if not public.hub_move_receipt_ok(m, receipt_in) then
    return 'receipt-invalid';
  end if;
  update public.topic_move set stage = 'registry_written', registry_receipt = receipt_in, updated_at = now() where id = m.id;
  return 'written';
end $$;

-- UNRELATED REGISTRY EDITS CHANGE THE DIGEST. The hub reconciles and refreshes the receipt when the binding still matches; a
-- receipt whose binding is not the activated one is `binding-changed` and the gate stays. Only before serve.
create function hub_move_registry_refresh(move_in text, receipt_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage in ('active', 'withdrawn') then
    return 'terminal';
  end if;
  if m.stage <> 'registry_written' then
    return 'stage';
  end if;
  if not public.hub_move_receipt_ok(m, receipt_in) then
    return 'binding-changed';
  end if;
  if receipt_in = m.registry_receipt then
    return 'unchanged';
  end if;
  update public.topic_move set registry_receipt = receipt_in, updated_at = now() where id = m.id;
  return 'refreshed';
end $$;

-- THE ONLY CALL THAT RELEASES THE GATE FOR A MOVE THAT WENT THROUGH. `loaded` is what the destination asserts it loaded: the agent,
-- the runner, the machine and the placement generation, the registry digest it actually loaded and saw agree with the
-- authoritative file, its effective profile and capabilities, and the imported context (generation, manifest digest). The store
-- checks those against what IT holds (the activated placement, the destination's own preflight facts, the receipt, the sealed
-- manifest) and, itself: the topic is ACTIVE with no open transition (an archive that landed between activation and serve keeps
-- the gate and the stage, and no notice is queued); conversation and topic name the destination; the import copy is still the
-- promoted one. A stale digest is `registry-stale` (the hub refreshes the receipt, or the destination reloads); profile or
-- capability drift is `profile-mismatch`; nothing releases. On success, in this transaction: `active`, the gate released, the
-- relocation note owed (`pending`, `note.digest`), the notice queued under its own key, the blobs removed (the destination has
-- its own copy; a late reader finds them gone and must treat that as a failure, never as an empty file), the source copy stale.
create function hub_move_serve(move_in text, runner_in text, inc_in text, loaded_in jsonb, note_in jsonb, notice_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  cp public.move_copy%rowtype;
  c public.conversation%rowtype;
  t public.topic%rowtype;
  refusal text;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage = 'active' then
    return 'replay';
  end if;
  if m.stage = 'withdrawn' then
    return 'terminal';
  end if;
  if m.stage <> 'registry_written' then
    return 'stage';
  end if;
  if runner_in is distinct from m.dest_runner or not public.hub_move_runner_current(runner_in, inc_in, m.dest_machine) then
    return 'not-destination';
  end if;
  if loaded_in is null or jsonb_typeof(loaded_in) <> 'object' or not public.hub_move_bounded(loaded_in, 8192)
     or note_in is null or jsonb_typeof(note_in) <> 'object' or not public.hub_move_hex64(note_in ->> 'digest')
     or not public.hub_move_bounded(notice_in, 4096)
     or (notice_in is not null and (notice_in ->> 'body' is null or notice_in ->> 'person' is null or notice_in ->> 'agent' is null)) then
    return 'loaded-invalid';
  end if;
  -- Any block stops it (whoever set it: the gate is not released under one), and so does a topic that is not active.
  refusal := public.hub_move_gate_progress(m.id);
  if refusal is not null then
    return refusal;
  end if;
  select * into t from public.topic where id = m.topic_id;
  select * into c from public.conversation where id = m.conversation_id;
  if c.machine is distinct from m.dest_machine or c.placement_generation is distinct from m.dest_generation
     or t.machine is distinct from m.dest_machine or t.runner is distinct from m.dest_runner then
    return 'placement-changed';
  end if;
  select * into cp from public.move_copy where move_id = m.id and machine = m.dest_machine and kind = 'dest_import' and generation = m.import_generation for update;
  if not found or cp.state <> 'promoted' then
    return 'import-unavailable';
  end if;
  if loaded_in ->> 'agent' is distinct from m.agent or loaded_in ->> 'runner' is distinct from m.dest_runner
     or loaded_in ->> 'machine' is distinct from m.dest_machine or loaded_in -> 'placement_generation' is distinct from to_jsonb(m.dest_generation)
     or jsonb_typeof(loaded_in -> 'imported') is distinct from 'object'
     or loaded_in -> 'imported' -> 'generation' is distinct from to_jsonb(m.import_generation)
     or loaded_in -> 'imported' ->> 'manifest_digest' is distinct from m.manifest ->> 'digest' then
    return 'loaded-mismatch';
  end if;
  if jsonb_typeof(loaded_in -> 'profile') is distinct from 'object' or loaded_in -> 'profile' is distinct from m.dest_facts -> 'profile'
     or loaded_in -> 'profile' is distinct from m.registry_receipt -> 'profile'
     or jsonb_typeof(loaded_in -> 'capabilities') is distinct from 'object' or loaded_in -> 'capabilities' is distinct from m.dest_facts -> 'capabilities' then
    return 'profile-mismatch';
  end if;
  if loaded_in ->> 'digest' is distinct from m.registry_receipt ->> 'digest' then
    return 'registry-stale';
  end if;
  update public.topic_move
     set stage = 'active', note_state = 'pending', note_digest = note_in ->> 'digest', finished_at = now(), updated_at = now()
   where id = m.id;
  perform public.hub_gate_release('move:' || m.id, null, null);
  update public.move_copy set state = 'active', updated_at = now()
   where move_id = m.id and machine = m.dest_machine and kind = 'dest_import' and generation = m.import_generation;
  update public.move_copy set state = 'retained_stale', updated_at = now()
   where move_id = m.id and kind = 'source_session_retained' and state = 'retained';
  delete from public.move_blob where move_id = m.id;
  if notice_in is not null then
    insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
    values ('notice', null, 1, notice_in ->> 'body', notice_in ->> 'person', notice_in ->> 'agent', 'topic-move:' || m.id || ':active', notice_in -> 'route')
    on conflict (notice_key) do nothing;
  end if;
  return 'active';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Withdrawal. The owner's only way out, and only before activation.
-- ---------------------------------------------------------------------------------------------------------------------

-- From `waiting`, `awaiting_owner`, `source_released` or `importing`; `too-late` from `activated` on (the activated move finishes
-- its destination handoff first: no new move is promised meanwhile); `execution-unresolved` while an attempt of the agent is
-- owned (the existing ownership machinery resolves it first). The stage is checked under the move's row lock, which activation
-- also takes, so the two cannot both win. In one transaction: the stage, ONLY this move's gate released (every other gate and
-- every hold stays), the destination's unfinished copies marked `cleanup_due` (a record that the owner must remove what it owns;
-- nothing here claims a file was removed), the source copy marked as still the owner's, the blobs removed. A reader that was
-- in flight against a removed blob must fail its verification: a completion is refused by the stage.
create function hub_move_withdraw(move_in text, by_in text, route_in jsonb, proof_in jsonb, notice_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
begin
  if not public.hub_move_enter(move_in) then
    return 'unknown-move';
  end if;
  select * into m from public.topic_move where id = move_in;
  if m.stage = 'withdrawn' then
    return 'replay';
  end if;
  if m.stage in ('activated', 'registry_written', 'active') then
    return 'too-late';
  end if;
  if coalesce(by_in, '') = '' or not public.hub_move_bounded(proof_in, 4096) or not public.hub_move_bounded(notice_in, 4096)
     or (notice_in is not null and (notice_in ->> 'body' is null or notice_in ->> 'person' is null or notice_in ->> 'agent' is null)) then
    return 'withdraw-invalid';
  end if;
  if public.hub_move_unresolved(m.agent) > 0 then
    return 'execution-unresolved';
  end if;
  update public.topic_move
     set stage = 'withdrawn', block = null, failure = null, finished_at = now(), updated_at = now(),
         evidence = evidence || jsonb_build_object('withdrawn', jsonb_build_object('by', by_in, 'at', now(), 'route', route_in) || coalesce(proof_in, '{}'::jsonb))
   where id = m.id;
  perform public.hub_gate_release('move:' || m.id, null, null);
  update public.move_copy set state = 'cleanup_due', updated_at = now()
   where move_id = m.id and kind = 'dest_import' and state in ('intent', 'verified', 'promote_intent', 'promoted');
  update public.move_copy set state = 'source_owned', updated_at = now()
   where move_id = m.id and kind = 'source_session_retained' and state = 'retained';
  delete from public.move_blob where move_id = m.id;
  if notice_in is not null then
    insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
    values ('notice', null, 1, notice_in ->> 'body', notice_in ->> 'person', notice_in ->> 'agent', 'topic-move:' || m.id || ':withdrawn', notice_in -> 'route')
    on conflict (notice_key) do nothing;
  end if;
  return 'withdrawn';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The relocation note. Owed from `active` until there is evidence it was consumed; never "delivered" by opening an attempt or by
-- a feed intent. It rides with the next real input (composed by the runner; no model turn of its own, no synthetic history).
-- ---------------------------------------------------------------------------------------------------------------------

-- JOURNAL WHICH ATTEMPT CARRIES THE OWED NOTES, in the transaction that commits the attempt's feed intent (`markFeedIntent`).
-- Two completed moves with no real input between them leave TWO notes owed, and what the model has to be told is the whole chain
-- (a machine, a root, a path that changed twice), so the carrier is given the chain, not one note: `notes_in` is the ordered list
-- of `{move, digest}` of EVERY note this conversation still owes, oldest first (`notes-mismatch` for any other list, `digest-mismatch`
-- for a digest that is not the one a move declared at serve). The chain has to be a real one (`ancestry-broken`): each move starts
-- where the one before it ended (machine and placement generation), and the last one ends where the conversation is NOW. The
-- carrier is fenced against the conversation's CURRENT placement, not against any note's own generation: the attempt is feeding
-- (`not-feeding`), on this conversation, at its current placement generation, through the runner the topic names now.
-- `no-note` when nothing is owed, `delivered` when the ones named were already consumed (the caller must not compose them again).
-- A later attempt (the first one never received anything) simply takes over the journal; a lost receipt repeats the notes, which is
-- conservative, and the held assignment is never replayed by it.
-- LOCKS: the agent's ordering lock and the topic's first (as every move routine; a feed holds the first already), then the owed
-- moves' rows, oldest first.
create function hub_move_note_carry(exec_in text, notes_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  e public.execution%rowtype;
  c public.conversation%rowtype;
  t public.topic%rowtype;
  m public.topic_move%rowtype;
  prev public.topic_move%rowtype;
  have_prev boolean := false;
  n integer := 0;
  want jsonb;
begin
  if notes_in is null or jsonb_typeof(notes_in) <> 'array' or jsonb_array_length(notes_in) = 0 or not public.hub_move_bounded(notes_in, 16384) then
    return 'notes-mismatch';
  end if;
  select * into e from public.execution where id = exec_in;
  if not found then
    return 'not-feeding';
  end if;
  select * into t from public.topic where conversation_id = e.conversation_id;
  if not found then
    return 'no-note';
  end if;
  perform public.hub_gate_order(t.agent_id);
  perform pg_advisory_xact_lock(682150, hashtext(t.id));
  for m in select * from public.topic_move tm
            where tm.conversation_id = e.conversation_id and tm.stage = 'active' and tm.note_state = 'pending'
            order by tm.finished_at, tm.id for update loop
    want := notes_in -> n;
    n := n + 1;
    if want is null or want ->> 'move' is distinct from m.id then
      return 'notes-mismatch';
    end if;
    if want ->> 'digest' is distinct from m.note_digest then
      return 'digest-mismatch';
    end if;
    if have_prev and (m.source_machine is distinct from prev.dest_machine or m.source_generation is distinct from prev.dest_generation) then
      return 'ancestry-broken';
    end if;
    prev := m;
    have_prev := true;
  end loop;
  if n = 0 then
    if exists (select 1 from jsonb_array_elements(notes_in) as w(v) join public.topic_move tm on tm.id = w.v ->> 'move'
                where tm.conversation_id = e.conversation_id and tm.note_state = 'delivered') then
      return 'delivered';
    end if;
    return 'no-note';
  end if;
  if n <> jsonb_array_length(notes_in) then
    return 'notes-mismatch';
  end if;
  select * into c from public.conversation where id = e.conversation_id;
  if e.state not in ('feed_intent', 'received', 'running') or e.placement_generation is distinct from c.placement_generation
     or e.runner is distinct from t.runner then
    return 'not-feeding';
  end if;
  if prev.dest_generation is distinct from c.placement_generation or prev.dest_machine is distinct from coalesce(c.machine, t.machine) then
    return 'ancestry-broken';
  end if;
  update public.topic_move set note_attempt = exec_in, updated_at = now()
   where conversation_id = e.conversation_id and stage = 'active' and note_state = 'pending';
  return 'carried';
end $$;

-- DELIVERY, ON EVIDENCE: the carrying attempt is `received`, `running` or `completed` (the engine acknowledged, produced, or the
-- result settled). In ONE transaction the conversation's recovery entry (source `move-note:<move>`, once: a repeat lands nothing)
-- and the delivered mark, so a failed bookkeeping write leaves the note owed and a crash after the ack duplicates no entry.
-- An attempt that never reached the engine (`failed`, `claimed`, or only `feed_intent`: FeedNotWritten, a fenced feed, a crash
-- before a byte) is `not-received` and the notes stay pending.
-- EXACTLY THE NOTES THE ATTEMPT CARRIED, AND THEIR OWN WORDS. `notes_in` is the list of `{move, body}` the attempt carried, oldest
-- first; it has to be the set the journal holds for this attempt (`notes-mismatch` otherwise: a partial acknowledgement of a chain is
-- not made), and each body has to be the one its move declared at serve - the sha256 of the body is that move's `note_digest`
-- (`digest-mismatch`), so no other text is ever written down as a move's explanation. The recovery entries (one for each, source
-- `move-note:<move>`, once) and the delivered marks commit together, so a failed bookkeeping write leaves all of them owed and a
-- crash after the acknowledgement duplicates nothing. `replay` for notes this very attempt already delivered.
create function hub_move_note_delivered(exec_in text, notes_in jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  m public.topic_move%rowtype;
  e public.execution%rowtype;
  t public.topic%rowtype;
  n integer := 0;
  want jsonb;
  body text;
  carried text[] := '{}';
begin
  if notes_in is null or jsonb_typeof(notes_in) <> 'array' or jsonb_array_length(notes_in) = 0 or not public.hub_move_bounded(notes_in, 65536) then
    return 'notes-mismatch';
  end if;
  select * into e from public.execution where id = exec_in;
  if not found then
    return 'not-received';
  end if;
  select * into t from public.topic where conversation_id = e.conversation_id;
  if not found then
    return 'no-note';
  end if;
  perform public.hub_gate_order(t.agent_id);
  perform pg_advisory_xact_lock(682150, hashtext(t.id));
  -- What this attempt carried and is still owed.
  for m in select * from public.topic_move tm
            where tm.conversation_id = e.conversation_id and tm.stage = 'active' and tm.note_state = 'pending' and tm.note_attempt = exec_in
            order by tm.finished_at, tm.id for update loop
    n := n + 1;
    carried := carried || m.id;
  end loop;
  if n = 0 then
    if exists (select 1 from jsonb_array_elements(notes_in) as w(v) join public.topic_move tm on tm.id = w.v ->> 'move'
                where tm.conversation_id = e.conversation_id and tm.note_state = 'delivered' and tm.note_attempt = exec_in) then
      return 'replay';
    end if;
    if exists (select 1 from public.topic_move tm where tm.conversation_id = e.conversation_id and tm.stage = 'active' and tm.note_state = 'pending') then
      return 'not-carrier';
    end if;
    return 'no-note';
  end if;
  if e.state not in ('received', 'running', 'completed') then
    return 'not-received';
  end if;
  if n <> jsonb_array_length(notes_in) then
    return 'notes-mismatch';
  end if;
  for k in 0 .. jsonb_array_length(notes_in) - 1 loop
    want := notes_in -> k;
    body := want ->> 'body';
    if want ->> 'move' is distinct from carried[k + 1] then
      return 'notes-mismatch';
    end if;
    if body is null or char_length(body) not between 1 and 8192 then
      return 'note-invalid';
    end if;
    if not exists (select 1 from public.topic_move tm where tm.id = carried[k + 1]
                    and tm.note_digest = encode(sha256(convert_to(body, 'UTF8')), 'hex')) then
      return 'digest-mismatch';
    end if;
  end loop;
  for k in 0 .. jsonb_array_length(notes_in) - 1 loop
    body := notes_in -> k ->> 'body';
    insert into public.conversation_entry (conversation_id, seq, source_id, kind, body, partial, execution_id)
    values (e.conversation_id, coalesce((select max(x.seq) from public.conversation_entry x where x.conversation_id = e.conversation_id), 0) + 1,
            'move-note:' || carried[k + 1], 'recovery', body, false, exec_in)
    on conflict (conversation_id, source_id, kind) do nothing;
  end loop;
  update public.topic_move set note_state = 'delivered', updated_at = now() where id = any (carried);
  return 'delivered';
end $$;

-- Who may call what. Nobody writes a move table directly: every role reads, and the routines write. The model's login has none.
-- The routines that speak for a runner check its current protocol-4 incarnation; the registry receipt is the hub's alone.
revoke all on function hub_move_bounded(jsonb, integer) from public;
revoke all on function hub_move_hex64(text) from public;
revoke all on function hub_move_runner_current(text, text, text) from public;
revoke all on function hub_move_enter(text) from public;
revoke all on function hub_move_unresolved(text) from public;
revoke all on function hub_move_topic_open(text) from public;
revoke all on function hub_move_annotate(text, text, jsonb) from public;
revoke all on function hub_move_runner_boot(text, text) from public;
revoke all on function hub_move_source_baseline(text, text) from public;
revoke all on function hub_move_gate_progress(text) from public;
revoke all on function hub_move_drain_items(public.topic_move, text, text) from public;
revoke all on function hub_move_drain_pending(public.topic_move, text, text) from public;
revoke all on function hub_move_fail_check(text) from public;
revoke all on function hub_move_new_failure(public.topic_move) from public;
revoke all on function hub_move_receipt_ok(public.topic_move, jsonb) from public;
revoke all on function hub_move_manifest_matches(text, jsonb) from public;
revoke all on function hub_move_request(text, text, text, text, text, text, jsonb, jsonb) from public;
revoke all on function hub_move_block(text, text, text, text, jsonb) from public;
revoke all on function hub_move_unblock(text, text, text, text) from public;
revoke all on function hub_move_dest_ready(text, text, text, jsonb) from public;
revoke all on function hub_move_drain_intent(text, text, text, jsonb) from public;
revoke all on function hub_move_drain_done(text, text, text, jsonb) from public;
revoke all on function hub_move_check_failure(text) from public;
revoke all on function hub_move_continue(text, text, text, integer, jsonb) from public;
revoke all on function hub_move_blob_put(text, text, text, integer, text, text, integer, bytea) from public;
revoke all on function hub_move_source_release(text, text, text, integer, jsonb, jsonb) from public;
revoke all on function hub_move_import_begin(text, text, text) from public;
revoke all on function hub_move_import_advance(text, text, text, integer, text, jsonb) from public;
revoke all on function hub_move_import_failed(text, text, text, integer, text, jsonb) from public;
revoke all on function hub_move_copy_removed(text, text, text, text, integer, jsonb) from public;
revoke all on function hub_move_copy_retire(text, text, text, text, text, integer) from public;
revoke all on function hub_move_activate(text, text, text, integer, jsonb) from public;
revoke all on function hub_move_registry_written(text, jsonb) from public;
revoke all on function hub_move_registry_refresh(text, jsonb) from public;
revoke all on function hub_move_serve(text, text, text, jsonb, jsonb, jsonb) from public;
revoke all on function hub_move_withdraw(text, text, jsonb, jsonb, jsonb) from public;
revoke all on function hub_move_note_carry(text, jsonb) from public;
revoke all on function hub_move_note_delivered(text, jsonb) from public;
-- The owner's requests (a tool's, the door's) and the reconciler's look.
grant execute on function hub_move_request(text, text, text, text, text, text, jsonb, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_move_withdraw(text, text, jsonb, jsonb, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_move_continue(text, text, text, integer, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_move_check_failure(text) to hub_door, hub_runner, hub_hub;
-- Blocks: a runner's, or the hub's own (a null runner is checked against the session's role).
grant execute on function hub_move_block(text, text, text, text, jsonb) to hub_runner, hub_hub;
grant execute on function hub_move_unblock(text, text, text, text) to hub_runner, hub_hub;
-- The runners of the two sides.
grant execute on function hub_move_dest_ready(text, text, text, jsonb) to hub_runner;
grant execute on function hub_move_drain_intent(text, text, text, jsonb) to hub_runner;
grant execute on function hub_move_drain_done(text, text, text, jsonb) to hub_runner;
grant execute on function hub_move_blob_put(text, text, text, integer, text, text, integer, bytea) to hub_runner;
grant execute on function hub_move_source_release(text, text, text, integer, jsonb, jsonb) to hub_runner;
grant execute on function hub_move_import_begin(text, text, text) to hub_runner;
grant execute on function hub_move_import_advance(text, text, text, integer, text, jsonb) to hub_runner;
grant execute on function hub_move_import_failed(text, text, text, integer, text, jsonb) to hub_runner;
grant execute on function hub_move_copy_removed(text, text, text, text, integer, jsonb) to hub_runner;
grant execute on function hub_move_copy_retire(text, text, text, text, text, integer) to hub_runner;
grant execute on function hub_move_activate(text, text, text, integer, jsonb) to hub_runner;
grant execute on function hub_move_serve(text, text, text, jsonb, jsonb, jsonb) to hub_runner;
grant execute on function hub_move_note_carry(text, jsonb) to hub_runner;
grant execute on function hub_move_note_delivered(text, jsonb) to hub_runner;
-- The hub.
grant execute on function hub_move_registry_written(text, jsonb) to hub_hub;
grant execute on function hub_move_registry_refresh(text, jsonb) to hub_hub;
grant select on topic_move, move_copy to hub_door, hub_runner, hub_hub;
-- Only the destination runner reads the bytes.
grant select on move_blob to hub_runner;
