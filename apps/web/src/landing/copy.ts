/**
 * The landing page's words, kept apart from its layout.
 *
 * This repo is public. Nothing here carries a price, and the only customer named is
 * `LIVE_AT`, which Ken has permission to show by name only (22 Oct 2026). That means no
 * quote, no logo, and nothing about the children there. Every claim is about something
 * that exists in the product today. Turtle is the exception, and its section says
 * "coming".
 */

export type Point = [title: string, body: string]

/** Where Book a demo writes to. Must be a real inbox: Resend only *sends* from no-reply@. */
export const DEMO_EMAIL = 'hello@yogucode.com'

export const DEMO_HREF = `mailto:${DEMO_EMAIL}?subject=${encodeURIComponent('Yogucode demo')}&body=${encodeURIComponent(
  'Hi Yogucode,\n\nWe would like to see Yogucode with our classes.\n\nCentre:\nWhere you are:\nHow many students code with you each week:\nWhat you teach (e.g. Python, Year 4-6):\n\nThanks,\n',
)}`

/** The centre Yogucode runs in today. Name only (see above). */
export const LIVE_AT = 'Magikid Castle Hill'

/**
 * The pitch (Ken, 23 Oct 2026): Yogucode is the all-in-one platform for coding academies.
 * Each line below is something in the product today.
 */
export const HEADLINE = 'The all-in-one platform for coding academies.'
export const SUBLINE =
  'Lessons, live class, homework, quizzes, marking and progress, in one place. Real Python in the browser, with nothing to install.'

/** What's inside: the tools a centre would otherwise juggle separately. */
export const INSIDE: Point[] = [
  ['Lessons with a ladder', 'Easy, medium and stretch problems on one idea, with checks and step-by-step hints.'],
  ['Live class', 'Every child on one screen. See who is stuck and help inside their code.'],
  ['Homework and marking', 'Set it in a real editor, then mark question by question with reusable comments.'],
  ['Quizzes', 'Timed quizzes mixing multiple choice and code, marked for you.'],
  ['Progress by concept', 'See which ideas each child and each class have, and what to teach next.'],
  ['Accounts and files', 'Usernames and PINs for kids, no email needed. Their files stay from term to term.'],
]

/** The live class demo's chapters, in order. Their start times are `CHAPTER_STARTS` in `liveScript.ts`. */
export const LIVE_CHAPTERS: { title: string; caption: string }[] = [
  { title: 'Noah types', caption: 'Noah types on his laptop. Ms Lee sees every keystroke as it happens.' },
  { title: 'He gets stuck', caption: 'Four runs, the same error. His tile tells her so she doesn’t have to spot it.' },
  { title: 'She opens his code', caption: 'She clicks his tile to see his code full size, then presses Help.' },
  { title: 'They fix it together', caption: 'She types the missing colon into his editor, and it appears on his screen.' },
  { title: 'Back to Noah', caption: 'Help ends, his editor unlocks, and his program runs.' },
]

export const TEACHER_POINTS: Point[] = [
  ['See who is stuck', 'Live class shows each child on the ladder, so the quiet kid who is stuck is reached early.'],
  ['Help, inside their code', 'Press Help and you type in the child’s file with them.'],
  ['Mark by question', 'Homework marked question by question, with comments you can reuse.'],
]

export const KID_POINTS: Point[] = [
  ['A username and a PIN', 'No email, no password to forget at home.'],
  ['"Not yet", never a red cross', 'A mistake is the next thing to try, not a failure.'],
  ['Their own files', 'Folders and files that are still there next week.'],
]

export const PARENT_POINTS: Point[] = [
  ['Real progress, not just a mark', 'Teachers see which ideas have clicked, so a chat at pickup can be specific.'],
  ['Private by design', 'No email or social account for children. Their records stay with their centre.'],
  ['Work is kept', 'A child’s files stay from term to term, so their progress follows them.'],
]
