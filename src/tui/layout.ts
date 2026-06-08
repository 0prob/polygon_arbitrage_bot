export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuiLayout {
  header: PanelRect;
  panels: PanelRect[]; // 6 panels in 3x2 grid: [index, mempool, opportunities, routing, graph, execution]
  log: PanelRect;
  statusBar: PanelRect;
  /** True when the terminal is below the recommended minimum size */
  cramped: boolean;
}

const HEADER_HEIGHT = 1;
const STATUS_HEIGHT = 1;
const GUTTER = 1;
/** Minimum total rows needed to render all panels at their minimum height */
const MIN_ROWS = 26;
const MIN_COLS = 100;

export function computeLayout(cols: number | undefined, rows: number | undefined): TuiLayout {
  const safeCols = Math.max(MIN_COLS, cols ?? MIN_COLS);
  const safeRows = Math.max(MIN_ROWS, rows ?? MIN_ROWS);

  // Note: do NOT emit console.warn here — when the TUI is active all console
  // output is redirected back into the EventBus which would create a feedback loop.
  // Terminal size warnings are surfaced via the statusBar "cramped" flag instead.
  const cramped = (cols !== undefined && cols < MIN_COLS) || (rows !== undefined && rows < MIN_ROWS);

  // Layout arithmetic:
  //   row 0           : header (1 row)
  //   row 1..panelEnd : 2 rows of panels
  //   gutter          : 1 blank row separator
  //   log area        : up to 15 rows
  //   last row        : status bar
  const reservedRows = HEADER_HEIGHT + STATUS_HEIGHT + GUTTER + STATUS_HEIGHT;
  const logHeight = Math.min(15, Math.max(3, safeRows - reservedRows - 8));
  const dataAreaStart = HEADER_HEIGHT;
  const dataAreaHeight = safeRows - HEADER_HEIGHT - logHeight - GUTTER - STATUS_HEIGHT;
  const panelRowHeight = Math.max(4, Math.min(6, Math.floor(dataAreaHeight / 2)));
  const colGutter = 2;
  const colWidth = Math.floor((safeCols - colGutter * 2) / 3);

  function panelCol(i: number): number {
    return i * (colWidth + colGutter);
  }

  return {
    header: { x: 0, y: 0, width: safeCols, height: HEADER_HEIGHT },
    panels: [
      // Row 1: Index, Mempool, Opportunities
      { x: panelCol(0), y: dataAreaStart, width: colWidth, height: panelRowHeight },
      { x: panelCol(1), y: dataAreaStart, width: colWidth, height: panelRowHeight },
      { x: panelCol(2), y: dataAreaStart, width: colWidth, height: panelRowHeight },
      // Row 2: Routing, Graph, Execution
      { x: panelCol(0), y: dataAreaStart + panelRowHeight, width: colWidth, height: panelRowHeight },
      { x: panelCol(1), y: dataAreaStart + panelRowHeight, width: colWidth, height: panelRowHeight },
      { x: panelCol(2), y: dataAreaStart + panelRowHeight, width: colWidth, height: panelRowHeight },
    ],
    log: { x: 0, y: dataAreaStart + dataAreaHeight + GUTTER, width: safeCols, height: logHeight },
    statusBar: { x: 0, y: safeRows - STATUS_HEIGHT, width: safeCols, height: STATUS_HEIGHT },
    cramped,
  };
}
