export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-muted">
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-grape-pale border-t-grape"
      />
      <span className="text-sm">{label}</span>
    </span>
  )
}
