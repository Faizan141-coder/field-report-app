import {useSyncExternalStore} from 'react';
import {isOnline, onConnectivityChange} from '../native/network';
import {engine} from './engine';

export const useReports = () => useSyncExternalStore(engine.subscribe, engine.getSnapshot);

export const useProgress = (id: string) =>
  useSyncExternalStore(engine.subscribeProgress, () => engine.getProgress(id));

export const useOnline = () =>
  useSyncExternalStore(
    cb => onConnectivityChange(cb),
    isOnline,
  );
