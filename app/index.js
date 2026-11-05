/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { getStartedEngine } from './src/app/engine';
import { registerKeepAliveTask } from './src/native/keepAlive';
import { name as appName } from './app.json';

registerKeepAliveTask(getStartedEngine);
AppRegistry.registerComponent(appName, () => App);
