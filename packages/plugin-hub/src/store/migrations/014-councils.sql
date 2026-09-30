-- Councils: an explicit, continuing comparison run by ordinary workers.
--
-- A COUNCIL IS A DURABLE OBJECT, NOT A SHEET ROW AND A MERGE. It has an owner (the
-- master conversation the question was asked in), an explicit roster, rounds, a
-- record of every owner decision that moved it, and one queued event at a time for
-- the master to assess. Its workers are the hub's ordinary workers: each member is
-- a job on the one queue with a conversation of its own, and a further round is the
-- same job machinery put into that same conversation. Nothing here runs a model,
-- retries a worker, replaces a member or writes an answer of its own.
--
-- Additive: the objects touched from before are `hub_report` (the report on a job now
-- carries a council's mark for a job that belongs to a council of this step as it
-- always did for the old one) and `hub_council_abandon`, which stops closing seats.
-- The old sheet rows of open councils, and the merged councils behind them, are read
-- into the tables below at the end of this file.

-- THE CUTOVER OF THE OLD DESIGN'S WRITERS. A door or a runner that predates this step is still running
-- when it is applied on a live store, and two things of the old design must stop with it: the merge
-- (`hub_council_merge`, written by the old runner at the last seat's settle) and the creation of a
-- council (the old door writes a seat's job for every configured seat, and a sheet row). Runner protocol
-- 3 fences an old RUNNER from a council of this design; it does not stop an old DOOR from writing, and
-- nothing about it says an old door was upgraded. So this step closes both writers in the database, and
-- does not rely on anybody having been quiesced:
--   * the merge writer is switched off below (history is kept: the merge rows already written stay);
--   * a job that names a council of the old design (`dispatch.council`) and does not continue an
--     interrupted one (`dispatch.continues`, which the store's own recovery writes for a held seat)
--     is refused at insert from here on: the old door's next council fails in its own transaction, and a
--     held seat's authorized continuation, a report and every other ordinary write are untouched.
-- THE TRANSACTIONS IN FLIGHT AT THE MOMENT OF THE STEP are accounted for, in the order that cannot deadlock
-- with the old writers' own (an old settle takes the sheet row and then writes the merge; an old door writes
-- seat jobs and a sheet row): the sheet is locked first, so an old settle that has read its row finishes, its
-- merge included, and one that has not meets the rows gone below and does nothing (the old settle returns when
-- its sheet row is missing); then the queue, so a seat job an old door wrote and has not yet committed is visible to
-- the read of the old councils that follows. Both are held to the end of this step (a plain read is not blocked).
-- The DO block is there so the same text runs where no transaction is open (a fresh install, which has no old
-- rows to wait for).
do $$
begin
  lock table state_row in exclusive mode;
  lock table inbound in share row exclusive mode;
end $$;

-- THE RUNNER PROTOCOL MOVES TO 3, THROUGH THE MACHINERY STEP 11 BUILT. There is no second
-- scheduler and no parallel fence: the same table (`hub_protocol`), the same claim setting
-- (`hub.runner_protocol`, said in the claiming transaction only), the same incarnation row and
-- the same activation guard, each allowed one more value.
--
-- 3 is 2 plus councils. A runner of 2 does not know a council's job or the event the master
-- reads for one: it would settle the job as an ordinary report and hand it to the master as a
-- turn of its own. So:
--   * landing this step activates nothing (`hub_protocol` stays where it is), and a new runner
--     moves it to 3 when it starts, before it registers or claims, exactly as the runner of 2
--     moved it to 2. Activation starts, stops, settles, replays and discards nothing; the
--     refusal it keeps is step 11's (an input a runner of 1 may have fed is in flight);
--   * once 3 is active, a claim that does not say 3 is refused, on whichever connection it
--     comes, and so is a registration of an incarnation that speaks less, so an old binary
--     that restarts can neither claim nor fence out the runner that can;
--   * INDEPENDENTLY of what is active, a council's job (`dispatch.council_round`) and the event
--     the master reads for a council (`council_event`) cannot be claimed by a connection that
--     does not say 3: the row carries the rule, so nothing a council wrote is open to an old
--     runner in the window between this step and the first runner of 3, nor on a pooled
--     connection whose previous borrower said 2 (the setting lives in the transaction).
-- The claim and the activation are ordered by the same row lock as before: a claim that does not
-- say 3 reads the protocol `for share`, the activation is an update of that row and waits for it.
-- A claim that says 3 is allowed by any state and takes no lock.
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
alter table hub_protocol add constraint hub_protocol_runner_protocol_check check (runner_protocol in (1, 2, 3));

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
                when '3' then 3 when '2' then 2 else 1 end;
      if said < 3 and (new.source -> 'dispatch' -> 'council_round' is not null
                       or new.source -> 'council_event' is not null) then
        raise exception
          'inbound % belongs to a council and is claimed by a runner that does not speak protocol 3: it is not claimable', new.id;
      end if;
      if said < 3 then
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

-- A registration of an incarnation is refused when it speaks less than the store has activated,
-- for the reason the claim is: the newest registration wins and fences out every other, so a
-- binary of protocol 2 that restarted after 3 was activated must not become the current
-- incarnation of a runner name and fence out the runner of 3 that is serving it.
create function hub_guard_runner_incarnation() returns trigger
language plpgsql as $$
declare
  active integer;
begin
  select p.runner_protocol into active from public.hub_protocol p for share;
  if new.protocol < active then
    raise exception 'runner % speaks protocol %, and this store has activated protocol %: it does not serve', new.runner, new.protocol, active;
  end if;
  return new;
end $$;
create trigger runner_incarnation_speaks_protocol
  before insert or update on runner_incarnation
  for each row execute function hub_guard_runner_incarnation();

-- ONE COUNCIL.
--
--   running           workers are working on the current round
--   waiting_master    every required member has answered, and the master has not read
--                     the event that says so (or read it and made no disposition)
--   assessing         the master's turn that consumed the event is under way
--   preparing_result  the master called finalize from an attempt of its own; the reply
--                     that attempt settles is the council's result
--   waiting_owner     an attention gate the OWNER decides: a member is missing, with the
--                     known cause. Healthy siblings keep running; nothing is rerun,
--                     replaced or synthesized without the owner's word
--   stopping          an explicit stop is under way; stopped only on evidence
--   stopped, complete terminal until the owner asks for a follow-up
--
-- `origin` and `return_route` are pinned when the council is made and never change: a
-- later chat move or archive does not silently re-address a council. `revision` moves
-- on every change and is what `expected_revision` is compared with.
--
-- `epoch` is one owner-authorized period of activity, and the checkpoint is measured
-- from the start of the current one. Only an owner-requested follow-up starts a new
-- epoch (`epoch_authority` names the messages); a model's own round never does.
create table council (
  id                  text primary key,
  person              text not null,
  agent               text not null,
  master_conversation text references conversation (id),
  origin_kind         text not null check (origin_kind in ('owner_request', 'proposal', 'legacy')),
  origin              jsonb not null,
  return_route        jsonb not null,
  operation_id        text not null unique,
  parent_job          text,
  question            text not null,
  question_revision   integer not null default 1 check (question_revision >= 1),
  roster_revision     integer not null default 1 check (roster_revision >= 1),
  context             jsonb not null default '[]'::jsonb,
  debate_opt_in       jsonb,
  lifecycle           text not null check (lifecycle in (
                        'running', 'waiting_master', 'assessing', 'preparing_result',
                        'waiting_owner', 'stopping', 'stopped', 'complete')),
  waiting             jsonb,
  current_round       integer not null default 1 check (current_round >= 1),
  epoch               integer not null default 1 check (epoch >= 1),
  epoch_started_at    timestamptz not null default now(),
  epoch_authority     jsonb not null default '{}'::jsonb,
  checkpoint_deadline timestamptz not null,
  extension           jsonb,
  finalize            jsonb,
  result              jsonb,
  status_effect_key   text not null,
  status_stage        text,
  status_at           timestamptz,
  revision            integer not null default 1 check (revision >= 1),
  legacy_of           text unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  constraint council_route_is_whole check (
    return_route ->> 'agent' is not null and return_route ->> 'door' is not null and return_route ->> 'chat' is not null)
);
create index council_live on council (agent) where lifecycle not in ('complete', 'stopped');
create index council_live_by_door on council ((return_route ->> 'door')) where lifecycle not in ('complete', 'stopped');
create index council_by_finalize_attempt on council ((finalize ->> 'attempt')) where finalize is not null;

-- ONE MEMBER OF THE ROSTER. A participant is the worker the owner's words chose, with the
-- exact preset and machine it was resolved to at acceptance (`preset_snapshot` keeps the
-- five settings, so a later registry edit does not change an approved council). A member
-- that is replaced is never overwritten: the replacement is a NEW row that names the one it
-- replaces. Its conversation is the worker conversation its first job made, and every later
-- round is put into that same one.
create table council_participant (
  id                  text primary key,
  council_id          text not null references council (id),
  ordinal             integer not null check (ordinal >= 1),
  worker_agent        text not null,
  preset_name         text,
  preset_id           text,
  preset_snapshot     jsonb not null default '{}'::jsonb,
  profile             jsonb not null default '{}'::jsonb,
  profile_id          text,
  machine             text,
  runner              text,
  brief               text not null default '',
  required            boolean not null default true,
  state               text not null default 'active' check (state in ('active', 'replaced')),
  replaces            text references council_participant (id),
  first_inbound       text,
  worker_conversation text references conversation (id),
  roster_revision     integer not null default 1,
  created_at          timestamptz not null default now(),
  unique (council_id, ordinal)
);
create index council_participant_by_council on council_participant (council_id);

-- ONE ROUND, and what asked for it. `kind` is what the master's action was; the evidence
-- is the owner's messages behind it, when the action needed them.
create table council_round (
  council_id        text not null references council (id),
  round             integer not null check (round >= 1),
  kind              text not null check (kind in ('independent', 'debate', 'follow_up')),
  question_revision integer not null,
  epoch             integer not null,
  evidence          jsonb not null default '{}'::jsonb,
  state             text not null default 'running' check (state in ('running', 'complete', 'stopped')),
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  primary key (council_id, round)
);

-- ONE INPUT GIVEN TO ONE PARTICIPANT IN ONE ROUND. `input_revision` counts the inputs the
-- participant was given in this round (a correction or an owner's retry is a further one),
-- `question_revision` is the council's question as it stood when the input was framed.
--
--   open          the input is queued, waiting for a machine, or running. WHICH of those is
--                 read off the job and its attempt, never written here
--   answered      the worker's report landed (`report_id`); `valid_for_revision` is the
--                 newest question revision the answer is taken to answer
--   missing       the member cannot be waited for: its attempt was interrupted, its
--                 ownership is unknown, it was refused, or it failed before it started.
--                 `cause` says which. Only the owner's choice moves it
--   cancelled     the input was queued and not yet fed, and was disabled (a correction, a stop)
--   superseding   a correction asked its running attempt to end; nothing new is fed to it
--                 until the attempt is shown to be over
--   superseded    the input was replaced by a correction. Whatever it produced is kept and
--                 never satisfies the round
--   stopping, stopped   an explicit stop of the council
--
-- `inbound_id` is the job row, or the owner's continuation of it. It may be null for the
-- moment between a correction and the evidence the corrected input waits for.
create table round_member (
  council_id        text not null,
  round             integer not null,
  participant_id    text not null references council_participant (id),
  input_revision    integer not null check (input_revision >= 1),
  question_revision integer not null default 1 check (question_revision >= 1),
  inbound_id        text,
  state             text not null default 'open' check (state in (
                      'open', 'answered', 'missing', 'cancelled', 'superseding', 'superseded', 'stopping', 'stopped')),
  cause             jsonb,
  awaiting          jsonb,
  report_id         text,
  valid_for_revision integer,
  supersedes        integer,
  answered_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (council_id, round, participant_id, input_revision),
  foreign key (council_id, round) references council_round (council_id, round)
);
create unique index round_member_by_job on round_member (inbound_id) where inbound_id is not null;
create index round_member_unsettled on round_member (council_id) where state in ('open', 'superseding', 'stopping');

-- EVERY OWNER DECISION AND MASTER DISPOSITION THAT MOVED A COUNCIL, in order, with the
-- messages that were its evidence and the attempt that made the call. A `use_available`
-- names the members it omits here BEFORE a result with fewer answers can be finalized;
-- an `extend` names its scope here; a `finalize` names the attempt whose reply is the result.
create table council_decision (
  council_id      text not null references council (id),
  seq             integer not null check (seq >= 1),
  kind            text not null,
  conversation_id text not null,
  request_key     text not null,
  operation_id    text not null,
  sources         jsonb not null default '[]'::jsonb,
  by_sender       text,
  attempt         text,
  payload         jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now(),
  primary key (council_id, seq),
  unique (operation_id, kind)
);

-- THE MASTER'S QUEUE ENTRIES. One row here is one `inbound` row of rank 0 that the hub wrote
-- for the master to read, and `ready_at` is the moment it was written: it is its OWN
-- queue time, so a message a person had already sent stays ahead of it and a later message
-- cannot jump it, and a redelivery of the same event moves nothing (`dedupe_key`). The time
-- of the request that started the work is provenance and is kept in `provenance`, never used
-- to order anything.
create table council_event (
  council_id        text not null references council (id),
  seq               integer not null check (seq >= 1),
  kind              text not null check (kind in ('round_complete', 'member_missing', 'round_stalled')),
  dedupe_key        text not null,
  inbound_id        text not null unique references inbound (id),
  ready_at          timestamptz not null,
  provenance        jsonb not null default '{}'::jsonb,
  consumed_at       timestamptz,
  consumed_attempt  text,
  disposition       text,
  primary key (council_id, seq),
  unique (council_id, dedupe_key)
);
create index council_event_by_attempt on council_event (consumed_attempt) where consumed_attempt is not null;

grant select, insert, update on council, council_participant, council_round, round_member, council_decision, council_event
  to hub_runner, hub_door;
grant select on council, council_participant, council_round, round_member, council_decision, council_event to hub_hub;

-- A council is written to the diary by the process that changed it.
create policy ledger_event_council on ledger_event
  for insert to hub_door, hub_runner
  with check (stream = 'council' and actor = case current_user when 'hub_door' then 'door' else 'runner' end);

-- What a council keeps for good: who and where it belongs to, and how it started.
create function hub_guard_council() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.person is distinct from old.person or new.agent is distinct from old.agent
     or new.origin_kind is distinct from old.origin_kind or new.origin is distinct from old.origin
     or new.return_route is distinct from old.return_route or new.operation_id is distinct from old.operation_id
     or new.status_effect_key is distinct from old.status_effect_key or new.created_at is distinct from old.created_at
     or (old.master_conversation is not null and new.master_conversation is distinct from old.master_conversation) then
    raise exception 'council % keeps the owner, origin and return route it was made with', old.id;
  end if;
  return new;
end $$;
create trigger council_rules
  before update on council
  for each row execute function hub_guard_council();

-- A member of the roster keeps its identity; a replaced one is marked, never rewritten.
create function hub_guard_council_participant() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.council_id is distinct from old.council_id
     or new.worker_agent is distinct from old.worker_agent or new.preset_id is distinct from old.preset_id
     or new.preset_snapshot is distinct from old.preset_snapshot or new.machine is distinct from old.machine
     or new.profile is distinct from old.profile or new.profile_id is distinct from old.profile_id
     or new.replaces is distinct from old.replaces or new.brief is distinct from old.brief then
    raise exception 'participant % keeps the worker, preset, profile and machine it was accepted with', old.id;
  end if;
  if old.first_inbound is not null and new.first_inbound is distinct from old.first_inbound then
    raise exception 'participant % already has its first job', old.id;
  end if;
  if old.worker_conversation is not null and new.worker_conversation is distinct from old.worker_conversation then
    raise exception 'participant % has its conversation for good', old.id;
  end if;
  return new;
end $$;
create trigger council_participant_rules
  before update on council_participant
  for each row execute function hub_guard_council_participant();

-- An input keeps what it was, a final state stays, and the job it names is set once.
create function hub_guard_round_member() returns trigger
language plpgsql as $$
begin
  if new.council_id is distinct from old.council_id or new.round is distinct from old.round
     or new.participant_id is distinct from old.participant_id or new.input_revision is distinct from old.input_revision
     or new.question_revision is distinct from old.question_revision then
    raise exception 'an input of a council is identified by its round, participant and revision, and none of them changes';
  end if;
  if old.inbound_id is not null and new.inbound_id is distinct from old.inbound_id then
    raise exception 'the job of an input is set once (%)', old.inbound_id;
  end if;
  if old.state in ('cancelled', 'superseded', 'stopped') and new.state <> old.state then
    raise exception 'an input that is % stays so', old.state;
  end if;
  return new;
end $$;
create trigger round_member_rules
  before update on round_member
  for each row execute function hub_guard_round_member();

-- The door that carries a council's chat hears about a change at its commit, on the channel
-- it already listens on for what it did not write (`hub_project`, payload `council:<door>`), and
-- recomputes the card and the notices from the rows. A hold on a member's job, and the stop of a
-- member's attempt, are announced the same way: the runner writes those rows and does not know councils.
create function hub_council_notify() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_project', 'council:' || (new.return_route ->> 'door'));
  return null;
end $$;
-- Every change of a council moves its `revision`, and the door's own bookkeeping of what it last
-- showed (`status_stage`, `status_at`) does not, so the door writing what it showed does not wake itself.
create trigger council_notify
  after insert or update of revision on council
  for each row execute function hub_council_notify();

create function hub_council_notify_member() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform pg_notify('hub_project', 'council:' || (select c.return_route ->> 'door' from public.council c where c.id = new.council_id));
  return null;
end $$;
create trigger round_member_notify
  after insert or update on round_member
  for each row execute function hub_council_notify_member();

create function hub_council_notify_hold() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  who text;
begin
  select c.return_route ->> 'door' into who
    from public.round_member m join public.council c on c.id = m.council_id
   where m.inbound_id = new.inbound_id and c.lifecycle not in ('complete', 'stopped') limit 1;
  if who is not null then
    perform pg_notify('hub_project', 'council:' || who);
  end if;
  return null;
end $$;
create trigger replay_hold_council_notify
  after insert or update of state on replay_hold
  for each row execute function hub_council_notify_hold();

create function hub_council_notify_stop() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  who text;
begin
  select c.return_route ->> 'door' into who
    from public.round_member m join public.council c on c.id = m.council_id
   where m.awaiting ->> 'execution' = new.execution_id and m.state in ('superseding', 'stopping') limit 1;
  if who is not null then
    perform pg_notify('hub_project', 'council:' || who);
  end if;
  return null;
end $$;
create trigger stop_request_council_notify
  after update of state on stop_request
  for each row when (old.state is distinct from new.state)
  execute function hub_council_notify_stop();

-- THE JOB OF ONE MEMBER'S INPUT. The runner holds no insert on `inbound`, and a council's tool
-- runs in the runner, so the job goes through a function owned by the role that already
-- writes the table, exactly as `hub_report` and `hub_council_merge` do. It is a `job` for an
-- agent that takes jobs alone, ready at the commit, and it belongs to a council of this
-- person: a job that names no council of theirs is refused. True when the row is new, so a
-- replayed transaction lands nothing twice.
create function hub_council_job(job_id text, person_id text, agent_id text, task text, job_source jsonb)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  cid text := job_source -> 'dispatch' -> 'council_round' ->> 'council';
begin
  if cid is null or not exists (select 1 from public.council c where c.id = cid and c.person = person_id) then
    raise exception 'council-job-unknown: % belongs to no council of %', job_id, person_id;
  end if;
  insert into public.inbound (id, person, agent, body, kind, source, log_ready)
  values (job_id, person_id, agent_id, task, 'job', job_source, true)
  on conflict (id) do nothing;
  if not found then
    return false;
  end if;
  insert into public.ledger_event (stream, subject, kind, actor)
  values ('inbound', job_id, 'received', 'door');
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  values ('control', job_id, 'dispatch.requested', 'door',
          jsonb_build_object('by', job_source -> 'dispatch' -> 'approved' ->> 'by',
            'dispatcher', job_source -> 'dispatch' ->> 'dispatcher', 'target', agent_id,
            'at', job_source ->> 'at', 'council', cid));
  return true;
end $$;
alter function hub_council_job(text, text, text, text, jsonb) owner to hub_door;
revoke all on function hub_council_job(text, text, text, text, jsonb) from public;
grant execute on function hub_council_job(text, text, text, text, jsonb) to hub_runner, hub_door;

-- THE ROW THE MASTER READS WHEN A COUNCIL NEEDS IT, and its own record. A `report`, so it is
-- rank 0 and a person's message that is already waiting stays ahead of it, and it is stamped
-- with the moment it is WRITTEN (`clock_timestamp()`, the insertion, not the start of the
-- transaction that wrote it) as its own queue time: it is not backdated to the question, and
-- a later message from a person sorts after it. It is ready at the commit, so nothing that
-- arrives after it can be claimed first because a door had not yet projected it. Its route is
-- the council's pinned one, which is where the master's reply to it is delivered.
--
-- The same event again (`dedupe`) returns the time it already has and writes nothing, so a
-- redelivered settle or a second reconciler moves nothing. Returns the queue time.
create function hub_council_event_put(event_id text, cid text, event_seq integer, event_kind text, dedupe text,
                                      agent_id text, person_id text, body_text text, route jsonb, provenance jsonb)
returns timestamptz language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  ready timestamptz;
  stamp timestamptz := clock_timestamp();
begin
  if not exists (select 1 from public.council c where c.id = cid and c.agent = agent_id and c.person = person_id) then
    raise exception 'council-event-unknown: % is not a council of % for %', cid, person_id, agent_id;
  end if;
  select e.ready_at into ready from public.council_event e where e.council_id = cid and e.dedupe_key = dedupe;
  if found then
    return ready;
  end if;
  insert into public.inbound (id, person, agent, body, kind, received_at, reported_at, source, log_ready)
  values (event_id, person_id, agent_id, body_text, 'report', stamp, stamp,
          jsonb_build_object(
            'log_id', event_id,
            'at', to_char(stamp at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'door', route ->> 'door',
            'chat', route ->> 'chat',
            'from', 'council',
            'text', 'council ' || event_kind,
            'origin', 'council',
            'council_event', jsonb_build_object('council', cid, 'seq', event_seq, 'kind', event_kind)
              || coalesce(provenance, '{}'::jsonb)),
          true);
  insert into public.ledger_event (stream, subject, kind, actor)
  values ('inbound', event_id, 'received', 'door');
  insert into public.council_event (council_id, seq, kind, dedupe_key, inbound_id, ready_at, provenance)
  values (cid, event_seq, event_kind, dedupe, event_id, stamp, coalesce(provenance, '{}'::jsonb));
  return stamp;
end $$;
alter function hub_council_event_put(text, text, integer, text, text, text, text, text, jsonb, jsonb) owner to hub_door;
revoke all on function hub_council_event_put(text, text, integer, text, text, text, text, text, jsonb, jsonb) from public;
grant execute on function hub_council_event_put(text, text, integer, text, text, text, text, text, jsonb, jsonb) to hub_runner, hub_door;

-- The report on a job carries the council's mark for a job of a council of this step too, so
-- the projection puts it on the chat line and both tails leave the line out. Nothing else
-- changes from the version in step 10.
create or replace function hub_report(job_id text, report text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  job public.inbound%rowtype;
begin
  select * into job from public.inbound where id = job_id;
  if not found then
    raise exception 'hub_report was given no job to report on (id %)', job_id;
  end if;
  if job.kind <> 'job' then
    raise exception 'hub_report was given a % row, and a report belongs to a job (id %)', job.kind, job_id;
  end if;
  insert into public.inbound (id, person, agent, body, kind, received_at, reported_at, source, log_ready)
  values ('report:' || job.id, job.person,
          job.source -> 'dispatch' -> 'return' ->> 'agent', report, 'report', job.received_at, now(),
          jsonb_build_object(
            'log_id', 'report:' || job.id,
            'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'door', job.source -> 'dispatch' -> 'return' ->> 'door',
            'chat', job.source -> 'dispatch' -> 'return' ->> 'chat',
            'from', job.agent,
            'text', report,
            'job', job.id)
          || case
               when job.source -> 'dispatch' -> 'approved' ->> 'source' = 'watch' then jsonb_build_object('origin', 'watcher')
               when job.source -> 'dispatch' -> 'approved' ->> 'source' = 'council'
                 or job.source -> 'dispatch' -> 'council_round' is not null then jsonb_build_object('origin', 'council')
               else '{}'::jsonb end,
          false)
  on conflict (id) do nothing;
  if found then
    insert into public.ledger_event (stream, subject, kind, actor)
    values ('inbound', 'report:' || job.id, 'received', 'door');
  end if;
end $$;

-- A COUNCIL SEAT IS NEVER GIVEN UP ON BY A CLOCK. The old grace closed an unclaimed seat and
-- merged what was left; a council now waits for its owner over a member that is missing, and
-- the old function is switched off for the councils of the old design too, so nothing can
-- stamp answered a seat nobody answered.
create or replace function hub_council_abandon(job_id text, cause text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return false;
end $$;

-- THE OLD MERGE IS SWITCHED OFF TOO. The old runner wrote `merge:<council>` at the last seat's settle through this
-- function, and the row it wrote reached the master as a report of its own: a synthesis nobody asked the master for, in a
-- council this design tracks. It writes nothing now and answers false, which the old caller reads as "already merged" (the
-- answer for a replayed settle), so it neither retries nor fails. The merge rows already written are history: they stay as
-- they are, are read below (a merged council is `complete`, with `result.legacy_merge` naming its row) and stay inspectable.
-- (An ordinary settle of an old seat AFTER this step does not reach the merge at all: the old settle reads the sheet row,
-- which is deleted below, and returns when it is missing. What this closes is a settle that had read the row before, and
-- a caller that does not read it.)
create or replace function hub_council_merge(council_id text, agent_id text, person_id text, body text, route jsonb, at timestamptz)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return false;
end $$;

-- NO NEW COUNCIL OF THE OLD DESIGN. A job that names one (`dispatch.council`) is an old door's seat, and no council row tracks it: it
-- would be claimed as an ordinary job, answered into nothing and merged by nobody. It is refused at insert. A job that names one AND
-- continues an interrupted attempt (`dispatch.continues`) is the owner's authorized recovery of a seat that was held when this step ran
-- (`hub_hold_advance` writes it), and is not a new council: it is let through, so an existing report, hold or recovery is not blocked.
create function hub_guard_legacy_council_job() returns trigger
language plpgsql as $$
begin
  raise exception 'legacy-council-closed: a council of the earlier design is not made any more (job %); a council is started with the hub_council tool', new.id;
end $$;
create trigger inbound_no_new_legacy_council
  before insert on inbound
  for each row
  when (new.kind = 'job' and new.source -> 'dispatch' -> 'council' is not null and new.source -> 'dispatch' -> 'continues' is null)
  execute function hub_guard_legacy_council_job();

-- THE OPEN COUNCILS OF THE OLD DESIGN AND THE MERGED ONES BEHIND THEM, read into the tables
-- above from what the store really holds. A seat's state is read off its job, its report and
-- its hold and is never guessed: an answered seat is answered, a seat with a hold or one that
-- was refused or given up on is missing with that cause, and a seat with neither is still
-- open, and its report lands later through the same code as any other. NO merge is written,
-- no seat is replayed and no model is called: an open council whose seats are not all
-- answered waits for its owner, and one whose seats all answered without a merge says so.
-- A merged council is kept as history (`result` names its merge row) and is inspectable.
do $$
declare
  c record;
  seat text;
  seat_no integer;
  cid text;
  job_id text;
  pid text;
  master text;
  sheet_data jsonb;
  qtext text;
  merged boolean;
  m_state text;
  m_cause jsonb;
  m_report text;
  m_answered timestamptz;
  missing_count integer;
  open_count integer;
  life text;
  gate jsonb;
  outcome jsonb;
  prefix constant text := 'Answer the question below on your own. State your position and your reasons, and name what you are unsure of. No preamble.' || E'\n\n';
begin
  for c in
    select distinct on (i.source -> 'dispatch' -> 'council' ->> 'id')
           i.source -> 'dispatch' -> 'council' ->> 'id' as cid,
           i.person as person, i.source as src, i.body as body, i.received_at as received_at
      from inbound i
     where i.kind = 'job' and i.source -> 'dispatch' -> 'council' ->> 'id' is not null
     order by i.source -> 'dispatch' -> 'council' ->> 'id', i.received_at, i.id
  loop
    cid := c.cid;
    master := c.src -> 'dispatch' -> 'return' ->> 'agent';
    select s.data into sheet_data from state_row s where s.sheet = 'council' and s.id = cid;
    qtext := coalesce(sheet_data ->> 'task',
                      case when left(c.body, length(prefix)) = prefix then substr(c.body, length(prefix) + 1) else c.body end);
    merged := exists (select 1 from inbound m where m.id = 'merge:' || cid);
    insert into council (id, person, agent, master_conversation, origin_kind, origin, return_route, operation_id, question,
                         lifecycle, current_round, epoch, epoch_started_at, checkpoint_deadline, status_effect_key,
                         legacy_of, created_at)
    values (cid, c.person, coalesce(master, ''),
            (select k.id from conversation k where k.kind = 'master' and k.agent = master),
            'legacy', jsonb_build_object('legacy', true, 'approved', c.src -> 'dispatch' -> 'approved'),
            jsonb_build_object('agent', coalesce(master, ''),
                               'door', coalesce(c.src -> 'dispatch' -> 'return' ->> 'door', ''),
                               'chat', coalesce(c.src -> 'dispatch' -> 'return' ->> 'chat', '')),
            'legacy:' || cid, qtext,
            'waiting_owner', 1, 1, c.received_at, c.received_at + interval '30 minutes', 'council-status:' || cid,
            cid, c.received_at);
    insert into council_round (council_id, round, kind, question_revision, epoch, evidence, state, created_at)
    values (cid, 1, 'independent', 1, 1, jsonb_build_object('legacy', true), 'running', c.received_at);
    seat_no := 0;
    missing_count := 0;
    open_count := 0;
    for seat in select jsonb_array_elements_text(c.src -> 'dispatch' -> 'council' -> 'seats') loop
      seat_no := seat_no + 1;
      job_id := cid || ':' || seat;
      pid := cid || ':p' || seat_no;
      insert into council_participant (id, council_id, ordinal, worker_agent, first_inbound, worker_conversation, brief)
      values (pid, cid, seat_no, seat, job_id,
              (select k.id from conversation k where k.kind = 'worker' and k.owner_ref = job_id), '');
      m_state := 'open';
      m_cause := null;
      m_report := null;
      m_answered := null;
      if exists (select 1 from inbound r where r.id = 'report:' || job_id) then
        m_state := 'answered';
        m_report := 'report:' || job_id;
        select r.reported_at into m_answered from inbound r where r.id = m_report;
      elsif exists (select 1 from replay_hold h where h.inbound_id = job_id) then
        m_state := 'missing';
        select jsonb_build_object('kind', h.cause, 'attempt', h.execution_id, 'legacy', true) into m_cause
          from replay_hold h where h.inbound_id = job_id;
      elsif not exists (select 1 from inbound j where j.id = job_id) then
        m_state := 'missing';
        m_cause := jsonb_build_object('kind', 'job-missing', 'legacy', true);
      elsif exists (select 1 from inbound j where j.id = job_id and j.state in ('answered', 'delivered')) then
        m_state := 'missing';
        m_cause := jsonb_build_object('kind', 'given-up', 'legacy', true,
          'detail', (select e.detail ->> 'cause' from ledger_event e
                      where e.subject = job_id and e.kind in ('dispatch.refused', 'dispatch.abandoned')
                      order by e.seq desc limit 1));
      end if;
      insert into round_member (council_id, round, participant_id, input_revision, question_revision, inbound_id, state, cause,
                                report_id, valid_for_revision, answered_at)
      values (cid, 1, pid, 1, 1, job_id, m_state, m_cause, m_report, case when m_state = 'answered' then 1 end, m_answered);
      if m_state = 'missing' then missing_count := missing_count + 1;
      elsif m_state = 'open' then open_count := open_count + 1;
      end if;
    end loop;
    gate := null;
    outcome := null;
    if merged then
      life := 'complete';
      outcome := jsonb_build_object('legacy_merge', 'merge:' || cid);
    elsif missing_count > 0 then
      life := 'waiting_owner';
      gate := jsonb_build_object('kind', 'members_missing', 'legacy', true,
        'members', (select jsonb_agg(m.participant_id order by m.participant_id) from round_member m
                     where m.council_id = cid and m.state = 'missing'));
    elsif open_count > 0 then
      life := 'running';
    else
      life := 'waiting_owner';
      gate := jsonb_build_object('kind', 'legacy_unmerged', 'legacy', true);
    end if;
    update council set lifecycle = life, waiting = gate, result = outcome,
                       completed_at = case when merged then now() else null end
     where id = cid;
    update council_round set state = case when merged then 'complete' else 'running' end,
                             completed_at = case when merged then now() else null end
     where council_id = cid and round = 1;
    insert into ledger_event (stream, subject, kind, actor, detail)
    values ('council', cid, 'legacy.read', 'hub',
            jsonb_build_object('lifecycle', life, 'seats', seat_no, 'missing', missing_count, 'open', open_count, 'merged', merged));
  end loop;
  -- The old sheet rows are read; the door no longer keeps or closes them.
  delete from state_row where sheet = 'council';
end $$;
