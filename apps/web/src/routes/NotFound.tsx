import { Link } from 'react-router'
import { Card } from '../components/Card'
import { JoinShell } from '../components/AppShell'
import { CupMark } from '../components/Brand'

export function NotFound() {
  return (
    <JoinShell>
      <Card className="text-center">
        <div className="mb-4 flex justify-center">
          <CupMark size={72} />
        </div>
        <h1 className="text-2xl text-grape">Nothing in this cup</h1>
        <p className="mt-2 text-sm text-muted">
          That page doesn’t exist.{' '}
          <Link to="/classes" className="text-grape-deep underline">
            Go to your classes
          </Link>{' '}
          or{' '}
          <Link to="/" className="text-grape-deep underline">
            join a class
          </Link>
          .
        </p>
      </Card>
    </JoinShell>
  )
}
