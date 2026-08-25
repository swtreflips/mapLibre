import './BrandMark.css'

/**
 * The app's identity lockup — icon slot and wordmark.
 *
 * Structure and proportions match Rates, Schedules and Planner exactly; only the accent differs,
 * and that comes free from the module's own `signal-*` override. See BrandMark.css for why each
 * number is what it is.
 *
 * THE SLOT IS RESERVED, NOT EMPTY. There is no artwork yet, so it shows the app's initial in the
 * logotype face — which stops the reserved space reading as a gap and lets four modules look like
 * one family before a single icon is drawn. Pass `icon` and it disappears; nothing around it moves,
 * because the square was always that size.
 */

/** Single source of truth for what this module is called. */
export const APP_NAME = 'Inbound'
/** Not rendered in the lockup; the module's description, used for the tab title. */
export const APP_DESCRIPTOR = 'Ocean Arrivals'

/**
 * @param {object} props
 * @param {import('react').ReactNode} [props.icon]  fills the slot and replaces the monogram
 * @param {'sm'|'lg'} [props.size]
 * @param {'dark'|'light'} [props.tone]
 * @param {string} [props.className]
 */
export default function BrandMark({ icon = null, size = 'sm', tone = 'dark', className = '' }) {
  return (
    <div className={`brandmark brandmark--${size} brandmark--${tone} ${className}`.trim()}>
      <span className="brandmark__slot">
        {icon ?? (
          <span aria-hidden="true" className="brandmark__monogram">
            {APP_NAME.charAt(0)}
          </span>
        )}
      </span>

      <span className="brandmark__name">
        {APP_NAME}
        <span className="brandmark__dot">.</span>
      </span>
    </div>
  )
}
