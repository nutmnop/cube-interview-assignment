import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { exportCalculatedCsv, parseFilters } from '@/lib/product-health';
import { createExportHandler } from '@/lib/export-handler';

// Keep the process-local slot across development module reloads.
const state = globalThis as typeof globalThis & {
  productHealthExportActive?: boolean;
};

export default createExportHandler(
  {
    parseFilters,
    generateCsv: exportCalculatedCsv,
    sendFile: (path, res, signal) =>
      pipeline(createReadStream(path), res, { signal }),
  },
  state
);

export const config = { api: { responseLimit: false } };
