// TURN relay settings for builds you distribute yourself.
//
// ASK_USER_API: true  -> every user enters their own Metered app name and
//                        API key in the popup (stored locally in their browser).
// ASK_USER_API: false -> the values below are baked into the build and the
//                        relay section is hidden from the popup.
//
// If you bake a key in, anyone with the extension files can read it, so
// only do that for builds you share privately.
const SYNCPARTY_TURN_CONFIG = {
  ASK_USER_API: true,

  // Only used when ASK_USER_API is false.
  TURN_APP_NAME: "",   // subdomain only, e.g. "syncparty" for syncparty.metered.live
  TURN_API_KEY: ""     // API key from the app's "TURN Server" page (not the account secret key)
};
