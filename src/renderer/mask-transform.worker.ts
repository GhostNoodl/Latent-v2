import { transformMask, type MaskTransformRequest, type MaskTransformResponse } from './mask-transform';

const scope = globalThis as unknown as { onmessage: (event: MessageEvent<MaskTransformRequest>) => void; postMessage: (message: MaskTransformResponse, transfer?: Transferable[]) => void };
scope.onmessage = ({ data }) => {
  try {
    const pixels = transformMask(data.pixels, data.width, data.height, data.settings);
    scope.postMessage({ id: data.id, pixels }, [pixels.buffer]);
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
