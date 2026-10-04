-- Operator-recorded health. Two narrow records an operator makes with
-- `imprnt hub health`, each keyed to the exact evidence it was judged on, and
-- nothing that hides a current failure:
--
--   * A NOTICE BATCH THAT CAN NO LONGER BE DELIVERED can be dismissed, whole.
--     Its rows stay, with their bytes, attempts and failure, in a state of their
--     own that is neither delivered nor pending: no door selects it, no door
--     recovery resets it, nothing marks it delivered, and who, why and when are
--     on the row. A reply is never dismissed.
--   * A HISTORICAL FINDING whose cause is shown to be over (an agent's retry
--     recorded by a runner process that has since been replaced, or an input's
--     missing stamps after its attempt was confirmed over and its hold released)
--     can be resolved. The resolution is one diary line carrying the fingerprint
--     of that evidence, and `check` honours it only while the evidence is
--     unchanged: a new failure is new evidence and is reported as itself. The
--     health row, the input, its attempt, its hold and its stamps are not touched,
--     and no acknowledgement or execution is written for work that never had one.
--
-- No table is added: a dismissal lives on its rows and goes with them, and a
-- resolution is a diary line whose subject (the agent, the input) is what topic
-- erasure already removes.

alter table outbox drop constraint outbox_delivery_state_check;
alter table outbox add constraint outbox_delivery_state_check
  check (delivery_state in ('pending', 'delivered', 'failed', 'dismissed'));
alter table outbox add column dismissed_at timestamptz;
alter table outbox add column dismissal jsonb;
-- The door's column grants cannot write these two, so it cannot reach the state.
alter table outbox add constraint outbox_dismissal_is_whole check (
  (delivery_state = 'dismissed') = (dismissed_at is not null and dismissal is not null)
  and (delivery_state <> 'dismissed' or (kind = 'notice' and delivered_at is null)));

-- A dismissed row is final: a door that read it before the dismissal, an
-- operator's door recovery, or anything else is refused rather than sending,
-- retrying, failing or marking it delivered.
create function hub_guard_outbox_dismissal() returns trigger
language plpgsql as $$
begin
  if old.delivery_state = 'dismissed'
     and (new.delivery_state, new.delivered_at, new.attempts, new.retry_at, new.failure,
          new.route, new.body, new.dismissed_at, new.dismissal)
         is distinct from
         (old.delivery_state, old.delivered_at, old.attempts, old.retry_at, old.failure,
          old.route, old.body, old.dismissed_at, old.dismissal)
  then
    raise exception 'outbox % was dismissed by an operator: it is never sent, retried or edited', old.id;
  end if;
  return new;
end $$;
create trigger outbox_dismissal_is_final before update on outbox
  for each row execute function hub_guard_outbox_dismissal();

