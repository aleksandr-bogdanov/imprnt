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
-- The door keeps the progress card's immutable chat, its tracking and the final
-- intent it still owes on a sheet of its own (`door_progress`), so a door started
-- again mid-turn finishes the card it inherits rather than posting a second one
-- beside it. Message identity and delivery of an ordinary card live in
-- `platform_effect`, not here. The door carries `delete` for that sheet alone: a
-- thing that is gone leaves no line behind (L17), and a door that could only add
-- rows would leave one per turn for ever. `door_cursor` and `door_progress` are
-- the door's own sheets and nothing else writes them.
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

-- The hub says the outcome of a lifecycle control in the chat it was asked in.
-- It applies those controls because it is the only process that writes the
-- registry, and it owns no insert on `outbox`. The function below writes one
-- keyed machinery notice on a pinned route and nothing else, so granting it is
-- one sentence rather than every row of the table.
grant execute on function hub_door_notice(text, text, text, text, jsonb, integer) to hub_hub;

insert into schema_version (version) values (6);
-- The bytes of every attachment a person sent, beside the row that carries it.
--
-- The door saves a photo, a file or a voice note under its own state directory
-- and the row's body names that path. A runner on another machine has no such
-- file, and one database is the ledger, so the door writes the bytes here in
-- the same transaction as the receipt, and a runner elsewhere writes them into
-- its own person inbox before it feeds the row, checking the hash. Capped by
-- the door's own `door.media_max_bytes`, which it enforces before the save.
create table media (
  inbound_id text    not null references inbound (id),
  index      integer not null check (index >= 0),
  sha256     text    not null,
  kind       text    not null,
  name       text    not null,
  bytes      bytea   not null,
  primary key (inbound_id, index)
);

grant select, insert on media to hub_door;
grant select on media to hub_runner;

insert into schema_version (version) values (7);
-- The one job row a hunt writes for its triage master.
--
-- A hunt runs as the hub's role, which holds no insert on `inbound`, and the
-- row has to land in the same transaction as the hunt's state, its notices and
-- its stamp. So the insert goes through a function owned by the role that
-- already writes the table, which is the door's, exactly as `hub_report` is,
-- and it is granted to the hub. It writes the row in the shape the door writes
-- a dispatched job: kind `job`, the provenance carrying the approval digest
-- and the return route, unprojected when the master has a chat, so the
-- runner's own gate admits it and the door projects it. True when the row is
-- new, so a replayed tick lands no second job and no second receipt.
create function hub_watch_job(job_id text, person_id text, agent_id text, task text, provenance jsonb)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.inbound (id, person, agent, body, kind, source, log_ready)
  values (job_id, person_id, agent_id, task, 'job', provenance, false)
  on conflict (id) do nothing;
  if not found then
    return false;
  end if;
  insert into public.ledger_event (stream, subject, kind, actor)
  values ('inbound', job_id, 'received', 'door');
  return true;
end $$;
alter function hub_watch_job(text, text, text, text, jsonb) owner to hub_door;
revoke all on function hub_watch_job(text, text, text, text, jsonb) from public;
grant execute on function hub_watch_job(text, text, text, text, jsonb) to hub_hub;

insert into schema_version (version) values (8);
-- The report on a hunt's triage job carries the watcher's mark.
--
-- The job row itself is written by the hunt with `origin` in its provenance.
-- The report is written by this function from the job it reports on, so the
-- mark is read off the job's approval and carried onto the report's
-- provenance the same way: both projections then put it on the chat line, and
-- both tails leave the line out. Nothing else about the function changes.
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
          || case when job.source -> 'dispatch' -> 'approved' ->> 'source' = 'watch'
                  then jsonb_build_object('origin', 'watcher') else '{}'::jsonb end,
          false)
  on conflict (id) do nothing;
  if found then
    insert into public.ledger_event (stream, subject, kind, actor)
    values ('inbound', 'report:' || job.id, 'received', 'door');
  end if;
end $$;

insert into schema_version (version) values (9);
-- A council: one question, one job per seat, one merged answer.
--
-- The door convenes it and says so in the diary, one line for the council
-- beside the `dispatch.requested` line each seat's job already gets. A SECOND
-- policy beside the shipped ones rather than a widening of them, for the
-- reason the dispatch policies give: PostgreSQL ORs permissive policies, so
-- this is purely additive and each fence stays readable as one sentence.
create policy ledger_event_control_council_request on ledger_event
  for insert to hub_door, hub_hub
  with check (stream = 'control' and kind = 'council.requested'
    and actor = case current_user when 'hub_door' then 'door' else 'hub' end);

