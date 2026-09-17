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

-- D-79. The hub process writes to the ledger as actor `hub`, and the invariant
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
  -- REVIEW S6. `measure` is the sixth and it is not work: it is what the
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
-- D-113. A NOTICE is a row here too, and it is the one thing on this table with
-- no message on it: a household-wide cause (a dead login, a used-up plan
-- window) is one line per person and not an apology per row, so it hangs on
-- nothing. `kind` defaults to `reply`, which is what keeps every shipped insert
-- (`insert into outbox (inbound_id, seq_in_reply, body)`) legal unchanged.
--
-- `notice_key unique` is the WHOLE of the one-notice arithmetic (D-122). The
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
-- D-114. It is also source one of `hub_turn`: a turn OPENS at `acked` and ENDS
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
-- D-113. A notice carries its own person, because there is no message to read
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

-- D-114, source two. The runner writes the open turn's progress onto a sheet
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

-- D-116. A clock running out is a line the door writes, and it is not a stamp.
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
-- 03b item 4 adds the `runner` stream: one line at connect naming the server
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
-- D-115. The runner writes three of its own now: the household's outage, the
-- household's window reading, and the open turn's progress. Two runners racing
-- for one outage row is an expected race and the primary key is what settles
-- it, so the runner claims with `claimRow` and never with `appendRow`, whose
-- refusal path writes as actor `hub` on the caller's own connection.
-- REVIEW S5. The door keeps the platform message id of the progress line it
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
