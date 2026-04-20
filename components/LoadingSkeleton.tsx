export function ScheduleSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-10 bg-gray-200 rounded mb-4" />
      <div className="overflow-x-auto">
        <div className="min-w-max">
          <div className="flex gap-0.5 mb-0.5">
            <div className="w-24 h-8 bg-gray-200 rounded" />
            {Array.from({ length: 20 }).map((_, i) => (
              <div key={i} className="w-10 h-8 bg-gray-200 rounded" />
            ))}
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-0.5 mb-0.5">
              <div className="w-24 h-8 bg-gray-200 rounded" />
              {Array.from({ length: 20 }).map((_, j) => (
                <div key={j} className="w-10 h-8 bg-gray-200 rounded" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function TableSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-10 bg-gray-200 rounded mb-4 w-1/2" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-12 bg-gray-200 rounded" />
        ))}
      </div>
    </div>
  )
}

export function ChatSkeleton() {
  return (
    <div className="animate-pulse space-y-3 p-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
          <div
            className={`h-10 bg-gray-200 rounded-xl ${
              i % 2 === 0 ? 'w-3/4' : 'w-1/2'
            }`}
          />
        </div>
      ))}
    </div>
  )
}
