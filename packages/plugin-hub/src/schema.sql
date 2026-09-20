-- The one store. Ledger and queue in one database, with every rule the hub
-- depends on enforced here rather than in the code that writes: roles, grants,
-- row-level policies, constraints and triggers. A second process that opens its
-- own connection meets the same fence.
--
-- Applied with psql -v ON_ERROR_STOP=1 against a fresh database. Roles are
-- cluster-wide, so their creation is idempotent and a second apply is clean.

do $$ begin
  create role hub_door login;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role hub_runner login;
exception when duplicate_object then null;
end $$;

do $$ begin
  create role hub_agent login;
exception when duplicate_object then null;
end $$;

-- The hub process writes to the ledger as actor `hub`, and the invariant
-- `current_user = 'hub_' || actor` is what makes the name this one. It is ugly
-- and it is kept, because a prettier one would cost that one-line check.
do $$ begin
  create role hub_hub login;
exception when duplicate_object then null;
end $$;

grant usage on schema public to hub_door, hub_runner, hub_agent, hub_hub;

-- The diary. Every state change of every message, plus every refusal. Appended,
-- never edited, never deleted.
create table ledger_event (
  seq     bigserial primary key,
  at      timestamptz not null default now(),
  stream  text not null,
  subject text not null,
  kind    text not null,
  actor   text not null,
  detail  jsonb not null default '{}'::jsonb,
  constraint ledger_event_actor_is_machinery
    check (actor in ('door', 'runner', 'hub')),
  constraint ledger_event_inbound_kinds
    check (
      stream <> 'inbound'
      or kind in ('received', 'acked', 'started', 'answered', 'delivered')
    )
);

create index ledger_event_stream_subject on ledger_event (stream, subject, seq);

-- One row per message. `state` is a function of the diary above, maintained by
-- trigger, and a direct write to it is refused. `rank` is a function of `kind`
-- and is generated, so a writer cannot set one to disagree with the other: rank
-- 0 is what a human is waiting on, rank 1 is proactive work.
create table inbound (
  id             text primary key,
  person         text not null,
  agent          text not null,
  body           text not null,
  kind           text not null default 'human',
  rank           int generated always as
                   (case when kind in ('human', 'report') then 0 else 1 end) stored,
  received_at    timestamptz not null default now(),
  state          text not null default 'received',
  claimed_by     text,
  claim_deadline timestamptz,
  retry_at       timestamptz,
  constraint inbound_state_is_a_stamp
    check (state in ('received', 'acked', 'started', 'answered', 'delivered')),
  -- `measure` is the sixth and it is not work: it is what the
  -- store's own measuring tool writes to weigh a message, and it is rank 1 like
  -- every other kind nobody is waiting on. It exists so those rows are
  -- invisible to every reader that asks about a person's messages, all of which
  -- select on `kind = 'human'`, in the window before the tool takes them away
  -- again and afterwards for a caller that could not.
  constraint inbound_kind_is_known
    check (kind in ('human', 'report', 'triage', 'room', 'harvest', 'measure'))
);

create index inbound_by_agent on inbound (agent, state);

-- One row per reply chunk. The runner writes them, the door marks them
-- delivered once the platform accepted them.
--
-- A NOTICE is a row here too, and it is the one thing on this table with
-- no message on it: a household-wide cause (a dead login, a used-up plan
-- window) is one line per person and not an apology per row, so it hangs on
-- nothing. `kind` defaults to `reply`, which is what keeps every shipped insert
-- (`insert into outbox (inbound_id, seq_in_reply, body)`) legal unchanged.
--
-- `notice_key unique` is the WHOLE of the one-notice arithmetic. The
-- pair above stops constraining a notice at all, because NULLs are distinct in
-- a unique index, so this is what makes a second runner's write, a restart's
-- write and a same-tick sibling's write all land nothing.
create table outbox (
  id           bigserial primary key,
  kind         text not null default 'reply',
  inbound_id   text references inbound (id),
  person       text,
  agent        text,
  notice_key   text unique,
  seq_in_reply int not null,
  body         text not null,
  written_at   timestamptz not null default now(),
  delivered_at timestamptz,
  unique (inbound_id, seq_in_reply),
  constraint outbox_kind_is_known check (kind in ('reply', 'notice')),
  constraint outbox_kind_is_whole
    check (
      (kind = 'reply'
        and inbound_id is not null
        and notice_key is null)
      or
      (kind = 'notice'
        and inbound_id is null
        and person is not null
        and agent is not null
        and notice_key is not null)
    )
);

