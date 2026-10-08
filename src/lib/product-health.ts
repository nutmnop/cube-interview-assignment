import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from './db';
import { toCsv, type CsvRow } from './csv';

export type ReportFilters = {
  startDate: string;
  endDate: string;
  country?: string;
  channel?: string;
  brandName?: string;
  search?: string;
};

export type ProductRow = {
  productName: string;
  skuId: string;
  country: string;
  channel: string;
  shopName: string;
  brandName: string;
  categoryL2: string;
  categoryL3: string;
  observations: number;
  inStockRate: number;
  averagePrice: number;
  priceIndex: number;
  rating: number;
  reviewCount: number;
  contentScore: number;
  healthScore: number;
  riskBand: 'High' | 'Medium' | 'Low';
};

export type ReportResult = {
  rows: ProductRow[];
  total: number;
};

type Observation = {
  productName: string;
  skuId: string;
  country: string;
  channel: string;
  shopName: string;
  brandName: string;
  listingUrl: string;
  categoryL2: string;
  categoryL3: string;
  inStock: boolean;
  price: number;
  competitorMedianPrice: number;
  rating: number;
  reviewCount: number;
  contentScore: number;
  rawSnapshot: string;
};

type ProductAccumulator = {
  productName: string;
  skuId: string;
  country: string;
  channel: string;
  shopName: string;
  brandName: string;
  categoryL2: string;
  categoryL3: string;
  observations: number;
  inStockCount: number;
  priceTotal: number;
  competitorPriceTotal: number;
  ratingTotal: number;
  reviewCountMax: number;
  contentScoreTotal: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFilters(input: Record<string, unknown>): ReportFilters {
  const filters = {
    startDate: String(input.startDate ?? ''),
    endDate: String(input.endDate ?? ''),
    country: optionalString(input.country),
    channel: optionalString(input.channel),
    brandName: optionalString(input.brandName),
    search: optionalString(input.search),
  };

  if (!DATE_RE.test(filters.startDate) || !DATE_RE.test(filters.endDate)) {
    throw new Error('startDate and endDate must use YYYY-MM-DD');
  }

  if (filters.startDate > filters.endDate) {
    throw new Error('startDate must be before or equal to endDate');
  }

  return filters;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildWhere(filters: ReportFilters): {
  sql: string;
  values: unknown[];
} {
  const clauses = ['observed_at BETWEEN $1 AND $2'];
  const values: unknown[] = [filters.startDate, filters.endDate];

  for (const [column, value] of [
    ['country', filters.country],
    ['channel', filters.channel],
    ['brand_name', filters.brandName],
  ] as const) {
    if (!value) continue;
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  }

  if (filters.search) {
    values.push(`%${filters.search}%`);
    clauses.push(`product_name ILIKE $${values.length}`);
  }

  return {
    sql: clauses.join(' AND '),
    values,
  };
}

export async function getReport(filters: ReportFilters): Promise<ReportResult> {
  const where = buildWhere(filters);
  const query = `
    SELECT
      product_name AS "productName",
      sku_id AS "skuId",
      country,
      channel,
      shop_name AS "shopName",
      brand_name AS "brandName",
      category_l2 AS "categoryL2",
      category_l3 AS "categoryL3",
      count(*)::int AS observations,
      round(avg(CASE WHEN in_stock THEN 100 ELSE 0 END), 1)::float AS "inStockRate",
      round(avg(price), 2)::float AS "averagePrice",
      round(avg(price / nullif(competitor_median_price, 0)) * 100, 1)::float AS "priceIndex",
      round(avg(rating), 2)::float AS rating,
      max(review_count)::int AS "reviewCount",
      round(avg(content_score), 0)::int AS "contentScore"
    FROM product_observations
    WHERE ${where.sql}
    GROUP BY product_name, sku_id, country, channel, shop_name, brand_name, category_l2, category_l3
    ORDER BY "inStockRate" ASC, "productName" ASC
    LIMIT 100
  `;

  const countQuery = `
    SELECT count(*)::int AS total
    FROM (
      SELECT sku_id, channel
      FROM product_observations
      WHERE ${where.sql}
      GROUP BY sku_id, channel
    ) grouped
  `;

  const [rows, total] = await Promise.all([
    pool.query<Omit<ProductRow, 'healthScore' | 'riskBand'>>(
      query,
      where.values
    ),
    pool.query<{ total: number }>(countQuery, where.values),
  ]);

  return {
    rows: rows.rows.map(addHealthScore),
    total: total.rows[0]?.total ?? 0,
  };
}

export async function exportCalculatedCsv(
  filters: ReportFilters,
  signal?: AbortSignal,
  deadline = Date.now() + 120000
): Promise<{
  fileName: string;
  filePath: string;
  cleanup: () => Promise<void>;
}> {
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'product-health-'));
  const filePath = join(directory, 'report.csv');
  const rawPath = join(directory, 'raw.csv');
  const cleanup = () => rm(directory, { recursive: true, force: true });

  try {
    const summaryFile = await open(filePath, 'w');
    try {
      const rawFile = await open(rawPath, 'w');
      try {
        let current: ProductAccumulator | undefined;
        let hasSummary = false;
        let hasRaw = false;

        for await (const batch of getRawObservations(filters, signal, deadline)) {
          signal?.throwIfAborted();
          const completed: ProductRow[] = [];
          for (const row of batch) {
            if (
              current &&
              (current.skuId !== row.skuId || current.channel !== row.channel)
            ) {
              completed.push(finalizeProductHealth(current));
              current = undefined;
            }
            current = accumulateProductHealth(current, row);
          }

          signal?.throwIfAborted();
          // Write only completed groups. The last group continues in the next batch.
          if (completed.length > 0) {
            await summaryFile.appendFile(toCsv(completed as CsvRow[], !hasSummary));
            hasSummary = true;
          }

          const rawRows = batch.map(toRawCsvRow);
          signal?.throwIfAborted();
          await rawFile.appendFile(toCsv(rawRows, !hasRaw));
          hasRaw = true;
        }

        signal?.throwIfAborted();
        if (current) {
          await summaryFile.appendFile(
            toCsv([finalizeProductHealth(current)] as CsvRow[], !hasSummary)
          );
        }
      } finally {
        await rawFile.close();
      }

      // Preserve the original format: summary first, raw observations second.
      await summaryFile.appendFile('\n\n# Raw observations\n');
      for await (const chunk of createReadStream(rawPath)) {
        signal?.throwIfAborted();
        await summaryFile.appendFile(chunk);
      }
    } finally {
      await summaryFile.close();
    }

    signal?.throwIfAborted();
    return {
      fileName: `product-health-calculated-${filters.startDate}-to-${filters.endDate}.csv`,
      filePath,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function toRawCsvRow(row: Observation): CsvRow {
  return {
    productName: row.productName,
    skuId: row.skuId,
    country: row.country,
    channel: row.channel,
    shopName: row.shopName,
    brandName: row.brandName,
    listingUrl: row.listingUrl,
    categoryL2: row.categoryL2,
    categoryL3: row.categoryL3,
    inStock: row.inStock,
    price: row.price,
    competitorMedianPrice: row.competitorMedianPrice,
    rating: row.rating,
    reviewCount: row.reviewCount,
    contentScore: row.contentScore,
    rawSnapshot: row.rawSnapshot,
    diagnosticPayload: `${row.rawSnapshot};calculation_context=${row.skuId}:${row.channel}:${row.price}:${row.rating}`,
  };
}

async function* getRawObservations(
  filters: ReportFilters,
  signal?: AbortSignal,
  deadline = Date.now() + 120000
): AsyncGenerator<Observation[], void, unknown> {
  const where = buildWhere(filters);
  const query = `
    SELECT
      product_name AS "productName",
      sku_id AS "skuId",
      country,
      channel,
      shop_name AS "shopName",
      brand_name AS "brandName",
      listing_url AS "listingUrl",
      category_l2 AS "categoryL2",
      category_l3 AS "categoryL3",
      in_stock AS "inStock",
      price::float AS price,
      competitor_median_price::float AS "competitorMedianPrice",
      rating::float AS rating,
      review_count AS "reviewCount",
      content_score AS "contentScore",
      raw_snapshot AS "rawSnapshot"
    FROM product_observations
    WHERE ${where.sql}
    ORDER BY sku_id, channel, observed_at
  `;

  signal?.throwIfAborted();
  const client = await pool.connect();
  try {
    signal?.throwIfAborted();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query(
      `DECLARE export_cursor NO SCROLL CURSOR FOR ${query}`,
      where.values
    );

    while (true) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Export timed out');
      // Bound in-flight FETCH work; abort checks run again when it returns.
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(Math.max(1, Math.min(30000, remaining))),
      ]);
      const { rows } = await client.query<Observation>(
        'FETCH FORWARD 1000 FROM export_cursor'
      );
      signal?.throwIfAborted();
      if (rows.length === 0) break;
      yield rows;
    }
  } catch (error) {
    console.error('Error fetching raw observations:', error);
    throw error;
  } finally {
    let discard = false;
    try {
      const rollback = { text: 'ROLLBACK', query_timeout: 5000 };
      await client.query(rollback);
    } catch (error) {
      discard = true;
      throw error;
    } finally {
      client.release(discard);
    }
  }
}

