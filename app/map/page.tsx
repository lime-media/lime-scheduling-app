'use client'

import dynamic from 'next/dynamic'
import { Navbar } from '@/components/Navbar'

const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center bg-gray-100">
      <p className="text-gray-500 text-sm">Loading map…</p>
    </div>
  ),
})

export default function MapPage() {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Navbar />
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <MapView />
      </div>
    </div>
  )
}
