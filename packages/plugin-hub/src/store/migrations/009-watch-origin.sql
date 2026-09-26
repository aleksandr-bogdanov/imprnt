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
