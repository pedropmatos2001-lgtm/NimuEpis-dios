-- =============================================================================
-- Títulos alternativos: pesquisar pelo nome inglês OU pelo romaji
-- =============================================================================
--
-- O PROBLEMA (reportado a 2026-09-28): na Crunchyroll o anime chama-se "The
-- Warrior Princess and the Barbaric King"; no Nimu só aparecia a pesquisar
-- "Himekishi wa Barbaroi no Yome". A pesquisa olhava só para `animes.title`, e
-- cada linha tem UM título:
--
--   * as 28 mil linhas do catálogo (manami) guardam o título principal, quase
--     sempre o romaji. O manami traz os sinónimos (o nome inglês incluído), mas
--     a ingestão deitava-os fora;
--   * as linhas do AnimeSchedule guardam o nome inglês e perdiam o romaji, por
--     isso "Shingeki no Kyojin" falhava onde "Attack on Titan" funcionava.
--
-- A SOLUÇÃO:
--
--   1. `alt_titles`: os outros nomes de cada anime (só alfabeto latino, que é o
--      que se escreve num site em inglês e português). Preenchida pela ingestão
--      através de `merge_anime_alt_titles`, que só ACRESCENTA.
--   2. `search_names` / `search_blob`: colunas geradas com os nomes já
--      normalizados (minúsculas, sem acentos, pontuação a espaço), para a
--      pesquisa não ter de os calcular linha a linha. `search_blob` tem índice
--      trigram, que é o que torna o `like '%...%'` barato.
--   3. `search_animes` passa a procurar em todos os nomes, com a mesma escada de
--      relevância de antes (exato > começa por > palavra começa por > contido),
--      e devolve `matched_title`: o nome que casou, quando não foi o título.
--      Um nome alternativo vale um degrau abaixo do título: "one" continua a
--      dar o One Piece (título, começa por) à frente de um anime cujo sinónimo
--      é exatamente "One", e a popularidade desempata dentro do degrau.
--
-- COMPATIBILIDADE: o site e a ingestão perguntam à base se a coluna existe
-- antes de a usar, por isso o código pode chegar antes ou depois desta
-- migração sem partir nada.
--
-- APLICAR: colar este ficheiro inteiro no SQL Editor da Supabase e correr (ou
-- o workflow db-migrate.yml, se o segredo SUPABASE_ACCESS_TOKEN existir).
-- Depois, `npm run alt-titles` em ingestion/ enche a coluna para o catálogo.
-- =============================================================================

begin;

-- `gin_trgm_ops` vive no schema da extensão: `extensions` na Supabase, `public`
-- num Postgres nu (ver 20260730000300_search_animes.sql).
set local search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Normalização de um nome
-- -----------------------------------------------------------------------------
-- Acentos fora (a MESMA tabela do `anime_slugify`, gerada e verificada par a
-- par), minúsculas, tudo o que não é letra ou dígito vira um espaço. Assim
-- "Pokémon", "pokemon" e "POKEMON" são o mesmo nome, e "Re:Zero" encontra-se
-- por "re zero". O que não é latino (kana, han) desaparece, e é de propósito:
-- `alt_titles` só guarda nomes latinos.
--
-- A lógica em JavaScript (ingestion/src/alt-titles.js) segue a mesma regra, para
-- a ingestão saber sem perguntar à base se um nome já lá está.
create or replace function public.nimu_norm(input text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      lower(
        translate(
          coalesce(input, ''),
          'áàâãäåāăąÁÀÂÃÄÅĀĂĄéèêëēĕėęěÉÈÊËĒĔĖĘĚíìîïĩīĭįÍÌÎÏĨĪĬĮóòôõöøōŏőÓÒÔÕÖØŌŎŐúùûüũūŭůÚÙÛÜŨŪŬŮçćĉċčÇĆĈĊČñńņňÑŃŅŇýÿŷÝŸŶšśŝşŠŚŜŞžźżŽŹŻğĝġģĞĜĠĢďđĎĐĺļľłĹĻĽŁŕŗřŔŖŘţťŧŢŤŦ',
          'aaaaaaaaaAAAAAAAAAeeeeeeeeeEEEEEEEEEiiiiiiiiIIIIIIIIoooooooooOOOOOOOOOuuuuuuuuUUUUUUUUcccccCCCCCnnnnNNNNyyyYYYssssSSSSzzzZZZggggGGGGddDDllllLLLLrrrRRRtttTTT'
        )
      ),
      '[^a-z0-9]+', ' ', 'g'
    )
  );
