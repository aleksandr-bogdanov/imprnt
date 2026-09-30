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
-- Durable execution controls: scoped claim gates and targeted stop requests.
--
-- TWO RECORDS THAT OTHER OPERATIONS (a council's stop, a topic's archive, a move)
-- BUILD ON, and nothing else. Neither decides who may ask: that is the caller's,
-- checked where the caller checks it (a tool call's source evidence, the door's
-- sender list). What these hold is what was asked, in whose name, and what is
-- actually known about it.
--
-- Additive only. The one old object changed is `hub_row_held`, which is how every
-- claim path already asks "may this row be fed"; it now also says no while a gate
-- covers the row. `create or replace` keeps its name, arguments and owner, so the
-- claim trigger, the runner's selection, `readEligible`, the council's abandon
-- and `check` all see the gates without being edited.

-- A CLAIM GATE: while it is open, NEW claims are refused for what it covers.
--
--   row           one input
--   agent         every input of one agent (any kind, a scheduled harvest included)
--   conversation  the inputs of one conversation: a master's own, a job's that
--                 names it (an explicit follow-up), and a worker's own job
--
-- A gate is owned by the OPERATION that placed it (`operation_id`), once per scope:
-- asking again for the same operation and scope is the same gate, and after it was
-- released asking again does NOT reopen it, so a replayed request cannot hold work
-- an operation already finished with. Releasing one operation's gates touches no
-- other operation's, and touches no `replay_hold`: the owner's gate on an
-- interrupted input is not this table's to lift.
--
-- A gate refuses a claim; it interrupts nothing. An attempt that already owns the
-- agent goes on to its result, and nothing is stamped answered to make waiting
-- work look finished. `cause` is the owner's own label (archive, council, a move);
-- nothing reads it to decide who is let through, because nothing lets anybody
-- through: there is no exception list here, and no sensitivity.
create table claim_gate (
  operation_id text not null check (operation_id <> ''),
  scope_kind   text not null check (scope_kind in ('row', 'agent', 'conversation')),
  scope_id     text not null check (scope_id <> ''),
  cause        text not null check (char_length(cause) between 1 and 60),
  state        text not null default 'open' check (state in ('open', 'released')),
  evidence     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  released_at  timestamptz,
  primary key (operation_id, scope_kind, scope_id),
  constraint claim_gate_released_has_time check ((state = 'released') = (released_at is not null))
);
create index claim_gate_open on claim_gate (scope_kind, scope_id) where state = 'open';

create function hub_guard_claim_gate() returns trigger
language plpgsql as $$
begin
  if new.operation_id is distinct from old.operation_id or new.scope_kind is distinct from old.scope_kind
     or new.scope_id is distinct from old.scope_id or new.cause is distinct from old.cause
     or new.created_at is distinct from old.created_at then
    raise exception 'gate % on % % is identified by its operation, scope and cause, and none of them changes',
      old.operation_id, old.scope_kind, old.scope_id;
  end if;
  if old.state = 'released' and new.state <> 'released' then
    raise exception 'gate % on % % is released and stays so', old.operation_id, old.scope_kind, old.scope_id;
  end if;
  return new;
end $$;
create trigger claim_gate_rules
  before update on claim_gate
  for each row execute function hub_guard_claim_gate();

-- The conversation a row belongs to, read the way `hub_row_needs_resume` reads it:
-- a job's is the one it names or its own, anything else is its agent's master, and
-- a harvest is nobody's turn. Null when the row has none yet: a conversation is
-- made when its row is first claimed, so a new job's cannot be gated beforehand.
create function hub_row_conversation(row_id text) returns text
language sql stable as $$
  select case when i.kind = 'harvest' then null
              when i.kind = 'job' then coalesce(i.source -> 'dispatch' ->> 'conversation',
                     (select c.id from public.conversation c where c.kind = 'worker' and c.owner_ref = i.id))
              else (select c.id from public.conversation c where c.kind = 'master' and c.agent = i.agent) end
    from public.inbound i where i.id = row_id
$$;

