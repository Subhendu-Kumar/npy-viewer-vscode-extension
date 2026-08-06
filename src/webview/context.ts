import type {
  InitPayload,
  Layout,
  TableWindow,
  ViewerConfig,
  WebviewCommand,
} from "../common/types";
import type { DecodedBlock } from "./decode";

/** Services each view needs from the app shell. */
export interface ViewContext {
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
