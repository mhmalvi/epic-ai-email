-- EXCERPT — SQL regression test that locks SECURITY DEFINER EXECUTE grants
-- (original file: supabase/tests/definer_execute_test)
--
-- What it is: a plain-psql test, run against the self-hosted Postgres, that
-- proves who may EXECUTE the SECURITY DEFINER functions in schema `public`
-- and who may touch the pg_net request queue. Background: by default Postgres
-- grants EXECUTE to PUBLIC, so every SECURITY DEFINER function was callable by
-- the `anon` role through PostgREST's /rest/v1/rpc. The fix revoked EXECUTE from
-- PUBLIC/anon/authenticated, granted service_role, and granted authenticated
-- back only for the functions a logged-in page calls. This test locks that in.
--
-- Everything runs in one transaction that is rolled back, so nothing survives.
-- Prints "DEFINER EXECUTE: PASS" or raises on the first failed expectation.
--
-- Removed: the role-by-role call matrix (section 5 in the original: real calls
-- as anon / authenticated / service_role, plus has_role ownership checks) and
-- the trigger-still-fires probe (section 7). Kept: the helpers and the
-- catalogue-level assertions.
--
-- Run: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < this file
begin;

-- expect_call(role, jwt_sub, sql, should_succeed)
--   role:           database role to run the statement as
--   jwt_sub:        user id placed in the JWT claims, or null for no user
--   sql:            the statement to run
--   should_succeed: true when it must run, false when it must fail with 42501
create function pg_temp.expect_call(p_role text, p_sub uuid, p_sql text, p_should_succeed boolean)
returns void language plpgsql as $$
declare
  v_ok boolean;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  perform set_config('role', p_role, true);
  begin
    execute p_sql;
    v_ok := true;
  exception when insufficient_privilege then
    v_ok := false;
  end;
  perform set_config('role', 'postgres', true);
  if v_ok is distinct from p_should_succeed then
    raise exception 'FAIL: % (sub=%) expected %: %', p_role, p_sub,
      case when p_should_succeed then 'success' else '42501' end, p_sql;
  end if;
end $$;

-- expect_scalar(sql, expected): runs a query as the current role and compares its single text result.
create function pg_temp.expect_scalar(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $$
declare
  v_got text;
begin
  execute p_sql into v_got;
  if v_got is distinct from p_expected then
    raise exception 'FAIL: % — expected [%], got [%]', p_label, p_expected, v_got;
  end if;
end $$;

-- 1. No SECURITY DEFINER function in public is executable by anon.
select pg_temp.expect_scalar('definer fns executable by anon',
  $q$select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by 1), '')
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and has_function_privilege('anon', p.oid, 'EXECUTE')$q$, '');

-- 2. authenticated gets exactly the three a logged-in page calls.
select pg_temp.expect_scalar('definer fns executable by authenticated',
  $q$select coalesce(string_agg(p.proname, ',' order by p.proname), '')
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')$q$,
  'delete_campaign,get_user_oauth_status,has_role');

-- 3. service_role keeps every one (edge functions call them with the service key).
select pg_temp.expect_scalar('definer fns NOT executable by service_role',
  $q$select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by 1), '')
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and not has_function_privilege('service_role', p.oid, 'EXECUTE')$q$, '');

-- 4. pg_net queue/response tables: closed to anon/authenticated, open to the roles that enqueue.
select pg_temp.expect_scalar('net tables writable/readable by anon or authenticated',
  $q$select coalesce(string_agg(r || ' ' || t || ' ' || pr, ', '), '')
     from unnest(array['anon','authenticated']) r,
          unnest(array['net.http_request_queue','net._http_response']) t,
          unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) pr
     where has_table_privilege(r, t, pr)$q$, '');
select pg_temp.expect_scalar('net queue missing for an enqueuing role',
  $q$select coalesce(string_agg(r || ' ' || pr, ', '), '')
     from unnest(array['postgres','service_role','supabase_functions_admin']) r,
          unnest(array['SELECT','INSERT','UPDATE','DELETE']) pr
     where not has_table_privilege(r, 'net.http_request_queue', pr)
        or not has_table_privilege(r, 'net._http_response', pr)
        or not has_sequence_privilege(r, 'net.http_request_queue_id_seq', 'USAGE')$q$, '');

-- 5. (trimmed) a sample of the real-role call matrix:
do $$
begin
  -- anon: a former offender now refuses
  perform pg_temp.expect_call('anon', null,
    format($q$select public.delete_campaign(%L)$q$, gen_random_uuid()), false);
  perform pg_temp.expect_call('anon', null,
    $q$insert into net.http_request_queue(method, url, headers, timeout_milliseconds) values ('GET', 'http://localhost/', '{}', 1000)$q$, false);
  -- service_role: edge-function rpc paths still run
  perform pg_temp.expect_call('service_role', null,
    $q$select * from public.users_with_claimable_emails()$q$, true);
end $$;

-- 6. New functions in public are closed to PUBLIC/anon by default.
create function public.s01_default_probe() returns int language sql security definer as 'select 1';
select pg_temp.expect_scalar('new function executable by anon',
  $q$select has_function_privilege('anon', 'public.s01_default_probe()', 'EXECUTE')::text$q$, 'false');

select 'DEFINER EXECUTE: PASS';
rollback;
