import React from 'react';
import {Alert, Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {useProgress} from '../../app/hooks';
import {engine} from '../../app/engine';
import {Report} from '../../core/types';
import {reportStatus} from '../status';
import {colors, HIT, toneColors} from '../theme';

export const ReportRow = React.memo(function ReportRow({report, online}: {report: Report; online: boolean}) {
  const s = reportStatus(report, online);
  const c = toneColors[s.tone];
  const progress = useProgress(report.id);
  const pending = report.phase !== 'uploaded';
  const thumb = pending ? report.images[0]?.originalUri : undefined;

  return (
    <View style={styles.card}>
      <View style={styles.top}>
        {thumb ? (
          <Image source={{uri: thumb}} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty, {backgroundColor: c.bg}]} />
        )}
        <View style={styles.body}>
          <Text numberOfLines={2} style={styles.desc}>{report.description}</Text>
          <Text style={styles.meta}>{report.images.length} photo{report.images.length > 1 ? 's' : ''}</Text>
        </View>
      </View>
      <View style={[styles.status, {backgroundColor: c.bg}]}>
        <Text style={[styles.statusTitle, {color: c.fg}]}>{s.title}</Text>
        <Text style={styles.statusDetail}>{s.detail}</Text>
        {report.phase === 'uploading' ? (
          <View style={styles.track}>
            <View style={[styles.fill, {width: `${Math.round((progress ?? 0) * 100)}%`, backgroundColor: c.fg}]} />
          </View>
        ) : null}
      </View>
      {report.phase === 'needsAttention' ? (
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" style={[styles.btn, styles.primary]} onPress={() => engine.retry(report.id)}>
            <Text style={styles.primaryText}>Try again</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.btn}
            onPress={() =>
              Alert.alert('Discard this report?', 'It has not been uploaded. Its photos and text will be deleted from this device.', [
                {text: 'Keep', style: 'cancel'},
                {text: 'Discard', style: 'destructive', onPress: () => engine.discard(report.id)},
              ])
            }>
            <Text style={[styles.btnText, {color: colors.bad}]}>Discard</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.line},
  top: {flexDirection: 'row', gap: 12},
  thumb: {width: 56, height: 56, borderRadius: 8},
  thumbEmpty: {opacity: 0.6},
  body: {flex: 1, justifyContent: 'center'},
  desc: {fontSize: 16, color: colors.text, fontWeight: '600'},
  meta: {fontSize: 13, color: colors.muted, marginTop: 2},
  status: {marginTop: 10, borderRadius: 8, padding: 10},
  statusTitle: {fontSize: 14, fontWeight: '700'},
  statusDetail: {fontSize: 13, color: colors.text, marginTop: 1},
  track: {height: 6, borderRadius: 3, backgroundColor: '#fff', marginTop: 8, overflow: 'hidden'},
  fill: {height: 6, borderRadius: 3},
  actions: {flexDirection: 'row', gap: 10, marginTop: 10},
  btn: {flex: 1, minHeight: HIT, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.line},
  btnText: {fontSize: 15, fontWeight: '600'},
  primary: {backgroundColor: colors.primary, borderColor: colors.primary},
  primaryText: {color: '#fff', fontSize: 15, fontWeight: '600'},
});
