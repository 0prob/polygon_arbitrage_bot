export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TuiLayout {
  header: PanelRect;
  panels: PanelRect[];       // 6 panels in 3x2 grid: [index, mempool, opportunities, routing, graph, execution]
  log: PanelRect;
  statusBar: PanelRect;
}

const STATUS_HEIGHT = 1;

export function computeLayout(cols: number | undefined, rows: number | undefined): TuiLayout {
  const safeCols = Math.max(100, cols ?? 100);
  const safeRows = Math.max(25, rows ?? 25);

  const logHeight = Math.min(15, safeRows - 9);  // leave room for header(1) + panels(6) + separators(2) + status(1)
  const dataAreaStart = STATUS_HEIGHT;
  const dataAreaHeight = safeRows - STATUS_HEIGHT - logHeight - 2 - STATUS_HEIGHT; // 2 = separators
  const panelRowHeight = Math.min(3, Math.floor(dataAreaHeight / 2));
  const colGutter = 2;
  const colWidth = Math.floor((safeCols - colGutter * 2) / 3);

  function panelCol(i: number): number {
    return i * (colWidth + colGutter);
  }

  return {
    header: { x: 0, y: 0, width: safeCols, height: STATUS_HEIGHT },
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
    log: { x: 0, y: dataAreaStart + dataAreaHeight + 1, width: safeCols, height: logHeight },
    statusBar: { x: 0, y: safeRows - STATUS_HEIGHT, width: safeCols, height: STATUS_HEIGHT },
  };
}
