import type { NextApiRequest, NextApiResponse } from 'next';
import type { ReportFilters } from './product-health';

type ExportFile = {
  fileName: string;
  filePath: string;
  cleanup: () => Promise<void>;
};

type ExportDependencies = {
  parseFilters: (input: Record<string, unknown>) => ReportFilters;
  generateCsv: (filters: ReportFilters, signal: AbortSignal, deadline: number) => Promise<ExportFile>;
  sendFile: (path: string, res: NextApiResponse, signal: AbortSignal) => Promise<void>;
};

type ExportState = { productHealthExportActive?: boolean };

export function createExportHandler(
  { parseFilters, generateCsv, sendFile }: ExportDependencies,
  state: ExportState,
  timeoutMs = 120000
) {
  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'GET') {
      return res.status(405).json({ message: 'Method not allowed' });
    }

    const downloadToken = req.query.downloadToken;
    const validDownloadToken = typeof downloadToken === 'string' &&
      /^[a-zA-Z0-9-]{1,64}$/.test(downloadToken);
    const notifyDownloadError = (status: number) => {
      if (validDownloadToken) {
        res.setHeader('Set-Cookie',
          `exportError=${downloadToken}-${status}; Path=/; Max-Age=180; SameSite=Strict`);
      }
    };

    let filters: ReportFilters;
    try {
      filters = parseFilters(req.query as Record<string, unknown>);
    } catch (error) {
      notifyDownloadError(400);
      const message = error instanceof Error ? error.message : 'Invalid filters';
      return res.status(400).json({ message });
    }

    if (state.productHealthExportActive) {
      notifyDownloadError(429);
      res.setHeader('Retry-After', '5');
      return res.status(429).json({
        message: 'An export is already running. Please retry later.',
      });
    }
    // No await between checking and taking the slot.
    state.productHealthExportActive = true;
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Export timed out'));
    }, timeoutMs);
    const onClose = () => {
      if (!res.writableFinished) {
        controller.abort(new Error('Client disconnected'));
      }
    };
    res.once('close', onClose);

    try {
      const exportFile = await generateCsv(filters, controller.signal, deadline);
      try {
        controller.signal.throwIfAborted();
        res.setHeader('content-type', 'text/csv');
        res.setHeader(
          'content-disposition',
          `attachment; filename="${exportFile.fileName}"`
        );
        if (validDownloadToken) {
          res.setHeader(
            'Set-Cookie',
            `exportReady=${downloadToken}; Path=/; Max-Age=180; SameSite=Strict`
          );
        }
        res.status(200);
        await sendFile(exportFile.filePath, res, controller.signal);
      } finally {
        await exportFile.cleanup();
      }
    } catch {
      if (res.headersSent || res.destroyed) return;
      res.removeHeader('content-disposition');
      const deadlineExceeded = timedOut || Date.now() >= deadline;
      const status = deadlineExceeded ? 504 : 500;
      notifyDownloadError(status);
      const message = deadlineExceeded
        ? 'Export timed out. Please use narrower filters.'
        : 'Export failed. Please retry.';
      return res.status(status).json({ message });
    } finally {
      clearTimeout(timeout);
      res.off('close', onClose);
      state.productHealthExportActive = false;
    }
  };
}