$$;

comment on function public.nimu_norm(text) is
  'Nome normalizado para pesquisa: sem acentos, minúsculas, pontuação a espaço.';

-- -----------------------------------------------------------------------------
-- 2. A coluna dos outros nomes
-- -----------------------------------------------------------------------------
alter table public.animes
  add column if not exists alt_titles text[] not null default '{}'::text[];

-- Teto: o anime com mais sinónimos latinos no manami tem perto de 40; mais do
-- que isso seria lixo a entrar, e cada nome pesa no índice.
alter table public.animes drop constraint if exists animes_alt_titles_max;
alter table public.animes
  add constraint animes_alt_titles_max check (cardinality(alt_titles) <= 40);

comment on column public.animes.alt_titles is
  'Outros nomes do anime (inglês, romaji, sinónimos), só alfabeto latino. Escrita pela ingestão via merge_anime_alt_titles, que só acrescenta.';

-- -----------------------------------------------------------------------------
-- 3. Colunas geradas para a pesquisa
-- -----------------------------------------------------------------------------
-- `search_names[1]` é o título; `search_names[k + 1]` é `alt_titles[k]`. As
-- posições ficam alinhadas de propósito (nenhum nome é filtrado aqui), para a
-- pesquisa poder devolver o `alt_titles` original que casou.
--
-- IMMUTABLE é uma promessa: se estas funções mudarem, as colunas guardadas NÃO
-- se recalculam sozinhas. Uma mudança futura tem de fazer
-- `update animes set alt_titles = alt_titles` para as refazer.
create or replace function public.anime_search_names(title text, alt_titles text[])
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array[public.nimu_norm(title)]
      || coalesce(array(select public.nimu_norm(n) from unnest(alt_titles) with ordinality as u(n, i) order by i), '{}'::text[]);
$$;

-- Os mesmos nomes numa só string, para o índice trigram. O separador " | " não
-- pode aparecer numa pesquisa normalizada, por isso nunca se casa um pedaço de
-- um nome com o início do seguinte.
create or replace function public.anime_search_blob(title text, alt_titles text[])
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array_to_string(public.anime_search_names(title, alt_titles), ' | ');
$$;

alter table public.animes
  add column if not exists search_names text[]
    generated always as (public.anime_search_names(title, alt_titles)) stored;

alter table public.animes
  add column if not exists search_blob text
    generated always as (public.anime_search_blob(title, alt_titles)) stored;

create index if not exists animes_search_blob_trgm_idx
  on public.animes using gin (search_blob gin_trgm_ops);

comment on column public.animes.search_names is
  'Gerada: título e alt_titles normalizados (nimu_norm), nas mesmas posições. Usada pela search_animes.';
comment on column public.animes.search_blob is
  'Gerada: search_names numa só string, com índice trigram. Filtro da search_animes.';

-- -----------------------------------------------------------------------------
-- 4. A pesquisa
-- -----------------------------------------------------------------------------
-- `drop` e não `create or replace`: a lista de colunas devolvidas muda (entra
-- `matched_title`).
drop function if exists public.search_animes(text, integer);

