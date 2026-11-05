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

export const SERVER_URL = `http://${Platform.OS === 'ios' ? IOS_SERVER_HOST : 'localhost'}:4000`;
