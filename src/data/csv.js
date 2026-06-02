const DELIMITER_CANDIDATES = [",", ";", "\t", "|"];

function countChar(str, ch) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === ch) n++;
  }
  return n;
}

export function detectDelimiter(text, options = {}) {
  const headerRow = Math.max(1, Number.parseInt(String(options.headerRow ?? 1), 10) || 1);
  const lines = text.split(/\r?\n/);
  const sampleLine = lines[headerRow - 1] ?? lines.find((line) => line.trim()) ?? "";

  let bestDelimiter = ",";
  let bestCount = -1;

  for (const delimiter of DELIMITER_CANDIDATES) {
    const count = countChar(sampleLine, delimiter);
    if (count > bestCount) {
      bestDelimiter = delimiter;
      bestCount = count;
    }
  }

  return bestDelimiter;
}

export function parseCsv(text, options = {}) {
  const headerRow = Math.max(1, Number.parseInt(String(options.headerRow ?? 1), 10) || 1);
  const delimiter = options.delimiter ?? detectDelimiter(text, { headerRow });
  const rows = [];
  const chars = [];
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        chars.push("\"");
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(chars.join(""));
      chars.length = 0;
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }

      row.push(chars.join(""));
      chars.length = 0;

      if (row.some((cell) => cell !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    chars.push(char);
  }

  if (chars.length > 0 || row.length > 0) {
    row.push(chars.join(""));
    if (row.some((cell) => cell !== "")) {
      rows.push(row);
    }
  }

  if (!rows.length) {
    return [];
  }

  const headerIndex = Math.min(rows.length - 1, headerRow - 1);
  const headers = (rows[headerIndex] ?? []).map((header, index) => (header || `column_${index + 1}`).trim());
  const dataRows = rows.slice(headerIndex + 1);

  return dataRows.map((values) => {
    const record = {};

    for (let i = 0; i < headers.length; i++) {
      record[headers[i]] = (values[i] ?? "").trim();
    }

    return record;
  });
}

export function toNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}
