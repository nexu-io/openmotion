/**
 * Explicit device-ID attribution consent for Google One Tap; written by `POST /motion-api/tracking/consent`
 * and read by the One Tap exchange (server) and the Studio attribution collector (browser).
 */
export const METRICS_CONSENT_COOKIE_NAME = 'om_metrics_consent';
export const METRICS_CONSENT_GRANTED = 'granted';
export const METRICS_CONSENT_DENIED = 'denied';
