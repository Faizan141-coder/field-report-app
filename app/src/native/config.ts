import {Platform} from 'react-native';

/**
 * Where reports are sent (the dev backend in ../server, plain HTTP).
 *
 * Android: `adb reverse tcp:4000 tcp:4000` makes `localhost` reach the dev machine on both
 * emulators and USB devices (see README).
 *
 * iOS: there is no adb reverse. The Simulator can use `localhost`; a physical iPhone must
 * reach the Mac over Wi-Fi, so set IOS_SERVER_HOST to the Mac's `.local` name
 * (`echo "$(scutil --get LocalHostName).local"`) or its LAN IP. Both phone and Mac must be on
 * the same network. Don't commit your personal value.
 */
const IOS_SERVER_HOST = 'localhost';

/**
 * Hosted backend (see README, "Hosted backend"). Release builds use it so the app works on any
 * phone with no cable; debug builds keep using the local dev server.
 */
const HOSTED_URL = 'https://field-report-server.onrender.com';

const DEV_URL = `http://${Platform.OS === 'ios' ? IOS_SERVER_HOST : 'localhost'}:4000`;

export const SERVER_URL = __DEV__ ? DEV_URL : HOSTED_URL;
