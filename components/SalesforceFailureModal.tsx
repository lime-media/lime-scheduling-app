'use client'

/**
 * Salesforce failed after a booking was saved. Shown on its own, in red, and
 * dismissed by hand, so a missing or stale opportunity can't be read past as
 * part of the green "Reserved" confirmation. `detail` is the server's
 * sfdcFailure: what failed and what to do in Salesforce.
 */
export function SalesforceFailureModal({ detail, onClose }: { detail: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="sfdc-failure-title">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md border-t-4 border-red-600">
        <div className="px-6 py-4">
          <h2 id="sfdc-failure-title" className="text-lg font-bold text-red-700">Salesforce was not updated</h2>
          <p className="text-sm text-gray-700 mt-2">The reservation is saved. Salesforce is not.</p>
          <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">{detail}</p>
        </div>
        <div className="px-6 py-3 border-t border-gray-100 flex justify-end">
          <button onClick={onClose} autoFocus className="bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg px-4 py-2">
            I&apos;ll fix it in Salesforce
          </button>
        </div>
      </div>
    </div>
  )
}