function accumulateProductHealth(
  current: ProductAccumulator | undefined,
  row: Observation
): ProductAccumulator {
  current ??= {
    productName: row.productName,
    skuId: row.skuId,
    country: row.country,
    channel: row.channel,
    shopName: row.shopName,
    brandName: row.brandName,
    categoryL2: row.categoryL2,
    categoryL3: row.categoryL3,
    observations: 0,
    inStockCount: 0,
    priceTotal: 0,
    competitorPriceTotal: 0,
    ratingTotal: 0,
    reviewCountMax: 0,
    contentScoreTotal: 0,
  };
  current.observations += 1;
  current.inStockCount += row.inStock ? 1 : 0;
  current.priceTotal += row.price;
  current.competitorPriceTotal += row.competitorMedianPrice;
  current.ratingTotal += row.rating;
  current.reviewCountMax = Math.max(current.reviewCountMax, row.reviewCount);
  current.contentScoreTotal += row.contentScore;
  return current;
}

function finalizeProductHealth(row: ProductAccumulator): ProductRow {
  const inStockRate = round((row.inStockCount / row.observations) * 100, 1);
  const averagePrice = round(row.priceTotal / row.observations, 2);
  const priceIndex = round(
    (row.priceTotal / Math.max(row.competitorPriceTotal, 1)) * 100,
    1
  );
  const rating = round(row.ratingTotal / row.observations, 2);
  const contentScore = round(row.contentScoreTotal / row.observations, 0);

  return addHealthScore({
    productName: row.productName,
    skuId: row.skuId,
    country: row.country,
    channel: row.channel,
    shopName: row.shopName,
    brandName: row.brandName,
    categoryL2: row.categoryL2,
    categoryL3: row.categoryL3,
    observations: row.observations,
    inStockRate,
    averagePrice,
    priceIndex,
    rating,
    reviewCount: row.reviewCountMax,
    contentScore,
  });
}

function addHealthScore(
  row: Omit<ProductRow, 'healthScore' | 'riskBand'>
): ProductRow {
  const availabilityScore = row.inStockRate;
  const priceScore = Math.max(0, 100 - Math.abs(row.priceIndex - 100) * 1.5);
  const ratingScore = (row.rating / 5) * 100;
  const reviewScore = Math.min(100, Math.log10(row.reviewCount + 1) * 30);

  // ponytail: intentionally CPU-side calculation for take-home; candidate decides isolation path.
  let stabilityPenalty = 0;
  for (let i = 0; i < 80; i += 1) {
    stabilityPenalty += Math.abs(Math.sin((row.priceIndex + i) / 13)) / 80;
  }

  const healthScore = round(
    availabilityScore * 0.35 +
      priceScore * 0.2 +
      ratingScore * 0.15 +
      reviewScore * 0.1 +
      row.contentScore * 0.2 -
      stabilityPenalty,
    1
  );

  return {
    ...row,
    healthScore,
    riskBand: healthScore < 60 ? 'High' : healthScore < 78 ? 'Medium' : 'Low',
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
