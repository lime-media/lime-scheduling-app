'use client'

import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { Navbar } from '@/components/Navbar'

export default function QuotePage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login')
  }, [status, router])

  if (status === 'loading' || !session) return null

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      <Navbar />
      <div className="flex-1 flex flex-col">
        <iframe
          src="/led-quote-generator.html"
          className="flex-1 w-full border-0"
          style={{ minHeight: 'calc(100vh - 56px)' }}
          title="LED Quote Generator"
        />
      </div>
    </div>
  )
}
