-- The confirmation is the immutable message revision. Only a door that observed
-- its owner's reaction can enqueue delivery; runners can inspect but cannot send.
create table outbound_delivery (
  confirmation_id text primary key references confirmation(id) on delete cascade,
  door text not null,
  state text not null default 'queued' check (state in ('queued','sending','sent','uncertain')),
  attempt_id text,
  receipt jsonb,
  notified boolean not null default false,
  checked_at timestamptz not null default '-infinity',
  cause text,
  updated_at timestamptz not null default now()
);
create index outbound_delivery_fair_scan on outbound_delivery (door, checked_at, confirmation_id);
grant select on outbound_delivery to hub_runner, hub_door, hub_hub;
grant insert, update on outbound_delivery to hub_door;

create table outbound_read (
  account text primary key,
  person text not null,
  config_hash text not null,
  next_at timestamptz not null default now(),
  hot_until timestamptz,
  findings jsonb not null default '[]',
  cause text,
  updated_at timestamptz not null default now()
);
grant select on outbound_read to hub_runner, hub_door, hub_hub;
grant insert, update on outbound_read to hub_door;

-- Outbound topic ownership is the immutable confirmation payload, never account ownership.
create function hub_outbound_source_live(agent_in text) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
 select agent_in is not null and agent_in <> ''
   and not exists(select 1 from public.identity_reservation where kind='agent' and id=agent_in)
   and not exists(select 1 from public.topic_tombstone where agent_id=agent_in)
   and not exists(select 1 from public.topic where agent_id=agent_in and lifecycle='deleting')
$$;
revoke all on function hub_outbound_source_live(text) from public;
grant execute on function hub_outbound_source_live(text) to hub_runner, hub_door, hub_hub;

create function hub_outbound_confirmation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 if new.operation_kind='outbound.send' then
   perform pg_advisory_xact_lock_shared(682151,1);
   if not public.hub_outbound_source_live(new.payload->>'agent') then
     raise exception 'outbound-source-erased';
   end if;
 end if;
 return new;
end $$;
revoke all on function hub_outbound_confirmation_guard() from public;
create trigger outbound_confirmation_source before insert or update on confirmation
 for each row execute function hub_outbound_confirmation_guard();

-- Only a live source confirmation can publish a notice, including to General.
-- The caller enqueues all parts and marks notice debt in one transaction.
create function hub_outbound_notice(confirmation_in text, person_in text, agent_in text, body_in text,
                                   key_in text, route_in jsonb, seq_in integer) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare c public.confirmation%rowtype;
begin
 perform pg_advisory_xact_lock_shared(682151,1);
 select * into c from public.confirmation where id=confirmation_in and operation_kind='outbound.send';
 if not found or c.person<>person_in or not public.hub_outbound_source_live(c.payload->>'agent') then return false; end if;
 if not starts_with(key_in,'outbound:' || c.id || ':') then raise exception 'outbound-notice-key'; end if;
 perform public.hub_door_notice(person_in,agent_in,body_in,key_in,
   route_in || jsonb_build_object('outbound_confirmation',c.id,'outbound_source_agent',c.payload->>'agent'),seq_in);
 return true;
end $$;
revoke all on function hub_outbound_notice(text,text,text,text,text,jsonb,integer) from public;
grant execute on function hub_outbound_notice(text,text,text,text,text,jsonb,integer) to hub_door;
create or replace function hub_erasure_confirmations(topic_in text, agent_in text, councils_in text[]) returns setof text
language sql stable security definer set search_path = pg_catalog, public as $$
  select cf.id from public.confirmation cf
   where (cf.operation_kind = 'topic.create' and cf.payload ->> 'topic_id' = topic_in)
      or (cf.operation_kind = 'outbound.send' and cf.payload ->> 'agent' = agent_in)
      or (cf.operation_kind = 'council.start'
          and (cf.payload -> 'master' ->> 'agent' = agent_in
               or cf.operation_id in (select c.operation_id from public.council c where c.id = any (councils_in))))
$$;

