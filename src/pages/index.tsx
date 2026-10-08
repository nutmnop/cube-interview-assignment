import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductRow, ReportFilters } from '@/lib/product-health';

const initialFilters: ReportFilters = {
  startDate: '2026-01-05',
  endDate: '2026-05-18',
  country: '',
  channel: '',
  brandName: '',
  search: '',
};

export default function Home() {
  const [filters, setFilters] = useState<ReportFilters>(initialFilters);
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState('');
  const downloadToken = useRef<string | null>(null);
  const downloadFrame = useRef<HTMLIFrameElement>(null);

  const query = useMemo(
    () => new URLSearchParams(cleanFilters(filters)).toString(),
    [filters]
  );

  async function loadReport(nextFilters = filters) {
    setLoading(true);
    setError('');

    const response = await fetch(
      `/api/product-health/report?${new URLSearchParams(cleanFilters(nextFilters))}`
    );
    const body = await response.json();

    if (!response.ok) {
      setError(body.message ?? 'Report failed');
      setLoading(false);
      return;
    }

    setRows(body.rows);
    setTotal(body.total);
    setLoading(false);
  }

  function requestExport() {
    if (downloadToken.current) return;
    const token = crypto.randomUUID();
    downloadToken.current = token;
    setExportError('');
    setExportMessage('Preparing your CSV. Large exports may take up to two minutes.');
    setExporting(true);
    if (downloadFrame.current) {
      downloadFrame.current.src = `/api/product-health/export?${query}&downloadToken=${token}`;
    }
  }

  function cancelExport() {
    downloadToken.current = null;
    if (downloadFrame.current) downloadFrame.current.src = 'about:blank';
    setExporting(false);
    setExportError('');
    setExportMessage('Export preparation cancelled. The server may take a moment to finish cleanup.');
  }

  function handleDownloadResponse() {
    if (!downloadToken.current) return;
    const text = downloadFrame.current?.contentDocument?.body?.textContent;
    if (!text) return;

    // Attachments go to the browser; an error response loads inside the frame.
    let message = 'Export failed. Please try again.';
    try {
      const body = JSON.parse(text);
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // Keep the fallback for an unexpected server response.
    }
    downloadToken.current = null;
    setExporting(false);
    setExportMessage('');
    setExportError(message);
  }

  useEffect(() => {
    if (!exporting) return;
    const checkReady = window.setInterval(() => {
      const token = downloadToken.current;
      if (!token) return;
      const cookies = document.cookie.split('; ');
      const failure = cookies.find(cookie => cookie.startsWith(`exportError=${token}-`));
      if (failure) {
        const status = failure.slice(failure.lastIndexOf('-') + 1);
        document.cookie = 'exportError=; Path=/; Max-Age=0; SameSite=Strict';
        downloadToken.current = null;
        setExporting(false);
        setExportMessage('');
        setExportError(status === '429'
          ? 'Another export is running. Please wait a few seconds and try again.'
          : status === '504'
            ? 'Export timed out. Please use narrower filters.'
            : 'Export failed. Please try again.');
        return;
      }
      const ready = cookies.includes(`exportReady=${token}`);
      if (ready) {
        document.cookie = 'exportReady=; Path=/; Max-Age=0; SameSite=Strict';
        downloadToken.current = null;
        setExporting(false);
        setExportMessage('Your file is ready. Check your browser downloads for progress.');
      }
    }, 250);
    const timeout = window.setTimeout(() => {
      if (!downloadToken.current) return;
      downloadToken.current = null;
      setExporting(false);
      setExportMessage('');
      setExportError('We could not confirm the download. Check your browser downloads before retrying.');
    }, 135000);
    return () => {
      window.clearInterval(checkReady);
      window.clearTimeout(timeout);
    };
  }, [exporting]);

  function submit(event: FormEvent) {
    event.preventDefault();
    loadReport();
  }

  useEffect(() => {
    loadReport(initialFilters);
  }, []);

  return (
    <main className="page">
      <section className="header">
        <div>
          <p className="eyebrow">Digital Shelf</p>
          <h1>Product Health</h1>
        </div>
        <div className="exportActions">
          <button onClick={requestExport} disabled={exporting} aria-busy={exporting}>
            {exporting && <span className="spinner" aria-hidden="true" />}
            {exporting ? 'Preparing CSV...' : 'Export Selected Filters'}
          </button>
          {exporting && (
            <button className="cancelExport" onClick={cancelExport}>Cancel export</button>
          )}
        </div>
      </section>

      <iframe
        ref={downloadFrame}
        title="CSV download"
        hidden
        onLoad={handleDownloadResponse}
      />
      {exportMessage && <section className="status" role="status">{exportMessage}</section>}
      {exportError && <section className="error" role="alert">{exportError}</section>}

      <form className="filters" onSubmit={submit}>
        {/* <label>
          Start
          <input
            type="date"
            value={filters.startDate}
            onChange={(event) =>
              setFilters({ ...filters, startDate: event.target.value })
            }
          />
        </label>
        <label>
          End
          <input
            type="date"
            value={filters.endDate}
            onChange={(event) =>
              setFilters({ ...filters, endDate: event.target.value })
            }
          />
        </label> */}
        <label>
          Country
          <select
            value={filters.country}
            onChange={(event) =>
              setFilters({ ...filters, country: event.target.value })
            }
          >
            <option value="">All</option>
            <option>Indonesia</option>
            <option>Malaysia</option>
            <option>Philippines</option>
            <option>Singapore</option>
            <option>Thailand</option>
            <option>Vietnam</option>
            <option>Taiwan</option>
            <option>China</option>
          </select>
        </label>
        <label>
          Channel
          <select
            value={filters.channel}
            onChange={(event) =>
              setFilters({ ...filters, channel: event.target.value })
            }
          >
            <option value="">All</option>
            <option>Shopee</option>
            <option>Lazada</option>
            <option>TikTok Shop</option>
          </select>
        </label>
        <label>
          Brand
          <select
            value={filters.brandName}
            onChange={(event) =>
              setFilters({ ...filters, brandName: event.target.value })
            }
          >
            <option value="">All</option>
            <option>Acme</option>
            <option>Nova</option>
            <option>Pinnacle</option>
            <option>Everyday Co</option>
          </select>
        </label>
        <label>
          Search
          <input
            value={filters.search}
            onChange={(event) =>
              setFilters({ ...filters, search: event.target.value })
            }
            placeholder="Product name"
          />
        </label>
        <button type="submit">Apply</button>
      </form>

      <section className="status">
        One-click export uses one API request and calculates health scores over
        raw observations. Large filters intentionally stress Node CPU and
        memory.
      </section>

      {error && <section className="error">{error}</section>}

      <section className="summary">
        <span>
          {loading ? 'Loading...' : `${rows.length} shown of ${total} products`}
        </span>
        <a href={`/api/product-health/report?${query}`}>JSON</a>
      </section>

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Brand</th>
              <th>Channel</th>
              <th>Shop</th>
              <th>In stock</th>
              <th>Price</th>
              <th>Rating</th>
              <th>Content</th>
              <th>Health</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.skuId}-${row.channel}`}>
                <td>
                  <strong>{row.productName}</strong>
                  <small>{row.skuId}</small>
                </td>
                <td>{row.brandName}</td>
                <td>{row.channel}</td>
                <td>{row.shopName}</td>
                <td>{row.inStockRate}%</td>
                <td>${row.averagePrice}</td>
                <td>{row.rating}</td>
                <td>{row.contentScore}</td>
                <td>{row.healthScore}</td>
                <td>{row.riskBand}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function cleanFilters(filters: ReportFilters): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([, value]) => typeof value === 'string' && value.length > 0
    )
  ) as Record<string, string>;
}
