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
