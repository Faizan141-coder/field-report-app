import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Summary} from '../status';
import {colors, HIT, toneColors} from '../theme';

export function StatusBanner({summary, onRetryNow}: {summary: Summary; onRetryNow?: () => void}) {
  const c = toneColors[summary.tone];
  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      style={[styles.box, {backgroundColor: c.bg, borderColor: c.fg}]}>
      <View style={styles.text}>
        <Text style={[styles.title, {color: c.fg}]}>{summary.title}</Text>
        <Text style={styles.detail}>{summary.detail}</Text>
      </View>
      {onRetryNow ? (
        <Pressable accessibilityRole="button" onPress={onRetryNow} style={[styles.btn, {borderColor: c.fg}]}>
          <Text style={[styles.btnText, {color: c.fg}]}>Retry now</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 12, borderWidth: 1, gap: 12},
  text: {flex: 1},
  title: {fontSize: 17, fontWeight: '700'},
  detail: {fontSize: 14, color: colors.text, marginTop: 2},
  btn: {minHeight: HIT, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 1, borderRadius: 10},
  btnText: {fontWeight: '600'},
});