-- The report on a council seat's job carries the council's mark, the way the
-- report on a hunt's triage job carries the watcher's: read off the job's
-- approval and put on the report's provenance, so the projection puts it on
-- the chat line and both tails leave the line out. Nothing else changes.
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
          || case job.source -> 'dispatch' -> 'approved' ->> 'source'
               when 'watch' then jsonb_build_object('origin', 'watcher')
               when 'council' then jsonb_build_object('origin', 'council')
               else '{}'::jsonb end,
          false)
  on conflict (id) do nothing;
  if found then
    insert into public.ledger_event (stream, subject, kind, actor)
    values ('inbound', 'report:' || job.id, 'received', 'door');
  end if;
end $$;

-- The one row a finished council writes: the merge, for the agent whose chat
-- the question was typed in.
--
-- The runner writes it at the last seat's settle and holds no insert on
-- `inbound`, so it goes through a function owned by the role that already
-- writes the table, the door's, and granted to the runner, exactly as
-- `hub_report` is. It is a `report` (rank 0, so the person waiting on it is
-- answered before a later message), it carries the council's own arrival so
-- the feed puts it where the question was, and `reported_at` is now() so the
-- door's clocks measure from the moment it landed rather than from the
-- question underneath it. Unprojected, so the door writes its line into the
-- chat log with the council mark before the runner feeds it. True when the
-- row is new, so a replayed settle lands no second merge and no second receipt.
create function hub_council_merge(council_id text, agent_id text, person_id text, body text, route jsonb, at timestamptz)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.inbound (id, person, agent, body, kind, received_at, reported_at, source, log_ready)
  values ('merge:' || council_id, person_id, agent_id, body, 'report', at, now(),
          jsonb_build_object(
            'log_id', 'merge:' || council_id,
            'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'door', route ->> 'door',
            'chat', route ->> 'chat',
            'from', 'council',
            'text', body,
            'council', council_id,
            'origin', 'council'),
          false)
  on conflict (id) do nothing;
  if not found then
    return false;
  end if;
  insert into public.ledger_event (stream, subject, kind, actor)
  values ('inbound', 'merge:' || council_id, 'received', 'door');
  return true;
end $$;
alter function hub_council_merge(text, text, text, text, jsonb, timestamptz) owner to hub_door;
revoke all on function hub_council_merge(text, text, text, text, jsonb, timestamptz) from public;
grant execute on function hub_council_merge(text, text, text, text, jsonb, timestamptz) to hub_runner;

-- What became of a council and of a seat given up on, as the runner records a
-- report or a refusal. The door writes the merge line too, when it is the
-- door that closed the last open seats of a council past the grace.
create policy ledger_event_control_council_result on ledger_event
  for insert to hub_runner, hub_door, hub_hub
  with check (stream = 'control' and kind in ('council.merged', 'dispatch.abandoned')
    and actor = case current_user when 'hub_runner' then 'runner' when 'hub_door' then 'door' else 'hub' end);