create function public.search_animes(
  q           text,
  max_results integer default 8
)
returns table (
  id              uuid,
  slug            text,
  title           varchar(500),
  cover_image_url text,
  status          public.anime_status,
  score           numeric,
  genres          jsonb,
  dominant_color  varchar(9),
  match_rank      integer,
  -- O nome alternativo que casou, quando foi por ele que o anime apareceu. A UI
  -- mostra-o por baixo do título, para quem pesquisou "The Warrior Princess…"
  -- perceber porque é que o resultado se chama "Himekishi wa…".
  matched_title   text
)
language plpgsql
stable
set search_path = ''
-- Planear cada chamada com o texto real. Com um plano genérico o Postgres não
-- sabe se a pesquisa tem 2 ou 20 letras, e escolhe mal entre o índice e a
-- leitura direta (ver o `if` abaixo).
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  -- Normalizada UMA vez. Numa função `language sql` o Postgres voltava a
  -- calculá-la para cada linha (medido: 760 ms em vez de 97 ms com "on").
  -- Normalizada, só tem [a-z0-9 ]: os coringas do LIKE (% e _) e a barra de
  -- escape nunca chegam ao padrão, por isso não há nada a escapar.
  v_q     text := public.nimu_norm(q);
  v_limit integer := greatest(1, least(coalesce(max_results, 8), 25));
  -- Com uma ou duas letras não há trigramas: o índice seria percorrido inteiro,
  -- mais devagar do que ler a tabela. E "a meio de uma palavra" é ruído (o "a"
  -- está em quase todos os títulos). Aí só conta uma palavra que COMECE pelo que
  -- se escreveu, e lê-se a tabela.
  v_short boolean := length(public.nimu_norm(q)) < 3;
begin
  if v_q = '' then
    return;
  end if;

  return query
  -- 1.ª fase: o degrau de cada candidato, só com LIKEs sobre duas strings já
  -- guardadas (o título normalizado e o `search_blob`), sem desfazer a lista de
  -- nomes linha a linha. Só o id e as chaves de ordenação: com poucas letras há
  -- milhares de candidatos, e arrastar as colunas todas pesava.
  --
  --   0  o título é exatamente a pesquisa
  --   1  o título começa pela pesquisa, OU um nome alternativo é exatamente ela
  --   2  uma palavra de algum nome começa pela pesquisa (inclui um nome
  --      alternativo que começa por ela)
  --   3  aparece a meio de uma palavra
  --
  -- No `search_blob` ("titulo | alt1 | alt2") um nome alternativo vem sempre
  -- depois de " | ", e o título nunca: é isso que os distingue nos padrões.
  with ranked as (
    select
      a.id,
      a.popularity,
      a.title,
      coalesce(a.score, a.average_score) as sort_score,
      (case
         when a.search_names[1] = v_q then 0
         when a.search_names[1] like v_q || '%' then 1
         when a.search_blob || ' |' like '% | ' || v_q || ' |%' then 1
         when ' ' || a.search_blob like '% ' || v_q || '%' then 2
         else 3
       end)::integer as tier
    from public.animes a
    -- Com o plano feito para o texto real, só um dos ramos sobra: o de cima usa
    -- o índice trigram, o de baixo lê a tabela.
    where (not v_short and a.search_blob like '%' || v_q || '%')
       or (v_short and ' ' || a.search_blob like '% ' || v_q || '%')
    -- A mesma ordem que o site aplica (lib/data/animes.ts): degrau, depois
    -- popularidade, nota e título. Ordenar igual aqui garante que o teto corta
    -- os mesmos que o site cortaria.
    order by 5, a.popularity desc nulls last, 4 desc nulls last, a.title
    -- Teto rígido: impede que um cliente peça 10 000 linhas por pedido.
    limit v_limit
  )
  -- 2.ª fase, só para os que ficaram: QUAL nome casou. Nulo quando o título
  -- chega ao degrau (o título ganha sempre ao alternativo no mesmo degrau).
  select
    a.id,
    a.slug,
    a.title,
    a.cover_image_url,
    a.status,
    r.sort_score::numeric,
    a.genres,
    coalesce(a.dominant_color, a.accent_color)::varchar(9),
    r.tier,
    case
      when (case
              when a.search_names[1] = v_q then 0
              when a.search_names[1] like v_q || '%' then 1
              when ' ' || a.search_names[1] like '% ' || v_q || '%' then 2
              when a.search_names[1] like '%' || v_q || '%' then 3
              else 9
            end) <= r.tier then null
      else (
        select a.alt_titles[(s.pos - 1)::integer]
        from unnest(a.search_names) with ordinality as s(name, pos)
        where s.pos > 1
          and (case
                 when s.name = v_q then 1
                 when ' ' || s.name like '% ' || v_q || '%' then 2
                 when s.name like '%' || v_q || '%' then 3
                 else 9
               end) <= r.tier
        order by s.pos
        limit 1
      )
    end
  from ranked r
  join public.animes a on a.id = r.id
  order by r.tier, r.popularity desc nulls last, r.sort_score desc nulls last, r.title;