-- One spelling of an instant inside a fingerprint, whatever the session's zone.
create function hub_health_instant(at_in timestamptz) returns text
language sql stable set search_path = pg_catalog as $$
  select to_char(at_in at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;
revoke all on function hub_health_instant(timestamptz) from public;

-- Who and why, required on every record.
create function hub_health_operator_refusal(reason_in text, who_in text, source_in text) returns text
language sql immutable as $$
  select case
    when reason_in is null or btrim(reason_in) = '' then 'reason-required'
    when length(reason_in) > 500 then 'reason-too-long'
    when who_in is null or btrim(who_in) = '' or length(who_in) > 200 then 'operator-required'
    when source_in is null or btrim(source_in) = '' or length(source_in) > 200 then 'source-required'
  end
$$;
revoke all on function hub_health_operator_refusal(text, text, text) from public;

-- The exact rows named, as distinct positive ids, or null for anything else.
create function hub_outbox_ids(ids_in jsonb) returns bigint[]
language plpgsql immutable as $$
declare
  wanted bigint[];
begin
  if ids_in is null or jsonb_typeof(ids_in) <> 'array' or jsonb_array_length(ids_in) = 0
     or jsonb_array_length(ids_in) > 64
     or exists (select 1 from jsonb_array_elements(ids_in) x
                 where jsonb_typeof(x) <> 'number' or (x #>> '{}') !~ '^[0-9]{1,18}$') then
    return null;
  end if;
  select array_agg(distinct (x #>> '{}')::bigint order by (x #>> '{}')::bigint) into wanted
    from jsonb_array_elements(ids_in) x;
  if cardinality(wanted) <> jsonb_array_length(ids_in) then return null; end if;
  return wanted;
end $$;
revoke all on function hub_outbox_ids(jsonb) from public;

-- WHAT A DISMISSAL OF THESE ROWS WOULD BE, and whether it may be made. The
-- digest is of every field the verdict rests on, so a dismissal made against a
-- preview is refused once anything in it moved. A batch is every part of one
-- notice (its key without `:part:<n>`), and only a WHOLE batch is dismissed: a
-- part left behind would be released to the door by its earlier part's state.
--   in-flight            a pending part has an attempt or an unknown outcome: a
--                        send may be under way, or may have happened
--   pending-not-blocked  a pending part no earlier failed part holds back, so the
--                        door may select it at any moment
--   partial-batch        an undelivered part of a named batch is not named
create function hub_outbox_dismissal_plan(ids_in jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  wanted bigint[];
  missing bigint[];
  outside bigint[];
  found_rows jsonb;
  verdict text;
begin
  wanted := public.hub_outbox_ids(ids_in);
  if wanted is null then return jsonb_build_object('verdict', 'invalid-ids'); end if;
  select array_agg(w order by w) into missing from unnest(wanted) w
   where not exists (select 1 from public.outbox o where o.id = w);
  if missing is not null then return jsonb_build_object('verdict', 'unknown-row', 'unknown', to_jsonb(missing)); end if;
  select jsonb_agg(jsonb_build_object(
           'id', o.id, 'kind', o.kind, 'agent', coalesce(o.agent, i.agent), 'person', coalesce(o.person, i.person),
           'batch', case when o.kind = 'notice' then regexp_replace(o.notice_key, ':part:[0-9]+$', '') end,
           'part', o.seq_in_reply, 'state', o.delivery_state, 'attempts', o.attempts,
           'retry_at', public.hub_health_instant(o.retry_at), 'failure', o.failure, 'route', o.route,
           'written_at', public.hub_health_instant(o.written_at),
           'delivered_at', public.hub_health_instant(o.delivered_at),
           'dismissed_at', public.hub_health_instant(o.dismissed_at),
           'body_sha256', encode(sha256(convert_to(o.body, 'UTF8')), 'hex'), 'body_bytes', octet_length(o.body))
         order by o.id) into found_rows
    from public.outbox o left join public.inbound i on i.id = o.inbound_id
   where o.id = any (wanted);
  verdict := case
    when exists (select 1 from public.outbox o where o.id = any (wanted) and o.kind <> 'notice') then 'reply-not-dismissible'
    when exists (select 1 from public.outbox o where o.id = any (wanted) and starts_with(o.notice_key, 'outbound:')) then 'outbound-unsupported'
    when not exists (select 1 from public.outbox o where o.id = any (wanted) and o.delivery_state <> 'dismissed') then 'already-dismissed'
    when exists (select 1 from public.outbox o where o.id = any (wanted) and o.delivery_state = 'dismissed') then 'partly-dismissed'
    when exists (select 1 from public.outbox o where o.id = any (wanted)
                  and (o.delivered_at is not null or o.delivery_state = 'delivered')) then 'delivered'
    when exists (select 1 from public.outbox o where o.id = any (wanted) and o.delivery_state = 'pending'
                  and (o.attempts > 0 or o.failure is not null or o.retry_at is not null)) then 'in-flight'
    when exists (select 1 from public.outbox o where o.id = any (wanted) and o.delivery_state = 'pending'
                  and not exists (select 1 from public.outbox e
                    where e.kind = 'notice' and e.seq_in_reply < o.seq_in_reply
                      and regexp_replace(e.notice_key, ':part:[0-9]+$', '') = regexp_replace(o.notice_key, ':part:[0-9]+$', '')
                      and e.delivered_at is null and e.delivery_state in ('failed', 'dismissed'))) then 'pending-not-blocked'
  end;
  if verdict is null then
    select array_agg(o.id order by o.id) into outside from public.outbox o
     where o.kind = 'notice' and o.delivered_at is null and o.delivery_state in ('pending', 'failed')
       and not (o.id = any (wanted))
       and regexp_replace(o.notice_key, ':part:[0-9]+$', '') in
           (select regexp_replace(t.notice_key, ':part:[0-9]+$', '') from public.outbox t where t.id = any (wanted));
    verdict := case when outside is null then 'eligible' else 'partial-batch' end;
  end if;
  return jsonb_build_object('verdict', verdict, 'ids', to_jsonb(wanted),
    'digest', encode(sha256(convert_to(found_rows::text, 'UTF8')), 'hex'),
    'rows', found_rows, 'outside', coalesce(to_jsonb(outside), '[]'::jsonb));
end $$;
revoke all on function hub_outbox_dismissal_plan(jsonb) from public;
grant execute on function hub_outbox_dismissal_plan(jsonb) to hub_hub;

-- DISMISS ONE OR MORE WHOLE BATCHES, against the digest of their preview.
-- Every undelivered part of every named batch is locked in id order first. The
-- door's pre-send stamp, its failure write and an operator's door recovery each
-- update one of these rows on a pending or failed state: one that committed
-- first is read by the plan below and refuses the dismissal (an attempt, or a
-- state that is no longer failed), and one that comes after finds the row no
-- longer pending or failed and sends nothing.
create function hub_outbox_dismiss(ids_in jsonb, digest_in text, reason_in text, who_in text, source_in text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  wanted bigint[];
  refusal text;
  plan jsonb;
begin
  refusal := public.hub_health_operator_refusal(reason_in, who_in, source_in);
  if refusal is not null then return jsonb_build_object('result', 'refused', 'cause', refusal); end if;
  wanted := public.hub_outbox_ids(ids_in);
  if wanted is null then return jsonb_build_object('result', 'refused', 'cause', 'invalid-ids'); end if;
  perform 1 from public.outbox o
   where o.id = any (wanted)
      or (o.kind = 'notice' and o.delivered_at is null
          and regexp_replace(o.notice_key, ':part:[0-9]+$', '') in
              (select regexp_replace(t.notice_key, ':part:[0-9]+$', '') from public.outbox t
                where t.id = any (wanted) and t.kind = 'notice'))
   order by o.id for update;
  plan := public.hub_outbox_dismissal_plan(ids_in);
  if plan ->> 'verdict' = 'already-dismissed' then return plan || jsonb_build_object('result', 'unchanged'); end if;
  if plan ->> 'verdict' <> 'eligible' then
    return plan || jsonb_build_object('result', 'refused', 'cause', plan ->> 'verdict');
  end if;
  if plan ->> 'digest' is distinct from digest_in then
    return plan || jsonb_build_object('result', 'refused', 'cause', 'stale-digest');
  end if;
  update public.outbox o
     set delivery_state = 'dismissed', dismissed_at = now(),
         dismissal = jsonb_build_object('reason', reason_in, 'by', who_in, 'source', source_in,
           'session', session_user::text, 'digest', digest_in, 'was', o.delivery_state)
   where o.id = any (wanted);
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  select 'health', o.agent, 'notice.dismissed', 'hub',
         jsonb_build_object('outbox', jsonb_agg(o.id order by o.id), 'digest', digest_in, 'reason', reason_in,
           'by', who_in, 'source', source_in, 'session', session_user::text)
    from public.outbox o where o.id = any (wanted) group by o.agent;
  return plan || jsonb_build_object('result', 'dismissed');
end $$;
revoke all on function hub_outbox_dismiss(jsonb, text, text, text, text) from public;
grant execute on function hub_outbox_dismiss(jsonb, text, text, text, text) to hub_hub;

-- The evidence an agent's retry finding stands on: the health row as the runner
-- last wrote it. A new failure rewrites it, and so is a new fingerprint.
create function hub_health_retry_fingerprint(agent_in text) returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(concat_ws(chr(31), 'agent-retry', r.id, r.data::text,
           public.hub_health_instant(r.updated_at)), 'UTF8')), 'hex')
    from public.state_row r
   where r.sheet = 'agent_health' and r.id = agent_in and r.data ->> 'status' = 'retry'
$$;
revoke all on function hub_health_retry_fingerprint(text) from public;
grant execute on function hub_health_retry_fingerprint(text) to hub_hub;

-- The evidence an input's stamp finding stands on: the input and its newest
-- stamp, its newest attempt and that attempt's exit evidence, and its hold.
create function hub_health_stamp_fingerprint(inbound_in text) returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(concat_ws(chr(31), 'input-stamp', i.id, i.kind, i.state,
           public.hub_health_instant(i.received_at),
           coalesce((select max(e.seq) from public.ledger_event e where e.stream = 'inbound' and e.subject = i.id)::text, '-'),
           coalesce(x.id, '-'), coalesce(x.state, '-'), coalesce(x.evidence -> 'exit' ->> 'confirmed', '-'),
           coalesce(h.execution_id, '-'), coalesce(h.state, '-'), coalesce(h.revision::text, '-'), coalesce(h.choice, '-'),
           coalesce(public.hub_health_instant(h.updated_at), '-')), 'UTF8')), 'hex')
    from public.inbound i
    left join public.replay_hold h on h.inbound_id = i.id
    left join lateral (select e.id, e.state, e.evidence from public.execution e where e.inbound_id = i.id
                        order by e.started_at desc, e.id desc limit 1) x on true
   where i.id = inbound_in
$$;
revoke all on function hub_health_stamp_fingerprint(text) from public;
grant execute on function hub_health_stamp_fingerprint(text) to hub_hub;

-- WHETHER AN AGENT'S RETRY IS HISTORY. The retry must have been recorded by an
-- earlier process of the agent's runner than the one registered now (the newest
-- registration fences every older one out of opening, feeding and settling), and
-- nothing of the agent may be running, unresolved, held, claimed or waiting to be
-- retried: work that is queued is the retry itself. The attempt the failure was
-- recorded after, when the runner opened one, must be over, and an interrupted or
-- stopped one must carry its confirmed exit. A runner process cannot be shown dead
-- from the store, so the registration is the evidence and the operator names the
-- incarnation they read, which a restart in between makes stale. An idle resident
-- has no attempt and is not a failed one.
create function hub_health_retry_plan(agent_in text, runner_in text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  r public.state_row%rowtype;
  inc public.runner_incarnation%rowtype;
  x public.execution%rowtype;
  facts jsonb;
  verdict text;
begin
  select * into r from public.state_row where sheet = 'agent_health' and id = agent_in;
  if not found then return jsonb_build_object('verdict', 'cleared', 'agent', agent_in); end if;
  if r.data ->> 'status' is distinct from 'retry' then
    return jsonb_build_object('verdict', 'not-a-retry', 'agent', agent_in, 'status', r.data ->> 'status');
  end if;
  select * into inc from public.runner_incarnation where runner = runner_in;
  select * into x from public.execution e where e.agent = agent_in and e.started_at <= r.updated_at
   order by e.started_at desc, e.id desc limit 1;
  facts := jsonb_build_object('agent', agent_in, 'runner', runner_in,
    'fingerprint', public.hub_health_retry_fingerprint(agent_in),
    'health', r.data, 'recorded_at', public.hub_health_instant(r.updated_at),
    'incarnation', inc.incarnation, 'incarnation_started_at', public.hub_health_instant(inc.started_at),
    'attempt', case when x.id is null then null else jsonb_build_object('id', x.id, 'state', x.state,
      'incarnation', x.incarnation, 'exit_confirmed', coalesce(x.evidence -> 'exit' ->> 'confirmed', '') = 'true') end);
  verdict := case
    when inc.runner is null then 'incarnation-unknown'
    when inc.started_at <= r.updated_at then 'recorded-by-current-incarnation'
    when x.id is not null and x.incarnation = inc.incarnation then 'recorded-by-current-incarnation'
    when public.hub_agent_blocked(agent_in) then 'execution-unresolved'
    when exists (select 1 from public.replay_hold h join public.execution e on e.id = h.execution_id
                  where e.agent = agent_in and h.state <> 'released') then 'hold-open'
    when exists (select 1 from public.inbound i where i.agent = agent_in and i.claimed_by is not null
                  and i.state not in ('answered', 'delivered')) then 'work-claimed'
    when exists (select 1 from public.inbound i where i.agent = agent_in and i.kind <> 'measure'
                  and i.state not in ('answered', 'delivered') and not public.hub_row_held(i.id)) then 'work-queued'
    when x.id is not null and x.state in ('interrupted', 'stopped')
         and coalesce(x.evidence -> 'exit' ->> 'confirmed', '') <> 'true' then 'exit-unconfirmed'
    else 'eligible'
  end;
  return facts || jsonb_build_object('verdict', verdict);
end $$;
revoke all on function hub_health_retry_plan(text, text) from public;
grant execute on function hub_health_retry_plan(text, text) to hub_hub;

create function hub_health_resolve_retry(agent_in text, runner_in text, fingerprint_in text, incarnation_in text,
                                         reason_in text, who_in text, source_in text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  refusal text;
  plan jsonb;
begin
  refusal := public.hub_health_operator_refusal(reason_in, who_in, source_in);
  if refusal is not null then return jsonb_build_object('result', 'refused', 'cause', refusal); end if;
  -- The agent's ordering point, as every claim, attempt opening and gate takes it,
  -- then the row the runner's next failure rewrites and its registration.
  perform public.hub_gate_order(agent_in);
  perform 1 from public.state_row where sheet = 'agent_health' and id = agent_in for update;
  perform 1 from public.runner_incarnation where runner = runner_in for share;
  plan := public.hub_health_retry_plan(agent_in, runner_in);
  if plan ->> 'verdict' = 'cleared' then return plan || jsonb_build_object('result', 'cleared'); end if;
  if plan ->> 'verdict' <> 'eligible' then
    return plan || jsonb_build_object('result', 'refused', 'cause', plan ->> 'verdict');
  end if;
  if plan ->> 'fingerprint' is distinct from fingerprint_in then
    return plan || jsonb_build_object('result', 'refused', 'cause', 'stale-fingerprint');
  end if;
  if plan ->> 'incarnation' is distinct from incarnation_in then
    return plan || jsonb_build_object('result', 'refused', 'cause', 'incarnation-changed');
  end if;
  if exists (select 1 from public.ledger_event e where e.stream = 'health' and e.subject = agent_in
              and e.kind = 'retry.resolved' and e.detail ->> 'fingerprint' = fingerprint_in) then
    return plan || jsonb_build_object('result', 'unchanged');
  end if;
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  values ('health', agent_in, 'retry.resolved', 'hub', (plan - 'verdict') || jsonb_build_object(
    'reason', reason_in, 'by', who_in, 'source', source_in, 'session', session_user::text));
  return plan || jsonb_build_object('result', 'resolved');
end $$;
revoke all on function hub_health_resolve_retry(text, text, text, text, text, text, text) from public;
grant execute on function hub_health_resolve_retry(text, text, text, text, text, text, text) to hub_hub;

-- WHETHER AN INPUT'S MISSING STAMPS ARE HISTORY. Its newest attempt is over with
-- its exit confirmed, its hold names that attempt and was released by the owner,
-- nothing of its agent has an ownership nobody resolved, and the replay predicate
-- still holds it, so it is never fed again. An input whose only trace is an old
-- runner's claim has no attempt to show any of this and is not supported.
create function hub_health_stamp_plan(inbound_in text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  i public.inbound%rowtype;
  x public.execution%rowtype;
  h public.replay_hold%rowtype;
  facts jsonb;
  verdict text;
begin
  select * into i from public.inbound where id = inbound_in;
  if not found then return jsonb_build_object('verdict', 'unknown-input', 'input', inbound_in); end if;
  select * into x from public.execution e where e.inbound_id = inbound_in order by e.started_at desc, e.id desc limit 1;
  select * into h from public.replay_hold where inbound_id = inbound_in;
  facts := jsonb_build_object('input', i.id, 'agent', i.agent, 'person', i.person, 'kind', i.kind, 'state', i.state,
    'missing', case i.state when 'received' then 'acked' when 'acked' then 'started'
                            when 'started' then 'answered' when 'answered' then 'delivered' end,
    'received_at', public.hub_health_instant(i.received_at),
    'fingerprint', public.hub_health_stamp_fingerprint(inbound_in),
    'attempt', case when x.id is null then null else jsonb_build_object('id', x.id, 'state', x.state,
      'incarnation', x.incarnation, 'exit_confirmed', coalesce(x.evidence -> 'exit' ->> 'confirmed', '') = 'true',
      'ended_at', public.hub_health_instant(x.ended_at)) end,
    'hold', case when h.inbound_id is null then null else jsonb_build_object('attempt', h.execution_id,
      'state', h.state, 'revision', h.revision, 'choice', h.choice, 'chosen_at', public.hub_health_instant(h.chosen_at)) end);
  verdict := case
    when i.state = 'delivered' then 'cleared'
    when i.kind <> 'human' then 'not-a-person-message'
    when i.state = 'answered' then 'answered-not-delivered'
    when x.id is null then 'no-attempt'
    when x.state in ('claimed', 'feed_intent', 'received', 'running', 'unknown', 'stop_requested', 'stop_unknown')
      then 'execution-unresolved'
    when x.state not in ('interrupted', 'stopped') then 'attempt-not-interrupted'
    when coalesce(x.evidence -> 'exit' ->> 'confirmed', '') <> 'true' then 'exit-unconfirmed'
    when h.inbound_id is null then 'no-hold'
    when h.execution_id <> x.id then 'hold-names-another-attempt'
    when h.state <> 'released' then 'hold-open'
    when i.claimed_by is not null then 'work-claimed'
    when exists (select 1 from public.execution e where e.agent = i.agent
                  and e.state in ('unknown', 'stop_requested', 'stop_unknown')) then 'ownership-unresolved'
    when not public.hub_row_held(i.id) then 'replayable'
    else 'eligible'
  end;
  return facts || jsonb_build_object('verdict', verdict);
end $$;
revoke all on function hub_health_stamp_plan(text) from public;
grant execute on function hub_health_stamp_plan(text) to hub_hub;

create function hub_health_resolve_stamp(inbound_in text, attempt_in text, revision_in integer, fingerprint_in text,
                                         reason_in text, who_in text, source_in text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  refusal text;
  agent_of text;
  plan jsonb;
begin
  refusal := public.hub_health_operator_refusal(reason_in, who_in, source_in);
  if refusal is not null then return jsonb_build_object('result', 'refused', 'cause', refusal); end if;
  select i.agent into agent_of from public.inbound i where i.id = inbound_in;
  if not found then return jsonb_build_object('result', 'refused', 'cause', 'unknown-input', 'input', inbound_in); end if;
  -- The order `hub_hold_choice` takes: the agent's ordering point, then the hold.
  perform public.hub_gate_order(agent_of);
  perform 1 from public.replay_hold where inbound_id = inbound_in for update;
  plan := public.hub_health_stamp_plan(inbound_in);
  if plan ->> 'verdict' = 'cleared' then return plan || jsonb_build_object('result', 'cleared'); end if;
  if plan ->> 'verdict' <> 'eligible' then
    return plan || jsonb_build_object('result', 'refused', 'cause', plan ->> 'verdict');
  end if;
  if plan #>> '{attempt,id}' is distinct from attempt_in then
    return plan || jsonb_build_object('result', 'refused', 'cause', 'attempt-mismatch');
  end if;
  if (plan #>> '{hold,revision}')::integer is distinct from revision_in then
    return plan || jsonb_build_object('result', 'refused', 'cause', 'stale-revision');
  end if;
  if plan ->> 'fingerprint' is distinct from fingerprint_in then
    return plan || jsonb_build_object('result', 'refused', 'cause', 'stale-fingerprint');
  end if;
  if exists (select 1 from public.ledger_event e where e.stream = 'health' and e.subject = inbound_in
              and e.kind = 'stamp.resolved' and e.detail ->> 'fingerprint' = fingerprint_in) then
    return plan || jsonb_build_object('result', 'unchanged');
  end if;
  insert into public.ledger_event (stream, subject, kind, actor, detail)
  values ('health', inbound_in, 'stamp.resolved', 'hub', (plan - 'verdict') || jsonb_build_object(
    'reason', reason_in, 'by', who_in, 'source', source_in, 'session', session_user::text));
  return plan || jsonb_build_object('result', 'resolved');
end $$;
revoke all on function hub_health_resolve_stamp(text, text, integer, text, text, text, text) from public;
grant execute on function hub_health_resolve_stamp(text, text, integer, text, text, text, text) to hub_hub;
