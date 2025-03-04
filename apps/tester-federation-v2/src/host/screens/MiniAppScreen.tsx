import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

const MiniAppNavigator = React.lazy(() => import('MiniApp/MiniAppNavigator'));

const FallbackComponent = () => (
  <View style={styles.container}>
    <ActivityIndicator color="rgba(56, 30, 114, 1)" size="large" />
  </View>
);

const MiniAppScreen = () => {
  return (
    <React.Suspense fallback={<FallbackComponent />}>
      <MiniAppNavigator />
    </React.Suspense>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default MiniAppScreen;
