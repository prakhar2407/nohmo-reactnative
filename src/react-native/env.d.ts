/**
 * Minimal type stubs for React Native peer dependencies.
 * These are declared here so the SDK builds without installing react-native
 * (a ~50 MB package) as a dev dependency. The consuming RN project provides
 * the real implementations at runtime.
 */

declare module 'react-native' {
  export const Platform: {
    OS: 'ios' | 'android' | 'web' | string
    Version: string | number
  }

  export interface AppStateSubscription {
    remove: () => void
  }

  export const AppState: {
    addEventListener: (
      event: 'change',
      handler: (state: 'active' | 'background' | 'inactive' | string) => void
    ) => AppStateSubscription
  }

  export const Dimensions: {
    get: (dim: 'window' | 'screen') => {
      width: number
      height: number
      scale: number
      fontScale: number
    }
  }

  export const Linking: {
    getInitialURL: () => Promise<string | null>
    addEventListener: (
      type: 'url',
      handler: (event: { url: string }) => void,
    ) => { remove: () => void }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const NativeModules: Record<string, any>
}

declare module '@react-native-async-storage/async-storage' {
  const AsyncStorage: {
    getItem:  (key: string) => Promise<string | null>
    setItem:  (key: string, value: string) => Promise<void>
  }
  export default AsyncStorage
}

// React Native defines __DEV__ globally: true in a development bundle, false in a
// release build. Metro also dead-code-eliminates `if (__DEV__)` blocks out of release
// bundles, so anything behind it costs shipping apps nothing.
declare const __DEV__: boolean

// React Native installs a global error handler hook (ErrorUtils) at runtime.
// It is not exported from 'react-native', so declare it as an ambient global.
declare const ErrorUtils: {
  getGlobalHandler(): (error: Error, isFatal?: boolean) => void
  setGlobalHandler(handler: (error: Error, isFatal?: boolean) => void): void
}
