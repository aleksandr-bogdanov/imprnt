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
