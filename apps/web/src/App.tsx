/**
 * The route tree.
 *
 * Two audiences share one app and must not share a frame. Teacher routes sit behind
 * `RequireTeacher`, which supplies the shell; `/join` is outside it entirely, because a
 * child needs no navigation, no sign-out and no centre name — and because the join flow
 * must keep working when Supabase is unconfigured or unreachable.
 */

import { Navigate, Route, Routes } from 'react-router'
import { AuthCallback } from './routes/AuthCallback'
import { ClassDetail } from './routes/ClassDetail'
import { ClassList } from './routes/ClassList'
import { Join } from './routes/Join'
import { NotFound } from './routes/NotFound'
import { RequireTeacher } from './routes/RequireTeacher'
import { SignIn } from './routes/SignIn'
import { SlipSheet } from './routes/SlipSheet'
import { Work } from './routes/Work'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/classes" replace />} />
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/join" element={<Join />} />
      <Route path="/work" element={<Work />} />

      <Route element={<RequireTeacher />}>
        <Route path="/classes" element={<ClassList />} />
        <Route path="/classes/:classId" element={<ClassDetail />} />
        <Route path="/classes/:classId/slips" element={<SlipSheet />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
