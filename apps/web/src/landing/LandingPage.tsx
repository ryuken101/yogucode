/**
 * The public front page. Ken's decision of 23 Oct 2026, after sharyap.com, made it calm and
 * minimal, replacing 22 Oct's busier page, and pitches Yogucode as the all-in-one platform
 * for coding academies. The top is a quiet desktop (`HeroDesktop`): desktop icons open
 * small windows, and Hello holds the headline. Below that is a short scroll: what's inside,
 * a short film of a live class (`LiveDemo`), who it's for, the turtle, then the live line and
 * Book a demo.
 *
 * Visitors watch and click, but never type code. The turtle drawing is a JS replay that
 * starts when it scrolls into view. The only decoration is the cup in the corner that fills
 * as you scroll (`Flair.tsx`).
 */

import { Backpack, BarChart3, BookOpen, ClipboardCheck, FolderClosed, GraduationCap, Heart, Mail, Radio, Timer } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useRef } from 'react'
import { Link } from 'react-router'
import { Lockup } from '../components/Brand'
import { DEMO_EMAIL, DEMO_HREF, INSIDE, KID_POINTS, LIVE_AT, PARENT_POINTS, TEACHER_POINTS } from './copy'
import type { Point } from './copy'
import { ScrollCup } from './Flair'
import { HeroDesktop } from './HeroDesktop'
import { LiveDemo } from './LiveDemo'
import { TurtleWindow } from './TurtleWindow'
import { useSeen } from './useMedia'

const linkQuiet =
  'rounded-2xl px-3 py-2 text-sm font-medium text-muted hover:bg-surface hover:text-grape focus-visible:outline-2 focus-visible:outline-grape-deep'

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-cream text-grape">
      <Hero />
      <main>
        <Inside />
        <LiveSection />
        <Audiences />
        <TurtleSection />
        <Closing />
      </main>
      <Footer />
      <ScrollCup target="demo" />
    </div>
  )
}

function Hero() {
  return (
    <section id="top" className="flex flex-col min-[761px]:h-[min(100dvh,860px)] min-[761px]:min-h-[620px]">
      <header className="flex h-16 shrink-0 items-center gap-2 px-4 min-[761px]:px-6">
        <Lockup size={28} />
        <span className="flex-1" />
        <Link to="/sign-in" className={`hidden sm:inline-flex ${linkQuiet}`}>
          Teacher sign in
        </Link>
        <Link
          to="/join"
          className="inline-flex rounded-2xl bg-lemon px-4 py-2 text-sm font-semibold text-grape ring-1 ring-grape/10 hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-grape-deep"
        >
          Student sign in
        </Link>
      </header>
      <HeroDesktop />
      <a href="#inside" aria-label="Scroll down" className="mx-auto mb-2 hidden px-4 py-1 text-muted hover:text-grape min-[761px]:block">
        ↓
      </a>
    </section>
  )
}

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      <h2 className="font-display text-3xl leading-tight font-semibold sm:text-4xl">{title}</h2>
      {children ? <p className="mt-4 text-lg text-muted">{children}</p> : null}
    </div>
  )
}

/** One icon per line of `INSIDE`, in order. */
const INSIDE_ICONS: LucideIcon[] = [BookOpen, Radio, ClipboardCheck, Timer, BarChart3, FolderClosed]

