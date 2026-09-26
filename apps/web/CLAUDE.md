# apps/web

Frontend conventions. The root `CLAUDE.md` carries the cross-cutting rules; this file
loads only when working under `apps/web`.

## The palette rule, and where it is enforced

`src/theme.css` holds the product-spec §8 palette as Tailwind v4 theme tokens (v4 was
chosen for its CSS-first config). One rule is load-bearing and easy to violate by habit:
**never red for a student's incorrect answer** — amber means "not yet", sage means
correct, rust is reserved for system errors. Cream background, not white. Serif headings,
sans UI, mono code.

That rule is encoded in components rather than left to each screen. `Badge` and `Notice`
take semantic tones (`not-yet`, `good`, `muted`, `system-error`), and the only way to
reach rust is to type the words `system-error`, which is long enough to make you think.
`Button` has **no danger variant**: nothing in this product deletes, and the two actions
that feel destructive — rotating a join code, signing a student out — confirm in a
`Dialog` with words instead of being coloured red.

`src/components/palette.test.tsx` and the colour assertions in `src/routes/Join.test.tsx`
fail the build if this slips. Deleting them is not a way to make a failure go away.

## Structure

- `src/lib/api-types.ts` is **generated** from `apps/api/openapi.json` by
  `npm run api:types`. Never edit it. Regenerate after any API response model changes;
  CI fails if `openapi.json` is stale.
- `src/lib/errors.ts` is the only place that narrows the API's four `detail` shapes.
  Screens read `ApiError`, never a raw body.
- `src/lib/api.ts` is the only place that calls `fetch`. It always sends credentials (the
  student cookie) and attaches a teacher bearer token when there is a session, read fresh
  each request because supabase-js rotates it.
- `src/lib/queries.ts` owns the TanStack Query keys. Mutations invalidate the key they
  affect and no more.

Students never talk to Supabase directly; `@supabase/supabase-js` is for teacher auth
only, and the `service_role` key must never appear in this app.

## Two audiences, one app

Teacher routes sit behind `RequireTeacher`, which supplies `AppShell`. `/join` is outside
it: a child gets `JoinShell` with no navigation, no sign-out and no centre name. The join
flow must keep working when Supabase is unconfigured or unreachable, because it does not
use Supabase at all.

**The class code never goes in a URL.** `/join` keeps its steps in component state. A code
in a query string lands in browser history on a shared centre laptop, in proxy logs, and
in the `Referer` of the next request — which is also why the API takes it in a POST body.

## Local development

`npm run dev` proxies `/api` to `localhost:8000` (see `vite.config.ts`), so the browser
sees one origin and the API needs no CORS. That changes at step 10, when the two are
genuinely on different domains; `VITE_API_BASE_URL` makes it a config change.

Copy `.env.example` to `.env.local` and fill in the Supabase values. Without them the app
still builds and `/join` still works — only teacher sign-in is unavailable, and it says so.