-- Whether an open gate covers an input, by the three things a gate can be about:
-- the input itself, its agent, and its conversation. It is the gate half of
-- `hub_row_held` and nothing else: no hold, no attempt. The opening of an attempt
-- asks exactly this (an existing hold has its own meaning there: the owner's
-- continuation is opened under it), and a tail, which has no input, asks it with
-- a null row.
create function hub_gate_covers(agent_id text, conversation_id text, row_id text) returns boolean
language sql stable as $$
  select exists (select 1 from public.claim_gate g
                  where g.state = 'open'
                    and ((g.scope_kind = 'row' and g.scope_id = row_id)
                      or (g.scope_kind = 'agent' and g.scope_id = agent_id)
                      or (g.scope_kind = 'conversation' and g.scope_id = conversation_id)))
$$;

-- Whether a row must not be fed by machinery: the two facts it already said (an
-- open hold, an attempt that may have handed it to the engine) and now an open
-- gate over the row, its agent or its conversation.
create or replace function hub_row_held(row_id text) returns boolean
language sql stable as $$
  select exists (select 1 from public.replay_hold h where h.inbound_id = row_id and h.state <> 'released')
      or exists (select 1 from public.execution e
                  where e.inbound_id = row_id
                    and e.state in ('feed_intent', 'received', 'running', 'unknown',
                                    'stop_requested', 'stop_unknown', 'interrupted', 'stopped'))
      or public.hub_gate_covers((select i.agent from public.inbound i where i.id = row_id),
                                public.hub_row_conversation(row_id), row_id)
$$;

-- THE ORDERING POINT BETWEEN PLACING A GATE AND OPENING AN ATTEMPT. A claim that
-- committed before a gate can still be on its way to opening an attempt, and a
-- statement that read the gates before the gate committed can insert after a
-- consumer has looked and found nothing. A check inside the insert alone proves
-- only the case where the gate had already committed. So both sides take this one
-- transaction-scoped lock, per agent, in a statement of their own BEFORE the one
-- that reads the gates (and the next statement reads the committed world again):
--   * a gate placed first is committed before an opening gets past the lock, and
--     the opening reads it and is refused;
--   * an opening that got the lock first commits its attempt before the gate is
--     placed, and whoever placed the gate then sees that attempt.
-- Nothing else is done under it: no process is waited for, and the holder's
-- transaction is short (an insert; a gate row and the stop requests it commits with).
-- LOCK ORDER: this lock is taken before any row lock of the same transaction, agents
-- in ascending order. A caller that places gates for several agents in one
-- transaction places them in ascending agent order, and places them before it
-- requests the stops that go with them.
create function hub_gate_order(agent_id text) returns void
language sql volatile as $$
  select pg_advisory_xact_lock(682107, hashtext(agent_id))
$$;

-- What an opening orders itself by: the agent it opens for and every agent its input
-- and its conversation name, so that the lock a gate on the input's own agent or on
-- its conversation takes is always among them (they are the same agent unless the
-- data disagrees with itself, and then the opening waits for all of them).
create function hub_open_order(row_id text, conversation_id text, agent_id text) returns void
language plpgsql volatile as $$
declare
  who text;
begin
  for who in
    select a.agent from (select agent_id as agent
                         union select i.agent from public.inbound i where i.id = row_id
                         union select c.agent from public.conversation c where c.id = conversation_id) a
     where a.agent is not null order by a.agent
  loop
    perform public.hub_gate_order(who);
  end loop;
end $$;

