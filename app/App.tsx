import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, StatusBar, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {startEngine} from './src/app/engine';
import {ComposeScreen} from './src/ui/screens/ComposeScreen';
import {HomeScreen} from './src/ui/screens/HomeScreen';
import {colors} from './src/ui/theme';

const Stack = createNativeStackNavigator();

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Reads the queue from local disk only; never waits on the network.
    startEngine().finally(() => setReady(true));
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      {ready ? (
        <NavigationContainer>
          <Stack.Navigator screenOptions={{headerStyle: {backgroundColor: colors.bg}, headerShadowVisible: false, contentStyle: {backgroundColor: colors.bg}}}>
            <Stack.Screen name="Home" component={HomeScreen as never} options={{title: 'Field reports'}} />
            <Stack.Screen name="Compose" component={ComposeScreen as never} options={{title: 'New report'}} />
          </Stack.Navigator>
        </NavigationContainer>
      ) : (
        <View style={{flex: 1, alignItems: 'center', justifyContent: 'center'}}><ActivityIndicator /></View>
      )}
    </SafeAreaProvider>
  );
}