-- State sheet storage. One row per id, edited in place, removed when the thing
-- is gone.
create table state_row (
  sheet      text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (sheet, id)
);

create function hub_ledger_append_only() returns trigger
language plpgsql as $$
begin
  raise exception
    'ledger_event is a diary: an entry is never changed and never deleted (seq %)',
    old.seq;
end $$;

create trigger ledger_event_append_only
  before update or delete on ledger_event
  for each row execute function hub_ledger_append_only();

-- The state of a message is derived from its events and from nothing else.
-- security definer, because the writing role holds no update on inbound: without
-- it every stamp fails with permission denied. The flag is what lets the guard
-- below tell this write apart from a hand-written one, and it is local to the
-- statement.
--
-- It is also source one of `hub_turn`: a turn OPENS at `acked` and ENDS
-- at `answered`, and nothing else in the store fires at the start of one. The
-- person comes back from the update this function already runs, so the channel
-- costs one notify and no second read.
create function hub_derive_inbound_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  whose text;
begin
  if new.stream = 'inbound'
     and new.kind in ('received', 'acked', 'started', 'answered', 'delivered')
  then
    perform set_config('hub.deriving', 'on', true);
    update inbound set state = new.kind where id = new.subject
      returning person into whose;
    perform set_config('hub.deriving', 'off', true);
    if whose is not null
       and new.kind in ('acked', 'started', 'answered')
    then
      perform pg_notify('hub_turn', whose);
    end if;
  end if;
  return null;
end $$;

create trigger ledger_event_derives_inbound_state
  after insert on ledger_event
  for each row execute function hub_derive_inbound_state();

create function hub_guard_inbound_state() returns trigger
language plpgsql as $$
begin
  if new.state is distinct from old.state
     and coalesce(current_setting('hub.deriving', true), 'off') <> 'on'
  then
    raise exception
      'inbound.state is derived from ledger_event: append an event instead (id %)',
      new.id;
  end if;
  return new;
end $$;

create trigger inbound_state_is_derived
  before update on inbound
  for each row execute function hub_guard_inbound_state();

-- The table holds the work. This only wakes a runner, and it is emitted by the
-- transaction that made the row available, so it is delivered at that commit.
create function hub_notify_work() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_work', new.agent);
  return null;
end $$;

create trigger inbound_notify_work
  after insert on inbound
  for each row execute function hub_notify_work();

-- The same rule on the way out. The chunk insert happens inside the settling
-- transaction, so the door hears about a reply at the commit that made it
-- postable and never before. The payload is the person, because the door filters
-- to the agents it serves and the outbox row does not carry a door.
--
-- A notice carries its own person, because there is no message to read
-- one off. The coalesce is what lets one trigger serve both rows.
create function hub_notify_out() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_outbox',
                    coalesce(new.person,
                             (select person from inbound where id = new.inbound_id)));
  return null;
end $$;

create trigger outbox_notify_out
  after insert on outbox
  for each row execute function hub_notify_out();

-- Source two of `hub_turn`. The runner writes the open turn's progress onto a sheet
-- while the turn runs, and the door edits one platform message as the count
-- grows. The write is an upsert, so this fires on INSERT OR UPDATE: a trigger
-- that fired on the insert alone would wake the door once and leave the person
-- reading the first count for the rest of the turn.
create function hub_notify_turn_progress() returns trigger
language plpgsql as $$
begin
  if new.data ->> 'person' is not null then
    perform pg_notify('hub_turn', new.data ->> 'person');
  end if;
  return null;
end $$;

create trigger state_row_notify_turn
  after insert or update on state_row
  for each row when (new.sheet = 'turn_progress')
  execute function hub_notify_turn_progress();

-- The fence. One owner per table, and inside the diary one owner per event kind,
-- because the door and the runner each own their own steps of a message.
alter table ledger_event enable row level security;
alter table inbound enable row level security;

grant select, insert on ledger_event to hub_door, hub_runner;
grant usage on sequence ledger_event_seq_seq to hub_door, hub_runner;

create policy ledger_event_readable on ledger_event
  for select to hub_door, hub_runner, hub_hub using (true);

create policy ledger_event_door_stamps on ledger_event
  for insert to hub_door
  with check (actor = 'door' and stream = 'inbound'
              and kind in ('received', 'delivered'));

-- A clock running out is a line the door writes, and it is not a stamp.
-- A SECOND policy rather than a widening of the one above: PostgreSQL ORs
-- permissive policies, so this is purely additive, and the fence
-- test/msg-stamps.test.ts binds in both directions stays readable as the one
-- sentence it is.
create policy ledger_event_door_clock on ledger_event
  for insert to hub_door
  with check (actor = 'door' and stream = 'clock' and kind = 'expired');

