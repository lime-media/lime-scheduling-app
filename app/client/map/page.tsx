'use client'

import dynamic from 'next/dynamic'
import { ClientHeader } from '@/components/ClientHeader'
import { useClientAuth } from '@/lib/useClientAuth'

const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center bg-gray-100">
      <p className="text-gray-500 text-sm">Loading map…</p>
    </div>
  ),
})

export default function ClientMapPage() {
  const { clientUser, authChecked } = useClientAuth()

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-gray-50">
      <ClientHeader clientUser={clientUser} authChecked={authChecked} />

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <MapView clientView />
      </div>
    </div>
  )
}
