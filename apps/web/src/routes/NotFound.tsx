import { Link } from 'react-router'
import { Card, PageHeader } from '../components/Card'
import { JoinShell } from '../components/AppShell'

export function NotFound() {
  return (
    <JoinShell>
      <Card>
        <PageHeader title="Page not found" />
        <p className="text-sm text-ink-soft">
          <Link to="/classes" className="text-sky-deep underline">
            Go to your classes
          </Link>{' '}
          or{' '}
          <Link to="/join" className="text-sky-deep underline">
            join a class
          </Link>
          .
        </p>
      </Card>
    </JoinShell>
  )
}
