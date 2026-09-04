import { useState } from 'react'
import BrandMark from './BrandMark'
import { supabase } from '../lib/supabase'
import './LoadingScreen.css'
import './LoginPage.css'

/**
 * The door.
 *
 * BUILT ON `.gate`, NOT BESIDE IT. LoadingScreen already established that surface and said in its
 * own comment that it "is the surface Supabase Auth will land on when it is built (CLAUDE.md §13),
 * so the gate does not get designed twice" — and shipped a `.gate--fullscreen` modifier for this
 * exact case. So this reuses the ground, grain, grid and caption treatment and adds only a form.
 *
 * WHY THERE IS A DOOR AT ALL. The map reads ports and lanes with the anon key that ships inside the
 * JS bundle, which is fine — a port coordinate is not a secret. Shipments are: container numbers,
 * BOLs, forwarders, vendors, PO numbers. `inbound_shipments` grants nothing to anon and is gated on
 * `my_org_type() = 'internal'`, so the boxes need a real session. Page-level protection on Vercel
 * would not have done: that guards the page, not the REST API the bundled key can call.
 *
 * The error is shown VERBATIM from Supabase rather than reworded. "Invalid login credentials" and
 * "Email not confirmed" call for different actions, and flattening both to "Could not sign in"
 * sends someone to the wrong one.
 */
export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)

    // No navigation on success: useSession's onAuthStateChange fires and App swaps the tree. One
    // path in, so a session restored in another tab lands exactly the same way as one signed in here.
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })

    if (err) setError(err.message)
    setBusy(false)
  }

  return (
    <div className="gate gate--fullscreen grain ground ground-grid">
      <div className="gate__inner">
        <BrandMark size="lg" tone="dark" />

        <form className="login" onSubmit={onSubmit}>
          <label className="login__field">
            <span className="gate__caption">Email</span>
            <input
              className="login__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>

          <label className="login__field">
            <span className="gate__caption">Password</span>
            <input
              className="login__input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <button className="login__submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          {/* role=alert so a screen reader is told, rather than the message only appearing. */}
          {error && (
            <p className="login__error" role="alert">
              {error}
            </p>
          )}
        </form>

        <p className="gate__caption login__note">Internal access only</p>
      </div>
    </div>
  )
}
