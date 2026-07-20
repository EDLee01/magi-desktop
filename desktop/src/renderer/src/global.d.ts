import type { MagiDesktopApi } from "../../shared/contracts";

declare global {
  interface Window {
    magiDesktop: MagiDesktopApi;
  }
}

export {};
