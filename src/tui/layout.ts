export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuiLayout {
  statusBar: PanelRect;
  metricsPanel: PanelRect;
  systemPanel: PanelRect;
  logPanel: PanelRect;
  keymapBar: PanelRect;
}

const STATUS_HEIGHT = 1;
const KEYMAP_HEIGHT = 1;
const TOP_PANEL_HEIGHT = 7;

export function computeLayout(cols: number | undefined, rows: number | undefined): TuiLayout {
  const safeCols = cols ?? 80;
  const safeRows = rows ?? 24;
  const middleHeight = safeRows - STATUS_HEIGHT - KEYMAP_HEIGHT;
  const topHeight = Math.min(TOP_PANEL_HEIGHT, Math.floor(middleHeight / 3));
  const logHeight = middleHeight - topHeight;
  const halfCols = Math.floor(safeCols / 2);

  return {
    statusBar: { x: 0, y: 0, width: safeCols, height: STATUS_HEIGHT },
    metricsPanel: { x: 0, y: STATUS_HEIGHT, width: halfCols, height: topHeight },
    systemPanel: { x: halfCols, y: STATUS_HEIGHT, width: safeCols - halfCols, height: topHeight },
    logPanel: { x: 0, y: STATUS_HEIGHT + topHeight, width: safeCols, height: logHeight },
    keymapBar: { x: 0, y: safeRows - KEYMAP_HEIGHT, width: safeCols, height: KEYMAP_HEIGHT },
  };
}