-- PLACE ONE GATE. The scope has to exist where the store can check it (an input, a
-- conversation); an agent is the registry's and is not checked here. The same
-- operation, scope and cause is the same gate whatever state it is in; the same
-- operation and scope for another cause is a different request and is refused.
-- The gate is ordered against the openings of the agent it is about (the input's
-- agent, the conversation's agent, or the agent itself), see `hub_gate_order`: when
-- the caller's transaction commits, no opening that read the gates earlier is still
-- to insert. Returns the state the gate stands in.
create function hub_gate_place(op_id text, kind_in text, scope_in text, why text, proof jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  seen public.claim_gate%rowtype;
  who text;
begin
  if kind_in = 'row' then
    select i.agent into who from public.inbound i where i.id = scope_in;
    if not found then
      raise exception 'gate-scope-unknown: there is no input %', scope_in;
    end if;
  elsif kind_in = 'conversation' then
    select c.agent into who from public.conversation c where c.id = scope_in;
    if not found then
      raise exception 'gate-scope-unknown: there is no conversation %', scope_in;
    end if;
  else
    who := scope_in;
  end if;
  perform public.hub_gate_order(who);
  insert into public.claim_gate (operation_id, scope_kind, scope_id, cause, evidence)
  values (op_id, kind_in, scope_in, why, coalesce(proof, '{}'::jsonb))
  on conflict (operation_id, scope_kind, scope_id) do nothing;
  select * into seen from public.claim_gate
   where operation_id = op_id and scope_kind = kind_in and scope_id = scope_in;
  if seen.cause <> why then
    raise exception 'gate-conflict: operation % already gates % % for another cause', op_id, kind_in, scope_in;
  end if;
  return seen.state;
end $$;

-- RELEASE ONE OPERATION'S GATES: all of them, or the one at a scope. Only that
-- operation's rows move; another operation's gate over the same scope keeps it
-- closed. The agents whose work may now be claimable are woken on the channel a
-- runner already waits on, at this commit, so nothing polls for it. Returns how
-- many gates this call released (a repeat releases none).
create function hub_gate_release(op_id text, kind_in text, scope_in text)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  released integer;
  woken text[];
  one text;
begin
  with moved as (
    update public.claim_gate
       set state = 'released', released_at = now()
     where operation_id = op_id and state = 'open'
       and (kind_in is null or scope_kind = kind_in)
       and (scope_in is null or scope_id = scope_in)
    returning scope_kind, scope_id),
  agents as (
    select case m.scope_kind
             when 'agent' then m.scope_id
             when 'row' then (select i.agent from public.inbound i where i.id = m.scope_id)
             else (select c.agent from public.conversation c where c.id = m.scope_id) end as agent
      from moved m)
  select (select count(*) from moved)::integer, coalesce(array_agg(distinct a.agent) filter (where a.agent is not null), '{}')
    into released, woken from agents a;
  foreach one in array woken loop
    perform pg_notify('hub_work', one);
  end loop;
  return released;
end $$;

-- A STOP REQUEST: intent to stop ONE attempt, kept before anything is signalled.
--
-- WHAT IT IS ABOUT IS FROZEN when it is made. The attempt (`execution_id`, its
-- conversation, agent, runner, incarnation and placement generation) is read from
-- the store at that instant and never re-resolved, so a request cannot come to
-- mean a NEWER attempt of the same conversation after a restart, a move or a
-- retry: a repeat of the same request meets the row it made. A request made when
-- nothing was owned is `moot` for good and says so (`outcome = 'no_attempt'`).
--
-- IT ONLY EVER SAYS WHAT THE ATTEMPT SAYS. `state` is not written by whoever asks
-- and not by the runner that signals: a trigger follows the attempt's own state
-- (`hub_stop_state`), so "stopped" is only ever the word for an attempt the runner
-- recorded as stopped, which it does only from evidence that every process is
-- gone. Silence, a grace that ran out or an owner's approval move nothing.
--
--   requested  intent is kept; nothing has been signalled
--   stopping   the attempt is `stop_requested`: the signal is being sent or was
--              sent, and the end is not confirmed
--   stopped    the attempt is `stopped`: the loop and everything recorded under it
--              are shown gone
--   unknown    the attempt is `stop_unknown`: the end is not shown. The agent stays
--              blocked and the input stays held, as for any such attempt; only
--              later evidence moves it, to stopped
--   settled    the attempt finished with its own result before the stop landed.
--              The result is kept; nothing was stopped
--   moot       the attempt was over by other means (interrupted, never fed), or
--              nothing was owned. `outcome` says which
--
-- A stop closes no claim gate: gating what is claimed next is a separate operation
-- (`hub_gate_place`) a caller places in the same transaction. Nothing here cancels
-- another job.
create table stop_request (
  id                      text primary key,
  operation_id            text not null check (operation_id <> ''),
  target_kind             text not null check (target_kind in ('execution', 'conversation', 'agent')),
  target_id               text not null check (target_id <> ''),
  requested_by            text not null check (requested_by <> ''),
  execution_id            text references execution (id),
  conversation_id         text,
  agent                   text,
  runner                  text,
  incarnation             text,
  placement_generation    integer,
  conversation_generation integer,
  state                   text not null default 'requested'
                            check (state in ('requested', 'stopping', 'stopped', 'unknown', 'settled', 'moot')),
  outcome                 text,
  evidence                jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (operation_id, target_kind, target_id),
  constraint stop_request_frozen check ((execution_id is null) = (runner is null)
    and (execution_id is null) = (conversation_id is null)
    and (execution_id is null) = (agent is null)
    and (execution_id is null) = (incarnation is null)),
  constraint stop_request_owned_unless_moot check (execution_id is not null or state = 'moot')
);
create index stop_request_by_execution on stop_request (execution_id);
create index stop_request_open_by_runner on stop_request (runner) where state in ('requested', 'stopping');

-- What the request may say for an attempt's state, or null when the attempt's state
-- says nothing about a stop (it is claimed, fed, running, or ended unproven).
create function hub_stop_state(execution_state text) returns text
language sql immutable as $$
  select case execution_state
           when 'stop_requested' then 'stopping'
           when 'stopped'        then 'stopped'
           when 'stop_unknown'   then 'unknown'
           when 'completed'      then 'settled'
           when 'interrupted'    then 'moot'
           when 'failed'         then 'moot'
           else null end
$$;

-- Frozen identity stays; the state only moves the ways an attempt's does.
create function hub_guard_stop_request() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.operation_id is distinct from old.operation_id
     or new.target_kind is distinct from old.target_kind or new.target_id is distinct from old.target_id
     or new.requested_by is distinct from old.requested_by or new.execution_id is distinct from old.execution_id
     or new.conversation_id is distinct from old.conversation_id or new.agent is distinct from old.agent
     or new.runner is distinct from old.runner or new.incarnation is distinct from old.incarnation
     or new.placement_generation is distinct from old.placement_generation
     or new.conversation_generation is distinct from old.conversation_generation
     or new.created_at is distinct from old.created_at then
    raise exception 'stop request % is frozen to the attempt it was made about', old.id;
  end if;
  if old.state in ('stopped', 'settled', 'moot') and new.state <> old.state then
    raise exception 'stop request % is % and stays so', old.id, old.state;
  end if;
  if old.state = 'stopping' and new.state = 'requested' then
    raise exception 'stop request % was already signalled and is not unsent again', old.id;
  end if;
  if old.state = 'unknown' and new.state in ('requested', 'stopping') then
    raise exception 'stop request % has an unproved end and only proof moves it', old.id;
  end if;
  return new;
end $$;
create trigger stop_request_rules
  before update on stop_request
  for each row execute function hub_guard_stop_request();

-- The runner that owns the attempt hears about the request at its commit, on a
-- channel of its own (the payload is the runner), and reads its requests then, at
-- start and after a lost connection: it does not look on a timer.
create function hub_notify_stop() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_stop', new.runner);
  return null;
end $$;
create trigger stop_request_notify
  after insert on stop_request
  for each row when (new.state in ('requested', 'stopping') and new.runner is not null)
  execute function hub_notify_stop();

-- THE REQUEST FOLLOWS THE ATTEMPT. Whoever moves an attempt (the runner stopping
-- it, the runner reconciling it after a restart, a settle that lands a result) is
-- the only writer of its state, and this carries the words across in the same
-- transaction. It is the runner's transaction that writes the attempt, so the
-- request can never be ahead of it or behind it.
create function hub_stop_follows_execution() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  said text := public.hub_stop_state(new.state);
begin
  if said is not null then
    update public.stop_request
       set state = said, outcome = new.state, updated_at = now()
     where execution_id = new.id and state in ('requested', 'stopping', 'unknown') and state <> said;
  end if;
  return null;
end $$;
create trigger execution_stop_requests
  after update of state on execution
  for each row when (old.state is distinct from new.state)
  execute function hub_stop_follows_execution();

-- MAKE ONE STOP REQUEST (or meet the one already made). The target is an attempt
-- by id, or "whatever attempt this conversation / agent owns right now". It is
-- resolved ONCE, here, under a share lock on the attempt so its state cannot move
-- between the read and the commit, and frozen. A request for an attempt that is
-- already over is answered from what that attempt is. Returns the request's id.
create function hub_stop_request(new_id text, op_id text, kind_in text, target_in text, by_in text, proof jsonb)
returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  standing public.stop_request%rowtype;
  ex public.execution%rowtype;
  said text;
begin
  perform pg_advisory_xact_lock(682106, hashtext(op_id || '|' || kind_in || '|' || target_in));
  select * into standing from public.stop_request
   where operation_id = op_id and target_kind = kind_in and target_id = target_in;
  if found then
    return standing.id;
  end if;
  if kind_in = 'execution' then
    select * into ex from public.execution where id = target_in for share;
    if not found then
      raise exception 'stop-target-unknown: there is no attempt %', target_in;
    end if;
  elsif kind_in = 'conversation' then
    if not exists (select 1 from public.conversation where id = target_in) then
      raise exception 'stop-target-unknown: there is no conversation %', target_in;
    end if;
    select * into ex from public.execution
     where conversation_id = target_in
       and state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
       for share;
  elsif kind_in = 'agent' then
    select * into ex from public.execution
     where agent = target_in
       and state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
       for share;
  else
    raise exception 'stop-target-unknown: % is not a kind of target', kind_in;
  end if;
  said := case when ex.id is null then 'moot' else public.hub_stop_state(ex.state) end;
  insert into public.stop_request (id, operation_id, target_kind, target_id, requested_by, execution_id, conversation_id,
                                   agent, runner, incarnation, placement_generation, conversation_generation,
                                   state, outcome, evidence)
  values (new_id, op_id, kind_in, target_in, by_in, ex.id, ex.conversation_id, ex.agent, ex.runner, ex.incarnation,
          ex.placement_generation, (select c.placement_generation from public.conversation c where c.id = ex.conversation_id),
          coalesce(said, 'requested'),
          case when ex.id is null then 'no_attempt' when said is not null then ex.state else null end,
          coalesce(proof, '{}'::jsonb));
  return new_id;
end $$;

-- LET A REQUEST CATCH UP WITH ITS ATTEMPT, for the runner that finds one the trigger
-- never saw (an attempt that ended before the request was made, read by a runner
-- that came up after). It moves a request only to what the attempt already is, so
-- it cannot say "stopped" of anything that was not. Returns the state it stands in.
create function hub_stop_settle(request_id text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  standing public.stop_request%rowtype;
  ex public.execution%rowtype;
  said text;
begin
  select * into standing from public.stop_request where id = request_id for update;
  if not found then
    return null;
  end if;
  if standing.execution_id is not null and standing.state in ('requested', 'stopping', 'unknown') then
    select * into ex from public.execution where id = standing.execution_id;
    said := public.hub_stop_state(ex.state);
    if said is not null and said <> standing.state then
      update public.stop_request set state = said, outcome = ex.state, updated_at = now() where id = request_id;
      return said;
    end if;
  end if;
  return standing.state;
end $$;

-- Only these routines write either table, and only the definer's trigger moves a
-- request afterwards. Everyone who works with them reads them.
revoke all on function hub_gate_place(text, text, text, text, jsonb) from public;
revoke all on function hub_gate_release(text, text, text) from public;
revoke all on function hub_stop_request(text, text, text, text, text, jsonb) from public;
revoke all on function hub_stop_settle(text) from public;
-- The ordering lock is taken by the roles that place gates and by the runner that opens
-- attempts; nobody else has a use for holding an agent's opening still.
revoke all on function hub_gate_order(text) from public;
revoke all on function hub_open_order(text, text, text) from public;
grant execute on function hub_gate_order(text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_open_order(text, text, text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_gate_place(text, text, text, text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_gate_release(text, text, text) to hub_door, hub_runner, hub_hub;
grant execute on function hub_stop_request(text, text, text, text, text, jsonb) to hub_door, hub_runner, hub_hub;
grant execute on function hub_stop_settle(text) to hub_door, hub_runner, hub_hub;
grant select on claim_gate, stop_request to hub_door, hub_runner, hub_hub;

insert into schema_version (version) values (13);
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

insert into schema_version (version) values (14);

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

insert into schema_version (version) values (15);