create policy ledger_event_runner_stamps on ledger_event
  for insert to hub_runner
  with check (actor = 'runner' and stream = 'inbound'
              and kind in ('acked', 'started', 'answered'));

-- What a turn cost and what the runner refused are the runner's own to write.
-- Neither is a stamp, so neither widens the fence above.
--
-- The `runner` stream: one line at connect naming the server
-- this runner really reached. It cannot be stream `machine`, which is the hub's
-- and is fenced below, so the runner says it in a stream of its own.
create policy ledger_event_runner_turn on ledger_event
  for insert to hub_runner
  with check (actor = 'runner' and stream in ('turn', 'refusal', 'memory', 'runner'));

-- What the hub did to the operating system, the restart requests it acts on and
-- the ones it refused. Three streams, one actor, and nothing else.
grant select, insert on ledger_event to hub_hub;
grant usage on sequence ledger_event_seq_seq to hub_hub;

create policy ledger_event_hub_writes on ledger_event
  for insert to hub_hub
  with check (actor = 'hub'
              and stream in ('machine', 'restart', 'refusal'));

grant select on inbound to hub_hub;

grant select, insert on inbound to hub_door;
grant select on inbound to hub_runner;
grant update (claimed_by, claim_deadline, retry_at) on inbound to hub_runner;

create policy inbound_readable on inbound
  for select to hub_door, hub_runner using (true);

create policy inbound_door_creates on inbound
  for insert to hub_door with check (true);

create policy inbound_runner_claims on inbound
  for update to hub_runner using (true) with check (true);

grant select, insert on outbox to hub_runner;
grant usage on sequence outbox_id_seq to hub_runner;
grant select on outbox to hub_door;
grant update (delivered_at) on outbox to hub_door;

-- The door keeps its platform cursor on a state sheet, so it writes here.
--
-- The runner writes three of its own now: the household's outage, the
-- household's window reading, and the open turn's progress. Two runners racing
-- for one outage row is an expected race and the primary key is what settles
-- it, so the runner claims with `claimRow` and never with `appendRow`, whose
-- refusal path writes as actor `hub` on the caller's own connection.
-- The door keeps the platform message id of the progress line it
-- posted on a sheet of its own (`door_progress`), so a door started again
-- mid-turn EDITS the line it inherits rather than posting a second one beside
-- it. It carries `delete` for that sheet alone: a thing that is gone leaves no
-- line behind (L17), and a door that could only add rows would leave one per
-- turn for ever. `door_cursor` and `door_progress` are the door's own sheets
-- and nothing else writes them.
grant select, insert, update, delete on state_row to hub_door;
grant select, insert, update, delete on state_row to hub_runner;

-- The hub keeps the measured peaks and, later, the findings. One row per id,
-- edited in place, and a thing that is gone leaves no line behind.
grant select, insert, update, delete on state_row to hub_hub;
grant select on outbox to hub_hub;

create policy inbound_hub_reads on inbound
  for select to hub_hub using (true);

-- Fresh installs carry the same ordered migration an existing store is upgraded with.
alter table inbound add column source jsonb;
alter table inbound add column log_ready boolean not null default true;
alter table outbox add column route jsonb;
alter table outbox add column delivery_state text not null default 'pending'
  check (delivery_state in ('pending', 'delivered', 'failed'));
alter table outbox add column attempts integer not null default 0 check (attempts >= 0);
alter table outbox add column retry_at timestamptz;
alter table outbox add column failure jsonb;
update outbox set delivery_state = 'delivered' where delivered_at is not null;

grant update (log_ready) on inbound to hub_door;
create policy inbound_door_projects on inbound
  for update to hub_door using (true) with check (true);
grant update (route, delivery_state, attempts, retry_at, failure) on outbox to hub_door;

create function hub_guard_outbox_route() returns trigger
language plpgsql as $$
begin
  if new.route is distinct from old.route
     and (old.route is not null or old.attempts > 0 or old.delivered_at is not null)
  then
    raise exception 'outbox.route is pinned before delivery (id %)', old.id;
  end if;
  return new;
end $$;
create trigger outbox_route_is_pinned before update of route on outbox
  for each row execute function hub_guard_outbox_route();

create or replace function hub_notify_work() returns trigger
language plpgsql as $$
begin
  if new.log_ready then
    perform pg_notify('hub_work', new.agent);
  end if;
  return null;