function Inside() {
  return (
    <section id="inside" className="scroll-mt-4 bg-surface px-4 py-24">
      <SectionHead title="Everything your academy runs on, in one place.">
        No more code in one app, quizzes in another and marks in a spreadsheet. Yogucode is the
        whole lesson, from the first problem to knowing what each child has learned.
      </SectionHead>
      <ul className="mx-auto grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {INSIDE.map(([title, body], i) => {
          const Icon = INSIDE_ICONS[i]
          return (
            <li key={title} className="rounded-3xl border border-line p-6">
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-grape-pale">
                <Icon size={20} aria-hidden="true" />
              </span>
              <p className="font-display text-lg font-semibold">{title}</p>
              <p className="mt-1 text-muted">{body}</p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function LiveSection() {
  return (
    <section id="live" aria-labelledby="live-title" className="scroll-mt-4 px-4 py-24">
      <div className="mx-auto mb-10 max-w-2xl text-center">
        <h2 id="live-title" className="font-display text-3xl leading-tight font-semibold sm:text-4xl">
          See a live class.
        </h2>
        <p className="mt-4 text-lg text-muted">
          Every child’s code is on the teacher’s screen as they type it. When someone is stuck,
          she opens their code and helps right inside their editor, from wherever she is in
          the room.
        </p>
      </div>
      <LiveDemo />
    </section>
  )
}

function Column({ icon: Icon, title, points }: { icon: LucideIcon; title: string; points: Point[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-grape-pale">
          <Icon size={20} aria-hidden="true" />
        </span>
        <h3 className="font-display text-xl font-semibold">{title}</h3>
      </div>
      <ul className="flex flex-col gap-3">
        {points.map(([t, body]) => (
          <li key={t}>
            <p className="font-semibold">{t}</p>
            <p className="text-sm text-muted">{body}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Audiences() {
  return (
    <section className="bg-surface px-4 py-24">
      <SectionHead title="Made for the whole classroom." />
      <div className="mx-auto grid max-w-5xl gap-10 md:grid-cols-3">
        <Column icon={GraduationCap} title="For teachers" points={TEACHER_POINTS} />
        <Column icon={Backpack} title="For kids" points={KID_POINTS} />
        <Column icon={Heart} title="For parents" points={PARENT_POINTS} />
      </div>
    </section>
  )
}

function TurtleSection() {
  const box = useRef<HTMLDivElement>(null)
  const seen = useSeen(box)
  return (
    <section className="px-4 py-24">
      <div className="mx-auto grid max-w-5xl items-center gap-10 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-4">
          <h2 className="font-display text-3xl leading-tight font-semibold sm:text-4xl">Our logo, drawn by a turtle.</h2>
          <p className="text-lg text-muted">
            Kids write real Python, not drag-and-drop blocks. This program draws the Yogucode cup
            one line at a time.
          </p>
          <p className="text-sm text-muted">Turtle drawing is coming to Yogucode classes.</p>
        </div>
        <div ref={box} className="h-[600px] overflow-hidden rounded-3xl border border-line bg-surface @container sm:h-[460px]">
          <TurtleWindow play={seen} />
        </div>
      </div>
    </section>
  )
}

function Closing() {
  return (
    <section id="demo" className="scroll-mt-4 bg-surface px-4 py-24 text-center">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-6">
        <p className="flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1 text-sm font-medium ring-1 ring-line">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-good opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-good" />
          </span>
          Live now
        </p>
        <h2 className="font-display text-3xl leading-tight font-semibold sm:text-4xl">
          Running in real classes at {LIVE_AT}.
        </h2>
        <p className="text-lg text-muted">
          Tell us a little about your centre and we'll walk through a lesson on Yogucode together.
        </p>
        <a
          href={DEMO_HREF}
          className="inline-flex items-center gap-2 rounded-2xl bg-grape px-6 py-3 text-lg font-medium text-surface hover:bg-grape-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-grape-deep"
        >
          <Mail size={20} aria-hidden="true" /> Email us to book a demo
        </a>
        <p className="text-sm text-muted">
          Or write to{' '}
          <a href={`mailto:${DEMO_EMAIL}`} className="font-medium text-grape underline">
            {DEMO_EMAIL}
          </a>
          .
        </p>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-line px-4 py-8">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 text-sm text-muted">
        <Lockup size={22} />
        <span className="flex-1" />
        <Link to="/join" className="hover:text-grape">Student sign in</Link>
        <Link to="/sign-in" className="hover:text-grape">Teacher sign in</Link>
        <span>© {new Date().getFullYear()} Yogucode</span>
      </div>
    </footer>
  )
}
