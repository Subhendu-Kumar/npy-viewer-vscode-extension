import type {
  Layout,
  InitPayload,
  TableWindow,
  ViewerConfig,
  WebviewCommand,
} from "../common/types";
import type { DecodedBlock } from "./decode";

/**
 * The slice of view state worth surviving a reload.
 *
 * Deliberately small and all-optional: it is restored best-effort, and anything
 * that no longer makes sense for the file is dropped rather than trusted.
 */
export interface PersistedView {
  tab?: string;
  frame?: number;
  colormap?: string;
  scale?: string;
  normalisation?: string;
  alternate?: boolean;
  rgb?: boolean;
  mode?: string;
}

/** Services each view needs from the app shell. */
export interface ViewContext {
  /** View state carried over from the last time this file was open. */
  readonly restored: PersistedView;
  /** Merges `patch` into the persisted state for this file. */
  persist(patch: PersistedView): void;
  readonly init: InitPayload;
  readonly config: ViewerConfig;
  /** The layout in force, honouring the channel-order toggle. */
  layout(alternate: boolean): Layout | null;
  requestBlock(
    frames: number[],
    maxSide: number,
    alternate: boolean,
  ): Promise<DecodedBlock>;
  requestTable(
    frame: number,
    rowStart: number,
    colStart: number,
    rowCount: number,
    colCount: number,
    alternate: boolean,
  ): Promise<TableWindow>;
  command(name: WebviewCommand, payload?: unknown): void;
  /** Switches the active tab, e.g. when a grid tile is opened. */
  openTab(id: string): void;
}

export interface View {
  render(host: HTMLElement): void;
  dispose?(): void;
}
