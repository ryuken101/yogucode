/**
 * The Yogucode marks, from the "Yogucode Brand" design system (Ken's choice, 10 Oct 2026).
 *
 * - `CupMark`: the smiling yogurt cup on a strawberry tile. The app icon, favicon and
 *   avatar. The SVG is the brand file verbatim (`public/favicon.svg` is the same drawing);
 *   never redraw it.
 * - `Wordmark`: `<yogucode>` in Fredoka SemiBold. Letters take the current text colour
 *   (grape on cream or white, white on grape); both o's and both brackets are always
 *   strawberry. Lower case, tracking -0.01em, brackets 0.8em tall.
 * - `Lockup`: cup to the left of the wordmark, the cup about twice the wordmark's x-height.
 *
 * The brand book's don'ts: don't change the bracket shape, recolour the o's, set the
 * wordmark in another font, or put the cup on a strawberry background (it vanishes).
 */

const STRAWBERRY = '#FF5C8A'

export function CupMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <rect x="0" y="0" width="200" height="200" rx="48" fill="#FF5C8A" />
      <rect x="72" y="58" width="56" height="26" rx="13" fill="#FFFFFF" />
      <circle cx="100" cy="50" r="9" fill="#FFD166" />
      <path d="M60 90 H140 L130 162 Q129.500 168 123 168 H77 Q70.500 168 70 162 Z" fill="#FFF6E9" />
      <rect x="54" y="80" width="92" height="14" rx="7" fill="#FFFFFF" />
      <circle cx="87" cy="124" r="5.500" fill="#4B2FB8" />
      <circle cx="113" cy="124" r="5.500" fill="#4B2FB8" />
      <path
        d="M92 135 Q100 143 108 135"
        fill="none"
        stroke="#4B2FB8"
        strokeWidth="4.500"
        strokeLinecap="round"
      />
      <circle cx="79" cy="136" r="6" fill="#FF5C8A" fillOpacity="0.55" />
      <circle cx="121" cy="136" r="6" fill="#FF5C8A" fillOpacity="0.55" />
    </svg>
  )
}

function Bracket({ side }: { side: 'open' | 'close' }) {
  const d = side === 'open' ? 'M28 8 L8 40 L28 72' : 'M8 8 L28 40 L8 72'
  return (
    <svg viewBox="0 0 36 80" className="relative top-[0.06em] h-[0.8em] w-[0.4em]" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={STRAWBERRY}
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** `<yogucode>`. Size it with a text-size class on the parent or `className`. */
export function Wordmark({ className = '' }: { className?: string }) {
  const o = <span style={{ color: STRAWBERRY }}>o</span>
  return (
    <span
      role="img"
      aria-label="Yogucode"
      className={`inline-flex items-center gap-[0.1em] font-display leading-none font-semibold tracking-[-0.01em] ${className}`}
    >
      <Bracket side="open" />
      <span aria-hidden="true" className="inline-flex items-baseline">
        y{o}guc{o}de
      </span>
      <Bracket side="close" />
    </span>
  )
}

/** Cup and wordmark together. `size` is the cup's edge in pixels. */
export function Lockup({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <CupMark size={size} />
      {/* The brand's own lockup sets a 64px cup beside 30px type; this keeps that ratio. */}
      <span style={{ fontSize: Math.round(size * 0.6) }}>
        <Wordmark />
      </span>
    </span>
  )
}

/**
 * The front-page welcome: the cup, the wordmark and the tagline. Above the class-code
 * card at the bare address (Ken's choice, 10 Oct 2026) and on the teacher sign-in.
 */
export function Welcome({ tagline = 'Code, but make it fun.' }: { tagline?: string }) {
  return (
    <div className="mb-8 flex flex-col items-center gap-3 text-center text-grape">
      <CupMark size={96} />
      <span className="text-5xl">
        <Wordmark />
      </span>
      <p className="text-lg text-muted">{tagline}</p>
    </div>
  )
}
