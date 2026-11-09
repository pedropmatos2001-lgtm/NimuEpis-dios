# Nimu: atualização dos episódios

Este repositório só corre as tarefas automáticas que mantêm os horários da
[Nimu](https://nimuhome.com) atualizados:

- `ingest.yml`: de 6 em 6 horas, vai buscar os horários da semana e atualiza
  episódios, estados, seguidores, títulos alternativos, trailers e sinopses.
- `push.yml`: envia as notificações push pendentes.
- `series.yml`: só à mão, para planear ou gravar o agrupamento por séries.

O site em si vive noutro repositório (privado). Aqui está só o código de
recolha de dados, mais os poucos ficheiros partilhados de que ele precisa
(`web/lib/...`, uma migração e um fixture dos testes).

## Segredos

Tudo o que é sensível está em **Settings → Secrets and variables → Actions**
e nunca aparece no código nem nos registos:

`SUPABASE_URL`, `SUPABASE_SECRET_KEY` (a chave secreta `sb_secret_...` ou a service_role), `ANIMESCHEDULE_TOKEN`,
`TVDB_API_KEY`, `TMDB_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`, `PUBLIC_SITE_URL`.

Nenhum workflow corre em pull requests: só no horário marcado ou à mão, por
isso ninguém de fora consegue pôr código a correr com estes segredos.

## Temporário

Existe enquanto o repositório principal não tem minutos de Actions (até 1 de
dezembro de 2026). Quando voltar, desligar aqui os workflows (Actions →
cada workflow → Disable) **antes** de os voltar a ligar no principal, para as
duas atualizações nunca correrem ao mesmo tempo.
