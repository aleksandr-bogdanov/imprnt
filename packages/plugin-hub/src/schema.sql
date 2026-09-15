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
  constraint inbound_kind_is_known
    check (kind in ('human', 'report', 'triage', 'room', 'harvest'))
);

create index inbound_by_agent on inbound (agent, state);

-- One row per reply chunk. The runner writes them, the door marks them
-- delivered once the platform accepted them.
create table outbox (
  id           bigserial primary key,
  inbound_id   text not null references inbound (id),
  seq_in_reply int not null,
  body         text not null,
  written_at   timestamptz not null default now(),
  delivered_at timestamptz,
  unique (inbound_id, seq_in_reply)
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
create function hub_derive_inbound_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stream = 'inbound'
     and new.kind in ('received', 'acked', 'started', 'answered', 'delivered')
  then
    perform set_config('hub.deriving', 'on', true);
    update inbound set state = new.kind where id = new.subject;
    perform set_config('hub.deriving', 'off', true);
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
create function hub_notify_out() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hub_outbox',
                    (select person from inbound where id = new.inbound_id));
  return null;
end $$;

create trigger outbox_notify_out
  after insert on outbox
  for each row execute function hub_notify_out();

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

create policy ledger_event_runner_stamps on ledger_event
  for insert to hub_runner
  with check (actor = 'runner' and stream = 'inbound'
              and kind in ('acked', 'started', 'answered'));

-- What a turn cost and what the runner refused are the runner's own to write.
-- Neither is a stamp, so neither widens the fence above.
create policy ledger_event_runner_turn on ledger_event
  for insert to hub_runner
  with check (actor = 'runner' and stream in ('turn', 'refusal', 'memory'));

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

-- The door keeps its platform cursor on a state sheet, so it writes here. The
-- runner only reads.
grant select, insert, update on state_row to hub_door;
grant select on state_row to hub_runner;

-- The hub keeps the measured peaks and, later, the findings. One row per id,
-- edited in place, and a thing that is gone leaves no line behind.
grant select, insert, update, delete on state_row to hub_hub;
grant select on outbox to hub_hub;

create policy inbound_hub_reads on inbound
  for select to hub_hub using (true);
