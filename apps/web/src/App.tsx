/**
 * The route tree.
 *
 * Two audiences share one app and must not share a frame. Teacher pages sit behind
 * `RequireTeacher` and students' behind `RequireStudent`; each guard puts its pages on a
 * desktop of app windows (`desktop/`). `/join` and the sign-in pages are outside both,
 * because a child needs no desktop to sign in — and because the join flow must keep
 * working when Supabase is unconfigured or unreachable.
 */

import { Route, Routes } from 'react-router'
import { AuthCallback } from './routes/AuthCallback'
import { Join } from './routes/Join'
import { Landing } from './routes/Landing'
import { NotFound } from './routes/NotFound'
import { studentPages, teacherPages } from './routes/pages'
import { RequireStudent } from './routes/RequireStudent'
import { RequireTeacher } from './routes/RequireTeacher'
import { ResetPassword } from './routes/ResetPassword'
import { SignIn } from './routes/SignIn'
import { SignUp } from './routes/SignUp'

export default function App() {
  return (
    <Routes>
      {/* The bare address is the children's sign-in; /join stays as an alias. */}
      <Route path="/" element={<Landing />} />
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/sign-up" element={<SignUp />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/join" element={<Join />} />

      <Route element={<RequireStudent />}>{studentPages}</Route>
      <Route element={<RequireTeacher />}>{teacherPages}</Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
