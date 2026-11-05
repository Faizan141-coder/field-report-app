import React, {useEffect, useRef, useState} from 'react';
import {Alert, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {engine} from '../../app/engine';
import {useOnline, useReports} from '../../app/hooks';
import {resetLocal} from '../../native/resetLocal';
import {ReportRow} from '../components/ReportRow';
import {StatusBanner} from '../components/StatusBanner';
import {summarize} from '../status';
import {colors, HIT} from '../theme';
import {ServerList} from './ServerList';

type Tab = 'device' | 'server';

export function HomeScreen({navigation}: {navigation: {navigate: (s: 'Compose') => void; setOptions: (o: object) => void}}) {
  const insets = useSafeAreaInsets();
  const reports = useReports();
  const online = useOnline();
  const [tab, setTab] = useState<Tab>('device');
  const [serverKey, setServerKey] = useState(0);
  const summary = summarize(reports, online);
  const unsent = reports.filter(r => r.phase !== 'uploaded').length;
  const attention = reports.filter(r => r.phase === 'needsAttention');
  // "Retry now" only means something for reports that are waiting; stopped ones need "Try again".
  const waiting = reports.some(r => r.phase === 'queued' || r.phase === 'uploading');

  // A newly saved report should be visible straight away, whichever tab the user was on.
  const lastUnsent = useRef(unsent);
  useEffect(() => {
    if (unsent > lastUnsent.current) setTab('device');
    lastUnsent.current = unsent;
  }, [unsent]);

  // Reload the server list whenever something new lands on it.
  const committed = reports.filter(r => r.phase === 'uploaded').length;
  const lastCommitted = useRef(committed);
  useEffect(() => {
    if (committed !== lastCommitted.current) setServerKey(k => k + 1);
    lastCommitted.current = committed;
  }, [committed]);

  const confirmReset = () =>
    Alert.alert(
      'Reset this device?',
      (unsent
        ? `${unsent} report${unsent > 1 ? 's' : ''} not yet uploaded will be permanently deleted from this phone. `
        : '') +
        'All saved photos and local records are removed. Reports already on the server are not affected.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: unsent ? `Delete ${unsent} unsent & reset` : 'Reset', style: 'destructive', onPress: () => resetLocal().then(() => setServerKey(k => k + 1))},
      ],
    );

  return (
    <View style={styles.flex}>
      <View style={styles.top}>
        <StatusBanner
          summary={summary}
          actionLabel={attention.length ? 'Try again' : 'Retry now'}
          onAction={
            attention.length
              ? () => attention.forEach(r => engine.retry(r.id))
              : waiting && online
              ? () => engine.nudge()
              : undefined
          }
        />
        <View style={styles.seg}>
          {(['device', 'server'] as Tab[]).map(t => (
            <Pressable key={t} accessibilityRole="tab" accessibilityState={{selected: tab === t}} onPress={() => setTab(t)} style={[styles.segBtn, tab === t && styles.segOn]}>
              <Text style={[styles.segText, tab === t && styles.segTextOn]}>{t === 'device' ? 'On this device' : 'On the server'}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {tab === 'device' ? (
        <FlatList
          data={reports}
          keyExtractor={r => r.id}
          contentContainerStyle={styles.list}
          renderItem={({item}) => <ReportRow report={item} online={online} />}
          ListEmptyComponent={<Text style={styles.empty}>No reports on this device.{'\n'}Tap “New report” to start one. It works offline.</Text>}
          ListFooterComponent={
            <View style={styles.footer}>
              {committed ? (
                <Pressable accessibilityRole="button" style={styles.link} onPress={() => engine.clearUploaded()}>
                  <Text style={styles.linkText}>Clear uploaded from this list</Text>
                </Pressable>
              ) : null}
              <Pressable accessibilityRole="button" style={styles.link} onPress={confirmReset}>
                <Text style={[styles.linkText, {color: colors.bad}]}>Reset this device…</Text>
              </Pressable>
            </View>
          }
        />
      ) : (
        <ServerList reloadKey={serverKey} />
      )}

      <View style={[styles.bar, {paddingBottom: Math.max(insets.bottom, 12)}]}>
        <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Compose')} style={styles.new}>
          <Text style={styles.newText}>New report</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: colors.bg},
  top: {padding: 16, paddingBottom: 8, gap: 12},
  seg: {flexDirection: 'row', backgroundColor: colors.line, borderRadius: 10, padding: 3},
  segBtn: {flex: 1, minHeight: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center'},
  segOn: {backgroundColor: colors.card},
  segText: {color: colors.muted, fontWeight: '600'},
  segTextOn: {color: colors.text},
  list: {padding: 16, paddingTop: 4, flexGrow: 1},
  empty: {textAlign: 'center', color: colors.muted, marginTop: 40, lineHeight: 22},
  footer: {alignItems: 'center', paddingVertical: 8},
  link: {minHeight: HIT, justifyContent: 'center', paddingHorizontal: 12},
  linkText: {color: colors.primary, fontWeight: '600'},
  bar: {paddingHorizontal: 16, paddingTop: 10, backgroundColor: colors.card, borderTopWidth: 1, borderColor: colors.line},
  new: {minHeight: 52, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center'},
  newText: {color: '#fff', fontSize: 17, fontWeight: '700'},
});