create or replace function hub_erasure_owns_notice(topic_in text, key_in text, councils_in text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((starts_with(key_in, 'outbound:') and exists (
      select 1 from public.outbox o where o.notice_key = key_in and (
        o.route ->> 'outbound_source_agent' in (
          select agent_id from public.topic where id = topic_in union select agent_id from public.topic_tombstone where topic_id = topic_in)
        or exists (select 1 from public.confirmation cf where cf.operation_kind = 'outbound.send'
          and starts_with(key_in, 'outbound:' || cf.id || ':') and cf.payload ->> 'agent' in (
            select agent_id from public.topic where id = topic_in union select agent_id from public.topic_tombstone where topic_id = topic_in)))))
    or starts_with(key_in, 'topic:attention-catchup:' || topic_in || ':')
    or (split_part(key_in, ':', 1) in
          ('council-missing','council-checkpoint','council-correction','council-master','council-legacy','council-status')
        and split_part(key_in, ':', 2) = any(councils_in))
    or (split_part(key_in, ':', 1) in ('council-quiet','council-overrun')
        and exists (select 1 from public.council_participant p
          where p.id = split_part(key_in, ':', 2) and p.council_id = any(councils_in))), false)
$$;

create or replace function hub_deletion_inventory(agent_in text, conversation_in text, workers_in jsonb, person_in text, door_in text,
                                       chat_in text, topic_in text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  s public.erasure_sets;
begin
  s := public.hub_erasure_sets(agent_in, conversation_in, workers_in);
  return jsonb_build_object(
    'confirmations', (select count(*) from public.hub_erasure_confirmations(topic_in, agent_in, s.councils)),
    'outbound_deliveries', (select count(*) from public.outbound_delivery where confirmation_id in
      (select x from public.hub_erasure_confirmations(topic_in, agent_in, s.councils) x)),
    'conversations', (select count(*) from public.conversation where id = any (s.conversations)),
    'conversation_entries', (select count(*) from public.conversation_entry where conversation_id = any (s.conversations)),
    'inbound', cardinality(s.inbound),
    'jobs', (select count(*) from public.inbound where id = any (s.inbound) and kind = 'job'),
    'executions', cardinality(s.executions),
    'councils', cardinality(s.councils),
    'outbox', (select count(*) from public.outbox where inbound_id = any (s.inbound) or agent = agent_in
      or public.hub_erasure_owns_notice(topic_in, notice_key, s.councils)),
    'media_files', (select count(*) from public.media where inbound_id = any (s.inbound)),
    'media_bytes', (select coalesce(sum(octet_length(bytes)), 0) from public.media where inbound_id = any (s.inbound)),
    'ledger_events', (select count(*) from public.ledger_event
                       where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
                          or subject = any (s.conversations) or subject = agent_in),
    'state_rows', (select count(*) from public.state_row r
                    where public.hub_erasure_owns_row(r.sheet, r.id, r.data, agent_in, person_in, door_in, chat_in, s.inbound)),
    'moves', cardinality(s.moves),
    'move_copies', (select count(*) from public.move_copy where move_id = any (s.moves) and state not in ('removed', 'superseded')),
    'effects_in_chat', (select count(*) from public.platform_effect e where chat_in is not null and e.door = door_in and e.chat = chat_in),
    'messages_elsewhere', (select count(*) from public.hub_erasure_linked_effects(topic_in, agent_in, s.councils) e
                            where e.platform_id is not null and not (e.door = door_in and coalesce(e.chat = chat_in, false)))
  );
end $$;

create or replace function hub_erase_scope(topic_in text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  k public.topic_tombstone%rowtype;
  s public.erasure_sets;
  n integer;
  counts jsonb := '{}'::jsonb;
  stops jsonb;
  left_over bigint;
begin
  select * into k from public.topic_tombstone where topic_id = topic_in;
  if not found then
    raise exception 'erase-unknown: topic % has no tombstone, and nothing is erased without one', topic_in;
  end if;
  perform set_config('hub.erasing', k.deletion_id, true);
  s := public.hub_erasure_sets(k.agent_id, k.conversation_id, k.worker_conversations);

  select coalesce(jsonb_agg(jsonb_build_object('target', r.target_kind || ':' || r.target_id, 'state', r.state, 'outcome', r.outcome) order by r.id), '[]'::jsonb)
    into stops from public.stop_request r where r.operation_id = 'delete:' || k.deletion_id;
  update public.topic_deletion set quiesce = jsonb_build_object('stops', stops), updated_at = now() where id = k.deletion_id;

  delete from public.source_consumption where conversation_id = any (s.conversations) or source_id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('source_consumption', n);
  delete from public.tool_invocation where conversation_id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('tool_invocation', n);
  delete from public.stop_request
   where execution_id = any (s.executions) or conversation_id = any (s.conversations) or agent = k.agent_id
      or (target_kind = 'agent' and target_id = k.agent_id)
      or (target_kind = 'conversation' and target_id = any (s.conversations));
  get diagnostics n = row_count; counts := counts || jsonb_build_object('stop_request', n);
  delete from public.replay_hold
   where inbound_id = any (s.inbound) or conversation_id = any (s.conversations) or execution_id = any (s.executions);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('replay_hold', n);
  delete from public.execution where id = any (s.executions);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('executions', n);
  delete from public.conversation_entry where conversation_id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('conversation_entries', n);

  -- The messages and the frozen proposals are found THROUGH the councils and the confirmations, so they go before either does.
  delete from public.platform_effect e
   where (k.chat is not null and e.door = k.door and e.chat = k.chat)
      or e.key in (select l.key from public.hub_erasure_linked_effects(k.topic_id, k.agent_id, s.councils) l);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('platform_effects', n);
  delete from public.outbox where inbound_id = any (s.inbound) or agent = k.agent_id
     or public.hub_erasure_owns_notice(k.topic_id, notice_key, s.councils);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('outbox', n);

  delete from public.confirmation cf where cf.id in (select x from public.hub_erasure_confirmations(k.topic_id, k.agent_id, s.councils) x);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('confirmations', n);

  delete from public.council_event where council_id = any (s.councils);
  delete from public.round_member where council_id = any (s.councils);
  delete from public.council_round where council_id = any (s.councils);
  delete from public.council_decision where council_id = any (s.councils);
  delete from public.council_participant where council_id = any (s.councils);
  delete from public.council where id = any (s.councils);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('councils', n);

  delete from public.move_blob where move_id = any (s.moves);
  delete from public.move_copy where move_id = any (s.moves);
  delete from public.topic_move where id = any (s.moves);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('moves', n);

  delete from public.media where inbound_id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('media', n);
  delete from public.ledger_event
   where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
      or subject = any (s.conversations) or subject = k.agent_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('ledger_events', n);
  delete from public.inbound where id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('inbound', n);
  delete from public.conversation where id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('conversations', n);

  delete from public.state_row r
   where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('state_rows', n);

  delete from public.topic_transition where topic_id = k.topic_id;
  delete from public.topic_channel_seen where topic_id = k.topic_id;
  delete from public.topic where id = k.topic_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('topic', n);

  select (select count(*) from public.ledger_event
           where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
              or subject = any (s.conversations) or subject = k.agent_id)
       + (select count(*) from public.state_row r
           where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound))
       + (select count(*) from public.inbound where id = any (s.inbound))
    into left_over;
  if left_over > 0 then
    raise exception 'erase-incomplete: % rows of topic % are still there', left_over, topic_in;
  end if;
  perform set_config('hub.erasing', '', true);
  return counts;
end $$;

create or replace function hub_erasure_remaining(topic_in text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  k public.topic_tombstone%rowtype;
  s public.erasure_sets;
begin
  select * into k from public.topic_tombstone where topic_id = topic_in;
  if not found then
    return 0;
  end if;
  s := public.hub_erasure_sets(k.agent_id, k.conversation_id, k.worker_conversations);
  return (select count(*) from public.hub_erasure_confirmations(k.topic_id, k.agent_id, s.councils))
       + (select count(*) from public.outbound_delivery where confirmation_id in
           (select x from public.hub_erasure_confirmations(k.topic_id, k.agent_id, s.councils) x))
       + (select count(*) from public.platform_effect where owner_ref in
           (select 'confirmation:' || x from public.hub_erasure_confirmations(k.topic_id, k.agent_id, s.councils) x))
       + (select count(*) from public.outbox where inbound_id = any(s.inbound) or agent = k.agent_id
           or public.hub_erasure_owns_notice(k.topic_id, notice_key, s.councils))
       + (select count(*) from public.topic where id = k.topic_id)
       + (select count(*) from public.conversation where id = any (s.conversations))
       + (select count(*) from public.inbound where id = any (s.inbound))
       + (select count(*) from public.execution where id = any (s.executions))
       + (select count(*) from public.council where id = any (s.councils))
       + (select count(*) from public.topic_move where id = any (s.moves))
       + (select count(*) from public.ledger_event
           where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
              or subject = any (s.conversations) or subject = k.agent_id)
       + (select count(*) from public.state_row r
           where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound));
end $$;
