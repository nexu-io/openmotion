/** New bridges can express a whole-path translation. Older frames return absolute playhead values. */
export type MeasuredCanvasPosition = {time:number} & (
  {x:number;y:number;delta?:never} | {delta:{x:number;y:number};x?:never;y?:never}
);

export interface CanvasBox {
  left: number;
  top: number;
  makeRelative: boolean;
  corner?: 'nw' | 'ne' | 'sw' | 'se';
  /** Additional CSS offsets needed to keep the opposite corner of a transformed box fixed. */
  extraAxes?: 'x' | 'y' | 'xy';
  width?: number;
  height?: number;
}

export function canvasBoxOperations(result: CanvasBox, offset: "layout" | "translate" = "layout") {
  if (result.corner && !['nw', 'ne', 'sw', 'se'].includes(result.corner))
    throw new Error('Invalid resize corner.');
  if (
    ![result.left, result.top].every(Number.isFinite) ||
    (result.corner &&
      !(
        Number.isFinite(result.width) &&
        result.width! > 0 &&
        Number.isFinite(result.height) &&
        result.height! > 0
      ))
  )
    throw new Error('Invalid canvas dimensions.');
  const operations: Array<{ type: 'inline-style'; property: string; value: string }> = [];
  const { corner } = result;
  const writeLeft = !corner || corner.endsWith('w') || result.extraAxes?.includes('x');
  const writeTop = !corner || corner.startsWith('n') || result.extraAxes?.includes('y');
  if (offset === "translate") {
    if (writeLeft || writeTop)
      operations.push({ type: 'inline-style', property: 'translate', value: result.left + 'px ' + result.top + 'px' });
  } else {
    if (result.makeRelative === true && (writeLeft || writeTop))
      operations.push({ type: 'inline-style', property: 'position', value: 'relative' });
    if (writeLeft)
      operations.push({ type: 'inline-style', property: 'left', value: result.left + 'px' });
    if (writeTop)
      operations.push({ type: 'inline-style', property: 'top', value: result.top + 'px' });
  }
  if (corner) {
    operations.push(
      { type: 'inline-style', property: 'width', value: result.width + 'px' },
      { type: 'inline-style', property: 'height', value: result.height + 'px' },
    );
  }
  return operations;
}
