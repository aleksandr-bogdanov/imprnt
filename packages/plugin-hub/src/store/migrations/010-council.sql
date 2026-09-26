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
