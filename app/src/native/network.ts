import NetInfo from '@react-native-community/netinfo';
import {SERVER_URL} from './config';

NetInfo.configure({
  reachabilityUrl: `${SERVER_URL}/health`,
  reachabilityTest: async r => r.status === 200,
  reachabilityShortTimeout: 5_000,
  reachabilityLongTimeout: 15_000,
});

let connected = true; // optimistic until NetInfo reports; a wrong guess just fails and backs off
let reachable: boolean | null = null;
const listeners = new Set<(online: boolean) => void>();

NetInfo.addEventListener(s => {
  const was = connected;
  connected = s.isConnected !== false;
  reachable = s.isInternetReachable;
  if (connected && !was) listeners.forEach(l => l(true));
  if (!connected && was) listeners.forEach(l => l(false));
});

/** Gate for the worker. Only "definitely no link" blocks; flaky-but-present is the engine's job. */
export const isOnline = () => connected;
export const isServerReachable = () => reachable;
export const onConnectivityChange = (l: (online: boolean) => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
