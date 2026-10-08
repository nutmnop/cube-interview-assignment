export type CsvRow = Record<string, string | number | boolean | null>;

function escapeCsv(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: CsvRow[], includeHeader = true): string {
  if (rows.length === 0) return '';

  const headers = Object.keys(rows[0]);
  const lines = [
    ...(includeHeader ? [headers.join(',')] : []),
    ...rows.map((row) =>
      headers.map((header) => escapeCsv(row[header])).join(',')
    ),
  ];

  return (includeHeader ? '' : '\n') + lines.join('\n');
}