end $$;
create trigger inbound_projection_ready after update of log_ready on inbound
  for each row when (new.log_ready and not old.log_ready)
  execute function hub_notify_work();

create table schema_version (version integer primary key);
insert into schema_version (version) values (1);

create policy ledger_event_door_operation on ledger_event
  for insert to hub_door
  with check (actor = 'door' and stream = 'operation' and kind in ('failed', 'read-restored'));

-- The door may request a machinery notice, never settle a model reply.
create function hub_door_notice(person_id text, agent_id text, body_text text, key_text text, pinned_route jsonb, part integer)
returns void language sql security definer set search_path = pg_catalog, public as $$
  insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
  values ('notice', null, part, body_text, person_id, agent_id, key_text, pinned_route)
  on conflict (notice_key) do nothing;
$$;
alter function hub_door_notice(text, text, text, text, jsonb, integer) owner to hub_runner;
revoke all on function hub_door_notice(text, text, text, text, jsonb, integer) from public;
grant execute on function hub_door_notice(text, text, text, text, jsonb, integer) to hub_door;

insert into schema_version (version) values (2);

create policy ledger_event_control_request on ledger_event
  for insert to hub_door, hub_hub
  with check (stream = 'control' and kind = 'recovery.requested'
    and actor = case current_user when 'hub_door' then 'door' else 'hub' end);
create policy ledger_event_control_applied on ledger_event
  for insert to hub_runner, hub_hub
  with check (stream = 'control' and kind in ('recovery.applied', 'recovery.refused')
    and actor = case current_user when 'hub_runner' then 'runner' else 'hub' end);

insert into schema_version (version) values (3);

-- The row's own transcription state, five columns the door owns.
--
-- Every one of them is nullable or defaulted, so an insert that says nothing
-- about them is legal unchanged, and a row that predates this step reads five
-- nulls and a zero rather than being reopened.
alter table inbound add column media_state text
  check (media_state in ('pending', 'done', 'failed'));
alter table inbound add column media_attempts integer not null default 0
  check (media_attempts >= 0);
alter table inbound add column media_retry_at timestamptz;
alter table inbound add column media_failure jsonb;
alter table inbound add column media_done_at timestamptz;

-- The door writes the transcript into the message it belongs to, so it needs
-- the text and the provenance beside the step's own state.
grant update (body, source, media_state, media_attempts, media_retry_at,
              media_failure, media_done_at) on inbound to hub_door;

-- The fence, and the reason it is a trigger. A policy cannot see WHICH columns
-- an update touched, and the door already holds a permissive update policy for
-- the projection, which PostgreSQL ORs with any second one. So the rule lives
-- where a column comparison is possible: once a row has been shown to somebody,
-- its text, its provenance and the step's own state are closed. A transcript
-- can never rewrite a message a person has already read.
create function hub_guard_media_columns() returns trigger
language plpgsql as $$
begin
  if old.log_ready
     and (new.body is distinct from old.body
          or new.source is distinct from old.source
          or new.media_state is distinct from old.media_state
          or new.media_attempts is distinct from old.media_attempts
          or new.media_retry_at is distinct from old.media_retry_at
          or new.media_failure is distinct from old.media_failure
          or new.media_done_at is distinct from old.media_done_at)
  then
    raise exception
      'inbound has been shown to somebody: its text and its transcription state are closed (id %)',
      old.id;
  end if;
  return new;
end $$;

create trigger inbound_media_is_closed_once_shown before update on inbound
  for each row execute function hub_guard_media_columns();

-- What the transcription of one note cost, as a diary stream of its own. A
-- SECOND policy beside the door's clock one rather than a widening of it:
-- PostgreSQL ORs permissive policies, so this is purely additive and each
-- fence stays readable as the one sentence it is.
create policy ledger_event_door_media on ledger_event
  for insert to hub_door
  with check (actor = 'door' and stream = 'media'
    and kind in ('transcribe.started', 'transcribe.done', 'transcribe.failed'));

insert into schema_version (version) values (4);

-- A job is a row on the one queue, because a message or job stored outside the
-- one database is forbidden and a table of its own would be a second claim
-- path over the same work.
--
-- THE RANK EXPRESSION IS NOT TOUCHED, and the reason is arithmetic rather than
-- taste: `rank` is a stored generated column, one of the two Postgres majors
-- this runs on cannot alter a generated expression, and a changed one would
-- mean dropping and re-adding a column on the table that holds every message.
-- Adding a kind to a check constraint is a cheap swap. It is also right on its
-- own terms: a job lands on ANOTHER agent's queue, where rank 0 would put one
-- person's errand ahead of the other person's live message, and only the
-- REPORT has to outrank a later human message, which `report` at rank 0
-- already does.
alter table inbound drop constraint inbound_kind_is_known;
alter table inbound add constraint inbound_kind_is_known
  check (kind in ('human', 'report', 'triage', 'room', 'harvest', 'measure', 'job'));

