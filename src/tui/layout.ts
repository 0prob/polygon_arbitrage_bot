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
const TOP_PANEL_HEIGHT = 6;

export function computeLayout(cols: number, rows: number): TuiLayout {
  const middleHeight = rows - STATUS_HEIGHT - KEYMAP_HEIGHT;
  const topHeight = Math.min(TOP_PANEL_HEIGHT, Math.floor(middleHeight / 3));
  const logHeight = middleHeight - topHeight;
  const halfCols = Math.floor(cols / 2);

  return {
    statusBar: { x: 0, y: 0, width: cols, height: STATUS_HEIGHT },
    metricsPanel: { x: 0, y: STATUS_HEIGHT, width: halfCols, height: topHeight },
    systemPanel: { x: halfCols, y: STATUS_HEIGHT, width: cols - halfCols, height: topHeight },
    logPanel: { x: 0, y: STATUS_HEIGHT + topHeight, width: cols, height: logHeight },
    keymapBar: { x: 0, y: rows - KEYMAP_HEIGHT, width: cols, height: KEYMAP_HEIGHT },
  };
}