end;
$$;

comment on function public.search_animes(text, integer) is
  'Pesquisa de animes pelo título e pelos títulos alternativos, com ranking (exato > prefixo > prefixo de palavra > contido; título antes de alternativo; depois popularidade). Alimenta o typeahead e /search.';

grant execute on function public.search_animes(text, integer) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Escrita pela ingestão: juntar nomes, nunca apagar
-- -----------------------------------------------------------------------------
-- A lista existente primeiro, depois a nova; um nome repetido (depois de
-- normalizado) fica na primeira posição; o próprio título e nomes vazios caem;
-- no máximo 40, cada um com até 200 caracteres.
create or replace function public.anime_merge_names(
  title    text,
  existing text[],
  incoming text[]
)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(array_agg(x.name order by x.pos), '{}'::text[])
  from (
    select d.name, d.pos
    from (
      select distinct on (k.key) k.name, k.pos
      from (
        select left(btrim(u.n), 200) as name, u.pos, public.nimu_norm(u.n) as key
        from unnest(coalesce(existing, '{}'::text[]) || coalesce(incoming, '{}'::text[]))
             with ordinality as u(n, pos)
        where u.n is not null
      ) k
      where k.key <> '' and k.key <> public.nimu_norm(title)
      order by k.key, k.pos
    ) d
    order by d.pos
    limit 40
  ) x;
$$;

-- Recebe `[{ "id": "<uuid>", "names": ["...", "..."] }, ...]` e devolve quantas
-- linhas mudaram. Uma UPDATE e nunca um INSERT: um id que não exista não cria
-- nada. SECURITY INVOKER (o defeito): só o service_role, que ignora a RLS,
-- consegue escrever; e só a ele se dá permissão para a chamar.
create or replace function public.merge_anime_alt_titles(payload jsonb)
returns integer
language sql
volatile
set search_path = ''
as $$
  with incoming as (
    select (e.value ->> 'id')::uuid as id, e.ord, e.value -> 'names' as names
    from jsonb_array_elements(
           case when jsonb_typeof(payload) = 'array' then payload else '[]'::jsonb end
         ) with ordinality as e(value, ord)
    where jsonb_typeof(e.value) = 'object'
      and jsonb_typeof(e.value -> 'id') = 'string'
      and jsonb_typeof(e.value -> 'names') = 'array'
  ),
  per_id as (
    select i.id, array_agg(n.value order by i.ord, n.ord) as names
    from incoming i
    cross join lateral jsonb_array_elements_text(i.names) with ordinality as n(value, ord)
    group by i.id
  ),
  changed as (
    update public.animes a
       set alt_titles = public.anime_merge_names(a.title, a.alt_titles, p.names)
      from per_id p
     where a.id = p.id
       and a.alt_titles is distinct from public.anime_merge_names(a.title, a.alt_titles, p.names)
    returning 1
  )
  select count(*)::integer from changed;
$$;

comment on function public.merge_anime_alt_titles(jsonb) is
  'Ingestão: junta nomes a animes.alt_titles (só acrescenta, sem repetidos). Só o service_role.';

revoke all on function public.merge_anime_alt_titles(jsonb) from public;
revoke all on function public.merge_anime_alt_titles(jsonb) from anon;
revoke all on function public.merge_anime_alt_titles(jsonb) from authenticated;
grant execute on function public.merge_anime_alt_titles(jsonb) to service_role;

commit;
