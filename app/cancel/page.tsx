/**
 * The confirm step of the expiry reminder email's Cancel link
 * (lib/holdExpiryWarnings.ts). No sign-in: the signed token is the rep's
 * permission for this booking (lib/extendLink.ts, signed for cancelling). The
 * email's link only opens this page; cancelling takes the click here, so a
 * mail scanner that opens links can't cancel anything.
 */
import Image from 'next/image'
import { prisma } from '@/lib/prisma'
import { centralDate, parseDateOnly } from '@/lib/dateOnly'
import { loadBooking } from '@/lib/bookingExpiry'
import { readCancelToken } from '@/lib/extendLink'
import { bookingSummary, closedWonRefusal } from '@/lib/bookings'
import { CancelConfirm } from './CancelConfirm'

export const dynamic = 'force-dynamic'

const longDate = (d: string) => parseDateOnly(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 w-full max-w-md p-6 space-y-4">
        <Image src="/logo.png" alt="Lime Media" width={120} height={40} />
        {children}
      </div>
    </main>
  )
}

const reservations = <a className="text-green-700 underline" href="/hold-requests">Reservations</a>

export default async function CancelPage({ searchParams }: { searchParams: { t?: string } }) {
  const secret = process.env.NEXTAUTH_SECRET
  const claims = secret && searchParams.t ? readCancelToken(searchParams.t, secret) : null
  const hold = claims ? await prisma.hold.findUnique({ where: { id: claims.holdId } }) : null
  if (!claims || !hold || hold.created_by !== claims.userId) {
    return <Shell><p className="text-sm text-gray-700">This link has expired or isn&apos;t valid. You can still cancel the reservation on {reservations}.</p></Shell>
  }
  // Cancelled already (from this link, or on Reservations): say so, not "changed".
  if (hold.status === 'EXPIRED' && hold.cancelled_at) {
    return <Shell><p className="text-sm text-gray-700">This reservation has already been cancelled. It&apos;s on {reservations} under Expired, where it can be reinstated.</p></Shell>
  }
  if (hold.expires_at?.toISOString() !== claims.expiresAt || (hold.status !== 'HOLD' && hold.status !== 'EXTENSION_REQUESTED')) {
    return <Shell><p className="text-sm text-gray-700">{hold.status === 'EXPIRED'
      ? <>This reservation has already been released, so there is nothing to cancel. See it on {reservations}.</>
      : <>This reservation has already been extended or changed since this email. You can cancel it on {reservations}.</>}</p></Shell>
  }

  const whole = await loadBooking(hold)
  // A won deal changes in Salesforce first, as the server refuses (lib/cancelBooking.ts).
  if (closedWonRefusal(whole)) {
    return <Shell><p className="text-sm text-gray-700">Part of this reservation is already committed (Closed Won), so it can&apos;t be cancelled here. Change it in Salesforce first, or see it on {reservations}.</p></Shell>
  }
  const booking = whole.filter(h => h.status === 'HOLD' || h.status === 'EXTENSION_REQUESTED')
  const { markets, trucks, startDate, endDate } = bookingSummary(booking)

  return (
    <Shell>
      <div>
        <h1 className="text-lg font-bold text-gray-900">Cancel this reservation</h1>
        <p className="text-sm text-gray-500 mt-1">{hold.client_name}</p>
      </div>
      <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-gray-500">{markets.length > 1 ? 'Markets' : 'Market'}</dt><dd className="text-gray-900">{markets.join(', ')}</dd>
        <dt className="text-gray-500">{trucks.length > 1 ? 'Trucks' : 'Truck'}</dt><dd className="text-gray-900">{trucks.join(', ')}</dd>
        <dt className="text-gray-500">Dates</dt><dd className="text-gray-900">{longDate(startDate)} – {longDate(endDate)}</dd>
        <dt className="text-gray-500">Expires</dt><dd className="text-gray-900">{longDate(centralDate(new Date(claims.expiresAt)))}, end of day (Central)</dd>
      </dl>
      <p className="text-xs text-gray-500">Every market and truck of this reservation is released now. It stays on Reservations under Expired, where it can be reinstated.</p>
      <CancelConfirm token={searchParams.t!} clientEmailed={booking.some(h => h.client_user?.email)} clientPortal={booking.some(h => h.client_user_id)} />
    </Shell>
  )
}