-- A council seat nobody claimed, given up on by the DOOR once the council's
-- grace has run out.
--
-- The runner gives up a seat whose turn keeps failing, in its own settle
-- path, but a seat whose runner is off is claimed by nobody and would hold
-- the council open until that runner returns. The door is the process that
-- already judges the council late, so it closes those seats, and it does so
-- through a function owned by the runner's role, whose stamp and diary line
-- these are, granted to the door. Only an UNCLAIMED, unanswered job is
-- closed: a seat some runner holds is working, and its own runner settles
-- or gives it up. A lease that has run out is not evidence the turn stopped,
-- because the claim's deadline is fixed when the row is claimed and a long
-- turn outlives it, so a claimed seat is left alone whatever its deadline
-- says. True when the seat was closed here.
create function hub_council_abandon(job_id text, cause text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  job public.inbound%rowtype;
begin
  select * into job from public.inbound where id = job_id for update;
  if not found or job.kind <> 'job' or job.state in ('answered', 'delivered') then
    return false;
  end if;
  if job.claimed_by is not null then
    return false;
  end if;
  insert into public.ledger_event (stream, subject, kind, actor)
  values ('inbound', job_id, 'answered', 'runner');
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  values ('control', job_id, 'dispatch.abandoned', 'runner',
          jsonb_build_object('agent', job.agent, 'runner', null, 'cause', cause,
            'dispatcher', job.source -> 'dispatch' ->> 'dispatcher',
            'council', job.source -> 'dispatch' -> 'council' ->> 'id', 'by', 'door'));
  update public.inbound set claimed_by = null, claim_deadline = null where id = job_id;
  return true;
end $$;
alter function hub_council_abandon(text, text) owner to hub_runner;
revoke all on function hub_council_abandon(text, text) from public;
grant execute on function hub_council_abandon(text, text) to hub_door;

insert into schema_version (version) values (10);
-- Durable conversations and explicit execution controls.
--
-- A JOB IS AN ASSIGNMENT, A TURN IS AN INBOUND ROW, AN ATTEMPT IS AN EXECUTION
-- AND A CONVERSATION IS WHAT THE ENGINE REMEMBERS. Until now the four were one
-- thing: a claimed row that was not settled was fed to the loop again, so a
-- crash between the feed and the settle repeated whatever the first attempt had
-- already done. From here a row that reached the engine is never fed twice by
-- machinery. What the store keeps instead is below.
--
-- Additive only: nothing here changes an existing column, and the only old
-- object touched is one trigger added to `inbound`, which is the fence that
-- lets a runner written before this step be refused a row it does not know is
-- held.

-- One conversation per master and one per new job. `native_session` is the id
-- the engine is launched with the first time and resumed with after, chosen here
-- so it is durable before the engine has heard of it. `native_state` is what the
-- hub has actually seen of it: new (never launched), launched (a child was
-- started under this id and the engine has NOT acknowledged anything under it, so
-- the id may or may not exist in the engine and is never taken for a new one),
-- started (the engine took a message), verified (the engine reported this very
-- id back).
create table conversation (
  id                   text primary key,
  person               text not null,
  agent                text not null,
  kind                 text not null check (kind in ('master', 'worker')),
  owner_ref            text,
  adapter              text not null,
  machine              text,
  placement_generation integer not null default 1 check (placement_generation >= 1),
  native_session       text not null,
  native_state         text not null default 'new'
                         check (native_state in ('new', 'launched', 'started', 'verified')),
  created_at           timestamptz not null default now(),
  constraint conversation_worker_has_owner check (kind = 'master' or owner_ref is not null)
);
create unique index conversation_one_master on conversation (agent) where kind = 'master';
create unique index conversation_one_per_job on conversation (owner_ref) where kind = 'worker';

-- What was put into a conversation and what came out of it, in order.
create table conversation_entry (
  conversation_id text not null references conversation (id),
  seq             integer not null check (seq >= 1),
  source_id       text not null,
  kind            text not null check (kind in ('input', 'reply', 'recovery')),
  body            text not null,
  partial         boolean not null default false,
  execution_id    text,
  at              timestamptz not null default now(),
  primary key (conversation_id, seq),
  unique (conversation_id, source_id, kind)
);

-- One attempt to run one input. The states that mean "something may be running
-- or may have run" are the ones the partial indexes below name, and there is at
-- most one of them per conversation: a second launch is refused by the table,
-- not by a clock.
--
--   claimed      the row is claimed and nothing was fed. Known to have done nothing.
--   feed_intent  committed BEFORE any byte goes to the engine. A crash after this
--                and before a receipt is uncertain, whatever `acked` says.
--   received     the engine acknowledged the exact message.
--   running      the engine produced something.
--   completed    settled. Terminal.
--   failed       ended before the engine was given the input. Terminal, no effects.
--   interrupted  the attempt is CONFIRMED over without a final result. Terminal;
--                the input it ran stays held (`replay_hold`).
--   unknown      ownership is unresolved: nobody has shown the process is gone.
--                The exclusive slot stays taken.
--   stop_requested / stopped / stop_unknown
--                an explicit stop: asked, confirmed by evidence, or not provable.
--
-- `purpose` is what the attempt runs: a turn of an input, or a `tail`, the chat
-- log a master's fresh child is primed with. A tail has no input row, but it is a
-- model turn like any other and is owned the same way, so it can never run beside
-- another attempt of the agent.
create table execution (
  id                   text primary key,
  inbound_id           text references inbound (id),
  conversation_id      text not null references conversation (id),
  agent                text not null,
  runner               text not null,
  incarnation          text not null,
  placement_generation integer not null check (placement_generation >= 1),
  state                text not null check (state in (
                         'claimed', 'feed_intent', 'received', 'running', 'completed', 'failed',
                         'interrupted', 'unknown', 'stop_requested', 'stopped', 'stop_unknown')),
  input_digest         text not null,
  purpose              text not null default 'turn' check (purpose in ('turn', 'tail')),
  native_session       text,
  feed_intent_at       timestamptz,
  result               jsonb,
  evidence             jsonb not null default '{}'::jsonb,
  effects              jsonb not null default '{}'::jsonb,
  started_at           timestamptz not null default now(),
  ended_at             timestamptz,
  constraint execution_turn_has_input check (purpose = 'tail' or inbound_id is not null)
);
create unique index execution_one_unresolved on execution (conversation_id)
  where state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown');
-- ONE CONFIGURED EXECUTOR PER AGENT, by the table. Two jobs of one worker are two
-- conversations, so the index above cannot see them together: this one can, and a
-- second claimant that gets past every check still fails here, at the insert.
create unique index execution_one_per_agent on execution (agent)
  where state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown');
create index execution_by_inbound on execution (inbound_id);

-- The original input of an attempt that reached the engine and did not finish.
-- It is never claimable again. `revision` moves whenever what is known about the
-- attempt changes, and a choice made against an older one is void.
--
-- `native_context` is what the runner MEASURED about whether the conversation can
-- take a turn on a resumable native context, scoped to THIS attempt at THIS revision
-- and to the engine it was measured on: {state: ready | unavailable | pending,
-- cause, engine, at}. It is read by the door, the hub's tool and `check`, so that an
-- owner who chose to continue is told what the continuation is waiting for and not
-- that it is queued behind a turn that will never run. Null is "not measured" and
-- is said as pending verification, never as ready; a runner that starts or stops
-- resets it to pending, so a status measured on an engine or a configuration that
-- has since changed is not shown as current.
create table replay_hold (
  inbound_id        text primary key references inbound (id),
  execution_id      text not null references execution (id),
  conversation_id   text not null references conversation (id),
  cause             text not null check (cause in ('interrupted', 'ownership-unknown', 'stopped')),
  state             text not null default 'held'
                      check (state in ('held', 'keep_held', 'continue_pending', 'continuing', 'released')),
  revision          integer not null default 1 check (revision >= 1),
  choice            text check (choice in ('continue', 'keep_held')),
  chosen_by         text,
  chosen_at         timestamptz,
  evidence          jsonb,
  continuation_body text,
  continuation_id   text,
  native_context    jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index replay_hold_open on replay_hold (conversation_id) where state <> 'released';
create index replay_hold_by_execution on replay_hold (execution_id);

-- A tool call the engine made through the hub's own facade, recorded before it
-- is applied. The key is scoped to the conversation that made it, so a model
-- that restarts and asks again meets its own earlier answer, and a changed
-- argument under the same key is a conflict rather than a second request.
create table tool_invocation (
  conversation_id text not null references conversation (id),
  request_key     text not null,
  tool            text not null,
  action          text not null,
  payload_hash    text not null,
  execution_id    text,
  result          jsonb,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, request_key)
);

-- A message a person wrote, once it has authorized something. One source, one
-- intent: the same message cannot authorize two different requests.
create table source_consumption (
  source_id       text primary key references inbound (id),
  conversation_id text not null,
  request_key     text not null,
  payload_hash    text not null,
  at              timestamptz not null default now(),
  foreign key (conversation_id, request_key) references tool_invocation (conversation_id, request_key)
);

-- THE CURRENT INCARNATION OF EACH RUNNER. A runner registers a new incarnation
-- when it starts, and the newest registration wins: an attempt is opened, fed and
-- settled only by the incarnation that is current, so an older process of the
-- same runner (a service manager's overlap, a hung process that wakes up) is
-- fenced out by the row and not by anybody's clock. `machine` and `boot_id` say
-- where and in which boot the incarnation ran, which is what later lets a
-- reboot be told from a runner that merely stopped.
create table runner_incarnation (
  runner      text primary key,
  incarnation text not null,
  protocol    integer not null check (protocol >= 2),
  machine     text,
  boot_id     text,
  started_at  timestamptz not null default now()
);

-- THE PROTOCOL THE FLEET SPEAKS. 1 is every runner before this step, which feeds a
-- claimed row again after a crash and takes an expired lease for a dead process.
-- A runner that speaks 2 moves it forward, once, when it starts; from then on a
-- claim by anything that does not say it speaks 2 is refused by the claim trigger
-- below, on whichever connection it comes. It only moves forward, and it does not
-- move while an input that an old runner may have fed is in flight (see
-- `hub_legacy_inputs`), because nothing could then say what became of it.
create table hub_protocol (
  singleton       boolean primary key default true check (singleton),
  runner_protocol integer not null default 1 check (runner_protocol in (1, 2)),
  activated_at    timestamptz
);
insert into hub_protocol default values;

grant select, insert, update on conversation, conversation_entry, execution, replay_hold,
  tool_invocation, source_consumption, runner_incarnation to hub_runner;
grant select on hub_protocol to hub_runner, hub_door, hub_hub;
grant update (runner_protocol, activated_at) on hub_protocol to hub_runner;
grant select on conversation, conversation_entry, execution, replay_hold,
  tool_invocation, source_consumption, runner_incarnation to hub_door, hub_hub;
-- The door records an owner's choice through the function below, which it owns.
grant update on replay_hold to hub_door;

-- The diary lines of this step. `execution` is the runner's; the two the door
-- writes are the ones its recovery choice function appends.
create policy ledger_event_runner_execution on ledger_event
  for insert to hub_runner
  with check (actor = 'runner' and stream = 'execution');
create policy ledger_event_door_execution on ledger_event
  for insert to hub_door
  with check (actor = 'door' and stream = 'execution'
              and kind in ('hold.choice', 'continuation.queued'));

-- Whether a row must not be fed by machinery. Two separate facts make it so, and
-- only the first is ever undone:
--   * an open hold on it (`replay_hold`, not released): the OWNER'S gate, moved by
--     the owner's choice and released once a continuation owns the conversation;
--   * an attempt that may have handed it to the engine and did not settle: the
--     REPLAY predicate. It is durable and permanent. Releasing a hold, queuing or
--     running a continuation, or a recovery that resolved never reopens it, so
--     the original input is not fed twice by anything. It is not stamped answered
--     either, because it was not: the model never produced its answer.
-- A `failed` attempt (never given the input) and a `claimed` one (nothing fed)
-- are not in the second set: those rows are tried again.
create function hub_row_held(row_id text) returns boolean
language sql stable as $$
  select exists (select 1 from public.replay_hold h where h.inbound_id = row_id and h.state <> 'released')
      or exists (select 1 from public.execution e
                  where e.inbound_id = row_id
                    and e.state in ('feed_intent', 'received', 'running', 'unknown',
                                    'stop_requested', 'stop_unknown', 'interrupted', 'stopped'))
$$;

-- Whether an agent has an attempt that may be running or whose ownership is
-- unresolved. While it does, nothing else of the agent's is claimed.
create function hub_agent_blocked(agent_id text) returns boolean
language sql stable as $$
  select exists (select 1 from public.execution e
                  where e.agent = agent_id
                    and e.state in ('claimed', 'feed_intent', 'received', 'running',
                                    'unknown', 'stop_requested', 'stop_unknown'))
$$;

-- Whether a SCHEDULED harvest may not be claimed for an agent, by the runner that
-- would claim it. A harvest runs in a session of its own beside the agent's live
-- turn, so an attempt of the claimant's own current incarnation (a turn that is
-- running, a priming tail) does not stop it. Everything else does: an attempt whose
-- ownership is unresolved (`unknown`, `stop_unknown`, `stop_requested`), and an
-- attempt that belongs to another runner or to an incarnation that is no longer the
-- current one, because nothing shows that its process is gone and a harvest is
-- another executor of the same agent's tools. It is not a scheduling redesign: it is
-- the same ownership question every other claim asks.
create function hub_harvest_blocked(agent_id text, claimant text) returns boolean
language sql stable as $$
  select exists (select 1 from public.execution e
                  where e.agent = agent_id
                    and e.state in ('claimed', 'feed_intent', 'received', 'running',
                                    'unknown', 'stop_requested', 'stop_unknown')
                    and (e.state in ('unknown', 'stop_requested', 'stop_unknown')
                         or e.runner is distinct from claimant
                         or not exists (select 1 from public.runner_incarnation r
                                         where r.runner = e.runner and r.incarnation = e.incarnation)))
$$;

-- Whether the conversation this row belongs to has an interrupted assignment
-- held. A row of such a conversation may only run on a native context that
-- resumes without replaying what the interrupted attempt left unfinished, and
-- whether it can is the runner's to say: this function only says it is asked.
-- A harvest is not asked: it runs in a session of its own and is nobody's turn.
create function hub_row_needs_resume(row_id text, agent_id text, row_kind text, row_source jsonb)
returns boolean language sql stable as $$
  select row_kind <> 'harvest' and exists (
    select 1 from public.replay_hold h
     where h.state <> 'released'
       and h.conversation_id = case when row_kind = 'job'
             then coalesce(row_source -> 'dispatch' ->> 'conversation',
                           (select c.id from public.conversation c where c.kind = 'worker' and c.owner_ref = row_id))
             else (select c.id from public.conversation c where c.kind = 'master' and c.agent = agent_id) end)
$$;

-- THE FENCE THAT DOES NOT DEPEND ON THE RUNNER'S VERSION. A runner that predates
-- this step claims with a statement that knows nothing about holds or attempts,
-- and its own lease arithmetic treats an expired lease as a dead process. It
-- meets this instead: a claim of a held row, or of any row of an agent whose
-- attempt is unresolved, is refused by the table. Releasing a claim is not a
-- claim and is untouched.
--
-- ONCE THE PROTOCOL IS ACTIVATED (`hub_protocol`), every claim made by the runner
-- role has to say it speaks protocol 2, and it says so with a setting that lives
-- in the claiming TRANSACTION only (`set_config(..., true)`): a pooled connection
-- that claimed under protocol 2 hands the next borrower nothing. A runner that
-- does not say it, which is every runner written before this step, is refused on
-- every claim of every row, whichever connection it comes on. Other roles and
-- superuser tooling do not claim work and are not asked.
--
-- THE CLAIM AND THE ACTIVATION ARE ORDERED BY A ROW LOCK, NOT BY A CLOCK. A claim
-- that does not say it speaks protocol 2 reads the protocol with `for share` and
-- holds that lock until its transaction ends; the activation is an update of the
-- same row, which waits for every such claim to finish, and its guard then looks
-- for in-flight inputs AFTER it has waited, so it sees what the claim committed.
-- The other way round, a claim that arrives while the activation is in flight
-- waits on the row and then reads the protocol as activated, and is refused. Either
-- order ends in a refusal and neither can pass the other. A claim that DOES say it
-- speaks protocol 2 is allowed by either state and takes no lock. The lock is
-- taken by the claiming role itself: `for share` needs an update privilege on the
-- table, which the runner role holds on the two columns activation writes.
-- Nothing in it is a lease, a broker or a wait on time.
create function hub_guard_inbound_claim() returns trigger
language plpgsql as $$
declare
  active integer;
  unavailable boolean;
begin
  if new.claimed_by is not null
     and (new.claimed_by is distinct from old.claimed_by
          or new.claim_deadline is distinct from old.claim_deadline)
  then
    if current_user = 'hub_runner' and coalesce(current_setting('hub.runner_protocol', true), '') <> '2' then
      select p.runner_protocol into active from public.hub_protocol p for share;
      if active >= 2 then
        raise exception
          'inbound % is claimed by a runner that does not speak protocol 2: it is not claimable', new.id;
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
create trigger inbound_claim_honours_holds
  before update of claimed_by, claim_deadline on inbound
  for each row execute function hub_guard_inbound_claim();

-- The owner's authorized continuation, queued once the attempt is known to be
-- over. It is a NEW input on the same conversation carrying the chosen context,
-- so the original input is never fed again. Owned by the door because it
-- inserts into `inbound`, granted to the runner and the hub exactly as
-- `hub_report` is. True state is returned, so a caller can say it.
create function hub_hold_advance(hold_id text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  h public.replay_hold%rowtype;
  e public.execution%rowtype;
  i public.inbound%rowtype;
  next_id text;
  digest text;
begin
  select * into h from public.replay_hold where inbound_id = hold_id for update;
  if not found then return null; end if;
  if h.state <> 'continue_pending' then return h.state; end if;
  select * into e from public.execution where id = h.execution_id;
  -- The old process is not shown to be gone until the attempt is terminal.
  if e.state not in ('interrupted', 'stopped', 'failed', 'completed') then return h.state; end if;
  select * into i from public.inbound where id = hold_id;
  next_id := 'continue:' || hold_id || ':' || h.revision;
  digest := encode(sha256(convert_to(h.continuation_body, 'UTF8')), 'hex');
  insert into public.inbound (id, person, agent, body, kind, source, log_ready)
  values (next_id, i.person, i.agent, h.continuation_body,
          case when i.kind = 'job' then 'job' else 'human' end,
          case when i.kind = 'job' then
            jsonb_set(
              jsonb_set(
                jsonb_set(i.source, '{dispatch,approved}',
                  jsonb_build_object('by', h.chosen_by,
                    'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                    'digest', digest, 'source', 'recovery')),
                '{dispatch,conversation}', to_jsonb(h.conversation_id)),
              '{dispatch,continues}', to_jsonb(hold_id))
            || jsonb_build_object('log_id', next_id, 'text', h.continuation_body)
          else null end,
          true)
  on conflict (id) do nothing;
  if found then
    insert into public.ledger_event (stream, subject, kind, actor)
    values ('inbound', next_id, 'received', 'door');
  end if;
  update public.replay_hold
     set state = 'continuing', continuation_id = next_id, updated_at = now()
   where inbound_id = hold_id;
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  values ('execution', h.execution_id, 'continuation.queued', 'door',
          jsonb_build_object('hold', hold_id, 'continuation', next_id, 'revision', h.revision));
  return 'continuing';
end $$;
alter function hub_hold_advance(text) owner to hub_door;
revoke all on function hub_hold_advance(text) from public;
grant execute on function hub_hold_advance(text) to hub_door, hub_runner, hub_hub;

-- The owner's choice about ONE attempt at ONE recovery revision. It returns what
-- became of it and never raises for a stale or closed one, so a door can say so.
-- `continue` does not start anything: it queues the continuation once the attempt
-- is terminal, and until then it waits for that evidence.
create function hub_hold_choice(attempt_id text, agent_id text, expected_revision integer,
                                picked text, who text, proof jsonb, body text)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  h public.replay_hold%rowtype;
begin
  select r.* into h from public.replay_hold r
    join public.execution e on e.id = r.execution_id
   where r.execution_id = attempt_id and e.agent = agent_id
   for update of r;
  if not found then return 'unknown-attempt'; end if;
  if picked not in ('continue', 'keep_held') then return 'invalid-choice'; end if;
  if h.revision <> expected_revision then return 'stale-revision'; end if;
  if h.state in ('continuing', 'released') then return 'closed'; end if;
  update public.replay_hold
     set choice = picked, chosen_by = who, chosen_at = now(), evidence = proof,
         continuation_body = case when picked = 'continue' then body else null end,
         state = case when picked = 'continue' then 'continue_pending' else 'keep_held' end,
         updated_at = now()
   where inbound_id = h.inbound_id;
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  values ('execution', attempt_id, 'hold.choice', 'door',
          jsonb_build_object('choice', picked, 'by', who, 'revision', h.revision, 'inbound', h.inbound_id));
  if picked = 'continue' then
    return hub_hold_advance(h.inbound_id);
  end if;
  return 'keep_held';
end $$;
alter function hub_hold_choice(text, text, integer, text, text, jsonb, text) owner to hub_door;
revoke all on function hub_hold_choice(text, text, integer, text, text, jsonb, text) from public;
grant execute on function hub_hold_choice(text, text, integer, text, text, jsonb, text)
  to hub_door, hub_runner, hub_hub;

-- INPUTS THAT A RUNNER BEFORE THIS STEP MAY HAVE HANDED TO THE ENGINE. Such a
-- runner keeps no attempt, so nothing here can say whether the engine did any of
-- it or whether its process is still running, and a row it fed and did not settle
-- is exactly what it would feed again. Guessing (an attempt of unknown ownership
-- per row) cannot be made sound: the table allows one unresolved attempt per
-- agent, and a positive "it exited" cannot be invented for a process nobody
-- recorded. So the step REFUSES instead, and so does the protocol's activation:
-- they need the old runners stopped and each such input settled or discarded by
-- somebody who can say what became of it. A row that is unanswered and either
-- acked or started, or claimed and merely received, and that has no attempt.
create function hub_legacy_inputs() returns setof text
language sql stable as $$
  select i.id
    from public.inbound i
   where i.kind not in ('harvest', 'measure')
     and i.state not in ('answered', 'delivered')
     and (i.state in ('acked', 'started') or (i.claimed_by is not null and i.state = 'received'))
     and not exists (select 1 from public.execution e where e.inbound_id = i.id)
   order by i.received_at, i.id
$$;

create function hub_guard_protocol_activation() returns trigger
language plpgsql as $$
declare
  pending text;
begin
  if new.runner_protocol < old.runner_protocol then
    raise exception 'the runner protocol only moves forward';
  end if;
  if new.runner_protocol > old.runner_protocol then
    select string_agg(l.x, ', ') into pending from (select x from public.hub_legacy_inputs() as x limit 20) l;
    if pending is not null then
      raise exception
        'legacy-inputs-in-flight: stop every runner that predates protocol 2 and settle or discard these inputs first: %', pending;
    end if;
  end if;
  return new;
end $$;
create trigger hub_protocol_activation
  before update on hub_protocol
  for each row execute function hub_guard_protocol_activation();

do $$
declare
  pending text;
begin
  select string_agg(l.x, ', ') into pending from (select x from hub_legacy_inputs() as x limit 20) l;
  if pending is not null then
    raise exception
      'migration-not-quiescent: stop every runner and settle or discard these inputs before applying migration 11: %', pending;
  end if;
end $$;

-- A COUNCIL SEAT THAT IS HELD, OR WHOSE OWNERSHIP IS UNRESOLVED, IS NOT ABANDONED.
-- The council's grace treats an unclaimed seat as one nobody works on. A seat
-- whose attempt was interrupted, is waiting on its owner's choice, or may still be
-- running is none of that: closing the council over it would merge a partial
-- council and stamp answered work the model never answered. It stays open until
-- its attempt is settled or its owner decides. Nothing else about the function
-- changes.
create or replace function hub_council_abandon(job_id text, cause text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  job public.inbound%rowtype;
begin
  select * into job from public.inbound where id = job_id for update;
  if not found or job.kind <> 'job' or job.state in ('answered', 'delivered') then
    return false;
  end if;
  if job.claimed_by is not null then
    return false;
  end if;
  if public.hub_row_held(job_id)
     or exists (select 1 from public.execution e
                 where e.inbound_id = job_id
                   and e.state in ('claimed', 'feed_intent', 'received', 'running', 'unknown',
                                   'stop_requested', 'stop_unknown'))
  then
    return false;
  end if;
  insert into public.ledger_event (stream, subject, kind, actor)
  values ('inbound', job_id, 'answered', 'runner');
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  values ('control', job_id, 'dispatch.abandoned', 'runner',
          jsonb_build_object('agent', job.agent, 'runner', null, 'cause', cause,
            'dispatcher', job.source -> 'dispatch' ->> 'dispatcher',
            'council', job.source -> 'dispatch' -> 'council' ->> 'id', 'by', 'door'));
  update public.inbound set claimed_by = null, claim_deadline = null where id = job_id;
  return true;
end $$;

insert into schema_version (version) values (11);
-- Platform message effects and frozen-preview confirmations.
--
-- TWO RECORDS, ONE MECHANISM. `platform_effect` is one row per chat message the
-- hub creates and then keeps editing: it is written BEFORE anything is sent, so a
-- door killed between the platform accepting a post and the id being saved leaves
-- a row that says what was sent, under which nonce and marker, and that is what a
-- restarted door needs to look for the original instead of making a second.
-- `confirmation` is one frozen preview and the one approval it can earn.
--
-- Additive only: nothing here changes an existing object. Ordinary replies still go
-- through `outbox`. An ordinary progress card's message identity and delivery are
-- owned by `platform_effect`; `door_progress` keeps its immutable chat, tracking and
-- final intent obligation.
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

insert into schema_version (version) values (12);
