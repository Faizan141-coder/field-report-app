import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View} from 'react-native';
import {SERVER_URL} from '../../native/config';
import {fetchServerReports, ServerReport} from '../../native/httpApi';
import {colors, HIT} from '../theme';

type State =
  | {kind: 'loading'}
  | {kind: 'error'; message: string}
  | {kind: 'ready'; reports: ServerReport[]};

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

/** Fetched from the server on purpose: this is what it holds, not what we remember sending. */
export function ServerList({reloadKey}: {reloadKey: number}) {
  const [state, setState] = useState<State>({kind: 'loading'});
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000); // never a spinner that outlives its welcome
    try {
      setState({kind: 'ready', reports: await fetchServerReports(SERVER_URL, ctl.signal)});
    } catch {
      setState(s => s.kind === 'ready' ? s : {kind: 'error', message: "Couldn't reach the server."});
    } finally {
      clearTimeout(t);
    }
  }, []);

  useEffect(() => { void load(); }, [load, reloadKey]);

  if (state.kind === 'loading') {
    return <View style={styles.center}><ActivityIndicator /><Text style={styles.muted}>Loading from server…</Text></View>;
  }
  if (state.kind === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>{state.message}</Text>
        <Text style={styles.muted}>Reports you saved are still on this device. This list only shows what the server has.</Text>
        <Pressable accessibilityRole="button" onPress={() => { setState({kind: 'loading'}); void load(); }} style={styles.btn}>
          <Text style={styles.btnText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <FlatList
      data={state.reports}
      keyExtractor={r => r.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      ListEmptyComponent={<View style={styles.center}><Text style={styles.title}>Nothing on the server yet</Text></View>}
      renderItem={({item}) => (
        <View style={styles.card}>
          <Text style={styles.desc}>{item.description}</Text>
          <Text style={styles.meta}>
            {item.images.length} photo{item.images.length > 1 ? 's' : ''} · {mb(item.images.reduce((a, i) => a + i.bytes, 0))} · received {new Date(item.receivedAt).toLocaleString()}
          </Text>
          <View style={styles.thumbs}>
            {item.images.map(i => <Image key={i.url} source={{uri: i.url}} style={styles.thumb} />)}
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: {padding: 16, paddingTop: 4},
  center: {padding: 32, alignItems: 'center', gap: 10},
  title: {fontSize: 16, fontWeight: '700', color: colors.text, textAlign: 'center'},
  muted: {fontSize: 13, color: colors.muted, textAlign: 'center'},
  meta: {fontSize: 13, color: colors.muted},
  btn: {minHeight: HIT, paddingHorizontal: 24, borderRadius: 10, borderWidth: 1, borderColor: colors.primary, justifyContent: 'center'},
  btnText: {color: colors.primary, fontWeight: '600'},
  card: {backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.line, gap: 6},
  desc: {fontSize: 16, fontWeight: '600', color: colors.text},
  thumbs: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4},
  thumb: {width: 60, height: 60, borderRadius: 6, backgroundColor: colors.line},
});
