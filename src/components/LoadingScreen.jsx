import BrandMark from './BrandMark'
import './LoadingScreen.css'

/**
 * The full-screen wait.
 *
 * The app fetches routes from Supabase and had no loading state at all — a slow query was
 * indistinguishable from a broken app, which is the same failure Schedules shipped with until it
 * was caught. This is the surface that fixes it, and it is the surface Supabase Auth will land on
 * when it is built (CLAUDE.md §13), so the gate does not get designed twice.
 *
 * Four layers, all from tokens the shared skin already defines: the radial ground, a film grain, a
 * faint chart grid, and the sweeping bar. Nothing here is a colour literal.
 *
 * @param {{ message?: string }} props
 */
export default function LoadingScreen({ message = 'Loading shipments…' }) {
  return (
    <div className="gate grain ground ground-grid">
      {/* above the grain and grid pseudo-elements */}
      <div className="gate__inner">
        <BrandMark size="lg" tone="dark" />

        <div className="gate__rail">
          <div className="gate__bar animate-sweep" />
        </div>

        <p className="gate__caption">{message}</p>
      </div>
    </div>
  )
}
