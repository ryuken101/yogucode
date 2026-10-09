/** A nav link as a pill: grape-pale when it is the page you are on. For `NavLink`'s className. */
export function navPill({ isActive }: { isActive: boolean }): string {
  return `rounded-full px-3 py-1 transition-colors ${
    isActive ? 'bg-grape-pale font-medium text-grape' : 'text-muted hover:bg-cream hover:text-grape'
  }`
}
