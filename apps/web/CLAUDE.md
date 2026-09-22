# apps/web

Frontend conventions. The root `CLAUDE.md` carries the cross-cutting rules; this file
loads only when working under `apps/web`.

`src/theme.css` holds the product-spec §8 palette as Tailwind v4 theme tokens (v4 was
chosen for its CSS-first config). One rule is load-bearing and easy to violate by habit:
**never red for a student's incorrect answer** — amber means "not yet", sage means
correct, rust is reserved for system errors. Cream background, not white. Serif headings,
sans UI, mono code.

Students never talk to Supabase directly; `@supabase/supabase-js` is for teacher auth
only.