-- When the report landed, which is a different question from when the person
-- asked. A report carries the JOB's own arrival stamp, so the feed puts it
-- ahead of a message that arrived while the job was running, and that stamp is
-- as old as the job is. A clock measured from it has run out before the row
-- exists, and the door would say the agent has not answered in the same second
-- the answer arrives. Written once, by the function below, and null on every
-- other row, which is measured from its own arrival exactly as it is today.
alter table inbound add column reported_at timestamptz;

-- The report a finished job sends back to the agent that dispatched it.
--
-- THE OWNER IS THE ROLE THAT ALREADY WRITES THE TABLE. This one inserts into
-- `inbound`, which the door owns, so the door owns it and the runner is granted
-- it. That is the reverse of `hub_door_notice` beside it, which inserts into
-- `outbox` and is therefore owned by the runner and granted to the door, and a
-- reader comparing the two lines needs the rule rather than the two spellings.
--
-- It is `plpgsql` and not `sql`, which is what its neighbour is: a plain SQL
-- function cannot raise, so the two refusals below would silently insert
-- nothing where they have to refuse by name.
--
-- It takes no destination. The route is read off the job row, so a model that
-- named an address in its answer has nothing to name it into.
create function hub_report(job_id text, report text)
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
  -- `received_at` is the JOB's own and never now(). The feed order is
  -- (rank, received_at, id), so a report stamped at completion time would sort
  -- after a human message that arrived while the job was running.
  insert into public.inbound (id, person, agent, body, kind, received_at, reported_at, source, log_ready)
  values ('report:' || job.id, job.person,
          job.source -> 'dispatch' -> 'return' ->> 'agent', report, 'report', job.received_at, now(),
          jsonb_build_object(
            'log_id', 'report:' || job.id,
            -- The chat line's own instant, which is when the line happens, and
            -- a different question from the stamp above that orders the feed.
            'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'door', job.source -> 'dispatch' -> 'return' ->> 'door',
            'chat', job.source -> 'dispatch' -> 'return' ->> 'chat',
            'from', job.agent,
            'text', report,
            'job', job.id),
          false)
  on conflict (id) do nothing;
  -- Only when the row is new, so a replayed settle lands nothing at all. The
  -- stamp is what puts the report into the household's own timing numbers,
  -- which are computed from the first event of each kind per message.
  if found then
    insert into public.ledger_event (stream, subject, kind, actor)
    values ('inbound', 'report:' || job.id, 'received', 'door');
  end if;
end $$;
alter function hub_report(text, text) owner to hub_door;
revoke all on function hub_report(text, text) from public;
grant execute on function hub_report(text, text) to hub_runner;

-- Who asked for a job and what became of it, as recorded as a recovery is.
-- SECOND policies beside the shipped ones rather than a widening of them:
-- PostgreSQL ORs permissive policies, so this is purely additive and each
-- fence stays readable as the one sentence it is.
create policy ledger_event_control_dispatch on ledger_event
  for insert to hub_door, hub_hub
  with check (stream = 'control' and kind = 'dispatch.requested'
    and actor = case current_user when 'hub_door' then 'door' else 'hub' end);
create policy ledger_event_control_dispatch_result on ledger_event
  for insert to hub_runner, hub_hub
  with check (stream = 'control' and kind in ('dispatch.reported', 'dispatch.refused')
    and actor = case current_user when 'hub_runner' then 'runner' else 'hub' end);

-- A row the runner inserted has no door process in the loop, so the door is
-- told to run the sweep it already runs at startup. The `when` clause is what
-- keeps it scoped: an ordinary human row the door itself accepted fires
-- nothing extra, and a job for an agent with no chat is inserted ready and so
-- costs nothing here either.
create function hub_notify_project() returns trigger
language plpgsql as $$
begin
  if new.source ->> 'door' is not null then
    perform pg_notify('hub_project', new.source ->> 'door');
  end if;
  return null;
end $$;

create trigger inbound_notify_project after insert on inbound
  for each row when (not new.log_ready and new.kind in ('report', 'job'))
  execute function hub_notify_project();

insert into schema_version (version) values (5);
