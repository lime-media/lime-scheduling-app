'use client'

import { Navbar } from '@/components/Navbar'
import { OpsPlanner } from '@/components/OpsPlanner'

export default function PlannerPage() {
  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      <Navbar />
      <OpsPlanner />
    </div>
  )
}
