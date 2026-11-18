// Just enough of react-native's types to typecheck the SDK in this repo
// (apps that vendor the file use the real package's types).
declare module "react-native" {
  export const Platform: { OS: "ios" | "android" | string; Version: number | string };
  export const Dimensions: { get(dim: "window" | "screen"): { width: number; height: number } };
  export const Linking: { getInitialURL(): Promise<string | null>; addEventListener(event: "url", cb: (e: { url: string }) => void): { remove(): void } };
  export const AppState: { currentState?: string | null; addEventListener(event: "change", cb: (state: string) => void): { remove(): void } };
}
