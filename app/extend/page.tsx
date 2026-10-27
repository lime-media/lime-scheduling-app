/**
 * The confirm step of the expiry reminder email's Extend button
 * (lib/holdExpiryWarnings.ts). No sign-in: the signed token is the rep's
 * permission for this booking (lib/extendLink.ts). The email's button only
 * opens this page; extending takes the click here, so a mail scanner that
 * opens links can't extend anything.
 */
import Image from 'next/image'
import { prisma } from '@/lib/prisma'
import { centralDate, parseDateOnly } from '@/lib/dateOnly'
import { capStarts, loadBooking } from '@/lib/bookingExpiry'
import { STAFF_MIN_DAYS_BEFORE_START, lastExpiryDate } from '@/lib/holdExpiry'
import { extendOptions, readExtendToken } from '@/lib/extendLink'
import { ExtendConfirm } from './ExtendConfirm'

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

export default async function ExtendPage({ searchParams }: { searchParams: { t?: string; d?: string } }) {
  const secret = process.env.NEXTAUTH_SECRET
  const claims = secret && searchParams.t ? readExtendToken(searchParams.t, secret) : null
  const hold = claims ? await prisma.hold.findUnique({ where: { id: claims.holdId } }) : null
  if (!claims || !hold || hold.created_by !== claims.userId) {
    return <Shell><p className="text-sm text-gray-700">This link has expired or isn&apos;t valid. You can still extend the reservation on <a className="text-green-700 underline" href="/hold-requests">Reservations</a>.</p></Shell>
  }
  // A hold that's no longer live (e.g. the deal went Closed Lost) keeps its expires_at.
  if (hold.expires_at?.toISOString() !== claims.expiresAt || (hold.status !== 'HOLD' && hold.status !== 'EXTENSION_REQUESTED')) {
    return <Shell><p className="text-sm text-gray-700">This reservation has already been extended or changed. The next reminder will have a new link, or you can change it on <a className="text-green-700 underline" href="/hold-requests">Reservations</a>.</p></Shell>
  }

  const whole = await loadBooking(hold)
  const booking = whole.filter(h => h.status === 'HOLD' || h.status === 'EXTENSION_REQUESTED')
  const day = (d: Date) => d.toISOString().slice(0, 10)
  const markets = [...new Set(booking.map(h => h.market))]
  const trucks = [...new Set(booking.map(h => h.truck_number))]
  const start = booking.map(h => day(h.start_date)).sort()[0]
  const end = booking.map(h => day(h.end_date)).sort().reverse()[0]
  const expiresOn = centralDate(new Date(claims.expiresAt))
  const picked = Number(searchParams.d) === 2 ? 2 : 1
  // Only the days the server would accept: the booking's limit, as on Reservations (lib/bookingExpiry.ts).
  const lastDate = lastExpiryDate([...capStarts(whole)].sort()[0], new Date(), STAFF_MIN_DAYS_BEFORE_START)
  // Extending sets every hold to one date: never earlier than one already expires (app/api/extend refuses the same).
  const latestOn = booking.map(h => h.expires_at ? centralDate(h.expires_at) : '').sort().reverse()[0]
  const options = extendOptions(expiresOn, lastDate, latestOn)
  if (booking.some(h => h.status === 'EXTENSION_REQUESTED')) {
    return <Shell><p className="text-sm text-gray-700">The client has asked to extend this reservation. Answer the request on <a className="text-green-700 underline" href="/hold-requests">Reservations</a>, which also emails them the decision.</p></Shell>
  }
  if (!options.length) {
    return <Shell><p className="text-sm text-gray-700">This reservation can&apos;t be held any later: its first market starts too soon. Commit it or change it on <a className="text-green-700 underline" href="/hold-requests">Reservations</a>.</p></Shell>
  }

  return (
    <Shell>
      <div>
        <h1 className="text-lg font-bold text-gray-900">Extend this reservation</h1>
        <p className="text-sm text-gray-500 mt-1">{hold.client_name}</p>
      </div>
      <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-gray-500">{markets.length > 1 ? 'Markets' : 'Market'}</dt><dd className="text-gray-900">{markets.join(', ')}</dd>
        <dt className="text-gray-500">{trucks.length > 1 ? 'Trucks' : 'Truck'}</dt><dd className="text-gray-900">{trucks.join(', ')}</dd>
        <dt className="text-gray-500">Dates</dt><dd className="text-gray-900">{longDate(start)} – {longDate(end)}</dd>
        <dt className="text-gray-500">Expires</dt><dd className="text-gray-900">{longDate(expiresOn)}, end of day (Central)</dd>
      </dl>
      <ExtendConfirm token={searchParams.t!} options={options} picked={options.some(o => o.days === picked) ? picked : options[0].days} />
    </Shell>
  )
}
