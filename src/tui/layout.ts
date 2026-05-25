export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuiLayout {
  header: PanelRect;
  pipeline: PanelRect;
  mainTable: PanelRect;
  sidebar: PanelRect;
  footerLog: PanelRect;
  keymap: PanelRect;
}

const STATUS_HEIGHT = 1;
const KEYMAP_HEIGHT = 1;
const SIDEBAR_WIDTH = 40;
const FOOTER_LOG_HEIGHT = 6;

export function computeLayout(cols: number | undefined, rows: number | undefined): TuiLayout {
  const safeCols = Math.max(80, cols ?? 80);
  const safeRows = Math.max(20, rows ?? 24);
  const middleHeight = safeRows - STATUS_HEIGHT - KEYMAP_HEIGHT;
  
  const sidebarWidth = Math.min(SIDEBAR_WIDTH, Math.floor(safeCols / 3));
  const mainWidth = safeCols - sidebarWidth;
  
  const logHeight = Math.min(FOOTER_LOG_HEIGHT, Math.floor(middleHeight / 3));
  const upperMainHeight = middleHeight - logHeight;
  
  const pipelineHeight = Math.min(7, Math.floor(upperMainHeight / 2));
  const tableHeight = upperMainHeight - pipelineHeight;

  return {
    header: { x: 0, y: 0, width: safeCols, height: STATUS_HEIGHT },
    sidebar: { x: mainWidth, y: STATUS_HEIGHT, width: sidebarWidth, height: middleHeight },
    pipeline: { x: 0, y: STATUS_HEIGHT, width: mainWidth, height: pipelineHeight },
    mainTable: { x: 0, y: STATUS_HEIGHT + pipelineHeight, width: mainWidth, height: tableHeight },
    footerLog: { x: 0, y: STATUS_HEIGHT + upperMainHeight, width: mainWidth, height: logHeight },
    keymap: { x: 0, y: safeRows - KEYMAP_HEIGHT, width: safeCols, height: KEYMAP_HEIGHT },
  };
}
