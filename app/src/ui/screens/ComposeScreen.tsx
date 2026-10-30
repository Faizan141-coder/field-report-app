import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator, AppState, Image, KeyboardAvoidingView, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {useHeaderHeight} from '@react-navigation/elements';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {engine} from '../../app/engine';
import {MAX_IMAGES} from '../../core/types';
import {newReportId, openSettings, pickFromGallery, PickResult, stagePhotos, takePhoto} from '../../native/photos';
import {colors, HIT} from '../theme';

type Notice = {kind: 'permission'; what: 'camera' | 'photos'} | {kind: 'error'; message: string} | null;

export function ComposeScreen({navigation}: {navigation: {goBack: () => void}}) {
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);

  // Coming back from Settings: drop the stale permission notice so the buttons are tried again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => s === 'active' && setNotice(n => (n?.kind === 'permission' ? null : n)));
    return () => sub.remove();
  }, []);

  const full = photos.length >= MAX_IMAGES;
  const busy = saving || picking;
  const canSave = description.trim().length > 0 && photos.length >= 1 && !busy;

  const handle = (r: PickResult) => {
    if (r.ok) {
      setNotice(null);
      setPhotos(p => [...p, ...r.uris].slice(0, MAX_IMAGES));
    } else if (r.reason === 'permission') setNotice({kind: 'permission', what: r.what});
    else if (r.reason === 'error') setNotice({kind: 'error', message: r.message});
  };

  // The picker only returns once large originals are copied, which can take seconds.
  const pick = async (run: () => Promise<PickResult>) => {
    setPicking(true);
    try {
      handle(await run());
    } finally {
      setPicking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const id = newReportId();
      const imageUris = await stagePhotos(id, photos);
      await engine.enqueue({id, description, imageUris});
      navigation.goBack();
    } catch (e) {
      setNotice({kind: 'error', message: `Could not save: ${(e as Error).message}. Nothing was lost; try again.`});
      setSaving(false);
    }
  };

  const hint = !description.trim() ? 'Add a short description' : photos.length < 1 ? 'Add at least one photo' : null;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>What did you find?</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Short description"
          placeholderTextColor={colors.muted}
          multiline
          maxLength={500}
          style={styles.input}
          editable={!saving}
        />

        <Text style={styles.label}>Photos ({photos.length}/{MAX_IMAGES})</Text>
        <View style={styles.grid}>
          {photos.map((uri, i) => (
            <View key={uri} style={styles.cell}>
              <Image source={{uri}} style={styles.img} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove photo ${i + 1}`}
                hitSlop={8}
                disabled={saving}
                onPress={() => setPhotos(p => p.filter((_, j) => j !== i))}
                style={styles.remove}>
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>

        <View style={styles.row}>
          <Pressable accessibilityRole="button" disabled={full || busy} onPress={() => pick(takePhoto)} style={[styles.pick, (full || busy) && styles.off]}>
            <Text style={styles.pickText}>Take photo</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={full || busy} onPress={() => pick(() => pickFromGallery(MAX_IMAGES - photos.length))} style={[styles.pick, (full || busy) && styles.off]}>
            <Text style={styles.pickText}>From gallery</Text>
          </Pressable>
        </View>
        {picking ? (
          <View style={styles.picking}>
            <ActivityIndicator />
            <Text style={styles.note}>Adding photos… large originals can take a few seconds.</Text>
          </View>
        ) : null}
        {full ? <Text style={styles.note}>That's the maximum of {MAX_IMAGES} photos. Remove one to add another.</Text> : null}

        {notice?.kind === 'permission' ? (
          <View style={styles.warn}>
            <Text style={styles.warnText}>
              {notice.what === 'camera' ? 'Camera' : 'Photo'} access is turned off. Turn it on in Settings, then come back. No restart needed.
            </Text>
            <Pressable accessibilityRole="button" onPress={openSettings} style={styles.warnBtn}>
              <Text style={styles.warnBtnText}>Open Settings</Text>
            </Pressable>
          </View>
        ) : null}
        {notice?.kind === 'error' ? (
          <View style={styles.warn}><Text style={styles.warnText}>{notice.message}</Text></View>
        ) : null}
      </ScrollView>

      <View style={[styles.bar, {paddingBottom: Math.max(insets.bottom, 12)}]}>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        <Pressable accessibilityRole="button" disabled={!canSave} onPress={save} style={[styles.save, !canSave && styles.off]}>
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save report</Text>}
        </Pressable>
        <Text style={styles.sub}>Saved on this device first. It uploads when there's a connection.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const CELL = 96;
const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: colors.bg},
  content: {padding: 16, gap: 10},
  label: {fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 6},
  input: {minHeight: 96, textAlignVertical: 'top', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, fontSize: 16, color: colors.text},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  cell: {width: CELL, height: CELL},
  img: {width: CELL, height: CELL, borderRadius: 10, backgroundColor: colors.line},
  remove: {position: 'absolute', top: -6, right: -6, width: 28, height: 28, borderRadius: 14, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center'},
  removeText: {color: '#fff', fontSize: 13},
  row: {flexDirection: 'row', gap: 10},
  pick: {flex: 1, minHeight: HIT, borderRadius: 10, borderWidth: 1, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card},
  pickText: {color: colors.primary, fontSize: 16, fontWeight: '600'},
  off: {opacity: 0.4},
  note: {fontSize: 13, color: colors.muted},
  picking: {flexDirection: 'row', alignItems: 'center', gap: 10},
  warn: {backgroundColor: colors.waitBg, borderRadius: 10, padding: 12, gap: 8},
  warnText: {color: colors.text, fontSize: 14},
  warnBtn: {minHeight: HIT, borderRadius: 10, borderWidth: 1, borderColor: colors.wait, alignItems: 'center', justifyContent: 'center'},
  warnBtnText: {color: colors.wait, fontWeight: '700'},
  bar: {paddingHorizontal: 16, paddingTop: 10, backgroundColor: colors.card, borderTopWidth: 1, borderColor: colors.line, gap: 6},
  hint: {color: colors.muted, fontSize: 13, textAlign: 'center'},
  save: {minHeight: 52, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center'},
  saveText: {color: '#fff', fontSize: 17, fontWeight: '700'},
  sub: {color: colors.muted, fontSize: 12, textAlign: 'center'},
});
