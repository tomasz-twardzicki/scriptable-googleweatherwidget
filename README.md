# scriptable-googleweatherwidget
Google Weather Widget for iOS running in Scriptable app

Google Weather API — Current Conditions Widget (Scriptable)
Endpoint: https://weather.googleapis.com/v1/currentConditions:lookup
 * Uses current GPS location (or fixed coords).
 * API key stored securely in iOS Keychain (no hard-coding).
 * Matches current Google Weather API schema (degrees/unit, description.text).
 * Suggests refresh every 10 minutes (iOS limits still apply).


Requires an active Google Weather API key (Free up to 10k calls/mo)
https://developers.google.com/maps/documentation/weather/get-api-key?setupProd=configure

