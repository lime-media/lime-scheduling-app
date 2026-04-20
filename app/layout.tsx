import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/Providers'

if (typeof window === 'undefined') {
  import('@/lib/cronJob').then(({ startCronJobs }) => startCronJobs())
}

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Lime Media Scheduling Assistant',
  description: 'Truck scheduling and availability management for Lime Media',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-gray-50 min-h-screen`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
