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
