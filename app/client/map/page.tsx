'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
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
  const pathname = usePathname()
  const { clientUser, authChecked } = useClientAuth()
  // Staged rollout — see app/api/client/chat/route.ts
  const isTestClient = clientUser?.username === 'testclient'

  return (
    <div className="flex flex-col h-dvh overflow-hidden">
      {isTestClient ? (
        <ClientHeader clientUser={clientUser} authChecked={authChecked} />
      ) : (
        <header className="bg-[#94ce3a] shadow-lg px-4 sm:px-6 py-3 flex items-center flex-shrink-0">
          <img src="/logo.png" alt="Lime Media" className="h-9 w-auto" />
          <span className="flex-1 text-center text-[#1a3028] font-bold text-lg">Lime Media Scheduling Availability</span>
          <nav className="flex gap-1">
            <Link
              href="/client"
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                pathname === '/client'
                  ? 'bg-[#1a3028] text-white'
                  : 'text-[#1a3028] hover:bg-[#1a3028]/20'
              }`}
            >
              Schedule
            </Link>
            <Link
              href="/client/map"
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                pathname === '/client/map'
                  ? 'bg-[#1a3028] text-white'
                  : 'text-[#1a3028] hover:bg-[#1a3028]/20'
              }`}
            >
              Map
            </Link>
          </nav>
        </header>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <MapView clientView />
      </div>
    </div>
  )
}
