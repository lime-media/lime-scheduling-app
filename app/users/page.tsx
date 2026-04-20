'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Navbar } from '@/components/Navbar'
import toast from 'react-hot-toast'

interface AppUser {
  id:         string
  name:       string
  email:      string
  role:       string
  created_at: string
}

interface UserForm {
  name:     string
  email:    string
  password: string
  role:     string
}

const EMPTY_FORM: UserForm = { name: '', email: '', password: '', role: 'SALES' }

export default function UsersPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [users,       setUsers]       = useState<AppUser[]>([])
  const [loading,     setLoading]     = useState(true)
  const [modalMode,   setModalMode]   = useState<'add' | 'edit' | null>(null)
  const [editTarget,  setEditTarget]  = useState<AppUser | null>(null)
  const [form,        setForm]        = useState<UserForm>(EMPTY_FORM)
  const [showPw,      setShowPw]      = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [deleteId,    setDeleteId]    = useState<string | null>(null)

  // Role guard
  useEffect(() => {
    if (status === 'loading') return
    if (!session || session.user?.role !== 'OPERATIONS') router.replace('/')
  }, [session, status, router])

  async function fetchUsers() {
    setLoading(true)
    try {
      const res  = await fetch('/api/users')
      const data = res.ok ? await res.json() : { users: [] }
      setUsers(data.users ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchUsers() }, [])

  function openAdd() {
    setForm(EMPTY_FORM)
    setShowPw(false)
    setEditTarget(null)
    setModalMode('add')
  }

  function openEdit(user: AppUser) {
    setForm({ name: user.name, email: user.email, password: '', role: user.role })
    setShowPw(false)
    setEditTarget(user)
    setModalMode('edit')
  }

  function closeModal() {
    setModalMode(null)
    setEditTarget(null)
    setForm(EMPTY_FORM)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.email.trim()) {
      toast.error('Name and email are required')
      return
    }
    if (modalMode === 'add' && !form.password) {
      toast.error('Password is required for new users')
      return
    }

    setSaving(true)
    try {
      const isEdit = modalMode === 'edit' && editTarget
      const url    = isEdit ? `/api/users/${editTarget.id}` : '/api/users'
      const method = isEdit ? 'PUT' : 'POST'

      const body: Record<string, string> = {
        name:  form.name.trim(),
        email: form.email.trim(),
        role:  form.role,
      }
      if (form.password) body.password = form.password

      const res  = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Failed to save user')
        return
      }

      toast.success(isEdit ? 'User updated' : 'User created')
      closeModal()
      fetchUsers()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    const res  = await fetch(`/api/users/${id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error || 'Failed to delete user')
    } else {
      toast.success('User deleted')
      fetchUsers()
    }
    setDeleteId(null)
  }

  const opsCount = users.filter((u) => u.role === 'OPERATIONS').length
  const myId     = session?.user?.id ?? ''

  function canDelete(user: AppUser) {
    if (user.id === myId) return false
    if (user.role === 'OPERATIONS' && opsCount <= 1) return false
    return true
  }

  if (status === 'loading' || (session?.user?.role !== 'OPERATIONS')) {
    return null
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <div className="max-w-5xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          <button
            onClick={openAdd}
            className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
          >
            + Add User
          </button>
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-16 text-gray-400">Loading users…</div>
        ) : users.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-gray-400 mb-4">No users yet</p>
            <button
              onClick={openAdd}
              className="bg-green-700 hover:bg-green-600 text-white text-sm px-4 py-2 rounded"
            >
              + Add User
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Name', 'Email', 'Role', 'Created', 'Actions'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 text-xs uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {user.name}
                      {user.id === myId && (
                        <span className="ml-2 text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">you</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{user.email}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        user.role === 'OPERATIONS'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {user.role === 'OPERATIONS' ? 'Operations' : 'Sales'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(user.created_at).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {/* Edit */}
                        <button
                          onClick={() => openEdit(user)}
                          title="Edit user"
                          className="text-gray-400 hover:text-gray-700 transition-colors p-1"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        {/* Delete */}
                        <button
                          onClick={() => canDelete(user) && setDeleteId(user.id)}
                          title={
                            user.id === myId ? 'Cannot delete yourself'
                            : !canDelete(user) ? 'Cannot delete last Operations admin'
                            : 'Delete user'
                          }
                          disabled={!canDelete(user)}
                          className={`p-1 transition-colors ${
                            canDelete(user)
                              ? 'text-red-400 hover:text-red-600'
                              : 'text-gray-200 cursor-not-allowed'
                          }`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add/Edit Modal ─────────────────────────────────────────────────────── */}
      {modalMode && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                {modalMode === 'add' ? 'Add User' : 'Edit User'}
              </h2>
            </div>
            <form onSubmit={handleSave} className="px-6 py-4 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              {/* Email */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              {/* Password */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Password{modalMode === 'edit' && <span className="text-gray-400 font-normal ml-1">(optional)</span>}
                </label>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder={modalMode === 'edit' ? 'Leave blank to keep current password' : ''}
                    required={modalMode === 'add'}
                    className="w-full border border-gray-300 rounded px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(!showPw)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPw ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              {/* Role */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  disabled={modalMode === 'edit' && editTarget?.id === myId}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100"
                >
                  <option value="SALES">Sales</option>
                  <option value="OPERATIONS">Operations</option>
                </select>
                {modalMode === 'edit' && editTarget?.id === myId && (
                  <p className="text-xs text-gray-400 mt-1">You cannot change your own role</p>
                )}
              </div>

              {/* Buttons */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm bg-green-700 hover:bg-green-600 text-white rounded transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete Confirm Modal ───────────────────────────────────────────────── */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Delete User</h2>
            <p className="text-sm text-gray-600 mb-6">
              Are you sure? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
